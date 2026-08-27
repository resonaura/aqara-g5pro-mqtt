import struct
import subprocess

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

with open('captures/e1_emu_20260825_174235.pcap', 'rb') as f:
    gh = f.read(24)
    linktype = struct.unpack('<I', gh[20:24])[0]
    raw_pkts = []
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
                    raw_pkts.append((idx, pkt))
                    if len(pkt) < 1032 and len(raw_pkts) > 10:
                        break

print(f'Collected {len(raw_pkts)} raw packets for Frame 0')

# Test different offsets for idx == 0 and idx > 0
# For idx == 0: pkt is [0..7] header + [8..39] AVIO (32 bytes) + [40..55] IV (16 bytes) + [56..] payload
for off0 in [48, 49, 56, 57]:
    for offN in [8, 12, 16, 20, 24, 32, 40, 48]:
        chunks = []
        for idx, pkt in raw_pkts:
            if idx == 0:
                chunks.append(pkt[off0:])
            else:
                chunks.append(pkt[offN:])
        frame = b''.join(chunks)
        with open('/tmp/test_candidate.h264', 'wb') as f:
            f.write(frame)
        res = subprocess.run(
            ['/opt/homebrew/bin/ffmpeg', '-v', 'error', '-i', '/tmp/test_candidate.h264', '-f', 'null', '-'],
            capture_output=True, text=True
        )
        err = res.stderr.strip()
        num_err_lines = len(err.split('\n')) if err else 0
        if num_err_lines < 5:
            print(f'✨ MATCH! off0={off0}, offN={offN}: {num_err_lines} errors -> {err[:100]}')
        else:
            first_line = err.split('\n')[0] if err else 'clean'
            # print(f'off0={off0}, offN={offN}: {num_err_lines} errors ({first_line[:60]})')
