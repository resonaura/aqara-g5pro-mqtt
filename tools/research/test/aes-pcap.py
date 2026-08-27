import struct
import hashlib
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PPCS_TABLE = bytes.fromhex(
  '7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc1'
  '1fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a3'
  '88ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb1'
  '0e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af42'
  '37d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479'
  'd24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7'
  '336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c8'
  '18e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17'
)

def decrypt(key, data):
    k = key[:20].encode()
    tot = sum(k)
    sx = 0
    s3 = 0
    for b in k:
        sx ^= b
        s3 += (b * 0xab) // 512
    seeds = [tot & 0xff, (-tot) & 0xff, s3 & 0xff, sx & 0xff]
    out = bytearray(len(data))
    out[0] = PPCS_TABLE[seeds[0]] ^ data[0]
    fb = data[0]
    for i in range(1, len(data)):
        out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i]
        fb = data[i]
    return bytes(out)

# Extract Frame 0 from capture
with open('captures/e1_emu_20260825_174235.pcap', 'rb') as f:
    gh = f.read(24)
    linktype = struct.unpack('<I', gh[20:24])[0]
    frags = {}
    frame0 = None
    while True:
        ph = f.read(16)
        if len(ph) < 16: break
        ts_sec, ts_usec, caplen, origlen = struct.unpack('<IIII', ph)
        p = f.read(caplen)
        if len(p) < caplen: break
        iph = 20 if linktype == 276 else 14
        proto = struct.unpack('>H', p[0:2] if linktype==276 else p[12:14])[0]
        if proto == 0x0800 and p[iph] >> 4 == 4 and p[iph+9] == 17:
            ihl = (p[iph] & 0xf) * 4
            uh = iph + ihl
            sp, dp, ulen = struct.unpack('>HHH', p[uh:uh+6])
            data = p[uh+8:uh+ulen]
            if len(data) > 20:
                pkt = decrypt('aqaraus19kn', data)
                if pkt[:2] == b'\xf1\xd0' and pkt[4:6] == b'\xd1\x01':
                    idx = struct.unpack('>H', pkt[6:8])[0]
                    pay = pkt[8:]
                    frags[idx] = pay
                    if len(pay) < 1024:
                        max_idx = max(frags.keys())
                        frame0 = b''.join(frags[i] for i in range(max_idx + 1) if i in frags)
                        break

print('Frame 0 total length:', len(frame0))
iv = frame0[32:48]
ciphertext = frame0[48:]
# Pad ciphertext to 16 bytes multiple if needed
if len(ciphertext) % 16 != 0:
    ciphertext = ciphertext[:-(len(ciphertext) % 16)]

# Candidate keys from REPORT.md and session
cand_keys = [
    bytes.fromhex('fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf'),
    bytes.fromhex('9461184abf94f783a19f92767030b1a169d4f67ddd1127671400624a6fab90ab'),
    bytes.fromhex('ac26a631ba91b5d91f7fd9d8ac2105b5610ca5bdbaf1861152b6ecb82e332f1b'),
    bytes.fromhex('2743f758746a3e61b30c98b3533208904d599a0610d38932d5d18a9eddec61a5'),
    b'aqaraus19kn\x00\x00\x00\x00\x00',
    b'AQARAUS-207160-BRSYM'[:16],
    hashlib.md5(b'lumi1.54ef4477da68').digest(),
    hashlib.md5(b'AQARAUS-207160-BRSYM').digest(),
]

for i, k in enumerate(cand_keys):
    for key_bytes in [k[:16], k[:32]] if len(k) >= 32 else [k[:16]]:
        cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv))
        decryptor = cipher.decryptor()
        try:
            plain = decryptor.update(ciphertext) + decryptor.finalize()
            if b'\x00\x00\x00\x01' in plain[:100] or plain[:4] == b'\x00\x00\x00\x01':
                print(f'🎉 Found AES plaintext key {i} ({len(key_bytes)} bytes)!')
                print('Decrypted bytes:', plain[:32].hex())
        except Exception as e:
            pass

print('Done checking candidate keys.')
