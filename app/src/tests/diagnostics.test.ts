import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DiagnosticJournal, redactDiagnostic, cameraDiagnosticId } from "../diagnostics.js";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "aqara-diagnostics-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("diagnostics remove private URLs, credentials and addresses without losing media counters", async () => {
  await temporary(async (directory) => {
    const journal = new DiagnosticJournal(directory);
    journal.record("camera.health", {
      camera: cameraDiagnosticId("private-device"),
      video_frames: 123,
      audio_frames: 98,
      token: "private-token",
      video_key_hex: "private-key",
      nested: { password: "private-password" },
      message:
        "rtsp://user:secret@192.168.1.10/private?key=hidden Bearer jwt-secret 10.2.3.4:8554 [fe80::1234] token=raw-secret",
    });
    await journal.flush();
    const raw = await readFile(path.join(directory, "events.jsonl"), "utf8");
    for (const secret of [
      "private-device",
      "private-token",
      "private-key",
      "private-password",
      "user:secret",
      "192.168",
      "jwt-secret",
      "10.2.3.4",
      "fe80::1234",
      "raw-secret",
    ])
      assert.ok(!raw.includes(secret), secret);
    const quoted = redactDiagnostic(
      `AQARA_PASS='two words private' cookie="session=abc private; next=def" api_secret=private-secret`,
    );
    for (const secret of ["two words", "private", "session=abc", "next=def"])
      assert.ok(!quoted.includes(secret));
    const entry = JSON.parse(raw);
    assert.equal(entry.fields.video_frames, 123);
    assert.equal(entry.fields.audio_frames, 98);
    assert.equal((await stat(path.join(directory, "events.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.ok(redactDiagnostic("2026-10-20T12:30:14.000Z frames=100").includes("12:30:14"));
  });
});

test("journal rotates, survives a new process session, and bounds a flooded producer", async () => {
  await temporary(async (directory) => {
    const first = new DiagnosticJournal(directory, 2048, 3);
    for (let i = 0; i < 50; i++) {
      first.record("fixture", { index: i, value: "x".repeat(600) });
      await first.flush();
    }
    let files = await readdir(directory);
    assert.equal(files.filter((file) => file.startsWith("events.jsonl")).length, 3);
    const second = new DiagnosticJournal(directory, 2048, 3);
    second.record("next.boot");
    await second.flush();
    const entries = (await readFile(path.join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.at(-1).event, "next.boot");
    assert.notEqual(first.boot, entries.at(-1).boot);
    for (let i = 0; i < 10_000; i++) second.record("flood", { i });
    await second.flush();
    files = await readdir(directory);
    const reports = await Promise.all(
      files.map((file) => readFile(path.join(directory, file), "utf8")),
    );
    assert.ok(reports.some((report) => report.includes("diagnostics.dropped")));
    assert.ok(reports.join("").length < 40_000, "flood cannot grow the disk/queue without bound");
  });
});

test("a fatal exception persists its redacted final event without suppressing the crash", async () => {
  await temporary(async (directory) => {
    const moduleUrl = new URL("../diagnostics.ts", import.meta.url).href;
    const script = `import {DiagnosticJournal} from ${JSON.stringify(moduleUrl)}; const j = new DiagnosticJournal(${JSON.stringify(directory)}); process.on('uncaughtExceptionMonitor',(error,origin)=>j.crash(error,origin)); throw new Error('rtsp://user:private-secret@10.0.0.1/live token=private-token');`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(child.status, 0);
    const raw = await readFile(path.join(directory, "crash.json"), "utf8");
    assert.equal(JSON.parse(raw).event, "app.crash");
    assert.ok(
      !raw.includes("private-secret") &&
        !raw.includes("private-token") &&
        !raw.includes("10.0.0.1"),
    );
    assert.equal((await stat(path.join(directory, "crash.json"))).mode & 0o777, 0o600);
  });
});

test("an unwritable journal cannot stop camera processing or reject flush", async () => {
  await temporary(async (directory) => {
    const obstruction = path.join(directory, "file");
    await writeFile(obstruction, "keep");
    const journal = new DiagnosticJournal(obstruction);
    journal.record("camera.running");
    await assert.doesNotReject(journal.flush());
    assert.equal(await readFile(obstruction, "utf8"), "keep");
  });
});

test("native telemetry uses a field allowlist and native stderr is sanitized before persistence", async () => {
  await temporary(async (directory) => {
    const { diagnostics } = await import("../diagnostics.js");
    const { NativeMediaEngine } = await import("../native-engine.js");
    const journal = diagnostics.start(directory);
    const restore = journal.captureConsole();
    const engine = new NativeMediaEngine({
      command: process.execPath,
      args: [
        "-e",
        `console.error('rtsp://secret:password@10.9.8.7/live token=private-native');console.log(JSON.stringify({event:'media_health', did:'private-camera', video_frames:20,audio_frames:30,missing_packets:12,late_packets:8,max_late_ms:275,max_gap_wait_ms:151,video_key_hex:'private-key',data_base64:'private-media'}));console.log(JSON.stringify({event:'media_recovery',did:'private-camera',action:'restart_stream',video_age_ms:6100,decoded_age_ms:6300,data_base64:'private-media'}));console.log(JSON.stringify({event:'ready'}));setInterval(()=>{},1000);`,
      ],
      killMs: 20,
    });
    try {
      engine.start();
      const deadline = Date.now() + 5000;
      while (!engine.ready && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(engine.ready);
      engine.stop();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await journal.flush();
      const raw = await readFile(path.join(directory, "events.jsonl"), "utf8");
      for (const secret of [
        "private-camera",
        "private-key",
        "private-media",
        "private-native",
        "10.9.8.7",
        "secret:password",
      ])
        assert.ok(!raw.includes(secret), secret);
      const health = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((row) => row.event === "native.media_health");
      assert.equal(health.fields.video_frames, 20);
      assert.equal(health.fields.audio_frames, 30);
      assert.equal(health.fields.missing_packets, 12);
      assert.equal(health.fields.late_packets, 8);
      assert.equal(health.fields.max_late_ms, 275);
      assert.equal(health.fields.max_gap_wait_ms, 151);
      assert.equal(health.fields.camera, cameraDiagnosticId("private-camera"));
      const recovery = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((row) => row.event === "native.media_recovery");
      assert.equal(recovery.fields.action, "restart_stream");
      assert.equal(recovery.fields.video_age_ms, 6100);
      assert.equal(recovery.fields.decoded_age_ms, 6300);
      assert.equal(recovery.fields.camera, cameraDiagnosticId("private-camera"));
    } finally {
      engine.stop();
      restore();
    }
  });
});
