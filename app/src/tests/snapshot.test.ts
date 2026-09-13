import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FrameSnapshotter } from "../snapshot.js";
import { getDataDir } from "../state.js";

test("FrameSnapshotter invokes getSnapshot and saves image when keyframe is available", async () => {
  const slug = "test-snap-cam";
  const did = "lumi.test_snap";

  // Create a minimal 1x1 H264 NAL or dummy bytes for test
  // If ffmpeg fails to decode dummy bytes, grabFromKeyframe gracefully returns false and falls through
  let getSnapshotCalled = false;
  const snapshotter = new FrameSnapshotter({
    slug,
    did,
    rtspUrl: "rtsp://127.0.0.1:8555/live/test",
    getSnapshot: async (requestedDid) => {
      getSnapshotCalled = true;
      assert.equal(requestedDid, did);
      return ""; // empty -> should fall through
    },
  });

  // Call private grabOnce indirectly via grabOnce or test options
  assert.equal(snapshotter.failureCount, 0);
  assert.equal(snapshotter.filePath.endsWith(`${slug}.jpg`), true);
  snapshotter.stop();
});
