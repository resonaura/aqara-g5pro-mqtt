/**
 * FfmpegTranscoder — In-process low-latency video filter and error-concealment transcoder.
 *
 * Automatically detects available hardware acceleration (macOS VideoToolbox,
 * Linux NVENC, Intel QSV, Raspberry Pi V4L2-M2M, VAAPI) and gracefully falls
 * back to universal CPU libx264 (ultrafast/zerolatency) when run in Docker/Raspberry Pi.
 *
 * Pipeline:
 *   Decrypted camera Annex-B H.264 / HEVC
 *     ↓ (pipe:0)
 *   FFmpeg (Error Concealment: -ec +guess_mvs+deblock, -flags2 +showall)
 *     ↓ (filter: deblock=filter=strong:block=4,fps=15)
 *   Hardware / CPU H.264 Encoder (-g 30, -bf 0, realtime)
 *     ↓ (pipe:1)
 *   Clean Annex-B Access Units → RTSP Server broadcastFrame
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface EncoderConfig {
  name: string;
  args: string[];
}

let cachedEncoderConfig: EncoderConfig | null = null;

/** Detect best available H.264 encoder on current OS/hardware. */
export function detectH264Encoder(): EncoderConfig {
  if (cachedEncoderConfig) return cachedEncoderConfig;

  let encodersOutput = "";
  try {
    encodersOutput = execSync("ffmpeg -encoders 2>&1", { encoding: "utf8" });
  } catch {
    // If ffmpeg is not available in PATH, default to libx264
    cachedEncoderConfig = {
      name: "libx264",
      args: [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
      ],
    };
    return cachedEncoderConfig;
  }

  // 1. macOS VideoToolbox (Apple Silicon / Intel Mac)
  if (encodersOutput.includes("h264_videotoolbox")) {
    cachedEncoderConfig = {
      name: "h264_videotoolbox",
      args: [
        "-c:v",
        "h264_videotoolbox",
        "-b:v",
        "4500k",
        "-realtime",
        "1",
        "-bf",
        "0",
        "-pix_fmt",
        "nv12",
      ],
    };
    return cachedEncoderConfig;
  }

  // 2. NVIDIA GPU (Linux / Windows)
  if (encodersOutput.includes("h264_nvenc")) {
    cachedEncoderConfig = {
      name: "h264_nvenc",
      args: [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p1",
        "-tune",
        "ll",
        "-b:v",
        "4500k",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
      ],
    };
    return cachedEncoderConfig;
  }

  // 3. Intel QuickSync (Linux / Windows)
  if (encodersOutput.includes("h264_qsv")) {
    cachedEncoderConfig = {
      name: "h264_qsv",
      args: [
        "-c:v",
        "h264_qsv",
        "-preset",
        "veryfast",
        "-b:v",
        "4500k",
        "-bf",
        "0",
        "-pix_fmt",
        "nv12",
      ],
    };
    return cachedEncoderConfig;
  }

  // 4. Raspberry Pi V4L2 Hardware (Linux / Raspberry Pi OS)
  if (encodersOutput.includes("h264_v4l2m2m")) {
    cachedEncoderConfig = {
      name: "h264_v4l2m2m",
      args: ["-c:v", "h264_v4l2m2m", "-b:v", "4000k", "-bf", "0", "-pix_fmt", "yuv420p"],
    };
    return cachedEncoderConfig;
  }

  // 5. Universal CPU fallback (Docker, Raspberry Pi without V4L2, general Linux)
  cachedEncoderConfig = {
    name: "libx264",
    args: [
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-crf",
      "19",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
    ],
  };
  return cachedEncoderConfig;
}

export interface FfmpegTranscoderOptions {
  did: string;
  name: string;
  fps?: number;
  bitrate?: string;
  deblock?: boolean;
  smoothMotion?: boolean;
}

