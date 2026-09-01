/**
 * OfflineCardGenerator — generates a sleek HUD placeholder card when a camera is offline.
 *
 * Features:
 * - Gaussian-blurred background from the last known valid snapshot (/data/frames/<slug>.last_live.jpg).
 * - Fallback dark gradient canvas if no previous snapshot exists.
 * - Dynamic HUD overlay showing:
 *     ● Camera Name & Offline/Reconnecting Status
 *     ● Active action (e.g. "Reconnecting P2P tunnel (attempt #2)...")
 *     ● Live seconds ticker ("Offline for: 14s")
 *     ● Timestamp
 * - Periodically updates /data/frames/<slug>.jpg and publishes the frame to MQTT.
 */

import { spawn } from "node:child_process";
import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "./state.js";

export interface OfflineCardOptions {
  slug: string;
  deviceName: string;
  reason?: string;
  startedAt?: number;
  dataDir?: string;
}

export function escapeFfmpegText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

export async function generateOfflineCardImage(options: {
  slug: string;
  deviceName: string;
  statusText: string;
  durationSeconds: number;
  dataDir?: string;
}): Promise<Buffer | null> {
  const dataDir = options.dataDir || getDataDir();
  const framesDir = path.join(dataDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });

  const lastLivePath = path.join(framesDir, `${options.slug}.last_live.jpg`);
  const outputPath = path.join(framesDir, `${options.slug}.jpg`);
  const tempPath = path.join(framesDir, `${options.slug}.offline.tmp.jpg`);

  const hasLastLive = existsSync(lastLivePath) && statSync(lastLivePath).size > 0;

  const escName = escapeFfmpegText(options.deviceName);
  const escStatus = escapeFfmpegText(options.statusText || "Reconnecting P2P tunnel...");
  const escTitle = `● ${escName} (OFFLINE)`;
  const escTimer = escapeFfmpegText(`Offline for ${options.durationSeconds}s`);
  const escTime = escapeFfmpegText(new Date().toLocaleTimeString());

  let args: string[];

  if (hasLastLive) {
    const filter = [
      "gblur=sigma=22:steps=2",
      "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill",
      "drawbox=x=(iw-720)/2:y=(ih-250)/2:w=720:h=250:color=black@0.75:t=fill",
      `drawtext=text='${escTitle}':fontcolor=red:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2-65`,
      `drawtext=text='${escStatus}':fontcolor=white:fontsize=22:x=(w-text_w)/2:y=(h-text_h)/2-10`,
      `drawtext=text='${escTimer}':fontcolor=yellow:fontsize=18:x=(w-text_w)/2:y=(h-text_h)/2+40`,
      `drawtext=text='${escTime}':fontcolor=gray:fontsize=14:x=(w-text_w)/2:y=(h-text_h)/2+75`,
    ].join(",");

    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      lastLivePath,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-update",
      "1",
      tempPath,
    ];
  } else {
    const filter = [
      "drawbox=x=(iw-720)/2:y=(ih-250)/2:w=720:h=250:color=black@0.75:t=fill",
      `drawtext=text='${escTitle}':fontcolor=red:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2-65`,
      `drawtext=text='${escStatus}':fontcolor=white:fontsize=22:x=(w-text_w)/2:y=(h-text_h)/2-10`,
      `drawtext=text='${escTimer}':fontcolor=yellow:fontsize=18:x=(w-text_w)/2:y=(h-text_h)/2+40`,
      `drawtext=text='${escTime}':fontcolor=gray:fontsize=14:x=(w-text_w)/2:y=(h-text_h)/2+75`,
    ].join(",");

    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x181825:s=1280x720:d=1",
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-update",
      "1",
      tempPath,
    ];
  }

  return new Promise((resolve) => {
    let proc: any;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve(null);
    }, 4000);
    timer.unref();

    proc.on("exit", async (code: number) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(tempPath)) {
        try {
          await fs.rename(tempPath, outputPath);
          const buf = await fs.readFile(outputPath);
          resolve(buf);
          return;
        } catch {}
      }
      resolve(null);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export class OfflineCardManager {
  private static instance: OfflineCardManager | null = null;
  private offlineStates = new Map<
    string,
    {
      slug: string;
      deviceName: string;
      deviceId: string;
      reason: string;
      startedAt: number;
      timer: NodeJS.Timeout | null;
      onFrameUpdate?: (buf: Buffer) => void;
    }
  >();

  public static getInstance(): OfflineCardManager {
    if (!OfflineCardManager.instance) {
      OfflineCardManager.instance = new OfflineCardManager();
    }
    return OfflineCardManager.instance;
  }

  public isOffline(slug: string): boolean {
    return this.offlineStates.has(slug);
  }

  public setOffline(options: {
    slug: string;
    deviceName: string;
    deviceId: string;
    reason: string;
    onFrameUpdate?: (buf: Buffer) => void;
  }): void {
    const existing = this.offlineStates.get(options.slug);
    const startedAt = existing ? existing.startedAt : Date.now();

    if (existing?.timer) {
      clearInterval(existing.timer);
    }

    const state = {
      slug: options.slug,
      deviceName: options.deviceName,
      deviceId: options.deviceId,
      reason: options.reason,
      startedAt,
      timer: null as NodeJS.Timeout | null,
      onFrameUpdate: options.onFrameUpdate ?? existing?.onFrameUpdate,
    };

    const render = async () => {
      const durationSeconds = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
      const buf = await generateOfflineCardImage({
        slug: state.slug,
        deviceName: state.deviceName,
        statusText: state.reason,
        durationSeconds,
      });
      if (buf && state.onFrameUpdate) {
        state.onFrameUpdate(buf);
      }
    };

    void render();
    state.timer = setInterval(render, 2500);
    state.timer.unref();
    this.offlineStates.set(options.slug, state);
  }

  public updateStatus(slug: string, reason: string): void {
    const state = this.offlineStates.get(slug);
    if (state) {
      state.reason = reason;
    }
  }

  public setOnline(slug: string): void {
    const state = this.offlineStates.get(slug);
    if (state) {
      if (state.timer) {
        clearInterval(state.timer);
      }
      this.offlineStates.delete(slug);
    }
  }
}
