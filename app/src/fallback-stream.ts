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
}

export class FallbackStreamManager {
  private static instance: FallbackStreamManager | null = null;
  private fallbacks = new Map<string, ActiveFallback>();

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
      if (!existing.stopping && existing.process) {
        return; // Already running
      }
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
          "stillimage",
          "-x265-params",
          "keyint=2:no-info=1",
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
          "stillimage",
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
    };
    this.fallbacks.set(options.slug, record);

    try {
      const proc = spawn("ffmpeg", fallbackArgs, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      record.process = proc;

      console.log(
        `📺 [FallbackStream:${options.deviceName}] Streaming offline card to RTSP ingest (127.0.0.1:${options.rtpPort})`,
      );

      proc.stderr?.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg && !msg.includes("frame=") && !msg.includes("fps=")) {
          // Log only non-progress warnings if needed
        }
      });

      proc.once("exit", () => {
        if (record.stopping) return;
        record.process = null;
        // If still registered and not explicitly stopped, restart after 2s
        record.restartTimer = setTimeout(() => {
          if (!record.stopping && this.fallbacks.get(options.slug) === record) {
            this.fallbacks.delete(options.slug);
            this.startFallback(options);
          }
        }, 2000);
        record.restartTimer.unref();
      });
    } catch (err: any) {
      console.error(
        `❌ [FallbackStream:${options.deviceName}] Failed to spawn fallback stream: ${err.message}`,
      );
    }
  }

  public stopFallback(slug: string): void {
    const record = this.fallbacks.get(slug);
    if (!record) return;
    record.stopping = true;
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
          proc.kill("SIGKILL");
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