export class FfmpegTranscoder extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private buffer: Buffer = Buffer.alloc(0);
  private encoderConfig: EncoderConfig;
  private readonly did: string;
  private readonly name: string;
  private readonly fps: number;
  private readonly deblock: boolean;
  private readonly smoothMotion: boolean;

  constructor(options: FfmpegTranscoderOptions) {
    super();
    this.did = options.did;
    this.name = options.name;
    this.fps = options.fps || 15;
    this.deblock = options.deblock !== false;
    this.smoothMotion = options.smoothMotion !== false;
    this.encoderConfig = detectH264Encoder();
  }

  public start(): void {
    if (this.proc || this.stopped) return;

    const filters: string[] = [];
    if (this.deblock) {
      filters.push("deblock=filter=strong:block=4");
      filters.push("atadenoise=0a=0.1:0b=0.1:1a=0.1:1b=0.1"); // Adaptive temporal noise suppression
      filters.push("smartblur=lr=1.5:ls=-0.8:lt=-5"); // Selectively smooth macroblock interiors without blurring real edges
      filters.push("unsharp=lx=3:ly=3:la=0.5"); // Restore crisp edge sharpness
    }
    if (this.smoothMotion) {
      filters.push("tblend=all_mode=average:all_opacity=0.20"); // Temporal motion edge smoothing
    }
    filters.push(`fps=${this.fps}`);

    const filterChain = filters.join(",");

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer+discardcorrupt",
      "-flags",
      "low_delay",
      "-avioflags",
      "direct",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-err_detect",
      "+ignore_err",
      "-ec",
      "+guess_mvs+deblock",
      "-flags2",
      "+showall",
      "-r",
      String(this.fps),
      "-f",
      "h264",
      "-i",
      "pipe:0",
      "-vf",
      filterChain,
      ...this.encoderConfig.args,
      "-g",
      String(this.fps * 2), // 2-second strict keyframe interval
      "-f",
      "h264",
      "pipe:1",
    ];

    try {
      this.proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
      const label = this.name ? `${this.name} (${this.did})` : this.did;
      console.log(
        `⚙️  [${label}] FFmpeg transcoder active: [${this.encoderConfig.name}] (EC + smartblur + atadenoise + unsharp + motion-blend, ${this.fps}fps, GOP=2s)`,
      );

      this.proc.stdout!.on("data", (chunk: Buffer) => {
        this.handleTranscodedChunk(chunk);
      });

      this.proc.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && process.env.DEBUG) {
          console.log(`[FFmpeg:${label}] ${msg}`);
        }
      });

      this.proc.on("exit", (code, signal) => {
        this.proc = null;
        if (!this.stopped) {
          console.warn(`[FFmpeg:${label}] exited (code=${code} sig=${signal}) — restarting`);
          setTimeout(() => this.start(), 1000);
        }
      });

      this.proc.on("error", (err) => {
        console.warn(`[FFmpeg:${label}] process error: ${err.message}`);
        this.proc = null;
      });
    } catch (err: any) {
      const label = this.name ? `${this.name} (${this.did})` : this.did;
      console.warn(`⚠️ [${label}] Failed to spawn ffmpeg: ${err.message}. Using passthrough.`);
    }
  }

  /** Write a raw Annex-B frame (SPS/PPS/IDR/P-frame) into FFmpeg stdin. */
  public write(frame: Buffer): void {
    if (this.stopped) return;
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      this.start();
    }
    try {
      this.proc?.stdin?.write(frame);
    } catch {
      /* ignore pipe backpressure or closed stdin */
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.stdin?.end();
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Kill the current ffmpeg process and reset all internal state so the next
   * write() call spawns a fresh encoder. Use this on P2P reconnect so that
   * the new IDR from the camera starts a brand-new encoding session with
   * fresh SPS/PPS rather than continuing the old bitstream.
   */
  public reset(): void {
    if (this.proc) {
      try {
        this.proc.stdin?.end();
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.buffer = Buffer.alloc(0);
    // Do NOT set this.stopped — the transcoder is still logically active
    // and write() will restart ffmpeg on the next frame.
  }

  /**
   * Split the continuous Annex-B stream from FFmpeg stdout into access units
   * (frames) and emit them as 'frame' events.
   */
  private handleTranscodedChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Find all start codes (00 00 01 or 00 00 00 01)
    const offsets: number[] = [];
    const len = this.buffer.length;
    for (let i = 0; i <= len - 4; i++) {
      if (this.buffer[i] === 0 && this.buffer[i + 1] === 0) {
        if (this.buffer[i + 2] === 1) {
          offsets.push(i);
        } else if (this.buffer[i + 2] === 0 && this.buffer[i + 3] === 1) {
          offsets.push(i);
        }
      }
    }

    if (offsets.length < 2) return;

    // We can extract everything up to the last start code as complete NALs
    const lastBoundary = offsets[offsets.length - 1];
    const readyChunk = this.buffer.subarray(0, lastBoundary);
    this.buffer = this.buffer.subarray(lastBoundary);

    if (readyChunk.length > 0) {
      this.emit("frame", readyChunk);
    }
  }
}
