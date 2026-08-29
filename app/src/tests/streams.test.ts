import assert from "node:assert/strict";
import test from "node:test";
import {
  jsonQualityChannel,
  parseCloudStreamQualities,
  pickMaxStreamQuality,
  videoStreamIndex,
} from "../aqara.js";

test("parseCloudStreamQualities reads G5 catalogue and picks 1520p as max", () => {
  const raw = JSON.stringify({
    "360p": "rtsp://292:709@192.168.5.31:8554/ch4",
    "720p": "rtsp://292:709@192.168.5.31:8554/ch3",
    "1080p": "rtsp://292:709@192.168.5.31:8554/ch2",
    "1520p": "rtsp://292:709@192.168.5.31:8554/ch1",
  });
  const list = parseCloudStreamQualities(raw);
  assert.equal(list[0].title, "1520p");
  assert.equal(list[0].height, 1520);
  assert.equal(list[0].channel, 1);
  const low = list.find((q) => q.title === "360p");
  assert.equal(low?.channel, 4);
  const best = pickMaxStreamQuality(list);
  assert.equal(best?.title, "1520p");
  assert.equal(best?.channel, 1);
});

test("parseCloudStreamQualities treats Low Resolution as 360p", () => {
  const list = parseCloudStreamQualities({
    "1520p": "rtsp://x/ch1",
    "1080p": "rtsp://x/ch2",
    "Low Resolution": "rtsp://x/ch4",
  });
  assert.equal(list[0].title, "1520p");
  assert.equal(list[list.length - 1].height, 360);
  assert.equal(pickMaxStreamQuality(list)?.channel, 1);
});

test("parseCloudStreamQualities ignores garbage", () => {
  assert.deepEqual(parseCloudStreamQualities("not-json"), []);
  assert.equal(pickMaxStreamQuality([]), null);
});

test("videoStreamIndex maps 1520p/1080p/Low to 0/1/2", () => {
  assert.equal(
    videoStreamIndex({ title: "1520p", height: 1520, channel: 1 }),
    0,
  );
  assert.equal(
    videoStreamIndex({ title: "1080p", height: 1080, channel: 2 }),
    1,
  );
  assert.equal(videoStreamIndex({ title: "360p", height: 360, channel: 4 }), 2);
  assert.equal(videoStreamIndex(null), 0);
});

test("jsonQualityChannel maps HD to 1 and Low to 0", () => {
  assert.equal(
    jsonQualityChannel({ title: "1520p", height: 1520, channel: 1 }),
    1,
  );
  assert.equal(
    jsonQualityChannel({ title: "1080p", height: 1080, channel: 2 }),
    1,
  );
  assert.equal(
    jsonQualityChannel({ title: "360p", height: 360, channel: 4 }),
    0,
  );
  assert.equal(jsonQualityChannel(null, "lumi.camera.agl004"), 1);
});
