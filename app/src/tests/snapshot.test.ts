import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { FrameSnapshotter } from "../snapshot.js";

test("native snapshots decode a real keyframe and a transient capture failure preserves the exact last JPEG", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "aqara-snapshot-"));
  const frame = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=1",
    "-frames:v",
    "1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-f",
    "h264",
    "pipe:1",
  ]);
  let called = false;
  const options = {
    slug: "fixture",
    did: "fixture",
    dataDir,
    intervalMs: 60000,
    rtspUrl: "rtsp://127.0.0.1:1/unreachable",
  };
  const snapshot = new FrameSnapshotter({
    ...options,
    getSnapshot: async (did) => {
      called = true;
      assert.equal(did, "fixture");
      return frame.toString("base64");
    },
  });
  let failure: FrameSnapshotter | undefined;
  try {
    const ready = once(snapshot, "frame", { signal: AbortSignal.timeout(6000) });
    snapshot.start();
    await ready;
    snapshot.stop();
    assert.equal(called, true);
    assert.equal(snapshot.failureCount, 0);
    const image = readFileSync(snapshot.filePath);
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
    assert.ok(image.length > 1000);
    failure = new FrameSnapshotter({ ...options, getSnapshot: async () => "" });
    const failed = once(failure, "failed", { signal: AbortSignal.timeout(6000) });
    failure.start();
    await failed;
    failure.stop();
    assert.equal(failure.failureCount, 1);
    assert.deepEqual(readFileSync(snapshot.filePath), image);
  } finally {
    snapshot.stop();
    failure?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
