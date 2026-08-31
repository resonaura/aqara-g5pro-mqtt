const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export interface AacConfig {
  objectType: number;
  sampleRate: number;
  channels: number;
}

/** Parse an AAC AudioSpecificConfig (2+ bytes from an RTMP sequence header). */
export function parseAudioSpecificConfig(asc: Buffer): AacConfig | null {
  if (!asc || asc.length < 2) return null;
  const objectType = (asc[0] >> 3) & 0x1f;
  const freqIndex = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const channels = (asc[1] >> 3) & 0x0f;
  const sampleRate =
    freqIndex === 0x0f && asc.length >= 5
      ? ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7)
      : AAC_SAMPLE_RATES[freqIndex];
  if (!sampleRate || objectType === 0) return null;
  return { objectType, sampleRate, channels };
}

/**
 * Wrap a raw AAC access unit in an MPEG-2 ADTS header.
 * The camera's talk decoder expects MPEG-2 ADTS (sync 0xfff9), AAC-LC, 16 kHz, mono.
 */
export function wrapRawAacToAdts(raw: Buffer, cfg: Partial<AacConfig> = {}): Buffer {
  const objectType = cfg.objectType ?? 2;
  const sampleRate = cfg.sampleRate ?? 16000;
  const channels = cfg.channels ?? 1;
  let srIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (srIndex < 0) srIndex = 8; // 16000
  const profile = Math.max(0, Math.min(3, objectType - 1));
  const frameLen = 7 + raw.length;
  const hdr = Buffer.alloc(7);
  hdr[0] = 0xff;
  hdr[1] = 0xf9; // MPEG-2, layer 0, no CRC
  hdr[2] = ((profile & 0x03) << 6) | ((srIndex & 0x0f) << 2) | ((channels >> 2) & 0x01);
  hdr[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  hdr[4] = (frameLen >> 3) & 0xff;
  hdr[5] = ((frameLen & 0x07) << 5) | 0x1f;
  hdr[6] = 0xfc;
  return Buffer.concat([hdr, raw]);
}

export function forceMpeg2Adts(frame: Buffer): Buffer {
  if (frame.length < 2 || frame[0] !== 0xff || (frame[1] & 0xf0) !== 0xf0) {
    return frame;
  }
  const out = Buffer.from(frame);
  out[1] |= 0x08;
  return out;
}

/** True when this AAC config can be sent to the camera without resampling. */
export function isTalkbackNativeAac(cfg: AacConfig | null): boolean {
  return !!cfg && cfg.objectType === 2 && cfg.sampleRate === 16000 && cfg.channels === 1;
}

/** Split an ADTS AAC byte stream into discrete frames (each with its ADTS header). */
export function splitAdts(aac: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 7 <= aac.length) {
    // ADTS syncword = 12 bits 0xFFF
    if (aac[off] === 0xff && (aac[off + 1] & 0xf0) === 0xf0) {
      const frameLen =
        ((aac[off + 3] & 0x03) << 11) | (aac[off + 4] << 3) | ((aac[off + 5] & 0xe0) >> 5);
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
