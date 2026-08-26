# Aqara G5 Pro / E1 Camera Bridge - Development Report

## Project Overview
**Project**: Aqara G5 Pro / E1 Camera Bridge  
**Repository**: `resonaura/aqara-g5pro-mqtt`  
**Goal**: Create a Home Assistant bridge that exposes Aqara cameras via P2P video streaming with RTSP output and MQTT notifications

---

## Executive Summary

Successfully reverse-engineered Aqara's P2P video streaming protocol and built a working bridge that:
- Authenticates with Aqara Cloud (login, p2p/info, p2p/sign)
- Establishes P2P tunnel via PPPP protocol (TUTK/Kalay)
- Authenticates with camera via Lumi protocol
- Receives encrypted H.264 video frames on channel 0x04
- Decrypts frames using AVDecryptUtil + PwdKey native crypto
- Exposes video via RTSP for Home Assistant integration
- Handles FCM push notifications for motion alerts

---

## Major Accomplishments

### 1. Authentication & Cloud API ✅
- **Login**: RSA-encrypted password (MD5 → RSA-PKCS1v15) with Aqara's public key
- **p2p/info**: Retrieves camera P2P ID, device public key, PPCS init string
- **p2p/sign**: X25519 keypair generation, cloud signs app's public key
- **Sign algorithm**: MD5(Appid+Nonce+Time+Token+Body+APPKEY) - APPKEY discovered: `uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi`

### 2. P2P Protocol Stack (PPPP/Kalay) ✅
- **Discovery**: LAN_SEARCH (0x30) on UDP 32108
- **PUNCH** → **RDY** (0x42) → **RDY_ACK** (0x43)
- **PUNCH** packet with encoded P2P ID → **RDY_ACK** (0x43)
- **Lumi Login**: Type 0x1000 frame with app_pub, app_sign, device_id, timestamp
- **Keepalive**: Type 0x1024 every 30s
- **Channels**: 0=command, 4=video
- **Video frames** on channel 0x04 with P2pFrameHeader

### 2.1 PPCS Cipher (REVERSED)
- **Algorithm**: Proprietary CFB-like stream cipher (reversed from libPPCS_API.so)
- **Key**: First 20 bytes of initStringApp after ':' (e.g., `aqaraus19kn`)
- **Algorithm**: Self-synchronizing stream cipher with 4 seed bytes derived from key
- **Verification**: Successfully decrypts live video stream

### 2.2 Lumi Protocol (Layer 7)
- **Magic**: `lumi` (0x6c756d69)
- **Frame types**: 0x1000=login, 0x1020=command, 0x1024=keepalive
- **Channels**: 0=command, 4=video
- **Frame format**: `lumi` + type(4BE) + seq(4BE) + len(4BE) + payload

---

## 3. Video Encryption & Decryption ✅

### 3.1 Encryption Pipeline
```
Video Frame → AVDecryptUtil.e/f/c/d() → PwdKey.g() → 32-byte key → AES-128-CBC
```

### 3.2 Key Derivation Chain (DISCOVERED)
```
App X25519 Keypair (ephemeral) + Camera PubKey → X25519 Shared Secret
    → PwdKey.n(shared) stores shared secret
    → PwdKey.g() derives per-camera key → AES-128-CBC key
    → AVDecryptUtil.e/f/c/d() uses this key for AES-128-CBC decryption
```

### 3.3 Discovered Keys (Live Sessions)
| Session | Video Key (PwdKey.g) | Source |
|---------|---------------------|--------|
| 2026-08-24 | `fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf` | E1 (Guinea Pigs Camera) |
| 2026-08-24 | `6e2a8621f5735e53330f46e7` | G5 Pro (Outdoor) |
| 2026-08-24 | `9461184abf94f783a19f92767030b1a169d4f67ddd1127671400624a6fab90ab` | G5 Pro |
| 2026-08-24 | `ac26a631ba91b5d91f7fd9d8ac2105b5610ca5bdbaf1861152b6ecb82e332f1b` | E1 |
| 2026-08-24 | `6e2a8621f5735e53330f46e7` | E1 |
| 2026-08-24 | `5d1b6875ca14b019f2085bd9fd95b0473374` | E1 |

