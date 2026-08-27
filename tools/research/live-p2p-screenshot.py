import socket
import time
import struct
import json
import urllib.request
import hashlib
import os

APP_ID = "444c476ef7135e53330f46e7"
APP_KEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi"
BASE_URL = "https://aiot-rpc-usa.aqara.com"
DID = "lumi1.54ef4477da68"

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

def md5(s):
    return hashlib.md5(s.encode()).hexdigest()

def encrypt(key, data):
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
    fb = out[0]
    for i in range(1, len(data)):
        out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i]
        fb = out[i]
    return bytes(out)

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

def punch_payload(p2p_id):
    parts = p2p_id.split('-')
    pre, num, suf = parts[0], int(parts[1]), parts[2]
    b = bytearray(20)
    b[:len(pre)] = pre.encode('ascii')
    b[9] = (num >> 16) & 0xff
    b[10] = (num >> 8) & 0xff
    b[11] = num & 0xff
    b[12:12+len(suf)] = suf.encode('ascii')
    return bytes(b)

def build_pppp(msg_type, payload=b''):
    return struct.pack('>BBH', 0xF1, msg_type, len(payload)) + payload

def build_lumi(msg_type, seq, payload=b''):
    return b'lumi' + struct.pack('<III', msg_type, seq, len(payload)) + payload

# 1. Login to Aqara Cloud
account = os.environ.get("AQARA_USER", "user@example.com")
password = os.environ.get("AQARA_PASS", "password")
req = urllib.request.Request(
    f"{BASE_URL}/app/v1.0/lumi/auth/pwd/login",
    data=json.dumps({"account": account, "password": md5(password)}).encode(),
    headers={"Content-Type": "application/json", "Appid": APP_ID}
)
with urllib.request.urlopen(req) as resp:
    login_res = json.loads(resp.read().decode())
token = login_res['result']['token']
print("   ✅ Logged in, token obtained.")

# 2. Get P2P Info
headers = {"Content-Type": "application/json", "Appid": APP_ID, "Token": token}
req = urllib.request.Request(f"{BASE_URL}/app/v1.0/lumi/devex/camera/p2p/info?did={DID}", headers=headers)
with urllib.request.urlopen(req) as resp:
    p2p_info = json.loads(resp.read().decode())['result']
p2p_id = p2p_info['p2pId']
key_str = p2p_info.get('initStringApp', '').split(':')[-1] or 'aqaraus19kn'
print(f"   ✅ P2P ID: {p2p_id}, Key: {key_str}")

# 3. Generate X25519 and Sign
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives import serialization
priv = x25519.X25519PrivateKey.generate()
pub_raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.Format.Raw)
pub_hex = pub_raw.hex()

req = urllib.request.Request(
    f"{BASE_URL}/app/v1.0/lumi/devex/camera/p2p/sign",
    data=json.dumps({"did": DID, "p2pAppPublicKey": pub_hex}).encode(),
    headers=headers
)
with urllib.request.urlopen(req) as resp:
    sign_res = json.loads(resp.read().decode())['result']
print("   ✅ Signed App Public Key.")

# 4. Connect via UDP
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(('0.0.0.0', 0))
sock.settimeout(0.1)
local_port = sock.getsockname()[1]
punch_data = punch_payload(p2p_id)

# TUTK Master Servers
tutk_servers = [("54.71.80.151", 32100), ("54.214.103.243", 32100), ("3.23.78.166", 32100)]
req20 = bytearray(36)
req20[:20] = punch_data
struct.pack_into('<H', req20, 20, 2)
struct.pack_into('<H', req20, 22, local_port)
req20[24:28] = bytes(map(int, "192.168.5.191".split('.')[::-1]))

hello_pkt = encrypt(key_str, build_pppp(0x00))
query_pkt = encrypt(key_str, build_pppp(0x20, req20))
punch_pkt = encrypt(key_str, build_pppp(0x41, punch_data))

print("2. Connecting to Camera via P2P Hole Punching...")
connected = False
cam_addr = None
endpoints = [("192.168.5.48", 20185), ("192.168.5.48", 27694), ("192.168.5.48", 23969)]

start_time = time.time()
while time.time() - start_time < 5 and not connected:
    for s_ip, s_port in tutk_servers:
        sock.sendto(hello_pkt, (s_ip, s_port))
        sock.sendto(query_pkt, (s_ip, s_port))
    for ep_ip, ep_port in endpoints:
        sock.sendto(punch_pkt, (ep_ip, ep_port))
    
    try:
        data, addr = sock.recvfrom(2048)
        pkt = data
        if pkt[0] != 0xF1:
            pkt = decrypt(key_str, pkt)
        if pkt[0] == 0xF1:
            m_type = pkt[1]
            pay = pkt[4:]
            if m_type == 0x40 and len(pay) >= 8:
                port = (pay[3] << 8) | pay[2]
                ip = f"{pay[7]}.{pay[6]}.{pay[5]}.{pay[4]}"
                if (ip, port) not in endpoints:
                    endpoints.append((ip, port))
                sock.sendto(punch_pkt, (ip, port))
            elif m_type == 0x41:
                cam_addr = addr
                sock.sendto(punch_pkt, cam_addr)
                sock.sendto(encrypt(key_str, build_pppp(0x42, punch_data)), cam_addr)
            elif m_type == 0x42:
                cam_addr = addr
                sock.sendto(encrypt(key_str, build_pppp(0x43)), cam_addr)
                connected = True
    except socket.timeout:
        pass

