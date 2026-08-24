# Aqara G5 Pro MQTT Bridge for Home Assistant

A Node.js bridge that connects the **Aqara Camera Hub G5 Pro** to **Home Assistant** via MQTT.  
It exposes all major camera features (detectors, spotlight control, volume, SD card monitoring) and integrates seamlessly using [Home Assistant MQTT Discovery](https://www.home-assistant.io/docs/mqtt/discovery/).

---

## ✨ Features

- **🎥 Multi-Camera Support**: Automatically discovers and connects all Aqara cameras in your account
- **🔍 Smart Capability Detection**: Automatically detects if camera supports spotlight before creating entities
- Full **Spotlight** as a `light` entity (ON/OFF + brightness) - only for supported cameras
- Switches (`switch`):
  - Lens Obstruction Detection
  - AI Sound Detection
  - Face Detection
  - Human Detection
  - Pets Detection
  - Vehicle Detection
  - Package Detection
  - Lingerer Detection (PIR)
- Numbers (`number`):
  - System Volume (%)
  - Alarm Volume (%)
  - Alarm Tone
  - Report Interval (seconds)
- Sensors (`sensor`):
  - WiFi RSSI (dBm)
  - WiFi Level
  - Alarm Status
  - P2P Stream
- SD Card sensors:
  - SD Card Total (MB)
  - SD Card Free (MB)
  - SD Card Used (%)
  - SD Card Status
- Automatic state synchronization after any command.
- Per-camera logging for easy identification.
- Guided setup with `npm run setup` (generates your `.env`).

---

## 🛠 Requirements

- Node.js **≈22.x** (tested on v22.16.0)
- Running MQTT broker (Mosquitto, EMQX, or Home Assistant MQTT add-on)

---

## 🚀 Installation

### Clone & run locally

```bash
git clone https://github.com/resonaura/aqara-g5pro-mqtt.git
cd aqara-g5pro-mqtt/app
npm install

# Run setup wizard to generate .env
npm run setup

npm run build
npm start
```

### Run with Docker

```bash
git clone https://github.com/resonaura/aqara-g5pro-mqtt.git
cd aqara-g5pro-mqtt/app
npm install

# Run setup wizard once on the host to generate .env
npm run setup

cd ../

docker compose up --build -d
```

⚠️ **Note:** The container requires a valid `.env` file.
You can generate it automatically via `npm run setup` before starting Docker.

---

## ⚙️ Configuration

All settings are provided via `.env`.
The setup wizard (`npm run setup`) asks for:

- Aqara account (username, password, region)
- MQTT broker URL, username, password

**Note**: The setup automatically discovers all cameras in your account - no need to select specific devices.

Example of generated `.env`:

```env
NODE_ENV=production
AQUARA_URL=https://aiot-rpc-usa.aqara.com
APPID=444c476ef7135e53330f46e7
TOKEN=xxxxxxxxxxxxxxxxxxxx
MQTT_URL=mqtt://192.168.1.100:1883
MQTT_USER=hauser
MQTT_PASS=hasecret
POLL_INTERVAL=5
LOG_LEVEL=info
```

### 🔑 Authentication

You can either provide a ready `TOKEN` or let the bridge log in automatically with your
Aqara account credentials (token is obtained via the signed `/user/login` endpoint):

```env
AQARA_USER=you@example.com
AQARA_PASS=yourpassword
```

If both `TOKEN` and credentials are provided, `TOKEN` takes precedence.
You can also verify credentials and list devices manually:

```bash
AQARA_USER=... AQARA_PASS=... npm run login
```

---

## ▶️ Usage

Start locally:

```bash
npm start
```

Start with Docker:

```bash
docker compose up -d
```

Check logs:

```bash
docker compose logs -f aqara-g5pro-mqtt
```

---

## 📡 How it works

1. On startup, the bridge connects to **Aqara Cloud API** and discovers all cameras in your account.
2. For each camera, checks capabilities (spotlight support, etc.) and publishes entity configs using MQTT Discovery.
3. Polls all cameras periodically (default every 5s) for state updates.
4. Commands from Home Assistant → forwarded to appropriate camera → updated states are published instantly.
5. Each camera gets its own unique device ID in Home Assistant for easy management.

---

## 📜 License

MIT — feel free to use, modify, and share.
