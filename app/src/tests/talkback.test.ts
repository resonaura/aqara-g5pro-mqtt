import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAdts, aacFrameDurationMs } from '../audio.js';

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

test('splitAdts separates concatenated ADTS frames', () => {
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

test('splitAdts ignores garbage between syncwords', () => {
  const f = adtsFrame(16);
  const garbage = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), f]);
  const out = splitAdts(garbage);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 16);
});

test('aacFrameDurationMs at 16kHz is ~64ms', () => {
  assert.ok(Math.abs(aacFrameDurationMs(16000) - 64) < 0.001);
});