if not connected:
    print("❌ Could not connect to camera!")
    exit(1)

print(f"   ✅ Connected directly to Camera at {cam_addr[0]}:{cam_addr[1]}!")

def send_enc_drw(chan, idx, lumi_data):
    inner = struct.pack('>BBH', 0xD1, chan, idx) + lumi_data
    h = struct.pack('>BBH', 0xF1, 0xD0, len(inner))
    sock.sendto(encrypt(key_str, h + inner), cam_addr)

def send_ack(chan, idx):
    ack_pay = struct.pack('>BBBBH', 0xD1, chan, 0x00, 0x01, idx)
    ack_hdr = struct.pack('>BBH', 0xF1, 0xD1, len(ack_pay))
    sock.sendto(encrypt(key_str, ack_hdr + ack_pay), cam_addr)

# Keepalive E0
sock.sendto(encrypt(key_str, build_pppp(0xE0)), cam_addr)
time.sleep(0.1)

# Login 0x1000
print("3. Sending Lumi Login (0x1000)...")
login_json = json.dumps({
    "app_public_key": pub_hex,
    "app_sign": sign_res['sign'],
    "device_id": DID,
    "timestamp": str(sign_res['time'])
}).encode()
send_enc_drw(0, 0, build_lumi(0x1000, 10, login_json))
time.sleep(0.3)

# Keepalive 0x1024
send_enc_drw(0, 1, build_lumi(0x1024, 11))
time.sleep(0.1)

# Session Start 0x1002
send_enc_drw(0, 2, build_lumi(0x1002, 12))
time.sleep(0.1)

# Stream Start 0x101C on Channel 3
print("4. Starting H.264 Video Stream on Channel 3...")
send_enc_drw(3, 0, build_lumi(0x101C, 13))

print("5. Receiving and reassembling live video stream...")
frags = {}
h264_stream = bytearray()
frame_count = 0
keyframe_count = 0
record_start = time.time()

while time.time() - record_start < 8:
    try:
        data, addr = sock.recvfrom(2048)
        pkt = data
        if pkt[0] != 0xF1:
            pkt = decrypt(key_str, pkt)
        if pkt[0] == 0xF1:
            m_type = pkt[1]
            pay = pkt[4:]
            if (m_type == 0xD0 or m_type == 0xD8) and len(pay) >= 4 and pay[0] == 0xD1:
                chan = pay[1]
                idx = struct.unpack('>H', pay[2:4])[0]
                c_data = pay[4:]
                send_ack(chan, idx)
                
                if chan == 1 or chan == 4:
                    if idx == 0:
                        frags[chan] = [c_data]
                    elif chan in frags:
                        frags[chan].append(c_data)
                    
                    if len(c_data) < 1024 and chan in frags:
                        full = b''.join(frags[chan])
                        del frags[chan]
                        frame_count += 1
                        
                        # Find NAL start code (0x00000001 or 0x000001)
                        pos = full.find(b'\x00\x00\x00\x01')
                        if pos != -1:
                            nal_data = full[pos:]
                            h264_stream.extend(nal_data)
                            if b'\x00\x00\x00\x01\x67' in nal_data:
                                keyframe_count += 1
                                print(f"   🌟 Keyframe (SPS/PPS/IDR) #{keyframe_count} captured! ({len(nal_data)} bytes)")
    except socket.timeout:
        pass

sock.close()
print(f"\n🎉 Capture Complete: {frame_count} total frames, {keyframe_count} keyframes, {len(h264_stream)} bytes H.264 data.")

stream_file = "/tmp/e1_live_perfect.h264"
with open(stream_file, "wb") as f:
    f.write(h264_stream)
print(f"💾 Saved to {stream_file}")

artifact_dir = "/Users/resonaura/.gemini/antigravity/brain/d4589a3a-9262-44f2-83af-0c160a3b7bd9"
shot1 = f"{artifact_dir}/live_screenshot1.jpg"
shot2 = f"{artifact_dir}/live_screenshot2.jpg"

print("6. Extracting clean JPEG screenshots with ffmpeg...")
os.system(f"/opt/homebrew/bin/ffmpeg -y -i {stream_file} -ss 00:00:01 -vframes 1 -q:v 2 {shot1}")
os.system(f"/opt/homebrew/bin/ffmpeg -y -i {stream_file} -ss 00:00:04 -vframes 1 -q:v 2 {shot2}")

print(f"📸 Screenshot 1: {shot1} (size: {os.path.getsize(shot1) if os.path.exists(shot1) else 0} bytes)")
print(f"📸 Screenshot 2: {shot2} (size: {os.path.getsize(shot2) if os.path.exists(shot2) else 0} bytes)")
