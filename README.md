# Aqara G5 Pro MQTT Bridge for Home Assistant

A Node.js bridge that connects the **Aqara Camera Hub G5 Pro** to **Home Assistant** via MQTT.  
It exposes all major camera features (detectors, spotlight control, volume, SD card monitoring) and integrates seamlessly using [Home Assistant MQTT Discovery](https://www.home-assistant.io/docs/mqtt/discovery/).

---

## ✨ Features

- Full **Spotlight** as a `light` entity (ON/OFF + brightness).
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
- Logging with emoji for clarity.
- Auto-generation of `.env.example` from schema in development mode.

---

## 🚀 Installation

### Clone & run locally

```bash
git clone https://github.com/resonaura/aqara-g5pro-mqtt.git
cd aqara-g5pro-mqtt-bridge
npm install
npm run build
npm start
```

### Run with Docker

Build and start using `docker compose`:

```bash
docker compose up --build -d
```

**docker-compose.yml (MQTT broker not included):**

```yaml
version: "3.8"

services:
  aqara-g5pro-mqtt:
    build: .
    container_name: aqara-g5pro-mqtt
    restart: unless-stopped
    env_file: .env
    environment:
      - NODE_ENV=production
    volumes:
      - .:/usr/src/app
```

---

## ⚙️ Configuration

All settings are provided via `.env`.
An `.env.example` file is automatically generated in development.

Example:

```env
NODE_ENV=production
AQUARA_URL=https://aiot-rpc-usa.aqara.com
APPID=your_appid
TOKEN=your_token
SUBJECT_ID=lumi3.your_device_id
MQTT_URL=mqtt://192.168.1.100:1883
MQTT_USER=hauser
MQTT_PASS=hasecret
POLL_INTERVAL=5
LOG_LEVEL=info
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

1. On startup, the bridge connects to **Aqara Cloud API** and your **MQTT broker**.
2. Publishes entity configs using MQTT Discovery.
3. Polls the camera periodically (default every 5s).
4. Commands from Home Assistant → forwarded to Aqara → updated states are published instantly.

## 📜 License

MIT — feel free to use, modify, and share.
