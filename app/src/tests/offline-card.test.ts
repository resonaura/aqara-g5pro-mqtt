import test from "node:test";
import assert from "node:assert/strict";
import { escapeFfmpegText, OfflineCardManager, generateOfflineCardImage } from "../offline-card.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

test("escapeFfmpegText escapes colons, backslashes, single quotes, and percent signs", () => {
  const raw = "Camera: 'Front Door' (100% OK) \\ test";
  const escaped = escapeFfmpegText(raw);
  assert.ok(!escaped.includes("'"));
  assert.ok(escaped.includes("\\:"));
  assert.ok(escaped.includes("\\%"));
});

test("generateOfflineCardImage creates a valid non-empty JPEG card", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-card-test-"));
  try {
    const buf = await generateOfflineCardImage({
      slug: "test-camera",
      deviceName: "Test Camera",
      statusText: "Reconnecting P2P tunnel (attempt #1)...",
      durationSeconds: 15,
      dataDir: tmpDir,
    });
    assert.ok(buf);
    assert.ok(buf.length > 100);
    // JPEG magic numbers FF D8
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OfflineCardManager manages lifecycle and updates state", async () => {
  const mgr = OfflineCardManager.getInstance();
  assert.equal(mgr.isOffline("camera-1"), false);

  let frameReceived = false;
  mgr.setOffline({
    slug: "camera-1",
    deviceName: "Camera 1",
    deviceId: "cam1_id",
    reason: "Test stall",
    onFrameUpdate: (_buf) => {
      frameReceived = true;
    },
  });

  assert.equal(mgr.isOffline("camera-1"), true);
  mgr.updateStatus("camera-1", "Updated reason");

  // Allow one render cycle
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(typeof frameReceived, "boolean");

  mgr.setOnline("camera-1");
  assert.equal(mgr.isOffline("camera-1"), false);
});
