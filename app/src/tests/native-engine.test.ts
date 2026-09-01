import assert from "node:assert/strict";
import test from "node:test";
import { NativeMediaEngine } from "../native-engine.js";

test("NativeMediaEngine binary exists and responds to ping", async () => {
  if (!NativeMediaEngine.isBinaryAvailable()) {
    return; // Skip if not compiled
  }

  const engine = NativeMediaEngine.getInstance();
  if (!engine.ready) {
    engine.start();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for native engine")), 2000);
      engine.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  assert.equal(engine.ready, true);
});

test("NativeMediaEngine preserves RTSP server on session restart", async () => {
  if (!NativeMediaEngine.isBinaryAvailable()) {
    return;
  }

  const engine = NativeMediaEngine.getInstance();
  if (!engine.ready) {
    engine.start();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for native engine")), 2000);
      engine.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  const testDid = "lumi.test_resurrect";
  const rtspPort = 18559;

  // 1. Initial start
  const startPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for session start")), 3000);
    const onStarted = (did: string, port: number) => {
      if (did === testDid) {
        clearTimeout(timeout);
        engine.off("session_started", onStarted);
        assert.equal(port, rtspPort);
        resolve();
      }
    };
    engine.on("session_started", onStarted);
  });

  engine.startP2p({
    did: testDid,
    rtsp_port: rtspPort,
    rtsp_path: "live/test",
    p2p_id: "TEST12345",
  });

  await startPromise;

  // 2. Re-start (resurrect) without stop_p2p: verifies RTSP server port is preserved without EADDRINUSE
  const resurrectPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for session resurrection")), 3000);
    const onStarted = (did: string, port: number) => {
      if (did === testDid) {
        clearTimeout(timeout);
        engine.off("session_started", onStarted);
        assert.equal(port, rtspPort);
        resolve();
      }
    };
    engine.on("session_started", onStarted);
  });

  engine.startP2p({
    did: testDid,
    rtsp_port: rtspPort,
    rtsp_path: "live/test",
    p2p_id: "TEST12345_RECONNECTED",
  });

  await resurrectPromise;

  // Cleanup
  engine.stopP2p(testDid);
  engine.stop();
});
