import assert from "node:assert/strict";
import test from "node:test";
import {
  AVIO_AUDIO,
  AVIO_VIDEO_H264,
  buildStreamStartBody,
  extractLeadingAudio,
  findAVIOOffset,
  isAVIOAudioHeader,
  isAVIOVideoHeader,
  isNewAVIODatagram,
  keepAVIORemainder,
  shouldFlushAVIO,
  splitAVIOFrames,
} from "../bridge.js";

function avio(flags: number, payload: Buffer, codec = AVIO_VIDEO_H264): Buffer {
  const h = Buffer.alloc(32 + payload.length);
  h.writeUInt16LE(codec, 0);
  h.writeUInt16LE(flags, 2);
  h.writeUInt32LE(payload.length, 28);
  payload.copy(h, 32);
  return h;
}

test("isAVIOVideoHeader accepts H264 and rejects audio / short buffers", () => {
  const idr = avio(1, Buffer.alloc(100, 0x65));
  assert.equal(isAVIOVideoHeader(idr), true);

  const audio = Buffer.alloc(40);
  audio.writeUInt16LE(AVIO_AUDIO, 0);
  audio.writeUInt32LE(8, 28);
  assert.equal(isAVIOVideoHeader(audio), false);
  assert.equal(isAVIOVideoHeader(Buffer.alloc(16)), false);
});

test("splitAVIOFrames keeps the next P-frame that starts in the IDR's last datagram", () => {
  const idr = avio(1, Buffer.alloc(200, 0x65));
  const p = avio(0, Buffer.alloc(50, 0x41));
  const packed = Buffer.concat([idr, p]);

  const { frames, remainder } = splitAVIOFrames(packed);
  assert.equal(frames.length, 2);
  assert.ok(frames[0].equals(idr));
  assert.ok(frames[1].equals(p));
  assert.equal(remainder.length, 0);
});

test("splitAVIOFrames returns an incomplete P-frame as remainder", () => {
  const idr = avio(1, Buffer.alloc(200, 0x65));
  const p = avio(0, Buffer.alloc(100, 0x41));
  const partialP = p.subarray(0, 50);
  const packed = Buffer.concat([idr, partialP]);

  const { frames, remainder } = splitAVIOFrames(packed);
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(idr));
  assert.equal(remainder.length, 50);
  assert.equal(isAVIOVideoHeader(remainder), true);
});

test("splitAVIOFrames is a no-op on a partial first header", () => {
  const { frames, remainder } = splitAVIOFrames(Buffer.alloc(20, 0x4e));
  assert.equal(frames.length, 0);
  assert.equal(remainder.length, 20);
});

test("splitAVIOFrames keeps a short IDR until every declared byte arrives", () => {
  const idrDeclared200 = avio(1, Buffer.alloc(200, 0x65));
  const short = idrDeclared200.subarray(0, 100);

  const { frames, remainder } = splitAVIOFrames(short);
  assert.equal(frames.length, 0);
  assert.equal(remainder.length, 100);
});

test("isNewAVIODatagram ignores 4e00-looking IDR tails at idx>0", () => {
  assert.equal(isNewAVIODatagram(true, 0, false, false), true);
  assert.equal(isNewAVIODatagram(true, 121, true, false), false);
  assert.equal(isNewAVIODatagram(true, 0, true, false), true);
  assert.equal(isNewAVIODatagram(true, 20, true, true), true);
  assert.equal(isNewAVIODatagram(false, 0, false, false), false);
});

test("findAVIOOffset locates a P-frame header after leftover IDR bytes", () => {
  const junk = Buffer.alloc(17, 0xaa);
  const p = avio(0, Buffer.alloc(50, 0x41));
  const packed = Buffer.concat([junk, p]);
  assert.equal(findAVIOOffset(packed), 17);
  assert.equal(findAVIOOffset(p), 0);
});

test("shouldFlushAVIO requires the exact declared AVIO length", () => {
  assert.equal(shouldFlushAVIO(122880, 140456, 300, 120), false);
  assert.equal(shouldFlushAVIO(140448, 140456, 1024, 137), false);
  assert.equal(shouldFlushAVIO(139500, 140456, 500, 136), false);
  assert.equal(shouldFlushAVIO(140456, 140456, 500, 137), true);
  assert.equal(shouldFlushAVIO(0, 140456, 300, 0), false);
});

test("extractLeadingAudio peels 0x0088 frames and leaves the P-header", () => {
  const audio = Buffer.alloc(48);
  audio.writeUInt16LE(AVIO_AUDIO, 0);
  audio.writeUInt32LE(8, 28);

  const p = avio(0, Buffer.alloc(50, 0x41));
  const packed = Buffer.concat([audio, p]);

  const { audio: audios, rest } = extractLeadingAudio(packed);
  assert.equal(audios.length, 1);
  assert.equal(isAVIOAudioHeader(audio), true);
  assert.ok(audios[0].equals(audio));
  assert.ok(rest.equals(p));
});

test("keepAVIORemainder drops IDR ciphertext and keeps a P-frame header", () => {
  const junk = Buffer.alloc(50, 0xaa);
  assert.equal(keepAVIORemainder(junk).length, 0);
  const p = avio(0, Buffer.alloc(50, 0x41));
  assert.ok(keepAVIORemainder(p).equals(p));
  const hidden = Buffer.concat([Buffer.alloc(10, 0xaa), p]);
  assert.ok(keepAVIORemainder(hidden).equals(p));
  assert.equal(keepAVIORemainder(Buffer.alloc(20, 0x4e)).length, 20);
});

test("buildStreamStartBody is 16 bytes channel/videoStream/streamType LE", () => {
  const b = buildStreamStartBody(4, 1, 0);
  assert.equal(b.length, 16);
  assert.equal(b.readUInt32LE(0), 4);
  assert.equal(b.readUInt32LE(4), 1);
  assert.equal(b.readUInt32LE(8), 0);
  assert.equal(b.readUInt32LE(12), 0);
});

test("out-of-order UDP fragments reorder correctly into single frame", () => {
  const p = avio(0, Buffer.alloc(100, 0x41));
  const frag1 = p.subarray(0, 60);
  const frag2 = p.subarray(60);

  const { frames } = splitAVIOFrames(Buffer.concat([frag1, frag2]));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(p));
});
