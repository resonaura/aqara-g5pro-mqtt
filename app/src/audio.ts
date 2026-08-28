/** Split an ADTS AAC byte stream into discrete frames (each with its ADTS header). */
export function splitAdts(aac: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 7 <= aac.length) {
    // ADTS syncword = 12 bits 0xFFF
    if (aac[off] === 0xff && (aac[off + 1] & 0xf0) === 0xf0) {
      const frameLen =
        ((aac[off + 3] & 0x03) << 11) |
        (aac[off + 4] << 3) |
        ((aac[off + 5] & 0xe0) >> 5);
      if (frameLen < 7 || off + frameLen > aac.length) break;
      frames.push(aac.subarray(off, off + frameLen));
      off += frameLen;
    } else {
      off++;
    }
  }
  return frames;
}

/** Samples per AAC-LC frame (fixed) and the resulting duration in ms at a given sample rate. */
export const AAC_FRAME_SAMPLES = 1024;
export function aacFrameDurationMs(sampleRate = 16000): number {
  return (AAC_FRAME_SAMPLES / sampleRate) * 1000;
}
