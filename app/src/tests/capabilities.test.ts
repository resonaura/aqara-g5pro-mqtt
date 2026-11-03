import assert from "node:assert/strict";
import test from "node:test";
import { checkDeviceCapabilities } from "../aqara.js";
import type { AqaraResponse } from "../types.js";

test("E1 has no spotlight even when generic cloud light attributes could be returned", async () => {
  let queries = 0;
  const query = async () => {
    queries++;
    return {
      result: [
        { attr: "white_light_enable", value: "0" },
        { attr: "white_light_level", value: "100" },
      ],
    } as unknown as AqaraResponse;
  };
  assert.deepEqual(
    await checkDeviceCapabilities("not-a-real-camera", "lumi.camera.acn003", query),
    { hasSpotlight: false },
  );
  assert.equal(queries, 0);
  assert.deepEqual(
    await checkDeviceCapabilities("not-a-real-camera", "lumi.camera.agl004", query),
    { hasSpotlight: true },
  );
  assert.equal(queries, 1);
});
