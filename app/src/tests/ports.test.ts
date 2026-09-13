import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  writeRTSPPortMap,
  readRTSPPortMap,
  findFreePortRange,
  isPortAllowed,
  type RTSPPortEntry,
} from "../ports.js";
import { getDataDir } from "../state.js";

test("isPortAllowed respects bounds and forbidden ranges", () => {
  assert.equal(isPortAllowed(8555), true);
  assert.equal(isPortAllowed(80), false); // well known
  assert.equal(isPortAllowed(3200), false); // 3000-3999 forbidden
  assert.equal(isPortAllowed(5555), false); // 5000-5999 forbidden
  assert.equal(isPortAllowed(10000), false); // > 9999
});

test("writeRTSPPortMap and readRTSPPortMap persist and restore port mappings", () => {
  const testEntries: RTSPPortEntry[] = [
    { did: "lumi1.54ef4477da68", port: 8555, slug: "guinea-pigs" },
    { did: "lumi3.a5e395b63ce5e6de", port: 8556, slug: "outdoor" },
  ];

  writeRTSPPortMap(8555, testEntries);

  const restored = readRTSPPortMap();
  assert.ok(restored, "Port map should be restored from disk");
  assert.equal(restored.base, 8555);
  assert.equal(restored.cameras["lumi1.54ef4477da68"]?.port, 8555);
  assert.equal(restored.cameras["lumi3.a5e395b63ce5e6de"]?.port, 8556);
  assert.equal(restored.cameras["lumi1.54ef4477da68"]?.slug, "guinea-pigs");
  assert.equal(restored.cameras["lumi3.a5e395b63ce5e6de"]?.slug, "outdoor");

  // Cleanup test file
  const filePath = path.join(getDataDir(), "rtsp_ports.json");
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
});

test("findFreePortRange allocates sequential allowed ports", async () => {
  const ports = await findFreePortRange(2, 8555);
  assert.equal(ports.length, 2);
  assert.equal(ports[1], ports[0] + 1);
  assert.ok(ports[0] >= 8555);
});
