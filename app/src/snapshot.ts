/**
 * FrameSnapshotter — pulls a still JPEG frame from the active P2P RTSP stream
 * at a fixed cadence (default: every 10 seconds) and writes it to a file
 * that the HTTP server can serve.
 *
 * Spawns a dedicated `ffmpeg` process that reads the local RTSP URL produced
 * by the AqaraCameraBridge and writes a single, full-frame JPEG to
 * `data/frames/<slug>.jpg`. Re-spawns every `intervalMs` so that the cached
 * file is always fresh.
 *
 * Lifecycle:
 *   - Call `start()` when P2P Stream is turned ON.
 *   - Call `stop()` when P2P Stream is turned OFF.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

export interface FrameSnapshotterOptions {
  slug: string;
  did: string;
  rtspUrl: string;
  dataDir?: string;
  intervalMs?: number;
}

export class FrameSnapshotter extends EventEmitter {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private currentPath: string;

  private readonly slug: string;
  private readonly did: string;
  private readonly rtspUrl: string;
  private readonly dataDir: string;
  private readonly intervalMs: number;

  constructor(options: FrameSnapshotterOptions) {
    super();
    this.slug = options.slug;
    this.did = options.did;
    this.rtspUrl = options.rtspUrl;
    this.dataDir = options.dataDir || path.resolve(process.cwd(), "data");
    this.intervalMs = options.intervalMs ?? 10_000;

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

  /** True if the cached file exists and is non-empty. */
  public hasFrame(): boolean {
    try {
      return statSync(this.currentPath).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a single ffmpeg process that grabs one full frame and exits.
   * Uses `-ss 1` to skip the initial probe, `-vframes 1` for a single
   * complete picture, and `-q:v 2` for a high-quality JPEG.
   */
  private grabOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve(false);
        return;
      }
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-stimeout",
        "5000000", // 5s RTSP connect timeout (microseconds)
        "-y",
        "-ss",
        "1",
        "-i",
        this.rtspUrl,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-f",
        "image2",
        this.currentPath,
      ];

      let proc: ChildProcess;
      try {
        proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (err: any) {
        console.warn(`⚠️ [Snapshot:${this.slug}] ffmpeg spawn failed: ${err.message}`);
        resolve(false);
        return;
      }

      let stderrBuf = "";
      proc.stderr?.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
      });
      proc.on("error", (err) => {
        if (!this.stopped) {
          console.warn(`⚠️ [Snapshot:${this.slug}] ffmpeg error: ${err.message}`);
        }
        resolve(false);
      });
      proc.on("exit", (code) => {
        if (this.stopped) {
          resolve(false);
          return;
        }
        if (code === 0 && this.hasFrame()) {
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
          resolve(false);
        }
      });
    });
  }

  /**
   * Start the periodic snapshot loop. Triggers an immediate first attempt
   * and then runs every `intervalMs`.
   */
  /** Start periodic snapshot loop. One file per slug (overwritten), 10s interval. */
  public start(): void {
    if (this.timer || this.stopped) return;
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
    // Do NOT delete the cached file — it serves as the last-known good frame.
  }
}
