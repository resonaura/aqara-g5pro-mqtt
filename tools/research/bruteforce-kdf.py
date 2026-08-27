#!/usr/bin/env python3
"""Brute-force shareKey derivation against a captured IDR frame."""
import struct, subprocess, hashlib, hmac, sys, collections

D = '/Users/resonaura/aqara-g5pro-mqtt/analysis/session_latest'
DID = b'lumi1.54ef4477da68'

meta = open(f'{D}/meta.txt').read()
kv = dict(l.split('=', 1) for l in meta.strip().splitlines() if '=' in l and not l.startswith('frame'))
raw = open(f'{D}/raw.bin', 'rb').read()
# frame sizes from meta lines 'frame N len'
sizes = [int(l.split()[2]) for l in meta.strip().splitlines() if l.startswith('frame')]
frames = []
off = 0
for s in sizes:
    frames.append(raw[off:off+s]); off += s
app_pub = kv['appPub']; info_pub = kv['infoDevPub']
print('appPub:', app_pub)
print('infoDevPub:', info_pub)

# We don't have the private key here (it lived in the node process), so instead
# the capture script also saved the computed shared key? -> recompute impossible.
# FALLBACK: use the shared key logged by bridge ('Computed X25519...' in run log).
import re, glob, os
shared = bytes.fromhex(kv['shared'])
print('shared:', shared.hex() if shared else 'NOT FOUND')

def rotl(v,n): return ((v<<n)|(v>>(32-n)))&0xffffffff
def qr(s,a,b,c,d):
    s[a]=(s[a]+s[b])&0xffffffff; s[d]^=s[a]; s[d]=rotl(s[d],16)
    s[c]=(s[c]+s[d])&0xffffffff; s[b]^=s[c]; s[b]=rotl(s[b],12)
    s[a]=(s[a]+s[b])&0xffffffff; s[d]^=s[a]; s[d]=rotl(s[d],8)
    s[c]=(s[c]+s[d])&0xffffffff; s[b]^=s[c]; s[b]=rotl(s[b],7)
def chacha(key,w12,w13,w14,w15):
    st=[0x61707865,0x3320646e,0x79622d32,0x6b206574]+list(struct.unpack('<8I',key))+[w12,w13,w14,w15]
    w=st[:]
    for _ in range(10):
        qr(w,0,4,8,12); qr(w,1,5,9,13); qr(w,2,6,10,14); qr(w,3,7,11,15)
        qr(w,0,5,10,15); qr(w,1,6,11,12); qr(w,2,7,8,13); qr(w,3,4,9,14)
    return struct.pack('<16I',*[(w[i]+st[i])&0xffffffff for i in range(16)])

# find IDR frame (count>=1, biggest)
cand = None
for f in frames:
    c = f[8]
    if 1 <= c <= 8 and 9+c*8+40 < len(f) and len(f) > 5000:
        cand = f; break
if cand is None:
    print('no IDR candidate'); sys.exit(1)
nonce = cand[:8]; count = cand[8]; te = 9+count*8
table = cand[9:te]; data = bytearray(cand[te+1:])
a, b = struct.unpack_from('<II', table, 0)
print(f'IDR: count={count} a={a} b={b} datalen={len(data)}')

def key_candidates():
    out = [('raw', shared)]
    out += [('sha256', hashlib.sha256(shared).digest())]
    out += [('md5x2', (hashlib.md5(shared).digest()*2))]
    out += [('sha256(did|s)', hashlib.sha256(DID+shared).digest())]
    out += [('sha256(s|did)', hashlib.sha256(shared+DID).digest())]
    out += [('hmac(did,s)', hmac.new(DID, shared, hashlib.sha256).digest())]
    out += [('hmac(s,did)', hmac.new(shared, DID, hashlib.sha256).digest())]
    out += [('sha256(hexlower)', hashlib.sha256(shared.hex().encode()).digest())]
    out += [('sha256(hexupper)', hashlib.sha256(shared.hex().upper().encode()).digest())]
    out += [('md5hexx2', (hashlib.md5(shared.hex().encode()).digest()*2))]
    return out

def score(t):
    open('/tmp/bf.h264','wb').write(bytes(t))
    r = subprocess.run(['ffmpeg','-v','error','-i','/tmp/bf.h264','-f','null','-'],capture_output=True,text=True)
    return r.stderr.count('error while decoding')

results = []
for name, key in key_candidates():
    ks = chacha(key,0,0,*struct.unpack('<2I',nonce))[:16]
    t = bytearray(data)
    pos = 32
    while pos+16 <= b:
        ab = a+pos
        if ab+16 > len(t): break
        for k in range(16): t[ab+k] ^= ks[k]
        pos += 160
    e = score(t)
    results.append((e, name))
    print(f'{name}: errors={e}')
results.sort()
print('BEST:', results[0])
