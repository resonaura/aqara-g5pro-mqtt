#!/usr/bin/env python3
"""Offline analysis of captured E1 frames: structure + decryption variants."""
import struct, sys

RAW = '/Users/resonaura/aqara-g5pro-mqtt/analysis/raw_frames.bin'
DEC = '/Users/resonaura/aqara-g5pro-mqtt/analysis/dec_frames.bin'
KEY = bytes.fromhex('3bfc1b897506c20604b1c23a399d38b937e4c769e101502dcbcd92f80cefdb6b')

def rotl(v, n): return ((v << n) | (v >> (32 - n))) & 0xffffffff
def qr(s, a, b, c, d):
    s[a] = (s[a] + s[b]) & 0xffffffff; s[d] ^= s[a]; s[d] = rotl(s[d], 16)
    s[c] = (s[c] + s[d]) & 0xffffffff; s[b] ^= s[c]; s[b] = rotl(s[b], 12)
    s[a] = (s[a] + s[b]) & 0xffffffff; s[d] ^= s[a]; s[d] = rotl(s[d], 8)
    s[c] = (s[c] + s[d]) & 0xffffffff; s[b] ^= s[c]; s[b] = rotl(s[b], 7)

def chacha_block(key, nonce_words, counter):
    st = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
    st += list(struct.unpack('<8I', key))
    st += [counter, 0] + list(nonce_words)  # djb: w12,w13=counter(8B), w14,w15=nonce(8B)
    w = st[:]
    for _ in range(10):
        qr(w,0,4,8,12); qr(w,1,5,9,13); qr(w,2,6,10,14); qr(w,3,7,11,15)
        qr(w,0,5,10,15); qr(w,1,6,11,12); qr(w,2,7,8,13); qr(w,3,4,9,14)
    return struct.pack('<16I', *[(w[i] + st[i]) & 0xffffffff for i in range(16)])

def read_frames(path):
    data = open(path, 'rb').read()
    meta = [tuple(map(int, l.split())) for l in open('/Users/resonaura/aqara-g5pro-mqtt/analysis/frames.meta')]
    out, off = [], 0
    for _, inlen, _ in meta:
        out.append(data[off:off+inlen]); off += inlen
    return out, meta

def nal_types(buf):
    d = {}
    for i in range(len(buf) - 5):
        if buf[i] == 0 and buf[i+1] == 0 and buf[i+2] == 0 and buf[i+3] == 1:
            t = buf[i+4] & 0x1f
            d[t] = d.get(t, 0) + 1
    return d

raw, meta = read_frames(RAW)
dec, _ = read_frames(DEC)

for idx, frame in enumerate(raw):
    print(f'===== frame {idx} len={len(frame)}')
    print('  first 48:', frame[:48].hex(' '))
    nonce = frame[:8]
    b8 = frame[8]
    print(f'  nonce={nonce.hex()} byte8={b8}')
    # candidate: count = b8
    for count in {b8, 1, 2, 4}:
        if count == 0: continue
        te = 9 + count * 8
        if te + 32 > len(frame): continue
        table = frame[9:te]
        ents = [(struct.unpack_from('<I', table, i*8)[0], struct.unpack_from('<I', table, i*8+4)[0]) for i in range(count)]
        ok = all(a + b <= len(frame) - te for a, b in ents)
        print(f'  count={count} table={ents} plausible={ok}')
    # try decrypt with count=b8 if plausible
    count = b8
    te = 9 + count * 8
    if count and te + 32 <= len(frame):
        table = frame[9:te]
        tail = bytearray(frame[te:])
        ks = chacha_block(KEY, struct.unpack('<2I', nonce), 0)[:16]
        ents = [(struct.unpack_from('<I', table, i*8)[0], struct.unpack_from('<I', table, i*8+4)[0]) for i in range(count)]
        blocks = 0
        for a, b in ents:
            pos = 32
            while pos + 16 <= b:
                abs_ = a + pos
                if abs_ + 16 > len(tail): break
                for k in range(16): tail[abs_+k] ^= ks[k]
                blocks += 1
                pos += 160
        nals = nal_types(bytes(tail))
        print(f'  decrypt(blocks={blocks}) NAL types: {nals}')
    # also NAL types of raw dec output from TS
    if idx < len(dec):
        print(f'  TS-dec NAL types: {nal_types(dec[idx])}')
    if idx >= 2: break
