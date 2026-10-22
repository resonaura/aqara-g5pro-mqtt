import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeMediaEngine } from "../native-engine.js";

async function until(predicate: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), "worker condition timed out");
}

test("unresponsive media worker is killed; RTSP outputs replay without expired auth or microphone commands", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aqara-worker-"));
  const script = path.join(dir, "worker.cjs");
  const log = path.join(dir, "commands.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    script,
    `
    const fs = require('node:fs');
    const rl = require('node:readline').createInterface({input: process.stdin});
    const countFile = process.argv[2] + '.count';
    const generation = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile)) + 1 : 1;
    fs.writeFileSync(countFile, String(generation));
    console.log(JSON.stringify({event:'ready'}));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    rl.on('line', line => {
      const command = JSON.parse(line);
      fs.appendFileSync(process.argv[2], JSON.stringify({generation, ...command}) + '\\n');
      if(command.cmd === 'ping' && generation > 1) console.log(JSON.stringify({event:'pong'}));
    });
  `,
  );
  const engine = new NativeMediaEngine({
    command: process.execPath,
    args: [script, log],
    heartbeatMs: 20,
    timeoutMs: 1500,
    restartMs: 10,
    killMs: 20,
  });
  let unhealthy = 0;
  engine.on("unhealthy", () => unhealthy++);
  const commands = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    engine.startP2P({ did: "fixture", rtsp_port: 18888, app_sign: "expired-fixture-auth" });
    engine.ptz("fixture", "right"); // Not ready: do not retain a stale move.
    await until(() => engine.ready);
    engine.ptz("fixture", "left");
    engine.ptz("fixture", "left_always"); // Continuous motion is never accepted.
    await until(() => commands().some((c) => c.generation === 2 && c.cmd === "ensure_output"));
    assert.equal(unhealthy, 1);
    assert.deepEqual(
      commands()
        .filter((c) => c.cmd === "ptz")
        .map((c) => [c.generation, c.direction]),
      [[1, "left"]],
    );
    assert.ok(commands().some((c) => c.generation === 1 && c.cmd === "start_p2p"));
    assert.ok(!commands().some((c) => c.generation === 2 && c.cmd === "start_p2p"));
    assert.ok(!commands().some((c) => c.cmd.includes("talkback")));
    await delay(200);
    assert.equal(engine.ready, true, "healthy replacement remains ready after the old child exits");
  } finally {
    engine.stop();
    await delay(100);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping a queued camera cannot resurrect it when the worker becomes ready", async () => {
  const engine = new NativeMediaEngine({
    command: process.execPath,
    args: [
      "-e",
      "setTimeout(() => console.log(JSON.stringify({event:'ready'})), 60);setInterval(() => {}, 1000)",
    ],
    heartbeatMs: 100,
    timeoutMs: 3000,
    killMs: 20,
  });
  try {
    engine.startP2P({ did: "cancelled", rtsp_port: 18889 });
    engine.stopP2P("cancelled");
    await until(() => engine.ready);
    assert.equal((engine as any).outputs.size, 0);
    assert.equal((engine as any).pendingStarts.size, 0);
    await assert.rejects(engine.getSnapshot("cancelled", 30), /timed out/);
  } finally {
    engine.stop();
    await delay(80);
  }
});
