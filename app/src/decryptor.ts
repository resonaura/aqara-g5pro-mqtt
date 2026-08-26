import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ChaCha20 block function (original djb variant: 64-bit counter + 64-bit nonce)
function quarterRound(s: number[], a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = ((s[d] << 16) | (s[d] >>> 16)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = ((s[b] << 12) | (s[b] >>> 20)) >>> 0;
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = ((s[d] << 8) | (s[d] >>> 24)) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = ((s[b] << 7) | (s[b] >>> 25)) >>> 0;
}

function chacha20Block(key: Buffer, nonce8: Buffer, counter: number): Buffer {
  const st: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
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
 * Every block uses the SAME keystream: first 16 bytes of
 * ChaCha20(key=shareKey, nonce=frame[0:8], counter=0).
 */
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
    // Column round
    x4 = (x4 ^ R((x0 + x12) >>> 0, 7)) >>> 0;
    x8 = (x8 ^ R((x4 + x0) >>> 0, 9)) >>> 0;
    x12 = (x12 ^ R((x8 + x4) >>> 0, 13)) >>> 0;
    x0 = (x0 ^ R((x12 + x8) >>> 0, 18)) >>> 0;

    x9 = (x9 ^ R((x5 + x1) >>> 0, 7)) >>> 0;
    x13 = (x13 ^ R((x9 + x5) >>> 0, 9)) >>> 0;
    x1 = (x1 ^ R((x13 + x9) >>> 0, 13)) >>> 0;
    x5 = (x5 ^ R((x1 + x13) >>> 0, 18)) >>> 0;

    x14 = (x14 ^ R((x10 + x6) >>> 0, 7)) >>> 0;
    x2 = (x2 ^ R((x14 + x10) >>> 0, 9)) >>> 0;
    x6 = (x6 ^ R((x2 + x14) >>> 0, 13)) >>> 0;
    x10 = (x10 ^ R((x6 + x2) >>> 0, 18)) >>> 0;

    x3 = (x3 ^ R((x15 + x11) >>> 0, 7)) >>> 0;
    x7 = (x7 ^ R((x3 + x15) >>> 0, 9)) >>> 0;
    x11 = (x11 ^ R((x7 + x3) >>> 0, 13)) >>> 0;
    x15 = (x15 ^ R((x11 + x7) >>> 0, 18)) >>> 0;

    // Row round
    x1 = (x1 ^ R((x0 + x3) >>> 0, 7)) >>> 0;
    x2 = (x2 ^ R((x1 + x0) >>> 0, 9)) >>> 0;
    x3 = (x3 ^ R((x2 + x1) >>> 0, 13)) >>> 0;
    x0 = (x0 ^ R((x3 + x2) >>> 0, 18)) >>> 0;

    x6 = (x6 ^ R((x5 + x4) >>> 0, 7)) >>> 0;
    x7 = (x7 ^ R((x6 + x5) >>> 0, 9)) >>> 0;
    x4 = (x4 ^ R((x7 + x6) >>> 0, 13)) >>> 0;
    x5 = (x5 ^ R((x4 + x7) >>> 0, 18)) >>> 0;

    x11 = (x11 ^ R((x10 + x9) >>> 0, 7)) >>> 0;
    x8 = (x8 ^ R((x11 + x10) >>> 0, 9)) >>> 0;
    x9 = (x9 ^ R((x8 + x11) >>> 0, 13)) >>> 0;
    x10 = (x10 ^ R((x9 + x8) >>> 0, 18)) >>> 0;

    x12 = (x12 ^ R((x15 + x14) >>> 0, 7)) >>> 0;
    x13 = (x13 ^ R((x12 + x15) >>> 0, 9)) >>> 0;
    x14 = (x14 ^ R((x13 + x12) >>> 0, 13)) >>> 0;
    x15 = (x15 ^ R((x14 + x13) >>> 0, 18)) >>> 0;
  }

  const out = Buffer.alloc(32);
  out.writeUInt32LE(x0, 0);
  out.writeUInt32LE(x5, 4);
  out.writeUInt32LE(x10, 8);
  out.writeUInt32LE(x15, 12);
  out.writeUInt32LE(x6, 16);
  out.writeUInt32LE(x7, 20);
  out.writeUInt32LE(x8, 24);
  out.writeUInt32LE(x9, 28);
  return out;
}

export class AqaraStreamDecryptor extends EventEmitter {
  private keyBuf: Buffer;

  /**
   * keyHex = HSalsa20(X25519_shared_secret) — recovered directly from
   * -[MHFrameEncryptManager getShareKey:remotePublicKey:myPrivateKey:] in AqaraHome.
   */
  constructor(keyHex: string) {
    super();
    this.keyBuf = Buffer.from(keyHex, 'hex');
    if (this.keyBuf.length !== 32) {
      const padded = Buffer.alloc(32);
      this.keyBuf.copy(padded);
      this.keyBuf = padded;
    }
  }

  public static deriveKey(_did: string, sharedSecret: Buffer): Buffer {
    return hsalsa20(sharedSecret);
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
    const table = frame.subarray(9, tableEnd);
    const tail = Buffer.from(frame.subarray(tableEnd)); // mutable copy
    // keystream: first 16 bytes of chacha20 block with counter=0 (same for all blocks)
    const ks = chacha20Block(this.keyBuf, nonce, 0).subarray(0, 16);

    for (let i = 0; i < nalCount; i++) {
      const off = table.readUInt32LE(i * 8);
      const nalLen = table.readUInt32LE(i * 8 + 4);
      if (off <= 0) continue;
      // skip first 32 bytes of NAL (slice header), decrypt 16 bytes every 160
      for (let pos = 32; pos + 16 <= nalLen; pos += 160) {
        const abs = off + pos;
        if (abs + 16 > tail.length) break;
        for (let k = 0; k < 16; k++) tail[abs + k] ^= ks[k];
      }
    }
    return tail;
  }

  public destroy(): void {}
}
