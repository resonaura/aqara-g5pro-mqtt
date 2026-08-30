import * as crypto from "crypto";
import { EventEmitter } from "events";

function hasAnnexBPrefix(nal: Buffer): boolean {
  return (
    nal.length >= 3 &&
    nal[0] === 0 &&
    nal[1] === 0 &&
    (nal[2] === 1 || (nal.length >= 4 && nal[2] === 0 && nal[3] === 1))
  );
}

function ensureAnnexB(data: Buffer): Buffer {
  if (hasAnnexBPrefix(data)) return data;
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), data]);
}

// ChaCha20 block function (original djb variant: 64-bit counter + 64-bit nonce)
function quarterRound(s: number[], a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] ^= s[a];
  s[d] = ((s[d] << 16) | (s[d] >>> 16)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] ^= s[c];
  s[b] = ((s[b] << 12) | (s[b] >>> 20)) >>> 0;
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] ^= s[a];
  s[d] = ((s[d] << 8) | (s[d] >>> 24)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] ^= s[c];
  s[b] = ((s[b] << 7) | (s[b] >>> 25)) >>> 0;
}

function chacha20Block(key: Buffer, nonce8: Buffer, counter: number): Buffer {
  const st: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  st[0] = 0x61707865;
  st[1] = 0x3320646e;
  st[2] = 0x79622d32;
  st[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) st[4 + i] = key.readUInt32LE(i * 4);
  st[12] = counter >>> 0;
  st[13] = Math.floor(counter / 0x100000000) >>> 0;
  st[14] = nonce8.readUInt32LE(0);
  st[15] = nonce8.readUInt32LE(4);
  const w = st.slice();
  for (let i = 0; i < 10; i++) {
    quarterRound(w, 0, 4, 8, 12);
    quarterRound(w, 1, 5, 9, 13);
    quarterRound(w, 2, 6, 10, 14);
    quarterRound(w, 3, 7, 11, 15);
    quarterRound(w, 0, 5, 10, 15);
    quarterRound(w, 1, 6, 11, 12);
    quarterRound(w, 2, 7, 8, 13);
    quarterRound(w, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((w[i] + st[i]) >>> 0, i * 4);
  return out;
}

// HSalsa20 is the key derivation used by the captured working live-P2P path.
// This is deliberately kept separate from the per-frame ChaCha20 cipher below.
function hsalsa20(sharedSecret: Buffer): Buffer {
  const R = (v: number, c: number) => ((v << c) | (v >>> (32 - c))) >>> 0;
  const c0 = 0x61707865, c1 = 0x3320646e, c2 = 0x79622d32, c3 = 0x6b206574;
  const k0 = sharedSecret.readUInt32LE(0), k1 = sharedSecret.readUInt32LE(4),
    k2 = sharedSecret.readUInt32LE(8), k3 = sharedSecret.readUInt32LE(12),
    k4 = sharedSecret.readUInt32LE(16), k5 = sharedSecret.readUInt32LE(20),
    k6 = sharedSecret.readUInt32LE(24), k7 = sharedSecret.readUInt32LE(28);
  let x0 = c0, x1 = k0, x2 = k1, x3 = k2;
  let x4 = k3, x5 = c1, x6 = 0, x7 = 0;
  let x8 = 0, x9 = 0, x10 = c2, x11 = k4;
  let x12 = k5, x13 = k6, x14 = k7, x15 = c3;
  for (let i = 0; i < 10; i++) {
    x4 = (x4 ^ R((x0 + x12) >>> 0, 7)) >>> 0; x8 = (x8 ^ R((x4 + x0) >>> 0, 9)) >>> 0;
    x12 = (x12 ^ R((x8 + x4) >>> 0, 13)) >>> 0; x0 = (x0 ^ R((x12 + x8) >>> 0, 18)) >>> 0;
    x9 = (x9 ^ R((x5 + x1) >>> 0, 7)) >>> 0; x13 = (x13 ^ R((x9 + x5) >>> 0, 9)) >>> 0;
    x1 = (x1 ^ R((x13 + x9) >>> 0, 13)) >>> 0; x5 = (x5 ^ R((x1 + x13) >>> 0, 18)) >>> 0;
    x14 = (x14 ^ R((x10 + x6) >>> 0, 7)) >>> 0; x2 = (x2 ^ R((x14 + x10) >>> 0, 9)) >>> 0;
    x6 = (x6 ^ R((x2 + x14) >>> 0, 13)) >>> 0; x10 = (x10 ^ R((x6 + x2) >>> 0, 18)) >>> 0;
    x3 = (x3 ^ R((x15 + x11) >>> 0, 7)) >>> 0; x7 = (x7 ^ R((x3 + x15) >>> 0, 9)) >>> 0;
    x11 = (x11 ^ R((x7 + x3) >>> 0, 13)) >>> 0; x15 = (x15 ^ R((x11 + x7) >>> 0, 18)) >>> 0;
    x1 = (x1 ^ R((x0 + x3) >>> 0, 7)) >>> 0; x2 = (x2 ^ R((x1 + x0) >>> 0, 9)) >>> 0;
    x3 = (x3 ^ R((x2 + x1) >>> 0, 13)) >>> 0; x0 = (x0 ^ R((x3 + x2) >>> 0, 18)) >>> 0;
    x6 = (x6 ^ R((x5 + x4) >>> 0, 7)) >>> 0; x7 = (x7 ^ R((x6 + x5) >>> 0, 9)) >>> 0;
    x4 = (x4 ^ R((x7 + x6) >>> 0, 13)) >>> 0; x5 = (x5 ^ R((x4 + x7) >>> 0, 18)) >>> 0;
    x11 = (x11 ^ R((x10 + x9) >>> 0, 7)) >>> 0; x8 = (x8 ^ R((x11 + x10) >>> 0, 9)) >>> 0;
    x9 = (x9 ^ R((x8 + x11) >>> 0, 13)) >>> 0; x10 = (x10 ^ R((x9 + x8) >>> 0, 18)) >>> 0;
    x12 = (x12 ^ R((x15 + x14) >>> 0, 7)) >>> 0; x13 = (x13 ^ R((x12 + x15) >>> 0, 9)) >>> 0;
    x14 = (x14 ^ R((x13 + x12) >>> 0, 13)) >>> 0; x15 = (x15 ^ R((x14 + x13) >>> 0, 18)) >>> 0;
  }
  const out = Buffer.alloc(32);
  out.writeUInt32LE(x0, 0); out.writeUInt32LE(x5, 4); out.writeUInt32LE(x10, 8); out.writeUInt32LE(x15, 12);
  out.writeUInt32LE(x6, 16); out.writeUInt32LE(x7, 20); out.writeUInt32LE(x8, 24); out.writeUInt32LE(x9, 28);
  return out;
}

  /**
 * Aqara E1 video frame decryption (recovered from
 * LMLKMHFrameEncryptManager decryptVideo:length:outBuf:outLength:shareKey:codeId:
 * in AqaraHome 5.2.8 arm64).
 *
 * Frame layout:
 *   [0..8)   nonce (8 bytes)            -> copied verbatim, used as ChaCha20 nonce
 *   [8]      service byte               -> skipped
 *   [9..9+N*8) chunk table: N entries of (u32le offset, u32le length), N = frame[8]
 *   [9+N*8..]  tail: NAL units data
 *
 * Decryption: for each NAL (a=offset, b=length): XOR 16-byte blocks located at
 * positions 32, 192, 352, ... (stride 160) within the NAL, while pos + 16 <= b.
 */
export class AqaraStreamDecryptor extends EventEmitter {
  private keyBuf: Buffer;

  constructor(keyHex: string) {
    super();
    this.keyBuf = Buffer.from(keyHex, "hex");
    if (this.keyBuf.length !== 32) {
      const padded = Buffer.alloc(32);
      this.keyBuf.copy(padded);
      this.keyBuf = padded;
    }
  }

  /**
   * The last known-good live path derives the sparse-ChaCha key with HSalsa20.
   * This must remain independent from the DID; selecting SHA-256 here changes
   * only encrypted 16-byte spans, which is enough to create striped H.264
   * pictures while still leaving the stream superficially decodable.
   */
  public static deriveKey(_did: string, sharedSecret: Buffer): Buffer {
    return hsalsa20(sharedSecret);
  }

  /**
   * Raw ChaCha20 (djb variant) XOR. Symmetric: encryption and decryption are
   * the same operation. Used for live G.711 audio which is encrypted with
   * ChaCha20(key=shareKey, nonce=frame[0:8], counter=0) — recovered from
   * -[MHFrameEncryptManager decryptAudioG711:shareKey:] at 0x10331231c.
   */
  public chacha20Xor(
    nonce8: Buffer,
    data: Buffer,
    counter: number = 0,
  ): Buffer {
    if (data.length === 0) return data;
    const n = nonce8.subarray(0, 8);
    const ks = chacha20Block(this.keyBuf, n, counter);
    const out = Buffer.from(data);
    const blockLen = ks.length;
    for (let off = 0; off < out.length; off += blockLen) {
      const block = chacha20Block(this.keyBuf, n, counter + off / blockLen);
      for (let i = 0; i < block.length && off + i < out.length; i++) {
        out[off + i] ^= block[i];
      }
    }
    return out;
  }

  /**
   * Decrypt a received audio AVIO frame.
   * Wire layout (verified against a live E1 capture, /tmp/e1_audio_frame0.bin):
   *   [0..2)   0x0088 (audio AVIO codec id)
   *   [2..4)   0x000e
   *   [4..8)   flags (1)
   *   [8..16)  8-byte timestamp (same layout as video AVIO header)
   *   [16..20) sample-rate marker (8 == 8 kHz)
   *   [20..28) reserved (0)
   *   [28..32) ENCRYPTED payload length (excludes the 8-byte nonce)
   *   [32..40) 8-byte nonce
   *   [40..40+len) encrypted AAC (ADTS) payload
   * The media datagram is padded to its MTU (e.g. 1024) with zeros, so we MUST
   * slice to the declared payload length and never decrypt the padding.
   */
  public decryptAudioFrame(frame: Buffer): Buffer {
    if (frame.length < 40) return frame;
    if (frame.readUInt16LE(0) !== 0x0088) return frame;
    const payLen = frame.readUInt32LE(28);
    const nonce = frame.subarray(32, 40);
    const enc =
      payLen > 0 && payLen <= frame.length - 40 && payLen <= 4096
        ? frame.subarray(40, 40 + payLen)
        : frame.subarray(40);

    return this.chacha20Xor(nonce, enc, 0);
  }

  /**
   * Build a talkback audio AVIO frame ready to be sent to the camera.
   *
   * Recovered from LMCAMHLumiCameraAudioTalk + LMCAMHLumiAACEncoder: the app
   * captures mic audio, encodes it to AAC (16 kHz, mono, ADTS) and ships it as
   * a 0x0088 AVIO media frame — the exact mirror of the audio frames the camera
   * streams *to* us (which we decrypt in decryptAudioFrame). Payload is
   * ChaCha20(key=shareKey, nonce=8B, ctr=0), same cipher as incoming audio.
   *
   * Returns the full 32-byte AVIO header + 8-byte nonce + encrypted AAC.
   */
  public encryptAudioFrame(
    audioData: Buffer,
    seq: number = 0,
    sampleRate = 16000,
  ): Buffer {
    // Mirror the exact layout decryptAudioFrame parses (verified against a real
    // E1 capture). The outgoing talkback frame is the byte-for-byte mirror of an
    // incoming audio frame, just with our encrypted AAC payload + fresh nonce.
    const header = Buffer.alloc(32);
    header.writeUInt16LE(0x0088, 0); // audio AVIO codec id (AAC)
    header.writeUInt16LE(0x000e, 2); // frame-type / flags (data)
    header.writeUInt32LE(0, 4); // flags (reserved)
    const ts = BigInt(Date.now()); // 8-byte timestamp (ms)
    header.writeUInt32LE(Number(ts & 0xffffffffn), 8);
    header.writeUInt32LE(Number((ts >> 32n) & 0xffffffffn), 12);
    const sampleRateKHz = Math.round(sampleRate / 1000); // marker in kHz (8 = 8 kHz)
    header.writeUInt32LE(sampleRateKHz, 16);
    header.writeUInt32LE(0, 20); // reserved
    header.writeUInt32LE(seq & 0xffffffff, 24); // seq / frameno
    header.writeUInt32LE(audioData.length, 28); // encrypted payload length
    const nonce = crypto.randomBytes(8);
    const enc = this.chacha20Xor(nonce, audioData, 0);
    return Buffer.concat([header, nonce, enc]);
  }

  public decrypt(frame: Buffer): Buffer {
    return this.decryptFrame(frame);
  }

  public decryptFrame(frame: Buffer): Buffer {
    if (frame.length < 10) return frame;
    const nonce = frame.subarray(0, 8);
    const nalCount = frame[8];
    const tableEnd = 9 + nalCount * 8;

    if (nalCount === 0 || tableEnd >= frame.length) {
      // unencrypted / no NAL table: payload starts after 9-byte prefix
      return frame.subarray(9);
    }

    const ks = chacha20Block(this.keyBuf, nonce, 0).subarray(0, 16);
    const table = frame.subarray(9, tableEnd);
    const tail = Buffer.from(frame.subarray(tableEnd));

    for (let i = 0; i < nalCount; i++) {
      const off = table.readUInt32LE(i * 8);
      const nalLen = table.readUInt32LE(i * 8 + 4);
      if (off < 0) continue;
      for (let pos = 32; pos + 16 <= nalLen; pos += 160) {
        const abs = off + pos;
        if (abs + 16 > tail.length) break;
        for (let k = 0; k < 16; k++) tail[abs + k] ^= ks[k];
      }
    }

    return tail;
  }

  /**
   * Decrypt a video payload and emit Annex-B (start-code prefixed) NAL units.
   * The camera's NAL table addresses raw NALs in the tail with no 00 00 01
   * prefixes — isAnnexBKeyframe() would never see an IDR without this wrap.
   */
  public decryptToAnnexB(frame: Buffer): Buffer {
    if (frame.length < 10) return frame;
    const nalCount = frame[8];
    const tableEnd = 9 + nalCount * 8;

    const tail = this.decryptFrame(frame);

    // If tail already contains in-band Annex-B start codes (00 00 00 01),
    // it includes in-band SPS (0x67), PPS (0x68), and IDR (0x65). Return as-is!
    if (hasAnnexBPrefix(tail)) {
      return tail;
    }

    // If tail does not start with a start code, use the NAL table to wrap raw NALs
    if (nalCount > 0 && nalCount <= 32 && tableEnd < frame.length) {
      const table = frame.subarray(9, tableEnd);
      const sc = Buffer.from([0, 0, 0, 1]);
      const parts: Buffer[] = [];

      const firstOff = table.readUInt32LE(0);
      if (firstOff > 0 && firstOff < tail.length) {
        // In-band parameter sets (SPS/PPS) located before the first table entry
        const lead = tail.subarray(0, firstOff);
        if (hasAnnexBPrefix(lead)) parts.push(lead);
        else parts.push(sc, lead);
      }

      for (let i = 0; i < nalCount; i++) {
        const off = table.readUInt32LE(i * 8);
        const nalLen = table.readUInt32LE(i * 8 + 4);
        if (nalLen <= 0 || off < 0 || off + nalLen > tail.length) continue;
        const nal = tail.subarray(off, off + nalLen);
        if (hasAnnexBPrefix(nal)) parts.push(Buffer.from(nal));
        else parts.push(sc, Buffer.from(nal));
      }
      if (parts.length > 0) return Buffer.concat(parts);
    }

    // Fallback for streams without NAL table (raw Annex-B)
    return ensureAnnexB(tail);
  }

  public destroy(): void {}
}
