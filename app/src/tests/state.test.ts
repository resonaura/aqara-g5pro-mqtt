import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAppState,
  updateAppState,
  getCameraState,
  setCameraState,
  getGlobalState,
  setGlobalState,
  loadP2pState,
  saveP2pState,
} from "../state.js";

test("extensible state manager persists camera and global states with concurrent safety", async () => {
  const didA = `cam_a_${Date.now()}`;
  const didB = `cam_b_${Date.now()}`;

  // Test concurrent updates across different keys and cameras
  await Promise.all([
    setCameraState(didA, { p2p_stream: true, quality_channel: 3, spotlight_brightness: 80 }),
    setCameraState(didB, { p2p_stream: false, motion_enabled: true }),
    setGlobalState("last_discovery_time", 123456789),
    saveP2pState(didA, true),
  ]);

  const camA = getCameraState(didA);
  assert.equal(camA.p2p_stream, true);
  assert.equal(camA.quality_channel, 3);
  assert.equal(camA.spotlight_brightness, 80);

  const camB = getCameraState(didB);
  assert.equal(camB.p2p_stream, false);
  assert.equal(camB.motion_enabled, true);

  assert.equal(getGlobalState("last_discovery_time", 0), 123456789);

  // Test convenience helpers
  const p2pMap = loadP2pState();
  assert.equal(p2pMap[didA], true);
  assert.equal(p2pMap[didB], false);

  await saveP2pState(didA, false);
  assert.equal(loadP2pState()[didA], false);

  const fullState = loadAppState();
  assert.equal(fullState.version, 1);
  assert.ok(fullState.updatedAt > 0);
});
