import struct
import hashlib
import subprocess
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

with open('/tmp/e1_hq_feed.h264', 'rb') as f:
    raw = f.read()

print('Raw stream length:', len(raw))

# Find the first I-frame (length > 30000)
# In raw stream, frames were concatenated
# Let's find SPS 00 00 00 01 67
sps_pos = raw.find(b'\x00\x00\x00\x01\x67')
print('SPS found at:', sps_pos)

if sps_pos != -1:
    frame_candidate = raw[sps_pos : sps_pos + 45000]
    print('Testing candidate slice from offset', sps_pos)
