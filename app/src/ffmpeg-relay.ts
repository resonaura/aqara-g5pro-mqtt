/**
 * FfmpegRelay — reads a camera's internal RTSP stream and pushes it to
 * MediaMTX so all cameras share one public RTSP port.
 *
 * Architecture:
 *   Node.js bridge → 127.0.0.1:855X/live/<slug>  (internal, TCP only)
 *       ↓ ffmpeg -c copy -f rtsp
 *   MediaMTX       → 0.0.0.0:8554/live/<slug>    (public, one port)
 *
 * ffmpeg is used purely as a reliable re-muxer (stream copy, zero transcoding).
 */

import { spawn, type ChildProcess } from "child_process";

export interface FfmpegRelayOptions {
  /** Camera display name for log messages. */
  name: string;
  /** Internal RTSP URL served by the Node.js bridge on 127.0.0.1. */
  internalRtspUrl: string;
  /** Publish destination on MediaMTX, e.g. rtsp://127.0.0.1:8554/live/slug */
  mediamtxUrl: string;
  /** Path to the ffmpeg binary. Defaults to "ffmpeg" (from PATH). */
  ffmpegBin?: string;
  /**
   * How long to wait before the first relay attempt after the bridge signals
   * "stream ready". The internal RTSP server needs a moment to warm the SDP.
   */
  warmupDelayMs?: number;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 2_000;

export class FfmpegRelay {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = BASE_BACKOFF_MS;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: FfmpegRelayOptions) {}

  /** Start the relay. Call once; it restarts automatically on failure. */
  public start(): void {
    this.stopped = false;
    const delay = this.opts.warmupDelayMs ?? 3_000;
    console.log(
      `📡 [Relay:${this.opts.name}] starting in ${delay}ms → ${this.opts.mediamtxUrl}`,
    );
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  /** Permanently stop the relay (no further restarts). */
  public stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }

  private spawn(): void {
    if (this.stopped) return;

    const bin = this.opts.ffmpegBin ?? "ffmpeg";

    /**
     * ffmpeg flags:
     *  -hide_banner -loglevel warning   — quiet; errors still visible
     *  -rtsp_transport tcp              — reliable TCP for the internal read
     *  -i <internal>                    — source: our Node.js RTSP server
     *  -c copy                          — zero transcoding; stream copy only
     *  -f rtsp                          — RTSP output muxer
     *  -rtsp_transport tcp              — push to MediaMTX over TCP
     *  <mediamtx>                       — destination path
     */
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-rtsp_transport",
      "tcp",
      "-i",
      this.opts.internalRtspUrl,
      "-c",
      "copy",
      "-f",
      "rtsp",
      "-rtsp_transport",
      "tcp",
      this.opts.mediamtxUrl,
    ];

    console.log(`🎬 [Relay:${this.opts.name}] spawning ffmpeg relay`);

    this.proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    this.proc.stdout?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[Relay:${this.opts.name}] ${msg}`);
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.warn(`[Relay:${this.opts.name}] ⚠️  ${msg}`);
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this.stopped) return;
      console.warn(
        `[Relay:${this.opts.name}] ffmpeg exited (code=${code} signal=${signal}) — ` +
          `restarting in ${this.backoffMs}ms`,
      );
      this.restartTimer = setTimeout(() => {
        this.spawn();
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }, this.backoffMs);
    });

    this.proc.on("error", (err) => {
      console.error(
        `[Relay:${this.opts.name}] ffmpeg spawn error: ${err.message}`,
      );
    });

    // Reset backoff after a stable run of 10 s
    setTimeout(() => {
      if (this.proc) this.backoffMs = BASE_BACKOFF_MS;
    }, 10_000);
  }
}
