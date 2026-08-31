# 🎥 Aqara Cameras Universal RTSP, 2-Way Talkback & MQTT Integration

[![Version](https://img.shields.io/badge/version-1.5.4-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-MQTT%20Discovery-orange.svg)](https://www.home-assistant.io/)
[![C++17 Engine](https://img.shields.io/badge/Native%20Engine-C%2B%2B17-00599C.svg)](app/native)

A high-performance bridge and streaming engine connecting **Aqara Cameras** to **Home Assistant** via **MQTT**, **Local RTSP**, and **2-Way Audio Talkback (RTMP)**.

While initially created for the **Aqara Camera Hub G5 Pro**, the architecture is fully universal and tested with multiple camera models (including **Aqara E1**, **G3**, etc.), with automatic capability detection for any number of cameras in your account.

---

## 📸 Supported Camera Models

| Model | Codename | Video & P2P RTSP | 2-Way Talkback | PTZ Controls | Spotlight | Tested Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Aqara Camera Hub G5 Pro** | `lumi.camera.agl004` | ✅ 3K / 1080p | ✅ | — (Fixed) | ✅ Dimmable | ✅ Verified |
| **Aqara Camera E1** | `lumi.camera.acn006` | ✅ 2K / 1080p | ✅ | ✅ Pan / Tilt | — | ✅ Verified |
| **Aqara Camera Hub G3** | `lumi.camera.acn001` | ✅ 2K / 1080p | ✅ | ✅ Pan / Tilt | — | 🧪 Compatible |
| **Aqara Camera Hub G2H Pro** | `lumi.camera.acn004` | ✅ 1080p | ✅ | — (Fixed) | — | 🧪 Compatible |
| **Aqara Camera Hub G2H** | `lumi.camera.gwac02/03` | ✅ 1080p | ✅ | — (Fixed) | — | 🧪 Compatible |
| **Aqara Smart Video Doorbell G4** | `lumi.camera.acn005` | ✅ 1080p | ✅ | — (Fixed) | — | 🧪 Compatible |

> 💡 **Have a different model?** See our [🤝 Collaboration & Device Testing](#-collaboration--device-testing) section!

---

## ✨ Key Features

### 🚀 High-Performance Native C++ Engine (`aqara-streamer`)
- **Zero-Copy Pipeline**: Written in pure C++17 with native POSIX sockets for decrypting ChaCha20 streams, reassembling fragmented AVIO/PPCS datagrams, and serving RTSP with near-zero CPU usage.
- **Auto-Build Guard**: Dynamic auto-compilation (`build-guard.ts`) with zero manual compiler setup.

### 🎥 Local RTSP Server (go2rtc / WebRTC / Frigate / VLC Compatible)
- **Direct P2P Bridge**: Bypasses cloud relaying by establishing direct local P2P tunnels to your cameras.
- **Zero-Drift Audio & Strict Clock Sync**: RFC 3640 AAC audio clock progression (+1024 samples per frame at 16 kHz), resolving audio drift and periodic dropouts.
- **Dynamic Port Allocation**: Sequential RTSP port allocation (`8555`, `8556`, ...) avoiding port collisions.

### 🎙️ 2-Way Audio Talkback (RTMP Ingest)
- Stream audio directly into your camera's speaker via RTMP (`rtmp://<host>:1935/talk/<slug>`).
- Full Home Assistant WebRTC / SIP / dashboard talkback integration.

### 🖼️ Live Snapshot HTTP Server & Stream Health Watchdog
- Dedicated HTTP server on port `8580` (auto-fallback if occupied) serving live JPEG snapshots at `http://<host>:8580/api/cameras/<slug>/snapshot`.
- **Intelligent Watchdog**: Snapshot-driven health monitoring automatically restarts degraded or frozen P2P streams with built-in cooldowns.

### 💾 Persistent State Across Reboots (`/data`)
- Full persistence for Home Assistant Add-ons and Docker via `/data/app_state.json`.
- Uses cross-process directory locking and atomic temp-file replacement (`fsync` + `rename`) to prevent file corruption.
- Auto-restores all enabled camera streams on add-on boot.

### 🎛️ Full Home Assistant MQTT Discovery
- **Switches**: P2P Stream toggle, AI Sound Detection, Human/Pet/Vehicle/Package Detection, Face Detection, Lens Obstruction, PIR Lingerer.
- **Controls**: PTZ Pan/Tilt buttons, System Volume, Alarm Volume, Alarm Tone, Spotlight brightness & state.
- **Sensors**: Live RTSP stream URL, Talkback RTMP URL, Snapshot URL, WiFi RSSI (dBm), SD Card storage (Total, Free, Used %).

---

## 🚀 Installation & Quick Start

### Option 1: Home Assistant Add-on (Recommended)

1. Add this repository to your Home Assistant Add-on Store repositories:
   ```text
   https://github.com/resonaura/aqara-g5pro-mqtt
   ```
2. Install the **Aqara Camera Integration** add-on.
3. Configure your Aqara credentials and MQTT settings in the add-on configuration tab.
4. Click **Start**. All cameras will appear automatically in Home Assistant!

---

### Option 2: Docker Compose

1. Clone the repository:
   ```bash
   git clone https://github.com/resonaura/aqara-g5pro-mqtt.git
   cd aqara-g5pro-mqtt
   ```

2. Run the interactive setup wizard to generate `.env`:
   ```bash
   cd app
   pnpm install
   pnpm run setup
   cd ..
   ```

3. Launch with Docker Compose:
   ```bash
   docker compose up --build -d
   ```

---

### Option 3: Local Node.js Installation

**Requirements:**
- Node.js **≥ 20.x** (tested on v22.x)
- `cmake` and C++17 compiler (`clang++` or `g++`)
- `ffmpeg` installed on the system (for live frame snapshots)

```bash
git clone https://github.com/resonaura/aqara-g5pro-mqtt.git
cd aqara-g5pro-mqtt/app

pnpm install
pnpm run setup   # Interactive wizard to generate .env
pnpm run build
pnpm start
```

---

## ⚙️ Configuration (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AQARA_USER` | — | Aqara account email or phone |
| `AQARA_PASS` | — | Aqara account password |
| `AQUARA_URL` | `https://aiot-rpc-usa.aqara.com` | Aqara Cloud region endpoint |
| `TOKEN` | — | Direct session token (if credentials are not used) |
| `MQTT_URL` | `mqtt://localhost:1883` | MQTT Broker address |
| `MQTT_USER` | — | MQTT username |
| `MQTT_PASS` | — | MQTT password |
| `RTSP_PORT` | `8555` | Base port for camera RTSP streams (`8555+N`) |
| `HTTP_PORT` | `8580` | Port for the HTTP snapshot server |
| `RTMP_PORT` | `1935` | Port for RTMP talkback audio ingest |
| `BRIDGE_HOST` | *(auto LAN IP)* | IP or domain advertised in MQTT stream URLs |
| `DATA_DIR` | `/data` or `./data` | Directory for persistent state and frame cache |

---

## 🤝 Collaboration & Device Testing

We want this project to support **every Aqara camera model in existence**! Because Aqara uses proprietary PPCS/AVIO encrypted protocols, expanding compatibility requires testing with real devices.

### How You Can Help

1. **Test Your Camera Model**:
   - If you have an **Aqara G2H**, **G2H Pro**, **G3**, **G4 Doorbell**, **P100**, or any regional variant, run the probe tool and let us know your results:
     ```bash
     cd app
     pnpm run list-p2p
     ```
2. **Report Issues & Stream Diagnostics**:
   - If audio, video, or PTZ controls behave unexpectedly on your model, open a GitHub Issue with:
     - Device model string (`lumi.camera.xxxx`)
     - Firmware version
     - Relevant diagnostic log lines (with credentials redacted)
3. **Submit Pull Requests**:
   - Check out our [Architecture Guide](app/native/README.md).
   - Ensure all unit and native tests pass:
     ```bash
     pnpm run build && pnpm test
     ```

### Contribution Rules & Guidelines
- **Zero Regression**: Changes to protocol reassembly must preserve compatibility with existing models.
- **Safe State Persistence**: Use `state.ts` for any persistent properties (with atomic file replacement and process locking).
- **Clean Architecture**: Media parsing and cryptographic routines belong in native C++ (`app/native`); orchestration, MQTT entities, and cloud APIs belong in TypeScript (`app/src`).

---

## 🛠 Useful CLI Tools

The repository includes convenient standalone tools for testing and debugging:

```bash
# List all cameras, credentials, and P2P connection strings
pnpm run list-p2p

# Test standalone RTSP streaming for all discovered cameras
pnpm run rtsp

# Probe P2P stream packets and inspect codec parameters
pnpm run probe

# Test 2-way talkback audio playback directly
pnpm run talkback:sample
```

---

## 📜 License

MIT License — Created and maintained by [resonaura](https://github.com/resonaura) and contributors.
Contributions and pull requests are warmly welcome!
