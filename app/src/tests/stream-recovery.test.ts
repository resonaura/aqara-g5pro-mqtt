import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { StreamRecovery } from "../stream-recovery.js";

async function until(predicate: () => boolean, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(5);
  assert.ok(predicate(), "condition did not become true");
}

test("cooldown retains requests and retries until real video arrives", async () => {
  const calls: number[] = [];
  const recovery = new StreamRecovery({
    isEnabled: async () => true,
    recover: async () => {
      calls.push(Date.now());
    },
    baseMs: 45,
    maxMs: 60,
    videoTimeoutMs: 10,
    random: () => 1,
  });
  try {
    recovery.request("initial");
    await until(() => calls.length === 1);
    recovery.request("watchdog during cooldown");
    recovery.request("duplicate watchdog");
    await until(() => calls.length >= 3);
    assert.ok(calls[1] - calls[0] >= 40, "cooldown prevents a reconnect storm");
    recovery.healthy();
    const count = calls.length;
    await delay(100);
    assert.equal(calls.length, count, "valid video cancels the waiting-for-video timer");
  } finally {
    recovery.stop();
  }
});

test("hung dispatch is aborted and retried, while another camera remains independent", async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  let peer = 0;
  const recovery = new StreamRecovery({
    isEnabled: async () => true,
    recover: async (signal) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        await delay(10000, undefined, { signal });
      } finally {
        active--;
      }
    },
    baseMs: 5,
    dispatchTimeoutMs: 20,
  });
  const other = new StreamRecovery({
    isEnabled: async () => true,
    recover: async () => {
      peer++;
    },
  });
  try {
    recovery.request("unresponsive cloud");
    other.request("peer");
    await until(() => calls >= 3 && peer === 1);
    assert.equal(peak, 1);
  } finally {
    recovery.stop();
    other.stop();
  }
});

test("manual OFF cancels in-flight auth and all scheduled retries", async () => {
  let entered = false;
  let lateStarts = 0;
  const recovery = new StreamRecovery({
    isEnabled: async () => true,
    recover: async (signal) => {
      entered = true;
      await delay(30, undefined, { signal });
      signal.throwIfAborted();
      lateStarts++;
    },
    baseMs: 5,
  });
  recovery.request("ON");
  await until(() => entered);
  recovery.stop();
  recovery.request("late unhealthy signal");
  await delay(80);
  assert.equal(lateStarts, 0);
});

test("disabled streams do not enter a retry loop", async () => {
  let checks = 0;
  const recovery = new StreamRecovery({
    isEnabled: async () => {
      checks++;
      return false;
    },
    recover: async () => {
      assert.fail("disabled camera must not start");
    },
  });
  try {
    recovery.request("stale request");
    await delay(70);
    assert.equal(checks, 1);
  } finally {
    recovery.stop();
  }
});