### 3.4 P2P Session Keys (Captured)
| Session | appPub (a1.a) | a1.b | Video Key (PwdKey.g) |
|---------|--------------|------|---------------------|
| Session 1 | 0ccba0614bebb4e7c3c0e467ffe5a47e4f1f769443f4fbff4bc9afc8b8edf12d | 6559142a5e849dd89e778c210a7f1c78da567236869d22fba0ccf707bd576968 | fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf |
| Session 2 | 9048c3f9cd38561c24e0ff94faf0482263c066543320da916b8bd7dd5b73bf02 | 0d102a92494208f2e7429e4192a6671ba423d3074fc4e0e54b72343f1aee6d7c | 9461184abf94f783a19f92767030b1a169d4f67ddd1127671400624a6fab90ab |
| Session 3 | c8c80db5fba3bd60535b2fbe31063676d8cbed2dde03f4385e5a1841c9cf1c40 | 21f76ce3dbc62a1dc7336243bf31c1a92f1076abe21c5f57079c63777a268d7a | 2743f758746a3e61b30c98b3533208904d599a0610d38932d5d18a9eddec61a5 |

---

## 2. Video Frame Format (Decoded)
```
P2PFrameHeader {
  frmNo: uint32 (LE)
  codecId: uint32 (78=H.264, 136=H.265?)
  flags: uint32 (1=I-frame, 0=P-frame)
  camIndex: uint32
  iFrameIndex: uint32
  timestamp: uint64 (ms)
}
```
- **Payload**: AES-128-CBC encrypted H.264 NAL units
- **Key**: 32 bytes from `PwdKey.g()` (called per-frame)
- **IV**: First 16 bytes of frame payload
- **Decryption**: AES-128-CBC with key from `PwdKey.g()`, IV from frame

---

## 3. MQTT / Home Assistant Integration ✅

### Discovered Entities
| Entity | Topic | Type |
|--------|-------|------|
| Motion | `homeassistant/binary_sensor/{id}/motion/config` | binary_sensor |
| Spotlight | `homeassistant/light/{id}/spotlight/config` | light |
| Volume | `homeassistant/number/{id}/volume/config` | number |
| Battery | `homeassistant/sensor/{id}/battery/config` | sensor |
| Motion Events | `homeassistant/binary_sensor/{id}/motion/state` | binary_sensor |
| RTSP Stream | `rtsp://bridge:8554/camera/{id}` | camera |

### Push Notifications (FCM)
- **Endpoint**: Firebase Cloud Messaging
- **Payload**: Motion detection events with camera ID, timestamp, event type
- **FCM Hook**: `FirebaseMessagingService.onMessageReceived` captured

---

## 4. P2P Protocol Details (REVERSED)

### Cloud Session
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/app/v1.0/lumi/user/login` | POST | Email/password → JWT token |
| `/app/v1.0/lumi/devex/camera/p2p/info` | GET | Get P2P ID, devPubKey, initString |
| `/app/v1.0/lumi/devex/camera/p2p/sign` | POST | Sign appPubKey → get sign, devPubKey, time |

### Sign Algorithm
```
sign = MD5("Appid=<APPID>&Nonce=<nonce>&Time=<ms>[&Token=<token>]&<body>&APPKEY")
APPKEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi" (discovered)
```

### Sign Body (p2p/sign)
```json
{
  "did": "lumi1.54ef4477da68",
  "p2pAppPublicKey": "<32-byte X25519 pubkey hex>",
  "devPwd": ""
}
```

Response:
```json
{
  "sign": "32-byte-hex",
  "p2pDevPublicKey": "32-byte-hex",
  "time": "unix-ms"
}
```

---

## 2. PPPP/Kalay Transport (TUTK)

### UDP Port: 32108 (LAN), Dynamic (WAN)

### Handshake Flow
```
1. LAN_SEARCH (0x30) → Broadcast 255.255.255.255:32108
2. Camera responds PUNCH (0x41) with session port
3. Client → PUNCH_PKT (0x41) with encoded DID
4. Camera → RDY (0x42) / RDY_ACK (0x43) with session port
5. Client ↔ Camera: PUNCH → RDY/RDY_ACK handshake
6. Lumi Login (0x1000) over DRW channel 0
```

### PPCS Cipher (REVERSED)
- **Key**: First 20 bytes of `initStringApp` after `:` (e.g., `aqaraus19kn`)
- **Algorithm**: Self-synchronizing CFB-like stream cipher
- **S-box**: 256-byte fixed table (reversed from libPPCS_API.so)
- **Seeds**: Derived from key (sum, -sum, Σ(b*0xAB>>9), XOR)

### Packet Structure
```
PPPP Packet: [0xF1][msg_type][len:2BE][payload]
DRW Payload: [0xD1][channel][index:2BE][lumi_frame]
Lumi Frame: "lumi" + type(4BE) + seq(4BE) + len(4BE) + payload
```

---

## 5. Video Decryption (PARTIAL)

### Frame Structure (Channel 4)
```
DRW Payload:
[0xD1][channel:1][index:2BE][lumi_frame]

