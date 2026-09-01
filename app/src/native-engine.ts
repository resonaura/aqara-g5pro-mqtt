import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";
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
  rtsp_path?: string;
  p2p_quality_channel?: number;
}

export class NativeMediaEngine extends EventEmitter {
  private static instance: NativeMediaEngine | null = null;
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private isReady = false;
  private pendingCommands: string[] = [];

  private constructor() {
    super();
  }

  public static getInstance(): NativeMediaEngine {
    if (!NativeMediaEngine.instance) {
      NativeMediaEngine.instance = new NativeMediaEngine();
    }
    return NativeMediaEngine.instance;
  }

  public static isBinaryAvailable(): boolean {
    try {
      const binPath = NativeMediaEngine.getBinaryPath();
      return fs.existsSync(binPath);
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
    if (this.process) return true;

    let binPath = "";
    try {
      binPath = NativeMediaEngine.getBinaryPath();
    } catch (e) {
      console.error(`❌ [NativeEngine] Failed to prepare native binary:`, e);
      return false;
    }

    if (!fs.existsSync(binPath)) {
      console.warn(`⚠️ [NativeEngine] Binary not found at ${binPath}`);
      return false;
    }

    try {
      this.process = spawn(binPath, [], {
        stdio: ["pipe", "pipe", "inherit"],
      });

      this.rl = readline.createInterface({
        input: this.process.stdout!,
        terminal: false,
      });

      this.rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          this.handleEvent(msg);
        } catch {
          console.log(`[NativeEngine] ${line}`);
        }
      });

      this.process.on("exit", (_code) => {
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        this.process = null;
        this.isReady = false;
      });

      this.process.on("error", (err) => {
        console.error(`❌ [NativeEngine] Process error:`, err);
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        this.process = null;
        this.isReady = false;
      });

      return true;
    } catch (e) {
      console.error(`❌ [NativeEngine] Failed to spawn binary:`, e);
      return false;
    }
  }

  private handleEvent(msg: Record<string, any>): void {
    if (msg.event === "ready") {
      this.isReady = true;
      this.emit("ready");
      for (const cmd of this.pendingCommands) {
        this.sendLine(cmd);
      }
      this.pendingCommands = [];
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
      this.emit("keyframe", msg.did);
    } else if (msg.event === "unhealthy") {
      this.emit("unhealthy", msg.did);
    } else {
      this.emit(msg.event || "message", msg);
    }
  }

  private sendLine(line: string): void {
    if (!this.process || !this.process.stdin) return;
    this.process.stdin.write(line + "\n");
  }

  public startP2p(config: NativeSessionConfig): void {
    const payload = JSON.stringify({
      cmd: "start_p2p",
      ...config,
    });

    if (this.isReady) {
      this.sendLine(payload);
    } else {
      this.pendingCommands.push(payload);
      if (!this.process) this.start();
    }
  }

  public startSession(config: NativeSessionConfig): void {
    this.startP2p(config);
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

  public stopP2p(did: string): void {
    const payload = JSON.stringify({
      cmd: "stop_p2p",
      did,
    });
    if (this.isReady) {
      this.sendLine(payload);
    }
  }

  public stopSession(did: string): void {
    this.stopP2p(did);
  }

  public stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      try {
        this.sendLine(JSON.stringify({ cmd: "exit" }));
        this.process.stdin?.end();
        this.process.kill("SIGTERM");
      } catch {}
      this.process = null;
      this.isReady = false;
    }
  }
}
