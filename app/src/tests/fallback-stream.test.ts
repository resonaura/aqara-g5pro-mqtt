import test from "node:test";
import assert from "node:assert/strict";
import { FallbackStreamManager } from "../fallback-stream.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

test("FallbackStreamManager manages fallback video stream lifecycle", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-test-"));
  const mgr = FallbackStreamManager.getInstance();

  try {
    assert.equal(mgr.isRunning("test-cam"), false);

    mgr.startFallback({
      slug: "test-cam",
      deviceName: "Test Camera",
      rtpPort: 19555,
      audioRtpPort: 19556,
      dataDir: tmpDir,
    });

    // Give child process moment to spawn
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mgr.isRunning("test-cam"), true);

    // Calling startFallback again should be idempotent
    mgr.startFallback({
      slug: "test-cam",
      deviceName: "Test Camera",
      rtpPort: 19555,
      audioRtpPort: 19556,
      dataDir: tmpDir,
    });
    assert.equal(mgr.isRunning("test-cam"), true);

    mgr.stopFallback("test-cam");
    assert.equal(mgr.isRunning("test-cam"), false);
  } finally {
    mgr.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("missing encoder does not crash the add-on or resurrect after stop", async () => {
  const mgr = new FallbackStreamManager({
    command: "/nonexistent/aqara-encoder-fixture",
    restartMs: 20,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-missing-"));
  try {
    mgr.startFallback({
      slug: "missing",
      deviceName: "Fixture",
      rtpPort: 19557,
      audioRtpPort: 19558,
      dataDir: dir,
    });
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(mgr.isRunning("missing"), false);
    mgr.stopAll();
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(mgr.isRunning("missing"), false);
  } finally {
    mgr.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
