/**
 * FallbackStreamManager — streams last known snapshot (or sleek offline placeholder)
 * as a continuous 1-fps video loop to the native RTSP server's UDP ingest port.
 *
 * Modeled after scrypted-tuya's fallback transcoder service:
 * - When real camera live stream is down or starting up, FFmpeg loops the snapshot
 *   (blurred last live frame or dark HUD overlay) with live advancing timestamps.
 * - Outbound RTP is sent to 127.0.0.1:<rtpPort> (video) and 127.0.0.1:<audioRtpPort> (silent AAC).
 * - When real camera stream recovers, fallback is stopped cleanly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "./state.js";

export interface FallbackOptions {
  slug: string;
  deviceName: string;
  rtpPort: number;
  audioRtpPort: number;
  isHevc?: boolean;
  dataDir?: string;
}

interface ActiveFallback {
  options: FallbackOptions;
  process: ChildProcess | null;
  stopping: boolean;
  restartTimer?: NodeJS.Timeout;
  watchdog?: NodeJS.Timeout;
  lastProgress: number;
}

export class FallbackStreamManager {
  private static instance: FallbackStreamManager | null = null;
  private fallbacks = new Map<string, ActiveFallback>();

  public constructor(
    private readonly runtime: {
      command?: string;
      args?: string[];
      restartMs?: number;
      watchdogMs?: number;
      stallMs?: number;
    } = {},
  ) {}

  public static getInstance(): FallbackStreamManager {
    if (!FallbackStreamManager.instance) {
      FallbackStreamManager.instance = new FallbackStreamManager();
    }
    return FallbackStreamManager.instance;
  }

  public isRunning(slug: string): boolean {
    const fb = this.fallbacks.get(slug);
    return !!(fb && fb.process && !fb.stopping);
  }

  public startFallback(options: FallbackOptions): void {
    const existing = this.fallbacks.get(options.slug);
    if (existing) {
      if (!existing.stopping) return; // Includes one pending restart; never create competing workers.
      this.stopFallback(options.slug);
    }

    const dataDir = options.dataDir || getDataDir();
    const framesDir = path.join(dataDir, "frames");
    const lastLiveFile = path.join(framesDir, `${options.slug}.last_live.jpg`);
    const frameFile = path.join(framesDir, `${options.slug}.jpg`);
    const lastLiveExists = existsSync(lastLiveFile);
    const fallbackImageExists = existsSync(frameFile);

    let inputArgs: string[];
    let videoFilter: string;

    if (lastLiveExists) {
      inputArgs = ["-loop", "1", "-framerate", "1", "-re", "-i", lastLiveFile];
      videoFilter = [
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "gblur=sigma=18:steps=2",
        "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill",
        "drawtext=text='OFFLINE':fontcolor=white@0.95:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2-20:shadowcolor=black@0.5:shadowx=2:shadowy=2",
        "drawtext=text='%{pts\\:hms}':fontcolor=white@0.70:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+28:shadowcolor=black@0.5:shadowx=1:shadowy=1",
      ].join(",");
    } else if (fallbackImageExists) {
      inputArgs = ["-loop", "1", "-framerate", "1", "-re", "-i", frameFile];
      videoFilter = [
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "drawtext=text='%{pts\\:hms}':fontcolor=white@0.70:fontsize=24:x=(w-text_w)/2:y=h-60:shadowcolor=black@0.5:shadowx=1:shadowy=1",
      ].join(",");
    } else {
      inputArgs = ["-re", "-f", "lavfi", "-i", "color=c=0x111116:s=1280x720:r=1"];
      videoFilter = [
        "drawtext=text='OFFLINE':fontcolor=white@0.95:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2-20:shadowcolor=black@0.5:shadowx=2:shadowy=2",
        "drawtext=text='%{pts\\:hms}':fontcolor=white@0.70:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+28:shadowcolor=black@0.5:shadowx=1:shadowy=1",
      ].join(",");
    }

    const videoCodecArgs = options.isHevc
      ? [
          "-c:v",
          "libx265",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-x265-params",
          "keyint=2:min-keyint=2:repeat-headers=1:no-info=1:pools=1:frame-threads=1",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "1",
        ]
      : [
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "stillimage,zerolatency",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "2",
          "-r",
          "1",
        ];

    const fallbackArgs = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-progress",
      "pipe:1",
      "-nostats",
      "-threads",
      "1",
      ...inputArgs,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-vf",
      videoFilter,
      "-map",
      "0:v:0",
      ...videoCodecArgs,
      "-f",
      "rtp",
      "-payload_type",
      "96",
      `rtp://127.0.0.1:${options.rtpPort}?pkt_size=1200`,
      "-map",
      "1:a:0",
      "-c:a",
      "aac",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "32k",
      "-f",
      "rtp",
      "-payload_type",
      "97",
      `rtp://127.0.0.1:${options.audioRtpPort}?pkt_size=1200`,
    ];

    const record: ActiveFallback = {
      options,
      process: null,
      stopping: false,
      lastProgress: Date.now(),
    };
    this.fallbacks.set(options.slug, record);

    let settled = false;
    const restart = () => {
      if (settled) return;
      settled = true;
      clearInterval(record.watchdog);
      record.process = null;
      if (record.stopping || this.fallbacks.get(options.slug) !== record) return;
      record.restartTimer = setTimeout(() => {
        if (record.stopping || this.fallbacks.get(options.slug) !== record) return;
        this.fallbacks.delete(options.slug);
        this.startFallback(options);
      }, this.runtime.restartMs ?? 2_000);
      record.restartTimer.unref();
    };
    try {
      const proc = spawn(
        this.runtime.command ?? "ffmpeg",
        [...(this.runtime.args ?? []), ...fallbackArgs],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      record.process = proc;
      let progress = "";
      let lastFrame = -1;
      proc.stdout?.on("data", (chunk: Buffer) => {
        progress = (progress + chunk.toString()).slice(-8192);
        const lines = progress.split("\n");
        progress = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("frame=")) continue;
          const frame = Number(line.slice(6).trim());
          if (Number.isFinite(frame) && frame > lastFrame) {
            lastFrame = frame;
            record.lastProgress = Date.now();
          }
        }
      });
      proc.stderr?.resume();
      // spawn failures emit error asynchronously; they must never terminate the add-on.
      proc.once("error", restart);
      proc.once("close", restart);
      record.watchdog = setInterval(() => {
        if (record.stopping || Date.now() - record.lastProgress < (this.runtime.stallMs ?? 15_000))
          return;
        proc.kill("SIGKILL"); // Only the disposable offline encoder, not MQTT/HTTP/native outputs.
      }, this.runtime.watchdogMs ?? 5_000);
      record.watchdog.unref();
    } catch {
      restart();
    }
  }

  public stopFallback(slug: string): void {
    const record = this.fallbacks.get(slug);
    if (!record) return;
    record.stopping = true;
    clearInterval(record.watchdog);
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
      record.restartTimer = undefined;
    }
    if (record.process) {
      try {
        record.process.kill("SIGTERM");
      } catch {}
      const proc = record.process;
      setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        } catch {}
      }, 1000).unref();
      record.process = null;
    }
    this.fallbacks.delete(slug);
    console.log(`📺 [FallbackStream:${record.options.deviceName}] Stopped offline fallback stream`);
  }

  public stopAll(): void {
    for (const slug of Array.from(this.fallbacks.keys())) {
      this.stopFallback(slug);
    }
  }
}
