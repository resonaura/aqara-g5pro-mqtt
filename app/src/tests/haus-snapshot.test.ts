import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameHTTPServer } from "../http-server.js";

test("Haus endpoint returns only the real cache and preserves capture age independently of Offline cards", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aqara-haus-frame-"));
  const server = new FrameHTTPServer(directory, 9850);
  t.after(() => {
    server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  server.registerHausCamera("garden", "rtsp://192.168.4.44:8590/live/garden");
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(join(directory, "garden.jpg"), "generated Offline placeholder");
  assert.equal((await fetch(base + "/api/cameras/garden/snapshot/last-live")).status, 404);
  const image = Buffer.from([255, 216, 1, 2, 255, 217]);
  const file = join(directory, "garden.haus_live.jpg");
  writeFileSync(file, image);
  utimesSync(file, 10, 10);
  const response = await fetch(base + "/api/cameras/garden/snapshot/last-live");
  assert.equal(response.headers.get("x-haus-snapshot-provider"), "aqara");
  assert.equal(response.headers.get("x-haus-snapshot-stale"), "1");
  assert.equal(Number(response.headers.get("x-haus-snapshot-captured-at")), 10000);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  const manifest = (await fetch(base + "/api/haus/cameras").then((response) =>
    response.json(),
  )) as { cameras: { stream: { port: number; path: string } }[] };
  assert.deepEqual(manifest.cameras[0].stream, {
    protocol: "rtsp:",
    port: 8590,
    path: "/live/garden",
  });
  assert.equal(JSON.stringify(manifest).includes("password"), false);
});
