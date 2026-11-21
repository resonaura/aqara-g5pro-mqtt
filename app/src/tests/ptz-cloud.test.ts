import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudPTZController,
  E1_PTZ_PAN_MAX,
  E1_PTZ_PAN_MIN,
  E1_PTZ_TILT_MAX,
  E1_PTZ_TILT_MIN,
  formatCloudPtzPayload,
  parseCloudPtzPosition,
  stepCloudPtzPosition,
  usesCloudPtzPosition,
} from "../ptz-cloud.js";

test("usesCloudPtzPosition selects Camera E1 (acn006 & acn007) and leaves G3/G350/G5 on P2P", () => {
  assert.equal(usesCloudPtzPosition("lumi.camera.acn006"), true);
  assert.equal(usesCloudPtzPosition("LUMI.CAMERA.ACN006"), true);
  assert.equal(usesCloudPtzPosition("lumi.camera.acn007"), true);
  assert.equal(usesCloudPtzPosition("lumi.camera.gwpgl1"), false);
  assert.equal(usesCloudPtzPosition("lumi.camera.agl010"), false);
  assert.equal(usesCloudPtzPosition("lumi.camera.agl004"), false);
});

test("parseCloudPtzPosition parses and clamps Aqara ptz_position payloads", () => {
  assert.deepEqual(
    parseCloudPtzPosition('{"x":-160, "y":-8, "x_dir":2, "y_dir":1, "step_x":-128, "step_y":-7}'),
    { x: -160, y: -8 },
  );
  assert.deepEqual(parseCloudPtzPosition({ x: 999, y: -999 }), {
    x: E1_PTZ_PAN_MAX,
    y: E1_PTZ_TILT_MIN,
  });
  assert.equal(parseCloudPtzPosition("not-json"), null);
  assert.equal(parseCloudPtzPosition(undefined), null);
});

test("stepCloudPtzPosition applies E1 pan/tilt sign conventions and clamps to firmware bounds", () => {
  assert.deepEqual(stepCloudPtzPosition({ x: 0, y: 0 }, "left", 20, 10), { x: 20, y: 0 });
  assert.deepEqual(stepCloudPtzPosition({ x: 0, y: 0 }, "right", 20, 10), { x: -20, y: 0 });
  assert.deepEqual(stepCloudPtzPosition({ x: 0, y: 0 }, "up", 20, 10), { x: 0, y: 10 });
  assert.deepEqual(stepCloudPtzPosition({ x: 0, y: 0 }, "down", 20, 10), { x: 0, y: -10 });

  assert.deepEqual(stepCloudPtzPosition({ x: 170, y: 50 }, "left", 20, 10), {
    x: E1_PTZ_PAN_MAX,
    y: 50,
  });
  assert.deepEqual(stepCloudPtzPosition({ x: -170, y: 50 }, "right", 20, 10), {
    x: E1_PTZ_PAN_MIN,
    y: 50,
  });
  assert.deepEqual(stepCloudPtzPosition({ x: 0, y: 50 }, "up", 20, 10), {
    x: 0,
    y: E1_PTZ_TILT_MAX,
  });
  assert.deepEqual(stepCloudPtzPosition({ x: 0, y: -12 }, "down", 20, 10), {
    x: 0,
    y: E1_PTZ_TILT_MIN,
  });
});

test("formatCloudPtzPayload omits x_dir/y_dir so motor_cruise performs a direct single-axis move", () => {
  assert.equal(formatCloudPtzPayload({ x: -145, y: 2 }), '{"x":-145,"y":2}');
});

test("CloudPTZController serializes rapid nudges, enforces hardware cooldown, and rejects continuous actions", async () => {
  let clock = 10_000;
  let queries = 0;
  const sleeps: number[] = [];
  const writes: Array<{ attr: string; value: string; did: string }> = [];

  const controller = new CloudPTZController(
    {
      queryAttrs: async () => {
        queries++;
        return {
          code: 0,
          message: "Success",
          result: [
            {
              attr: "ptz_position",
              value: JSON.stringify({ x: -100, y: 0, x_dir: 2, y_dir: 2 }),
              timeStamp: clock,
            },
          ],
        };
      },
      writeAttr: async (attr, value, subjectId) => {
        writes.push({ attr, value: String(value), did: subjectId });
      },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
    { panStep: 10, tiltStep: 5, cacheTtlMs: 5_000, minIntervalMs: 250 },
  );

  // Continuous motion is rejected
  const invalid = await controller.move("lumi.e1", "left_always");
  assert.deepEqual(invalid, { moved: false, reason: "invalid_direction" });
  assert.equal(writes.length, 0);

  // Two rapid left nudges + one up nudge serialize cleanly from cached position
  const [r1, r2, r3] = await Promise.all([
    controller.move("lumi.e1", "left"),
    controller.move("lumi.e1", "left"),
    controller.move("lumi.e1", "up"),
  ]);

  assert.equal(queries, 1);
  assert.deepEqual(r1, { moved: true, position: { x: -90, y: 0 } });
  assert.deepEqual(r2, { moved: true, position: { x: -80, y: 0 } });
  assert.deepEqual(r3, { moved: true, position: { x: -80, y: 5 } });
  assert.deepEqual(sleeps, [250, 250]);
  assert.deepEqual(
    writes.map((w) => w.value),
    ['{"x":-90,"y":0}', '{"x":-80,"y":0}', '{"x":-80,"y":5}'],
  );

  // Stop clears cache so next move re-queries hardware position
  const stopRes = await controller.move("lumi.e1", "stop");
  assert.deepEqual(stopRes, { moved: false, reason: "bounded_step_noop" });

  clock += 300;
  await controller.move("lumi.e1", "right");
  assert.equal(queries, 2);
  assert.equal(writes.at(-1)?.value, '{"x":-110,"y":0}');
});

test("CloudPTZController returns position_unavailable when camera reports no ptz_position", async () => {
  let writes = 0;
  const controller = new CloudPTZController({
    queryAttrs: async () => ({ code: 0, message: "Success", result: [] }),
    writeAttr: async () => {
      writes++;
    },
  });

  const res = await controller.move("lumi.e1", "left");
  assert.deepEqual(res, { moved: false, reason: "position_unavailable" });
  assert.equal(writes, 0);
});
