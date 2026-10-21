import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";
import { diagnostics, cameraDiagnosticId, redactDiagnostic } from "./diagnostics.js";
import { ensureNativeBinary } from "./build-guard.js";

export interface NativeSessionConfig {
  did: string;
  p2p_id?: string;
  init_string?: string;
  app_pub_hex?: string;
  app_sign?: string;
  sign_time?: string;
  dev_pub_hex?: string;
  video_key_hex?: string;
  audio_key_hex?: string;
  camera_ip?: string;
  camera_port?: number;
  rtsp_port: number;
  video_codec?: "h264" | "hevc";
  rtsp_path?: string;
  p2p_quality_channel?: number;
  udp_video_port?: number;
  udp_audio_port?: number;
}

export interface NativeEngineOptions {
  command?: string;
  args?: string[];
  heartbeatMs?: number;
  timeoutMs?: number;
  restartMs?: number;
  killMs?: number;
}

export class NativeMediaEngine extends EventEmitter {
  private static instance: NativeMediaEngine | null = null;
  private process: ChildProcess | null = null;
  private isReady = false;
  private wanted = false;
  private terminating = false;
  private lastPong = 0;
  private startedAt = 0;
  private failures = 0;
  private heartbeat?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private outputs = new Map<string, NativeSessionConfig>();
  private pendingStarts = new Map<string, NativeSessionConfig>();
  private pendingSnapshots = new Map<
    string,
    { resolve: (b64: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  public constructor(private readonly options: NativeEngineOptions = {}) {
    super();
  }

  public static getInstance(): NativeMediaEngine {
    return (NativeMediaEngine.instance ??= new NativeMediaEngine());
  }

  public static isBinaryAvailable(): boolean {
    try {
      return fs.existsSync(NativeMediaEngine.getBinaryPath());
    } catch {
      return false;
    }
  }

  public static getBinaryPath(): string {
    return ensureNativeBinary();
  }

  public get ready(): boolean {
    return this.isReady;
  }

  public start(): boolean {
    this.wanted = true;
    if (this.process || this.restartTimer) return true;
    try {
      const command = this.options.command ?? NativeMediaEngine.getBinaryPath();
      const child = spawn(command, this.options.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
      diagnostics.record("worker.start", { failures: this.failures });
      this.process = child;
      this.terminating = false;
      this.startedAt = this.lastPong = Date.now();
      child.stdin?.on("error", () => {});
      const reader = readline.createInterface({ input: child.stdout!, terminal: false });
      reader.on("line", (line) => {
        if (this.process !== child || this.terminating || !line.trim()) return;
        try {
          this.handleEvent(JSON.parse(line));
        } catch {
          // Native stdout is JSON-only. Never echo malformed, potentially key-bearing IPC.
          diagnostics.record("worker.invalid_ipc", { bytes: Buffer.byteLength(line) }, "warn");
        }
      });
      const errors = readline.createInterface({ input: child.stderr!, terminal: false });
      errors.on("line", (line) => {
        if (line.trim()) console.warn("[Native]", redactDiagnostic(line));
      });
      child.once("error", () => {
        diagnostics.record("worker.spawn_failed", {}, "error");
        console.warn("[NativeEngine] Media worker could not be started");
      });
      child.once("close", (code, signal) => {
        reader.close();
        errors.close();
        diagnostics.record(
          "worker.exit",
          { code, signal, expected: !this.wanted, uptimeMs: Date.now() - this.startedAt },
          this.wanted ? "warn" : "info",
        );
        if (this.process !== child) return;
        clearInterval(this.heartbeat);
        clearTimeout(this.killTimer);
        this.process = null;
        this.isReady = false;
        this.terminating = false;
        this.pendingStarts.clear();
        this.rejectSnapshots("Native media worker stopped");
        if (this.wanted) {
          for (const did of this.outputs.keys()) this.emit("unhealthy", did);
          this.scheduleRestart();
        }
      });
      this.heartbeat = setInterval(() => {
        if (this.process !== child || this.terminating) return;
        if (Date.now() - this.lastPong > (this.options.timeoutMs ?? 15_000)) {
          console.warn("[NativeEngine] Media worker unresponsive; restarting only media worker");
          diagnostics.record(
            "worker.heartbeat_timeout",
            { ageMs: Date.now() - this.lastPong },
            "error",
          );
          this.terminateWorker();
          return;
        }
        if (Date.now() - this.startedAt > 60_000) this.failures = 0;
        this.sendLine(JSON.stringify({ cmd: "ping" }));
      }, this.options.heartbeatMs ?? 5_000);
      this.heartbeat.unref();
      return true;
    } catch {
      this.scheduleRestart();
      return false;
    }
  }

  private scheduleRestart(): void {
    if (!this.wanted || this.restartTimer) return;
    const delay = Math.min(
      30_000,
      (this.options.restartMs ?? 1_000) * 2 ** Math.min(this.failures++, 5),
    );
    diagnostics.record(
      "worker.restart_scheduled",
      { delayMs: delay, failures: this.failures },
      "warn",
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.wanted) this.start();
    }, delay);
    this.restartTimer.unref();
  }

  private rejectSnapshots(reason: string): void {
    for (const pending of this.pendingSnapshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingSnapshots.clear();
  }

  private terminateWorker(): void {
    const child = this.process;
    if (!child || this.terminating) return;
    this.terminating = true;
    this.isReady = false;
    this.rejectSnapshots("Native media worker restarting");
    this.sendLine(JSON.stringify({ cmd: "exit" }));
    child.stdin?.end();
    child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      // Keep the child reference until close; never spawn a replacement on occupied ports.
      if (this.process === child) {
        diagnostics.record("worker.force_kill", {}, "warn");
        child.kill("SIGKILL");
      }
    }, this.options.killMs ?? 1_500);
    this.killTimer.unref();
  }

