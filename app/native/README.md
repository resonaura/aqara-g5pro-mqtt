# 🚀 Aqara Native Media Engine (`aqara-streamer`)

A lightweight, zero-dependency C++17 streaming daemon designed for high-throughput, low-latency RTSP streaming and media reassembly from Aqara cameras.

---

## 🏗 Architecture

```text
               +-------------------------------------------------+
               |             Node.js / TypeScript App            |
               +-------------------------------------------------+
                                      |  (JSON IPC via stdio)
                                      v
+---------------------------------------------------------------------------------+
|                       aqara-streamer (Native C++ Engine)                       |
|                                                                                 |
|  +---------------------+   +---------------------+   +-----------------------+  |
|  |  P2P Tunnel Client  |-->|  ChaCha20 Decryptor |-->|   AVIO Reassembler    |  |
|  | (UDP/PPCS Protocol) |   | (Hardware Accelerated)| |(Annex-B & ADTS Parser)|  |
|  +---------------------+   +---------------------+   +-----------------------+  |
|                                                                  |              |
|                                                                  v              |
|                                                      +-----------------------+  |
|                                                      |      RTSP Server      |  |
|                                                      |  (RFC 3640 / RFC 6184)|  |
|                                                      +-----------------------+  |
+---------------------------------------------------------------------------------+
                                      |
                                      v
                     RTSP Stream: rtsp://<host>:8555/live/<slug>
```

---

## 📂 Source Structure

- **`src/crypto/`**:
  - `chacha20.cpp` / `chacha20.hpp`: High-performance ChaCha20 symmetric cipher (8-byte nonce, counter 0).
- **`src/media/`**:
  - `reassembler.cpp` / `reassembler.hpp`: AVIO packet de-fragmentation, NAL Annex-B framing (`00 00 00 01`), SPS/PPS extraction, and ADTS audio parsing.
- **`src/p2p/`**:
  - `client.cpp` / `client.hpp`: UDP socket transport, PPCS packet framing (`0x80`, `0x82`, `0xE0`), login handshake (`0x1000`/`0x1001`), and session keepalive.
  - `cipher.cpp` / `cipher.hpp`: Per-session symmetric cipher setup.
- **`src/rtsp/`**:
  - `server.cpp` / `server.hpp`: Non-blocking POSIX RTSP server with RTP video (H.264/H.265 FU-A packetization) and RTP audio (RFC 3640 AAC at 16 kHz).
- **`src/ipc/`**:
  - `server.cpp` / `server.hpp`: Thread-safe JSON line-based protocol over `stdin`/`stdout`.
- **`src/session.cpp`**: Multi-camera lifecycle orchestration.

---

## 🛠 Building & Testing

### Manual Build

```bash
cd app/native
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
```

### Run Native Tests

```bash
./aqara-reassembler-test
```
