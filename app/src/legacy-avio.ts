export const AVIO_AUDIO = 0x0088;
export const AVIO_VIDEO_H264 = 0x004e;
export const AVIO_VIDEO_HEVC = 0x004f;

export function buildStreamStartBody(channel = 4, videoStream = 0, streamType = 0): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(channel >>> 0, 0);
  b.writeUInt32LE(videoStream >>> 0, 4);
  b.writeUInt32LE(0, 8);
  b.writeUInt32LE(streamType >>> 0, 12);
  return b;
}

export function isAVIOVideoHeader(data: Buffer, offset = 0): boolean {
  if (data.length < offset + 32) return false;
  const codec = data.readUInt16LE(offset);
  if (codec !== AVIO_VIDEO_H264 && codec !== AVIO_VIDEO_HEVC) return false;
  const flags = data.readUInt16LE(offset + 2);
  if (flags > 1) return false;
  const payloadLen = data.readUInt32LE(offset + 28);
  return payloadLen >= 16 && payloadLen <= 2_000_000;
}

export function isAVIOAudioHeader(data: Buffer, offset = 0): boolean {
  if (data.length < offset + 32) return false;
  if (data.readUInt16LE(offset) !== AVIO_AUDIO) return false;
  const payloadLen = data.readUInt32LE(offset + 28);
  return payloadLen > 0 && payloadLen <= 4096;
}

export function findAVIOOffset(data: Buffer): number {
  if (isAVIOVideoHeader(data, 0)) return 0;
  const last = Math.min(Math.max(0, data.length - 32), 1536);
  for (let i = 1; i <= last; i++) {
    if (isAVIOVideoHeader(data, i)) return i;
  }
  return -1;
}

export function extractLeadingAudio(buf: Buffer): {
  audio: Buffer[];
  rest: Buffer;
} {
  const audio: Buffer[] = [];
  let offset = 0;
  while (isAVIOAudioHeader(buf, offset)) {
    const payLen = buf.readUInt32LE(offset + 28);
    const frameLen = 40 + payLen;
    if (offset + frameLen > buf.length) break;
    audio.push(buf.subarray(offset, offset + frameLen));
    offset += frameLen;
  }
  return { audio, rest: buf.subarray(offset) };
}

export function keepAVIORemainder(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  if (buf.length < 32) return buf;
  if (isAVIOAudioHeader(buf) || buf.readUInt16LE(0) === AVIO_AUDIO) return buf;
  const off = findAVIOOffset(buf);
  if (off < 0) return Buffer.alloc(0);
  return off === 0 ? buf : buf.subarray(off);
}

export function isNewAVIODatagram(
  looksLikeHeader: boolean,
  idx: number,
  assembling: boolean,
  complete: boolean,
): boolean {
  if (!looksLikeHeader) return false;
  if (!assembling) return true;
  if (complete) return true;
  return idx === 0;
}

export function shouldFlushAVIO(
  curLen: number,
  declaredLen: number,
  _lastChunkLen?: number,
  _curIdx?: number,
): boolean {
  if (curLen === 0 || declaredLen === 0) return false;
  return curLen === declaredLen;
}

export function splitAVIOFrames(buf: Buffer): {
  frames: Buffer[];
  remainder: Buffer;
} {
  const frames: Buffer[] = [];
  let cur = buf;

  while (cur.length >= 32) {
    if (!isAVIOVideoHeader(cur) && !isAVIOAudioHeader(cur)) {
      const off = findAVIOOffset(cur);
      if (off < 0) break;
      cur = cur.subarray(off);
    }

    const payLen = cur.readUInt32LE(28);
    const frameLen = (isAVIOAudioHeader(cur) ? 40 : 32) + payLen;
    if (cur.length < frameLen) break;

    frames.push(cur.subarray(0, frameLen));
    cur = cur.subarray(frameLen);
  }

  return { frames, remainder: cur };
}

// Aliases for compatibility
export const isAvioVideoHeader = isAVIOVideoHeader;
export const isAvioAudioHeader = isAVIOAudioHeader;
export const findAvioOffset = findAVIOOffset;
export const keepAvioRemainder = keepAVIORemainder;
export const isNewAvioDatagram = isNewAVIODatagram;
export const shouldFlushAvio = shouldFlushAVIO;
export const splitAvioFrames = splitAVIOFrames;
