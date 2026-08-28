import struct, sys

pcap_file = '/tmp/aqara_talk.pcap'
cam_ip = '192.168.5.48'

with open(pcap_file, 'rb') as f:
    hdr = f.read(24)
    magic, = struct.unpack('<I', hdr[:4])
    endian = '<' if magic == 0xa1b2c3d4 else '>'

    pkts = []
    while True:
        b = f.read(16)
        if len(b) < 16: break
        ts_sec, ts_usec, incl_len, orig_len = struct.unpack(endian + 'IIII', b)
        data = f.read(incl_len)
        if len(data) < 42: continue

        # IP header offset assuming Ethernet (14)
        ip_hdr = data[14:34]
        proto = ip_hdr[9]
        if proto != 17: continue # UDP

        src_ip = '.'.join(map(str, ip_hdr[12:16]))
        dst_ip = '.'.join(map(str, ip_hdr[16:20]))
        src_port, dst_port = struct.unpack('>HH', data[34:38])
        udp_payload = data[42:]

        pkts.append({
            'ts': ts_sec + ts_usec / 1e6,
            'src_ip': src_ip,
            'src_port': src_port,
            'dst_ip': dst_ip,
            'dst_port': dst_port,
            'len': len(udp_payload),
            'payload': udp_payload
        })

print(f"Total UDP packets: {len(pkts)}")

# Filter packets involving cam_ip
cam_pkts = [p for p in pkts if p['src_ip'] == cam_ip or p['dst_ip'] == cam_ip]
print(f"Packets to/from camera {cam_ip}: {len(cam_pkts)}")

t0 = cam_pkts[0]['ts'] if cam_pkts else 0

outbound = [p for p in cam_pkts if p['dst_ip'] == cam_ip]
inbound = [p for p in cam_pkts if p['src_ip'] == cam_ip]

print(f"Outbound (App -> Cam): {len(outbound)}")
print(f"Inbound (Cam -> App): {len(inbound)}")

# Summary of outbound payload sizes & PPPP headers
print("\n--- Outbound Packets Summary (first 30 and non-ack) ---")
for p in outbound[:50]:
    rel_ts = p['ts'] - t0
    payload = p['payload']
    # Check PPPP header (4 bytes): [magic, msg_type, len_hi, len_lo]
    hdr_info = ""
    if len(payload) >= 4:
        magic = payload[0]
        msg_type = payload[1]
        msg_len = (payload[2] << 8) | payload[3]
        hdr_info = f"PPPP magic=0x{magic:02x} type=0x{msg_type:02x} len={msg_len}"
    print(f"[{rel_ts:8.3f}s] App -> Cam:{p['dst_port']} | UDP len={len(payload)} | {hdr_info}")
