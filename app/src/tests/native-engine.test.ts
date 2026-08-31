import assert from "node:assert/strict";
import test from "node:test";
import { NativeMediaEngine } from "../native-engine.js";

test("NativeMediaEngine binary exists and responds to ping", async () => {
  if (!NativeMediaEngine.isBinaryAvailable()) {
    return; // Skip if not compiled
  }

  const engine = NativeMediaEngine.getInstance();
  const started = engine.start();
  assert.equal(started, true);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for native engine")), 2000);
    engine.on("ready", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  engine.stop();
});
