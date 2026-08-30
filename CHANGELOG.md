# Changelog

## v1.4.5 — Fix: missing USER_ID in .env

- **Root cause**: `setup.ts` generated `.env` with `TOKEN` but omitted `USER_ID` from the login response. `aqara.ts` initialized `USER_ID` to empty string and never read it from `process.env`. API requests lacked the `Userid` header, so the Aqara server returned an empty device list.
- **Fix**: `setup.ts` now extracts `userId` from `resp.data.result.userId` and writes `USER_ID=${userId}` into `.env`. `aqara.ts` initializes `USER_ID` from `process.env.USER_ID || ""`.
- **Build**: `dist/` rebuilt with both changes.

## v1.4.4 — Fix: dotenv / login order

- **Root cause**: `dotenv.config()` ran inside `config.ts` (after imports). `aqara.ts` captured `process.env.TOKEN = ""` at module load time — so after `setup.js` wrote `.env`, `index.ts` still used empty token and failed `getCameras()`.
- **Fix**: `dotenv.config()` moved to line 1 of `index.ts`; `config.ts` cleaned.
- **Setup**: `.env` generation verified (`TOKEN`, `AQUARA_URL`, `APPID` all correct).

## v1.4.3

### ✨ New: Frame Snapshot Endpoint

- **On-demand JPEG snapshots**: When P2P Stream is ON, a dedicated `ffmpeg` process pulls a full JPEG frame from the RTSP stream every **10 seconds** and caches it to `data/frames/<slug>.jpg`
- **HTTP server**: Built-in HTTP server (port `HTTP_PORT` / default 8080) serves cached frames at `GET /frame/<slug>` with `Content-Type: image/jpeg` — activated only while P2P Stream is running
- **MQTT discovery**: `sensor.frame_url` publishes the frame endpoint URL whenever a new frame is cached — auto-disabled when P2P Stream is turned off
- **Resource-efficient**: Snapshotter is completely separate from the transcoder pipeline; zero extra ffmpeg processes unless P2P Stream is active. JPEG file is overwritten in-place (no accumulation)

### 📝 Updated

- `app/src/index.ts` — imports `path`, `FrameSnapshotter`, `FrameHttpServer`; starts HTTP server on boot; spawns/kills snapshotter per bridge lifecycle
- `app/src/snapshot.ts` — new: `FrameSnapshotter` class (single ffmpeg grab per tick, file overwritten in-place)
- `app/src/http-server.ts` — new: `FrameHttpServer` class (`/frame/<slug>`, `/health`, `/frames/list`)

## v1.4.2

### 🔧 Fixed

- `app/Dockerfile` — added `ffmpeg` to runtime stage (`apt-get install ... ffmpeg`)
- `tsconfig.build.json` — added `include: ["src/**/*"]` so `dist/scripts/setup.js` builds correctly for HA add-on
- `app/package.json` — corrected JSON syntax (was broken after 1.4.0 version bump)

### ✨ P2P → Integrated RTSP

- **No separate `pnpm run rtsp`**: RTSP server fully integrated into main `index.ts` via `AqaraCameraBridge`; starts when `p2p_stream` ON, stops when OFF
- **On-demand FFmpeg**: `FfmpegTranscoder` activates only when P2P Stream is ON (`TRANSCODE_VIDEO=true`); off by default, conserves CPU/memory
- **Talkback audio**: Works via RTMP ingest (`rtmp://host:1935/talk/<slug>`) when P2P active

### 🔇 Logging

- Only `p2p_stream`, `talkback`, `ptz_*` events + errors logged during normal polling
- Optimistic updates and per-attribute polling spam removed

## v1.4.1 - Build Fix: tsconfig scripts

### 🔧 Fixed

- **Build**: `tsconfig.build.json` — `src/scripts` excluded, missing `dist/scripts/setup.js` in HA add-on. Removed exclusion so scripts build correctly
- **Build**: `app/package.json` — JSON syntax error (`version:` unquoted) broke Docker `npm install`

### ✨ New Features

- **Docker FFmpeg**: `apt-get install -y ffmpeg` added to runtime stage — transcoder works out of the box
- **Integrated RTSP**: P2P RTSP streams are managed directly by the main app (`index.ts`) via the `p2p_stream` MQTT switch; server starts/stops with bridge lifecycle. No standalone `pnpm run rtsp` required
- **On-demand transcoding**: `FfmpegTranscoder` activates only when P2P is ON (default OFF), conserving resources

### 🔇 Logging

