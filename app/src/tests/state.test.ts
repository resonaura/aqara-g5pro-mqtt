import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAppState,
  getCameraState,
  setCameraState,
  getGlobalState,
  setGlobalState,
  loadP2PState,
  saveP2PState,
} from "../state.js";
import { closeDatabase } from "../db/data-source.js";

test("extensible state manager persists camera and global states with SQLite TypeORM", async () => {
  const didA = `cam_a_${Date.now()}`;
  const didB = `cam_b_${Date.now()}`;

  // Test concurrent updates across different keys and cameras
  await Promise.all([
    setCameraState(didA, { p2p_stream: true, quality_channel: 3, spotlight_brightness: 80 }),
    setCameraState(didB, { p2p_stream: false, motion_enabled: true }),
    setGlobalState("last_discovery_time", 123456789),
    saveP2PState({ cameras: { [didA]: { p2p_stream: true } } }),
  ]);

  const camA = await getCameraState(didA);
  assert.equal(camA.p2p_stream, true);
  assert.equal(camA.quality_channel, 3);
  assert.equal(camA.spotlight_brightness, 80);

  const camB = await getCameraState(didB);
  assert.equal(camB.p2p_stream, false);
  assert.equal(camB.motion_enabled, true);

  const globalTime = await getGlobalState("last_discovery_time", 0);
  assert.equal(globalTime, 123456789);

  // Test convenience helpers
  const p2pMap = await loadP2PState();
  assert.equal(p2pMap[didA], true);
  assert.equal(p2pMap[didB], false);

  await saveP2PState({ cameras: { [didA]: { p2p_stream: false } } });
  const updatedP2p = await loadP2PState();
  assert.equal(updatedP2p[didA], false);

  const fullState = await loadAppState();
  assert.equal(fullState.version, 1);
  assert.ok(fullState.updatedAt > 0);
  assert.ok(fullState.cameras[didA]);
  assert.ok(fullState.cameras[didB]);

  await closeDatabase();
});
