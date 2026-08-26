# Aqara Camera Bridge — Technical Reverse Engineering Report & Roadmap (Part 2)

**Document Purpose**: Detailed technical handover report explaining the architecture, reversed protocols, current blockers on Camera E1 (`lumi1.54ef4477da68`), and actionable investigation paths for achieving incoming P2P video frame stream.

---

## 1. Network & Device Topology

| Device Name | Model | DID | IP Address | Streaming Status | Protocols / Ports |
|---|---|---|---|---|---|
| **Outdoor Camera** | Camera Hub G5 Pro (`lumi.camera.agl004`) | `lumi3.a5e395b63ce5e6de` | `192.168.5.31` | **WORKING (Live 3K @ 20fps)** | Native RTSP on port `8554` (`rtsp://292:709@192.168.5.31:8554/ch1`), PPPP UDP `32108`, Matter over Wi-Fi |
| **Guinea Pigs Camera** | Camera E1 (`lumi.camera.acn006`) | `lumi1.54ef4477da68` | `192.168.4.22` | **P2P Connected / 0 Video Frames** | P2P ID: `AQARAUS-207160-BRSYM`, PPPP UDP `32108`, RTSP port `554` (Digest auth), Matter over Wi-Fi |

---

## 2. Reversed Protocols & Implemented Components

### 2.1 Aqara Cloud API Stack
- **Base URL**: `https://aiot-rpc-usa.aqara.com`
- **APPID**: `444c476ef7135e53330f46e7`
- **APPKEY**: `uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi`
- **Sign Algorithm**: `MD5("Appid=<APPID>&Nonce=<NONCE>&Time=<MS>[&Token=<TOKEN>]&[<BODY_OR_QS>&]APPKEY")`
- **Key Endpoints**:
  - `POST /app/v1.0/lumi/user/login`: RSA-PKCS1v15 encrypted MD5 password.
  - `GET /app/v1.0/lumi/devex/camera/p2p/info`: Returns `p2pId`, `devP2pPublicKey`, `initStringApp`.
  - `POST /app/v1.0/lumi/devex/camera/p2p/sign`: Takes `p2pAppPublicKey` (X25519), returns `sign`, `p2pDevPublicKey`, `time`.
  - `POST /app/v1.0/lumi/res/subscribe`: Subscribes to 26 device attributes.
  - `POST /app/v1.0/lumi/res/direct/query`: Queries live attributes directly from device.

### 2.2 PPPP (TUTK / Kalay) Transport Protocol
- **Discovery**: Send `[0xF1, 0x30, 0x00, 0x00]` broadcast to UDP `32108`.
- **Handshake Sequence**:
  1. Camera responds with `0x41` (PUNCH) on a dynamic session port (e.g. `12485`, `18417`).
  2. Client echoes `0x41` with payload + sends `0x42` (RDY).
  3. Camera sends `0x42` (RDY).
  4. Client responds with `0x43` (RDY_ACK).
  5. Camera and Client continuously exchange `0xE0` (ALIVE request) and `0xE1` (ALIVE ack).
- **Transport Packet Framing**:
  - Unencrypted header: `[0xF1, type, length_be (2 bytes), payload...]`
  - DRW Data frame: `[0xD1, channel, seq_be (2 bytes), payload...]` (Type `0xD0` or `0xD8`).

### 2.3 PPCS Proprietary Cipher (Reversed from `libPPCS_API.so`)
- **Key Source**: First 20 bytes after `:` in `initStringApp` (e.g., `aqaraus19kn`).
- **Algorithm**: CFB-like stream cipher with 256-byte substitution table `TABLE`.
- **Seed Derivation**:
  - `s[0] = sum(key_bytes) & 0xff`
  - `s[1] = (-sum(key_bytes)) & 0xff`
  - `s[2] = sum((b * 0xab) >> 9) & 0xff`
  - `s[3] = xor(key_bytes) & 0xff`
- **Native Implementation**: Implemented in TypeScript (`bridge.ts`), Python, and Java Unidbg (`AqaraP2PClient.java`).

