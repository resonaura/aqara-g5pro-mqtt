import assert from "node:assert/strict";
import test from "node:test";
import {
  AVIO_AUDIO,
  AVIO_VIDEO_H264,
  buildStreamStartBody,
  extractLeadingAudio,
  findAvioOffset,
  isAvioAudioHeader,
  isAvioVideoHeader,
  isNewAvioDatagram,
  keepAvioRemainder,
  shouldFlushAvio,
  splitAvioFrames,
} from "../bridge.js";

function avio(flags: number, payload: Buffer, codec = AVIO_VIDEO_H264): Buffer {
  const h = Buffer.alloc(32 + payload.length);
  h.writeUInt16LE(codec, 0);
  h.writeUInt16LE(flags, 2);
  h.writeUInt32LE(payload.length, 28);
  payload.copy(h, 32);
  return h;
}

test("isAvioVideoHeader accepts H264 and rejects audio / short buffers", () => {
  const idr = avio(1, Buffer.alloc(100, 0x65));
  assert.equal(isAvioVideoHeader(idr), true);
  const audio = Buffer.alloc(40);
  audio.writeUInt16LE(AVIO_AUDIO, 0);
  audio.writeUInt32LE(8, 28);
  assert.equal(isAvioVideoHeader(audio), false);
  assert.equal(isAvioVideoHeader(Buffer.alloc(16)), false);
});

test("splitAvioFrames keeps the next P-frame that starts in the IDR's last datagram", () => {
  const idr = avio(1, Buffer.alloc(1000, 0x65));
  const p = avio(0, Buffer.alloc(200, 0x41));
  const extra = Buffer.alloc(50, 0x99);
  const packed = Buffer.concat([idr, p, extra]);

  const { frames, remainder } = splitAvioFrames(packed);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, idr.length);
  assert.equal(frames[0].readUInt16LE(2), 1);
  assert.equal(frames[1].length, p.length);
  assert.equal(frames[1].readUInt16LE(2), 0);
  assert.ok(remainder.equals(extra));
});

test("splitAvioFrames returns an incomplete P-frame as remainder", () => {
  const idr = avio(1, Buffer.alloc(400, 0x65));
  const pHead = avio(0, Buffer.alloc(800, 0x41)).subarray(0, 100);
  const packed = Buffer.concat([idr, pHead]);

  const { frames, remainder } = splitAvioFrames(packed);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, idr.length);
  assert.ok(remainder.equals(pHead));
  assert.equal(isAvioVideoHeader(remainder), true);
});

test("splitAvioFrames is a no-op on a partial first header", () => {
  const { frames, remainder } = splitAvioFrames(Buffer.alloc(20, 0x4e));
  assert.equal(frames.length, 0);
  assert.equal(remainder.length, 20);
});

test("splitAvioFrames keeps a short IDR until every declared byte arrives", () => {
  const payload = Buffer.alloc(123876, 0x65);
  const idr = avio(1, payload);
  assert.equal(idr.length, 123908);
  const short = idr.subarray(0, 123904);
  const { frames, remainder } = splitAvioFrames(short);
  assert.equal(frames.length, 0, "a truncated NAL must never be published");
  assert.ok(remainder.equals(short));
});

test("isNewAvioDatagram ignores 4e00-looking IDR tails at idx>0", () => {
  assert.equal(isNewAvioDatagram(true, 0, false, false), true);
  assert.equal(isNewAvioDatagram(true, 121, true, false), false);
  assert.equal(isNewAvioDatagram(true, 0, true, false), true);
  assert.equal(isNewAvioDatagram(true, 20, true, true), true);
  assert.equal(isNewAvioDatagram(false, 0, false, false), false);
});

test("findAvioOffset locates a P-frame header after leftover IDR bytes", () => {
  const p = avio(0, Buffer.alloc(80, 0x41));
  const packed = Buffer.concat([Buffer.alloc(17, 0xaa), p]);
  assert.equal(findAvioOffset(packed), 17);
  assert.equal(findAvioOffset(p), 0);
});

test("shouldFlushAvio requires the exact declared AVIO length", () => {
  assert.equal(shouldFlushAvio(122880, 140456, 300, 120), false);
  assert.equal(shouldFlushAvio(140448, 140456, 1024, 137), false);
  assert.equal(shouldFlushAvio(139500, 140456, 500, 136), false);
  assert.equal(shouldFlushAvio(140456, 140456, 500, 137), true);
  assert.equal(shouldFlushAvio(0, 140456, 300, 0), false);
});

test("extractLeadingAudio peels 0x0088 frames and leaves the P-header", () => {
  const audio = Buffer.alloc(40 + 8, 0);
  audio.writeUInt16LE(AVIO_AUDIO, 0);
  audio.writeUInt16LE(0x000e, 2);
  audio.writeUInt32LE(8, 28);
  const p = avio(0, Buffer.alloc(80, 0x41));
  const packed = Buffer.concat([audio, p]);
  assert.equal(isAvioAudioHeader(audio), true);
  const { audio: frames, rest } = extractLeadingAudio(packed);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 48);
  assert.ok(rest.equals(p));
});

test("keepAvioRemainder drops IDR ciphertext and keeps a P-frame header", () => {
  const junk = Buffer.alloc(1024, 0xab);
  assert.equal(keepAvioRemainder(junk).length, 0);
  const p = avio(0, Buffer.alloc(80, 0x41));
  assert.ok(keepAvioRemainder(p).equals(p));
  const hidden = Buffer.concat([Buffer.alloc(11, 0xcc), p]);
  assert.ok(keepAvioRemainder(hidden).equals(p));
  assert.equal(keepAvioRemainder(Buffer.alloc(20, 0x4e)).length, 20);
});

test("buildStreamStartBody is 16 bytes channel/videoStream/streamType LE", () => {
  const max = buildStreamStartBody();
  assert.equal(max.length, 16);
  assert.equal(max.readUInt32LE(0), 4);
  assert.equal(max.readUInt32LE(4), 0);
  const sd = buildStreamStartBody(4, 2, 0);
  assert.equal(sd.readUInt32LE(0), 4);
  assert.equal(sd.readUInt32LE(4), 2);
});

test("out-of-order UDP fragments reorder correctly into single frame", () => {
  const payload = Buffer.alloc(1500, 0x55);
  const frame = avio(0, payload);
  const frag1 = frame.subarray(0, 1024);
  const frag2 = frame.subarray(1024);
  assert.equal(frag1.length + frag2.length, frame.length);
  const { frames } = splitAvioFrames(Buffer.concat([frag1, frag2]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, frame.length);
});
