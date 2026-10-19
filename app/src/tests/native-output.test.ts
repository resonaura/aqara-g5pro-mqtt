import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { NativeMediaEngine } from "../native-engine.js";
import { FallbackStreamManager } from "../fallback-stream.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function decodeFrames(url: string): Promise<void> {
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-i",
      url,
      "-an",
      "-frames:v",
      "2",
      "-f",
      "null",
      "-",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-3000);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, errors);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

async function options(port: number): Promise<void> {
  const socket = connect(port, "127.0.0.1");
  socket.setTimeout(2000, () => socket.destroy(new Error("RTSP timeout")));
  try {
    await once(socket, "connect");
    socket.write(`OPTIONS rtsp://127.0.0.1:${port}/live/fixture RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
    const [response] = await once(socket, "data");
    assert.match(response.toString(), /RTSP\/1.0 200/);
  } finally {
    socket.destroy();
  }
}

test("offline RTSP outputs start without cloud auth and decode both H264 and HEVC fallback video", async (t) => {
  const engine = new NativeMediaEngine();
  const fallback = new FallbackStreamManager();
  const dir = mkdtempSync(path.join(tmpdir(), "aqara-output-"));
  try {
    engine.start();
    if (!engine.ready) await once(engine, "ready");
    for (const [index, codec] of ["h264", "hevc"].entries()) {
      await t.test(codec, async () => {
        const port = 18661 + index;
        const video = 19761 + index * 4;
        const did = `offline-fixture-${codec}`;
        const started = once(engine, "session_started");
        engine.ensureOutput({
          did,
          rtsp_port: port,
          rtsp_path: "live/fixture",
          udp_video_port: video,
          udp_audio_port: video + 2,
          video_codec: codec as "h264" | "hevc",
        });
        await started;
        await options(port);
        fallback.startFallback({
          slug: did,
          deviceName: "Offline fixture",
          rtpPort: video,
          audioRtpPort: video + 2,
          isHevc: codec === "hevc",
          dataDir: dir,
        });
        await decodeFrames(`rtsp://127.0.0.1:${port}/live/fixture`);
        await options(port); // Readers can disconnect/reconnect while the camera stays offline.
        fallback.stopFallback(did);
        engine.stopP2P(did);
      });
    }
  } finally {
    fallback.stopAll();
    engine.stop();
    await delay(200);
    rmSync(dir, { recursive: true, force: true });
  }
});