  public ensureOutput(config: NativeSessionConfig): void {
    const output = {
      did: config.did,
      rtsp_port: config.rtsp_port,
      rtsp_path: config.rtsp_path,
      udp_video_port: config.udp_video_port,
      udp_audio_port: config.udp_audio_port,
      // The offline feed must advertise the same codec as the eventual live stream.
      video_codec: config.video_codec,
    };
    this.outputs.set(config.did, output);
    if (this.isReady) this.sendLine(JSON.stringify({ cmd: "ensure_output", ...output }));
    this.start();
  }

  private handleEvent(msg: Record<string, any>): void {
    const tracked = [
      "ready",
      "p2p_connected",
      "session_ready",
      "session_started",
      "session_stopped",
      "unhealthy",
      "error",
      "media_health",
      "media_recovery",
    ];
    if (tracked.includes(msg.event)) {
      // Explicit allowlist: never persist IPC configs, keys or snapshot/audio payloads.
      const fields: Record<string, unknown> = {};
      if (typeof msg.did === "string") fields.camera = cameraDiagnosticId(msg.did);
      for (const key of [
        "connected",
        "session_ready",
        "reason",
        "operation",
        "action",
        "message",
        "packets",
        "duplicates",
        "reordered",
        "sequence_gaps",
        "video_frames",
        "audio_frames",
        "discarded_bytes",
        "malformed_frames",
        "keyframe_requests",
        "video_age_ms",
        "audio_age_ms",
        "decoded_age_ms",
      ]) {
        if (["string", "number", "boolean"].includes(typeof msg[key])) fields[key] = msg[key];
      }
      diagnostics.record(
        `native.${msg.event}`,
        fields,
        ["unhealthy", "error"].includes(msg.event) ? "warn" : "info",
      );
    }
    if (msg.event === "ready") {
      this.isReady = true;
      this.lastPong = Date.now();
      for (const config of this.outputs.values()) {
        this.sendLine(JSON.stringify({ cmd: "ensure_output", ...config }));
      }
      for (const config of this.pendingStarts.values()) {
        this.sendLine(JSON.stringify({ cmd: "start_p2p", ...config }));
      }
      this.pendingStarts.clear();
      this.emit("ready");
    } else if (msg.event === "pong") {
      this.lastPong = Date.now();
    } else if (msg.event === "p2p_connected") {
      this.emit("p2p_connected", msg.did, msg.ip, msg.port);
    } else if (msg.event === "session_ready") {
      this.emit("session_ready", msg.did);
    } else if (msg.event === "request_keyframe") {
      this.emit("request_keyframe", msg.did);
    } else if (msg.event === "talkback_ready") {
      this.emit("talkback_ready", msg.did);
    } else if (msg.event === "session_started") {
      this.emit("session_started", msg.did, msg.rtsp_port);
    } else if (msg.event === "keyframe") {
      this.emit("keyframe", msg.did, msg.video_codec);
    } else if (msg.event === "unhealthy") {
      this.emit("unhealthy", msg.did);
    } else if (msg.event === "snapshot") {
      const pending = this.pendingSnapshots.get(msg.did);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSnapshots.delete(msg.did);
        pending.resolve(msg.data_base64);
      }
      this.emit("snapshot", msg.did, msg.data_base64);
    } else if (msg.event === "error") {
      if (msg.did) {
        const pending = this.pendingSnapshots.get(msg.did);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingSnapshots.delete(msg.did);
          pending.reject(new Error(msg.message || "Native engine snapshot error"));
        }
      }
      if (this.listenerCount("error")) this.emit("error", msg);
      else console.warn("[NativeEngine] Media operation failed:", msg.message);
    } else {
      this.emit(msg.event || "message", msg);
    }
  }

  private sendLine(line: string): void {
    if (!this.process || !this.process.stdin || !this.process.stdin.writable) return;
    try {
      this.process.stdin.write(line + "\n");
    } catch {
      // Ignored: process may be shutting down
    }
  }

  public startP2P(config: NativeSessionConfig): void {
    this.ensureOutput(config);
    if (this.isReady) {
      this.sendLine(JSON.stringify({ cmd: "start_p2p", ...config }));
    } else {
      // One fresh request per camera, never an unbounded queue of stale keys.
      this.pendingStarts.set(config.did, config);
    }
  }

  public startP2p(config: NativeSessionConfig): void {
    this.startP2P(config);
  }

  public startSession(config: NativeSessionConfig): void {
    this.startP2P(config);
  }

  public requestKeyframe(did: string): void {
    const payload = JSON.stringify({
      cmd: "request_keyframe",
      did,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public setQuality(did: string, channel: number): void {
    const payload = JSON.stringify({
      cmd: "set_quality",
      did,
      channel,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public ptz(did: string, direction: string): void {
    const payload = JSON.stringify({
      cmd: "ptz",
      did,
      direction,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public startTalkback(did: string): void {
    const payload = JSON.stringify({
      cmd: "start_talkback",
      did,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public stopTalkback(did: string): void {
    const payload = JSON.stringify({
      cmd: "stop_talkback",
      did,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public sendTalkback(did: string, adts: Buffer): void {
    const payload = JSON.stringify({
      cmd: "send_talkback",
      did,
      data_hex: adts.toString("hex"),
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public stopP2P(did: string): void {
    this.outputs.delete(did);
    this.pendingStarts.delete(did);
    const payload = JSON.stringify({
      cmd: "stop_p2p",
      did,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public stopP2p(did: string): void {
    this.stopP2P(did);
  }

  public stopSession(did: string): void {
    this.stopP2P(did);
  }

  public getSnapshot(did: string, timeoutMs = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      const existing = this.pendingSnapshots.get(did);
      if (existing) {
        clearTimeout(existing.timer);
        this.pendingSnapshots.delete(did);
        existing.reject(new Error("Snapshot request superseded"));
      }
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(did);
        reject(new Error("Snapshot request timed out"));
      }, timeoutMs);
      timer.unref?.();
      this.pendingSnapshots.set(did, { resolve, reject, timer });
      const payload = JSON.stringify({ cmd: "get_snapshot", did });
      if (this.isReady) {
        this.sendLine(payload);
      } else {
        clearTimeout(timer);
        this.pendingSnapshots.delete(did);
        reject(new Error("Native media worker is not ready"));
      }
    });
  }

  public stop(): void {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    clearInterval(this.heartbeat);
    this.outputs.clear();
    this.pendingStarts.clear();
    this.rejectSnapshots("Native engine stopped");
    this.terminateWorker();
  }
}