- Removed flood of `⬅️ HA →` messages; only `p2p_stream`, `talkback`, `ptz_*` events logged
- Removed `⚡ ... optimistic` noisy updates
- Removed per-attribute `📊` polling logs; only spotlight/SD-card changes kept

## v1.3.1 - Optimistic State Updates

### ✨ New Features

- **Optimistic UI**: switches, numbers and the spotlight publish their expected state to MQTT
  immediately on command (before the cloud round-trip), then confirm with a real attribute poll
  after 2 seconds — no more toggle flip-back in Home Assistant

## v1.3.0 - Motion Sensor + RTSP Stream

### ✨ New Features

- **Motion binary_sensor**: generic per-camera motion entity. Polls `detect_*_event`
  attribute timestamps; any change publishes `ON` to `homeassistant/binary_sensor/<id>/motion/state`,
  auto-`OFF` after `MOTION_RESET` seconds (default 30). Verified live on Camera E1
- **RTSP Stream sensor** (G5 Pro family): fetches the camera's stream URLs from the
  cloud `rtsp_url` attribute and publishes the highest-quality one as
  `sensor.rtsp_stream` — ready for go2rtc / Frigate / Generic Camera in HA.
  Verified: H264 2688×1520 + AAC on port 8554 (`ch1`…`ch4` = 1520p→360p)
- **Spotlight verified end-to-end**: ON/OFF + brightness via `res/write`
  (`white_light_enable` / `white_light_level`) work against the G5 Pro

### 🔎 Research notes

- Camera E1 exposes detection events as cloud attributes; G5 Pro does not store
  detection events in the cloud at all — they only travel through the phone push
  channel (`wss://<host>/app/v1.0/lumi/push/ws/aqarahome`, subscription via
  `/app/v1.0/lumi/res/subscribe`, exact body format still unknown)
- G5 Pro has no ONVIF; E1 has neither RTSP nor events

## v1.2.0 - Working Authentication (Sign + AppKey)

### ✨ New Features

- **Working login**: The `/app/v1.0/lumi/user/login` endpoint works again — the sign formula
  now appends the app's `APPKEY` (`uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi`) to the signed string:
  `MD5("Appid=..&Nonce=..&Time=..[&Token=..][&body]&APPKEY")`, empty segments omitted
- **Automatic login**: If `TOKEN` is not set, the bridge logs in with `AQARA_USER`/`AQARA_PASS`
- **New `npm run login` script**: Verify credentials and list account devices
- **Per-request signing**: All API requests are now signed (Sign header) with Token/Userid headers

### 🔧 Fixed

- Requests rejected with `code=106 "Invalid sign"` — caused by missing APPKEY in the signature
- POST bodies are now serialized before signing so the signature matches the exact payload

## v1.1.0 - Multi-Camera Support

### ✨ New Features

- **Automatic multi-camera support**: The application now automatically discovers and connects all available Aqara cameras in your account
- **Smart capability detection**: Automatically detects if a camera supports spotlight before publishing discovery to Home Assistant
- **Improved device filtering**: More accurate camera detection using `lumi.camera` model prefix

### 🔧 Breaking Changes

- **Removed SUBJECT_ID**: No longer need to specify a specific camera ID in configuration
- **Updated setup script**: No longer requires selecting a specific camera - supports all automatically

### 📋 Technical Details

#### Modified Files:

- `src/aqara.ts`:
  - Added `getCameras()` function to retrieve all cameras
  - Added `checkDeviceCapabilities()` function to check camera capabilities
  - Updated filtering to use `lumi.camera` model prefix
- `src/discovery.ts`:
  - Added `hasSpotlight` parameter for conditional spotlight publishing
- `src/index.ts`:
  - Completely rewritten logic to support multiple cameras
  - Updated polling and command handling functions
- `src/config.ts`:
  - Removed `SUBJECT_ID` validation
- `src/scripts/setup.ts`:
  - Removed specific camera selection
  - Improved camera filtering

#### New Behavior:

1. On startup, the application automatically discovers all cameras in the account
2. For each camera, checks for spotlight support
3. Publishes entities to Home Assistant for all discovered cameras
4. Each camera gets a unique ID based on its DID

### 🚀 Migration

For users upgrading from previous versions:

1. Remove `SUBJECT_ID` from .env file (if present)
2. Restart the application - it will automatically discover all cameras

### 📝 Notes

- If a camera doesn't have a spotlight, the corresponding light entity won't be created
- All other functions (sensors, switches, SD card) work for all cameras
- Logs now show camera names for better identification
