import assert from "node:assert/strict";
import test from "node:test";
import {
  aacFrameDurationMs,
  forceMpeg2Adts,
  isTalkbackNativeAac,
  parseAudioSpecificConfig,
  splitAdts,
  wrapRawAacToAdts,
} from "../audio.js";

// Build a minimal ADTS AAC frame of `len` bytes with a valid syncword + length field.
function adtsFrame(len: number, profile = 2, srIndex = 4, chan = 1): Buffer {
  const buf = Buffer.alloc(len);
  buf[0] = 0xff;
  buf[1] = 0xf0 | (profile << 1); // MPEG-4, layer 0, no crc
  buf[2] = (srIndex << 2) | ((chan >> 2) & 0x01);
  buf[3] = ((chan & 0x03) << 6) | ((len >> 11) & 0x03);
  buf[4] = (len >> 3) & 0xff;
  buf[5] = ((len & 0x07) << 5) | 0x1f; // 13-bit length in low bits, rest = 0x1f
  buf[6] = 0xfc;
  return buf;
}

test("splitAdts separates concatenated ADTS frames", () => {
  const f1 = adtsFrame(20);
  const f2 = adtsFrame(40);
  const f3 = adtsFrame(13);
  const joined = Buffer.concat([f1, f2, f3]);
  const out = splitAdts(joined);
  assert.equal(out.length, 3);
  assert.equal(out[0].length, 20);
  assert.equal(out[1].length, 40);
  assert.equal(out[2].length, 13);
  assert.ok(out[0][0] === 0xff && (out[0][1] & 0xf0) === 0xf0);
});

test("splitAdts ignores garbage between syncwords", () => {
  const f = adtsFrame(16);
  const garbage = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), f]);
  const out = splitAdts(garbage);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 16);
});

test("aacFrameDurationMs at 16kHz is ~64ms", () => {
  assert.ok(Math.abs(aacFrameDurationMs(16000) - 64) < 0.001);
});

test("wrapRawAacToAdts emits MPEG-2 AAC-LC 16 kHz mono matching the camera", () => {
  const raw = Buffer.from([0x01, 0x0c, 0x13, 0x10]);
  const adts = wrapRawAacToAdts(raw, {
    objectType: 2,
    sampleRate: 16000,
    channels: 1,
  });
  assert.equal(adts[0], 0xff);
  assert.equal(adts[1], 0xf9);
  assert.equal((adts[2] >> 6) & 0x03, 1);
  assert.equal((adts[2] >> 2) & 0x0f, 8);
  const len = ((adts[3] & 3) << 11) | (adts[4] << 3) | (adts[5] >> 5);
  assert.equal(len, adts.length);
  assert.deepEqual(adts.subarray(7), raw);
});

test("parseAudioSpecificConfig reads AAC-LC 16 kHz mono", () => {
  const cfg = parseAudioSpecificConfig(Buffer.from([0x14, 0x08]));
  assert.ok(cfg);
  assert.equal(cfg!.objectType, 2);
  assert.equal(cfg!.sampleRate, 16000);
  assert.equal(cfg!.channels, 1);
  assert.equal(isTalkbackNativeAac(cfg), true);
});

test("forceMpeg2Adts sets the MPEG-2 ID bit", () => {
  const mpeg4 = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x7f, 0xfc]);
  const out = forceMpeg2Adts(mpeg4);
  assert.equal(out[1] & 0x08, 0x08);
});
