import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AqaraCameraBridge } from "../bridge.js";
import { NativeMediaEngine } from "../native-engine.js";

test("snapshot cache misses cannot reconnect a flowing P2P bridge; actual session errors still recover", async () => {
  const fake = new EventEmitter() as any;
  let starts = 0,
    stops = 0;
  fake.ensureOutput = () => {};
  fake.startP2P = () => starts++;
  fake.stopP2P = () => stops++;
  const original = (NativeMediaEngine as any).instance;
  (NativeMediaEngine as any).instance = fake;
  const bridge = new AqaraCameraBridge({ did: "lumi.fixture", token: "fixture" });
  bridge.initCloudSession = async () => ({ appPub: "fixture", sign: "fixture" });
  let unhealthy = 0,
    warnings = 0,
    frames = 0;
  bridge.on("unhealthy", () => unhealthy++);
  bridge.on("warn", () => warnings++);
  bridge.on("keyframe", () => frames++);
  try {
    await bridge.connect();
    fake.emit("keyframe", "lumi.fixture", "h264");
    for (let i = 0; i < 5; i++)
      fake.emit("error", {
        did: "lumi.fixture",
        message: "snapshot annexb not ready",
        operation: "snapshot",
      });
    fake.emit("keyframe", "lumi.fixture", "h264");
    assert.equal(unhealthy, 0);
    assert.equal(warnings, 5);
    assert.equal(starts, 1);
    assert.equal(stops, 0);
    assert.equal(frames, 2);
    fake.emit("error", { did: "another-camera", message: "session failed" });
    assert.equal(unhealthy, 0);
    fake.emit("error", { did: "lumi.fixture", message: "Failed to start session" });
    assert.equal(unhealthy, 1);
    fake.emit("unhealthy", "lumi.fixture");
    assert.equal(unhealthy, 2);
  } finally {
    bridge.stop();
    (NativeMediaEngine as any).instance = original;
  }
});