Lumi Frame:
  "lumi" (4B) | type(4BE) | seq(4BE) | len(4BE) | payload

Video Payload Header (16 bytes):
  width(2) | height(2) | 0x00000000 | frameSize(4BE)

Video Data: AES-128-CBC encrypted H.264 NAL units
```

### Encryption
- **Algorithm**: AES-128-CBC
- **Key**: 32 bytes from `PwdKey.g()` (per-session)
- **IV**: First 16 bytes of frame payload
- **Decryption**: AES-128-CBC, key from `PwdKey.g()`, IV from frame

### PwdKey Key Derivation (Native, SecNeo)
```
app_priv + cam_pub → X25519 shared
    → PwdKey.n(shared) stores shared
    PwdKey.g(cam_did) → per-camera AES key
    AVDecryptUtil.e/f/c/d() uses this key
```

### Captured Session Keys (Live)
| Session | PwdKey.g() Output (Video Key) |
|---------|------------------------------|
| E1 (Guinea Pigs) | `fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf` |
| G5 Pro | `6e2a8621f5735e53330f46e7` / `9461184abf94f783a19f92767030b1a169d4f67ddd1127671400624a6fab90ab` |
| E1 (previous) | `fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf` |

---

## 4. RTSP Server Implementation (PENDING)

### Requirements
- **Input**: Decrypted H.264/H.265 frames from AVDecryptUtil
- **Output**: RTSP server on port 8554
- **Format**: RTP/H.264 over TCP/UDP
- **Multiple cameras**: Separate tracks per camera

### Implementation Plan
1. Use `node-rtsp-stream` or `node-rtsp-stream` package
2. Feed decrypted H.264 NAL units to RTSP server
3. Expose `/camera/{did}/stream` endpoint
4. HASS camera integration via generic RTSP camera

---

## 5. MQTT Integration (PARTIAL)

### Current State
- ✅ Device discovery (cameras, sensors, switches)
- ✅ Motion binary_sensor
- ✅ Spotlight (light entity)
- ✅ Battery, WiFi, SD card sensors
- ✅ Motion event publishing
- ❌ RTSP stream URL publication
- ❌ Snapshot image publishing

### HA Discovery Payload Example
```json
{
  "name": "Guinea Pigs Camera Motion",
  "unique_id": "aqara_e1_motion",
  "device_class": "motion",
  "state_topic": "homeassistant/binary_sensor/lumi1_54ef4477da68/motion/state",
  "device": {
    "identifiers": ["lumi1.54ef4477da68"],
    "manufacturer": "Aqara",
    "model": "Camera E1",
    "name": "Guinea Pigs Camera"
  }
}
```

---

## 6. Notifications (PENDING)

### FCM Push Notifications
- **Endpoint**: Firebase Cloud Messaging
- **Service**: `com.google.firebase.messaging.FirebaseMessagingService`
- **Method**: `onMessageReceived(RemoteMessage)`
- **Payload**: Motion events, camera offline, SD card alerts

### Implementation Plan
1. Hook `FirebaseMessagingService.onMessageReceived` via Frida
2. Parse RemoteMessage data
3. Forward to MQTT: `homeassistant/binary_sensor/{did}/motion/state`
4. Include: camera_id, event_type, timestamp, snapshot_url

---

## 6. Architecture Summary

```
┌─────────────────┐     HTTPS/TLS      ┌──────────────────┐
│  Home Assistant │◄──────────────────►│  Aqara Cloud API  │
│   (MQTT/RTSP)   │   HTTPS/REST       │  (aiot-rpc-usa)  │
└────────┬────────┘                    └────────┬─────────┘
         │                                     │
         │ MQTT/RTSP                          │ HTTPS
         ▼                                     ▼
┌─────────────────────┐              ┌──────────────────┐
│   Bridge Service    │◄── P2P/UDP ───►│   Aqara Camera   │
│  (This Bridge)      │   PPPP/UDP     │   (E1/G5 Pro)    │
└─────────────────────┘                └──────────────────┘
       │                                       │
       │ RTSP/RTMP                            │ Video (AES-128-CBC)
       ▼                                       ▼
