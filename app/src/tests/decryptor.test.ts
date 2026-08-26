import test from 'node:test';
import assert from 'node:assert/strict';
import { AqaraStreamDecryptor } from '../decryptor.js';

// ---------------------------------------------------------------------------
// Independent, spec-faithful reference implementation of the DJB ChaCha20
// (8-byte nonce, 64-bit counter, constant "expand 32-byte k"). This is NOT
// used in production — it only lets the test prove that the production
// chacha20Xor is a correct standard ChaCha20. The AqaraHome binary uses the
// same primitive: the string "expand 32-byte k" sits at file offset 0x696d3f0
// and decryptAudioG711:shareKey: (0x10331231c) calls the ChaCha20 core with a
// 5-arg signature (out, in, len, nonce8, key) => crypto_stream_chacha20_xor,
// i.e. counter == 0, key == shareKey, nonce == input[0:8]. Therefore a correct
// standard ChaCha20 implementation IS byte-for-byte identical to the binary.
// ---------------------------------------------------------------------------
function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function qr(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = rotl32(s[d], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = rotl32(s[b], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = rotl32(s[d], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = rotl32(s[b], 7);
}

function refChacha20Block(key: Buffer, nonce: Buffer, counter: number): Buffer {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 0x100000000) >>> 0;
  s[14] = nonce.readUInt32LE(0);
  s[15] = nonce.readUInt32LE(4);
  const w = s.slice();
  for (let i = 0; i < 10; i++) {
    qr(w, 0, 4, 8, 12); qr(w, 1, 5, 9, 13); qr(w, 2, 6, 10, 14); qr(w, 3, 7, 11, 15);
    qr(w, 0, 5, 10, 15); qr(w, 1, 6, 11, 12); qr(w, 2, 7, 8, 13); qr(w, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((w[i] + s[i]) >>> 0, i * 4);
  return out;
}

function refChacha20Xor(key: Buffer, nonce: Buffer, data: Buffer, counter: number): Buffer {
  const out = Buffer.from(data);
  for (let off = 0; off < out.length; off += 64) {
    const ks = refChacha20Block(key, nonce, counter + Math.floor(off / 64));
    for (let i = 0; i < 64 && off + i < out.length; i++) out[off + i] ^= ks[i];
  }
  return out;
}

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

test('chacha20Xor matches an independent standard ChaCha20 (djb, 8-byte nonce)', () => {
  const d = new AqaraStreamDecryptor(KEY);
  const key = Buffer.from(KEY, 'hex');
  for (const len of [0, 1, 7, 8, 63, 64, 65, 131, 200, 1024]) {
    const nonce = Buffer.alloc(8, 0x42);
    const data = crypto_random(len);
    const got = d.chacha20Xor(nonce, data, 0);
    const want = refChacha20Xor(key, nonce, data, 0);
    assert.deepEqual(got, want, `length ${len} mismatch`);
  }
});

test('chacha20Xor is symmetric (decrypt == encrypt)', () => {
  const d = new AqaraStreamDecryptor(KEY);
  const nonce = Buffer.alloc(8, 0x11);
  const pt = crypto_random(160);
  const ct = d.chacha20Xor(nonce, pt, 0);
  assert.notDeepEqual(ct, pt);
  assert.deepEqual(d.chacha20Xor(nonce, ct, 0), pt);
});

test('chacha20Xor uses counter 0 to match binary (out[0..8] differs from counter 1)', () => {
  const d = new AqaraStreamDecryptor(KEY);
  const key = Buffer.from(KEY, 'hex');
  const nonce = Buffer.alloc(8, 0x7);
  const data = crypto_random(64);
  const c0 = d.chacha20Xor(nonce, data, 0);
  const c1 = d.chacha20Xor(nonce, data, 1);
  assert.deepEqual(c0, refChacha20Xor(key, nonce, data, 0));
  assert.deepEqual(c1, refChacha20Xor(key, nonce, data, 1));
  assert.notDeepEqual(c0, c1);
});

// Build a realistic audio AVIO frame exactly like the wire layout the camera
// sends: 32-byte header + 8-byte nonce + encrypted payload (no MTU padding
// needed for the decrypt path because we slice by the declared length).
test('decryptAudioFrame decrypts the payload with nonce[32:40] and counter 0', () => {
  const d = new AqaraStreamDecryptor(KEY);
  const key = Buffer.from(KEY, 'hex');
  const nonce = Buffer.alloc(8, 0x99);
  const g711 = crypto_random(131); // observed real payload length
  const enc = refChacha20Xor(key, nonce, g711, 0);

  const frame = Buffer.alloc(40 + enc.length);
  frame.writeUInt16LE(0x0088, 0);
  frame.writeUInt32LE(131, 28); // encrypted payload length
  nonce.copy(frame, 32);
  enc.copy(frame, 40);

  const out = d.decryptAudioFrame(frame);
  assert.equal(out.length, 131);
  assert.deepEqual(out, g711);
});

test('decryptAudioFrame ignores zero MTU padding after the declared length', () => {
  const d = new AqaraStreamDecryptor(KEY);
  const key = Buffer.from(KEY, 'hex');
  const nonce = Buffer.alloc(8, 0x55);
  const g711 = crypto_random(131);
  const enc = refChacha20Xor(key, nonce, g711, 0);

  const frame = Buffer.alloc(1024); // padded datagram
  frame.writeUInt16LE(0x0088, 0);
  frame.writeUInt32LE(131, 28);
  nonce.copy(frame, 32);
  enc.copy(frame, 40);

  const out = d.decryptAudioFrame(frame);
  assert.equal(out.length, 131);
  assert.deepEqual(out, g711);
});

test('encryptAudioFrame is the inverse of decryptAudioFrame', () => {
  const d = new AqaraStreamDecryptor(KEY);
  const g711 = crypto_random(200);
  const built = d.encryptAudioFrame(g711, 7);
  assert.equal(built.readUInt16LE(0), 0x0088);
  assert.equal(built.readUInt32LE(28), 200);
  const back = d.decryptAudioFrame(built);
  assert.deepEqual(back, g711);
});

function crypto_random(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}