### 2.4 Java / Unidbg Execution Environment
- Located in `app/signer/`.
- Uses Unidbg ARM32 emulator to load `liblumidevsdk.so` (cloud signature & decrypt) and `libPPCS_API.so` (P2P APIs).
- Builds via Maven to shaded JAR `app/signer/target/aqara-signer-1.0.0.jar`.

---

## 3. The Core Issue: Why Camera E1 Does Not Emit Video Frames

When running `src/scripts/test_stream_start_sync.ts` or `src/scripts/test_e1_p2p_exact.ts`:
1. The UDP socket connects directly to `192.168.4.22`.
2. The PPPP handshake completes (`0x41` -> `0x42` -> `0x43`).
3. Keepalive packets (`0xE0`/`0xE1`) flow without dropping.
4. Channel 0 commands (`0x1000` Login, `0x1020` Start Stream, `0x1022` Clarity, `0x1028` Get Frame) are transmitted.
5. **Result**: The camera receives the UDP packets and acknowledges them at the PPPP layer, but the camera daemon on the device does **not** push H.264 frames to Channel 4. Total video frames = `0`.

---

## 4. Actionable Paths & Clues for Unlocking Video Frames

### Clue 1: Capture a Byte-for-Byte Android App Live Session (Highest Yield)
The Android app `com.lumiunited.aqarahome.play` communicates with the E1 camera over local Wi-Fi.
- **Action**: Run Android emulator or rooted phone with Aqara Home, open Guinea Pigs Camera live stream, and capture a `tcpdump` / Wireshark `.pcap` on port 32108 and 554.
- **Look for**:
  - The exact payload of the first `0xD0`/`0xD8` packet sent from App to Camera.
  - Check whether Channel 0 uses JSON, Protobuf, or binary structs for `0x1000` / `0x1020`.
  - Check whether RDT (Reliable Data Transfer, packet type `0x50` / `0x51` / `0x52`) is initialized prior to DRW streaming.

### Clue 2: Matter / CHIP Local Controller (`CameraAvStreamManagementCluster`)
In `libdatajar.so`, both G5 Pro and E1 reference:
- `CameraAvStreamManagementCluster`
- `CameraAvStreamManagementClusterVideoStreamAllocateResponseCallback`
- `ChipDeviceController`
- `getCameraRTSPEnableTrait` / `getCameraRTSPURLTrait`
- **Action**: The camera exposes Matter over Wi-Fi. A Matter controller script can issue the `VideoStreamAllocate` command to the `CameraAvStreamManagement` cluster, which activates the hardware video encoder and returns either the dynamic RTSP credentials or opens the P2P video stream.

### Clue 3: The Exact Binary Format of `sendStreamStartRequestSync`
In `P2pConnectorV2` (`libdatajar.so`):
- `sendStreamStartRequestSync` handles `handleSession`, `videoStream` (0=1520p, 1=1080p, 2=SD), and `streamType`.
- Look into `P2pCameraControlRequestBody` and `P2pFrameHeader` in `libdatajar.so`. If the camera expects a 16-byte binary AVIO struct `[channel:4, stream:4, resolution:4, fps:4]` instead of a JSON string, sending binary framing will trigger the encoder.

### Clue 4: RTSP Digest Auth Password on Port 554
- Port `554` on `192.168.4.22` is **open** and running an RTSP server (`realm="smDgsJ4"`).
- In `libdatajar.so`, `CameraPropertyRepository` has `CameraRTSPEnable` and `CameraRTSPURL`.
- If the RTSP stream is enabled via local Matter cluster write or Cloud attribute write, the camera provides direct RTSP streaming identical to G5 Pro.

---

## 5. Quick Test Commands

```bash
# 1. Test G5 Pro Live RTSP Stream (WORKING)
ffplay -rtsp_transport tcp "rtsp://292:709@192.168.5.31:8554/ch1"

# 2. Test E1 P2P Stream Sequence
cd /Users/resonaura/aqara-g5pro-mqtt/app
npx tsx src/scripts/test_e1_p2p_exact.ts

# 3. Test Java Unidbg Native P2P Client
cd /Users/resonaura/aqara-g5pro-mqtt/app/signer
java -cp target/aqara-signer-1.0.0.jar com.aqara.signer.AqaraP2PClient

# 4. Probe RTSP Auth on Port 554
python3 src/scripts/test_rtsp_auth_e1.py
```
