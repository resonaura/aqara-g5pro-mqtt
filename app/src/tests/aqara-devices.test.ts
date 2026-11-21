import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { InternalAxiosRequestConfig } from "axios";
import {
  api,
  DEVICE_QUERY_PAGE_SIZE,
  getCameras,
  getDevices,
  serializeSortedQueryParams,
} from "../aqara.js";

function makeDevice(index: number, model = "lumi.sensor_ht.agl02") {
  return {
    did: `lumi.test.${String(index).padStart(4, "0")}`,
    model,
    deviceName: `Device ${index}`,
    originalName: `Device ${index}`,
    devicetype: 1,
    positionName: "Room",
    categoryNames: [],
    lowBatteryFlag: 0,
    supportHomeKit: 0,
    parentDeviceId: "",
    state: 1,
    usageType: 0,
    real2: "",
    pwdState: 0,
    real1: "",
    layout: 0,
    positionId: "",
    createTime: "0",
  };
}

test("serializeSortedQueryParams sorts keys alphabetically and skips nullish values", () => {
  assert.equal(
    serializeSortedQueryParams({ startIndex: 0, size: 300, ignored: undefined, nil: null }),
    "size=300&startIndex=0",
  );
  assert.equal(serializeSortedQueryParams({ z: "last", a: "first", m: 2 }), "a=first&m=2&z=last");
});

test("GET request interceptor signs alphabetically sorted query params", async () => {
  const prevAdapter = api.defaults.adapter;
  const prevToken = process.env.TOKEN;
  const prevAppId = process.env.APPID;
  process.env.TOKEN = "test-token";
  process.env.APPID = "444c476ef7135e53330f46e7";

  let captured: InternalAxiosRequestConfig | undefined;
  api.defaults.adapter = async (config) => {
    captured = config;
    return {
      data: { code: 0, result: {} },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };

  try {
    await api.get("/app/v1.0/lumi/app/position/device/query", {
      params: { startIndex: 30, size: 100 },
    });

    assert.ok(captured);
    const nonce = String(captured.headers["Nonce"]);
    const time = String(captured.headers["Time"]);
    const expectedSign = crypto
      .createHash("md5")
      .update(
        `Appid=444c476ef7135e53330f46e7&Nonce=${nonce}&Time=${time}&Token=test-token&size=100&startIndex=30&uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi`,
      )
      .digest("hex");
    assert.equal(captured.headers["Sign"], expectedSign);
  } finally {
    api.defaults.adapter = prevAdapter;
    if (prevToken === undefined) delete process.env.TOKEN;
    else process.env.TOKEN = prevToken;
    if (prevAppId === undefined) delete process.env.APPID;
    else process.env.APPID = prevAppId;
  }
});

test("getDevices paginates across multiple pages using 0-based startIndex and discovers cameras beyond first 30", async () => {
  const prevAdapter = api.defaults.adapter;
  const catalog = Array.from({ length: 105 }, (_, idx) => {
    if (idx === 4) return makeDevice(idx, "lumi.camera.gwpgl1");
    if (idx === 102) return makeDevice(idx, "lumi.camera.acn005");
    return makeDevice(idx);
  });

  const seenCalls: Array<{ size: number; startIndex: number }> = [];
  api.defaults.adapter = async (config) => {
    const size = Number(config.params?.size);
    const startIndex = Number(config.params?.startIndex);
    seenCalls.push({ size, startIndex });
    // Simulate a server that caps each page at 30 even if a larger size is requested
    const effective = Math.min(size, 30);
    const slice = catalog.slice(startIndex, startIndex + effective);
    return {
      data: {
        code: 0,
        message: "Success",
        requestId: "req",
        msgDetails: "Success",
        result: {
          count: catalog.length,
          devices: slice,
        },
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };

  try {
    const res = await getDevices();
    assert.equal(res.code, 0);
    assert.equal(res.result.count, 105);
    assert.equal(res.result.devices.length, 105);
    assert.deepEqual(seenCalls, [
      { size: DEVICE_QUERY_PAGE_SIZE, startIndex: 0 },
      { size: DEVICE_QUERY_PAGE_SIZE, startIndex: 30 },
      { size: DEVICE_QUERY_PAGE_SIZE, startIndex: 60 },
      { size: DEVICE_QUERY_PAGE_SIZE, startIndex: 90 },
    ]);

    const cameras = await getCameras();
    assert.deepEqual(
      cameras.map((c) => c.model),
      ["lumi.camera.gwpgl1", "lumi.camera.acn005"],
    );
  } finally {
    api.defaults.adapter = prevAdapter;
  }
});

test("getDevices stops safely when server omits count or repeats duplicate devices", async () => {
  const prevAdapter = api.defaults.adapter;
  let calls = 0;

  api.defaults.adapter = async (config) => {
    calls++;
    return {
      data: {
        code: 0,
        message: "Success",
        requestId: "req",
        msgDetails: "Success",
        result: {
          // Deliberately repeat same device to verify loop termination guard
          count: 500,
          devices: [makeDevice(1, "lumi.camera.agl004")],
        },
      },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };

  try {
    const res = await getDevices(1);
    assert.equal(calls, 2);
    assert.equal(res.result.devices.length, 1);
  } finally {
    api.defaults.adapter = prevAdapter;
  }
});