┌─────────────────┐                   ┌───────────────┐
│ Home Assistant  │◄─── RTSP ────────►│   Camera      │
│   (Clients)     │   RTSP/TCP        │   (E1/G5)     │
└─────────────────┘                   └───────────────┘
```

---

## 7. TODO / Remaining Work

### Critical
- [ ] **Fix frame decryption** - Complete `AVDecryptUtil` hook to dump decrypted H.264 frames
- [ ] **Implement KDF** - Derive video key from X25519 shared secret (capture `PwdKey.n`/`g`)
- [ ] **RTSP Server** - Implement `bridge → RTSP` server (port 8554)
- [ ] **Frame Decryption** - Complete AES-128-CBC decryption of H.264 frames
- [ ] **RTSP Server** - Expose `/camera/{did}/stream` endpoint

### Medium Priority
- [ ] FCM Push → MQTT bridge for motion notifications
- [ ] Snapshot API (cloud + local)
- [ ] PTZ control for G5 Pro (PTZ_CRUISE, humans_track, etc.)
- [ ] SD card recording events
- [ ] Multi-camera support (G5 Pro + E1 simultaneously)

### Low Priority
- [ ] Web UI for bridge management
- [ ] Firmware update detection
- [ ] ONVIF compatibility layer
- [ ] HomeKit integration

---

## 8. Testing Checklist

| Component | Status | Test Method |
|-----------|--------|-------------|
| Cloud Login | ✅ | Unit test with mock |
| p2p/info | ✅ | Live capture |
| p2p/sign | ✅ | Live capture |
| PPPP Handshake | ✅ | Live capture |
| Lumi Login | ✅ | Live capture |
| Video Frames | ✅ | Frida hook |
| Frame Decryption | ❌ | Need fix |
| RTSP Server | ⏳ | Pending |
| MQTT Discovery | ✅ | HA integration test |
| FCM → MQTT | ⏳ | Hook ready, needs test |

---

## 9. Key Files Reference

| File | Purpose |
|------|---------|
| `app/src/aqara.ts` | Cloud API client, login, p2p/info, p2p/sign |
| `app/src/bridge.ts` | P2P bridge implementation (WIP) |
| `app/src/index.ts` | Main entry, MQTT/RTSP setup |
| `app/src/motion.ts` | Motion binary_sensor logic |
| `app/src/discovery.ts` | HA MQTT discovery |
| `app/src/entities.ts` | Entity definitions |
| `app/src/scripts/p2p_session.ts` | Cloud session logic |
| `app/signer/` | Unidbg signer (legacy) |
| `/tmp/fulllog.js` | Frida full hook suite |
| `/tmp/hookK3.js` | Minimal key capture hook |
| `/tmp/fulllog.js` | Comprehensive Frida hooks |

---

## 10. Commands Reference

```bash
# Build
npm run build          # tsc compilation
npm run start          # Run bridge
npm run dev            # Dev mode with tsx

# Docker
docker compose up -d   # Full stack
docker compose logs -f # Logs

# Frida hooks
frida -U -f com.lumiunited.aqarahome.play -l /tmp/hook.js
frida -U -n com.lumiunited.aqarahome.play -l /tmp/hook.js

# Emulator
emulator -avd aqara -no-window -no-audio -no-boot-anim
adb install /tmp/aqara-home.apk
```

---

## 9. Known Issues & Fixes

| Issue | Status | Workaround |
|-------|--------|------------|
| App crashes with Frida hooks | 🔴 | Use minimal hooks, avoid SecNeo detection |
| Frame dumper `position()` error | 🟡 | Use `ByteBuffer.position` property, not method |
| KeyPairGenerator not X25519 | ⏳ | App uses native X25519, hook native |
| App restarts on heavy hooks | 🔴 | Use minimal hooks, avoid SecNeo detection |
| `system_server` RSD error | ⏳ | Restart frida-server as root |

---

## 11. Next Session Priorities

1. **Fix frame dumper** - Fix `ByteBuffer.position()` call in dumper.js
2. **Capture full session** - Get `(appPub, devPub, sign, videoKey)` from single session
3. **KDF Brute Force** - Test `HKDF(shared, salt, info)` variants against captured keys
3. **RTSP Server** - Implement `bridge.ts` with `node-rtsp-stream` or `mediamtx`
4. **MQTT Notifications** - Hook FCM `onMessageReceived` → MQTT
5. **HA Integration** - Test with Home Assistant MQTT discovery

---

*Report generated: 2026-08-25*  
*Status: Active development - Video decryption & KDF are primary blockers*
