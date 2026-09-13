/**
 * FrameSnapshotter — pulls a still JPEG frame from the active P2P RTSP stream
 * at a fixed cadence (default: every 10 seconds) and writes it to a file
 * that the HTTP server can serve.
 *
 * Also acts as a Stream Health Indicator:
 * If 3 consecutive snapshot attempts fail (e.g. RTSP frozen, decryption failed,
 * or camera P2P connection dropped), it emits 'unhealthy' so the bridge can
 * automatically restart the camera connection with appropriate cooldown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, copyFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "./state.js";

export interface FrameSnapshotterOptions {
  slug: string;
  did: string;
  rtspUrl: string;
  dataDir?: string;
  intervalMs?: number;
  maxConsecutiveFailures?: number;
  getSnapshot?: (did: string, timeoutMs?: number) => Promise<string>;
}

export class FrameSnapshotter extends EventEmitter {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private currentPath: string;
  private consecutiveFailures = 0;
  private lastSuccessTime = 0;
  private startTime = 0;

  private readonly slug: string;
  private readonly did: string;
  private readonly rtspUrl: string;
  private readonly dataDir: string;
  private readonly intervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly getSnapshot?: (did: string, timeoutMs?: number) => Promise<string>;

  constructor(options: FrameSnapshotterOptions) {
    super();
    this.slug = options.slug;
    this.did = options.did;
    this.rtspUrl = options.rtspUrl;
    this.dataDir = options.dataDir || getDataDir();
    this.intervalMs = options.intervalMs ?? 10_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.getSnapshot = options.getSnapshot;

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    const framesDir = path.join(this.dataDir, "frames");
    if (!existsSync(framesDir)) {
      mkdirSync(framesDir, { recursive: true });
    }
    this.currentPath = path.join(framesDir, `${this.slug}.jpg`);
  }

  /** Path to the most recent cached JPEG (read-only). */
  public get filePath(): string {
    return this.currentPath;
  }

  /** Number of consecutive failed snapshot captures. */
  public get failureCount(): number {
    return this.consecutiveFailures;
  }

  /** True if the cached file exists and is non-empty. */
  public hasFrame(): boolean {
    try {
      return statSync(this.currentPath).size > 0;
    } catch {
      return false;
    }
  }

  private async grabFromKeyframe(): Promise<boolean> {
    try {
      if (!this.getSnapshot) return false;
      const b64 = await this.getSnapshot(this.did, 4000);
      if (!b64) return false;
      const annexb = Buffer.from(b64, "base64");
      if (annexb.length < 64) return false;

      const framesDir = path.join(this.dataDir, "frames");
      const tmpVideoPath = path.join(framesDir, `${this.slug}.${Date.now()}.tmp.h264`);
      const tmpJpgPath = path.join(framesDir, `${this.slug}.${Date.now()}.tmp.jpg`);

      writeFileSync(tmpVideoPath, annexb);

      const ok = await new Promise<boolean>((resolve) => {
        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          tmpVideoPath,
          "-an",
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
          "-frames:v",
          "1",
          "-q:v",
          "2",
          "-y",
          tmpJpgPath,
        ];
        let proc: ChildProcess;
        try {
          proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
        } catch {
          resolve(false);
          return;
        }
        const killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 5000);
        killTimer.unref();

        proc.on("exit", (code) => {
          clearTimeout(killTimer);
          resolve(code === 0);
        });
        proc.on("error", () => {
          clearTimeout(killTimer);
          resolve(false);
        });
      });

      try {
        unlinkSync(tmpVideoPath);
      } catch {}

      if (!ok || !existsSync(tmpJpgPath)) {
        try {
          unlinkSync(tmpJpgPath);
        } catch {}
        return false;
      }

      const st = statSync(tmpJpgPath);
      if (st.size < 1000) {
        try {
          unlinkSync(tmpJpgPath);
        } catch {}
        return false;
      }

      renameSync(tmpJpgPath, this.currentPath);
      try {
        const lastLivePath = path.join(this.dataDir, "frames", `${this.slug}.last_live.jpg`);
        copyFileSync(this.currentPath, lastLivePath);
      } catch {}

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Grab one frame (prefers low-overhead native keyframe tap, falls back to RTSP pull).
   */
  private async grabOnce(): Promise<boolean> {
    if (this.stopped) return false;

    if (this.getSnapshot) {
      const ok = await this.grabFromKeyframe();
      if (ok) {
        this.consecutiveFailures = 0;
        this.lastSuccessTime = Date.now();
        this.emit("frame", {
          slug: this.slug,
          did: this.did,
          path: this.currentPath,
        });
        return true;
      }
    }

    return new Promise((resolve) => {
      if (this.stopped) {
        resolve(false);
        return;
      }
      const tempPath = `${this.currentPath}.tmp`;
      try {
        rmSync(tempPath, { force: true });
      } catch {}
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "5000000", // 5s RTSP connect timeout (microseconds)
        "-y",
        "-analyzeduration",
        "5000000",
        "-probesize",
        "5000000",
        "-i",
        this.rtspUrl,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-f",
        "image2",
        "-update",
        "1",
        tempPath,
      ];

      let proc: ChildProcess;
      try {
        proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (err: any) {
        console.warn(`⚠️ [Snapshot:${this.slug}] ffmpeg spawn failed: ${err.message}`);
        this.handleFailure();
        resolve(false);
        return;
      }

      this.proc = proc;
      let stderrBuf = "";

      const killTimer = setTimeout(() => {
        if (this.proc === proc) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }, 7000);
      killTimer.unref();

      proc.stderr?.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
      });
      proc.on("error", (err) => {
        clearTimeout(killTimer);
        if (!this.stopped) {
          console.warn(`⚠️ [Snapshot:${this.slug}] ffmpeg error: ${err.message}`);
        }
        this.handleFailure();
        resolve(false);
      });
      proc.on("exit", (code) => {
        clearTimeout(killTimer);
        if (this.proc === proc) this.proc = null;
        if (this.stopped) {
          resolve(false);
          return;
        }
        let completed = false;
        if (code === 0) {
          try {
            if (statSync(tempPath).size > 0) {
              renameSync(tempPath, this.currentPath);
              try {
                const lastLivePath = path.join(
                  this.dataDir,
                  "frames",
                  `${this.slug}.last_live.jpg`,
                );
                copyFileSync(this.currentPath, lastLivePath);
              } catch {}
              completed = true;
            }
          } catch {}
        }
        if (completed && this.hasFrame()) {
          this.consecutiveFailures = 0;
          this.lastSuccessTime = Date.now();
          this.emit("frame", {
            slug: this.slug,
            did: this.did,
            path: this.currentPath,
          });
          resolve(true);
        } else {
          if (stderrBuf.trim()) {
            console.warn(
              `⚠️ [Snapshot:${this.slug}] ffmpeg exited (code=${code}): ${stderrBuf.trim().split("\n").pop()}`,
            );
          }
          this.handleFailure();
          resolve(false);
        }
      });
    });
  }

  private handleFailure(): void {
    if (this.stopped) return;
    this.consecutiveFailures++;
    this.emit("failed", {
      slug: this.slug,
      did: this.did,
      consecutiveFailures: this.consecutiveFailures,
    });

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      const durationMs = Date.now() - (this.lastSuccessTime || this.startTime);
      this.emit("unhealthy", {
        slug: this.slug,
        did: this.did,
        consecutiveFailures: this.consecutiveFailures,
        durationMs,
      });
    }
  }

  /** Start periodic snapshot loop. One file per slug (overwritten), 10s interval. */
  public start(): void {
    if (this.timer || this.stopped) return;
    this.startTime = Date.now();
    this.consecutiveFailures = 0;
    if (!process.env.DEBUG)
      console.log(`📸 [Snapshot:${this.slug}] ON (${this.intervalMs}ms cache, single file)`);
    const tick = async () => {
      if (this.stopped || this.inFlight) return;
      this.inFlight = true;
      try {
        await this.grabOnce();
      } finally {
        this.inFlight = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Only kill if a process is running; normally grabOnce exits on its own.
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}
