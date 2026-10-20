import test from "node:test";
import assert from "node:assert/strict";
import { RecoveryGrace } from "../recovery-grace.js";

test("transient recovery retains the last frame and cancels offline on progress", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const grace = new RecoveryGrace();
  let offline = 0;
  grace.defer("garden", Date.now(), () => offline++);
  t.mock.timers.tick(29_999);
  assert.equal(offline, 0);
  grace.cancel("garden");
  t.mock.timers.tick(30_000);
  assert.equal(offline, 0);
});

test("retries update the message without restarting the 30 second deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const grace = new RecoveryGrace();
  const messages: string[] = [];
  grace.defer("garden", Date.now() - 10_000, () => messages.push("first"));
  t.mock.timers.tick(15_000);
  grace.defer("garden", Date.now(), () => messages.push("retry"));
  t.mock.timers.tick(4_999);
  assert.deepEqual(messages, []);
  t.mock.timers.tick(1);
  assert.deepEqual(messages, ["retry"]);
  t.mock.timers.tick(60_000);
  assert.equal(messages.length, 1);
});

test("cameras have independent grace periods, including startup and shutdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const grace = new RecoveryGrace();
  const offline: string[] = [];
  grace.defer("already-stalled", Date.now() - 40_000, () => offline.push("stalled"));
  grace.defer("starting", undefined, () => offline.push("starting"));
  t.mock.timers.tick(1);
  assert.deepEqual(offline, ["stalled"]);
  grace.clear();
  t.mock.timers.tick(60_000);
  assert.deepEqual(offline, ["stalled"]);
});
