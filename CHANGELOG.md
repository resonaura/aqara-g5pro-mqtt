# Changelog

## v1.5.8 — Offline Card Ticker Fix, Keyframe Lifecycle & Backoff Watchdog

### 🩺 Offline Card & Reconnect Lifecycle Fixes
- **True Video Frame Verification**: Fixed premature `keyframe` and `stream_started` event emission during P2P session setup in `bridge.ts`. The bridge now waits for actual H.264/HEVC keyframe NALs to arrive from the camera before declaring the stream online.
- **Continuous Offline Card Ticker**: Resolved a bug where `OfflineCardManager` state was cancelled and reset to `1s` every 5 seconds. The offline card ticker now continuously renders and publishes updated elapsed seconds (`Offline for 15s`, `Offline for 45s`, etc.) throughout the entire offline period.
- **Exponential Reconnect Backoff**: Watchdog reconnect attempts now properly increment (`attempt #1`, `attempt #2`, `attempt #3`...) with progressive cooldown intervals (`15s` $\rightarrow$ `60s`) instead of resetting back to attempt #1 immediately.
- **FFmpeg Concurrency Guard**: Added `isRendering` protection in `OfflineCardManager` to prevent overlapping background FFmpeg card generation processes.
- **C++ Watchdog Throttling**: Native `P2PClient` now throttles `unhealthy` event emissions to once every 15 seconds, eliminating log flood when a camera is powered off or disconnected from Wi-Fi.

## v1.5.7 — Protocol Enums, Abbreviation Standardization & Docker PNPM Pipeline

### 📡 Strongly-Typed Protocol Enums & Documentation
- **PPCS & Lumi Protocol Headers**: Extracted all magic byte codes into typed enums `PpcsMsgType` and `LumiCmdType` across C++ (`protocol.hpp`) and TypeScript (`protocol.ts`), with detailed documentation for every opcode (`0x1000` Login, `0x1001` Login OK, `0x1002`/`0x1003` Session Init, `0x100A` PTZ/Talk Start, `0x100B` Talkback Ready, `0x100C` Talk Stop, `0x100E` Resolution Switch, `0x1018` Keyframe Request, `0x101C` Stream Request).
- **Abbreviation Standardization**: Standardized all acronyms across C++ and TypeScript to uppercase (`PPCS`, `P2P`, `RTSP`, `RTMP`, `HTTP`, `MQTT`, `PTZ`, `SD`, `AVIO`).

### 🐳 Home Assistant Supervisor & Docker Build
- **Pure PNPM Containerization**: Switched `app/Dockerfile` to `corepack` with `pnpm@11.21.0` and `--frozen-lockfile` layer caching, eliminating `npm` peer-dependency resolution errors (`ERESOLVE`) on `better-sqlite3` and `typeorm`.
- **Prebuild Approval**: Configured `pnpm-workspace.yaml` `allowBuilds: better-sqlite3: true` for prebuilt native sqlite bindings.
- **Root Scripts Parity (DRY)**: Synchronized all workspace root npm scripts 1:1 with `app/package.json`.
- **Gitignore Cleanliness**: Added auto-generated build files (`compile_commands.json`, `*.sqlite*`) to `.gitignore`.

## v1.5.6 — SQLite TypeORM Persistence, Oxlint Integration & Addon Build Fix

### 🗄️ SQLite3 & TypeORM Persistence Layer
- **TypeORM & better-sqlite3**: Replaced file-based JSON state storage with a structured SQLite database (`storage.sqlite`) using TypeORM with `synchronize: true` (no manual migrations required).
- **Entities**: Defined typed entities for `CameraStateEntity`, `GlobalSettingEntity`, and `RtspPortEntity`.
- **Zero Data-Loss Auto-Migration**: Legacy `app_state.json`, `p2p_state.json`, and `rtsp_ports.json` are automatically imported into SQLite tables upon first startup.
- **Oxlint & Code Quality**: Integrated `oxlint` with Prettier and Clang-Format in `lint:all` pipeline for instant TypeScript static analysis (0 warnings, 0 errors).
- **Tarball Glaze FetchContent**: Switched CMake `FetchContent` to use direct GitHub release tarball URLs, resolving build errors in environments where `git` is absent.
- **Docker Build Dependencies**: Added `git`, `python3`, and `ca-certificates` to `app/Dockerfile` and root `Dockerfile`.
- **Repository Cleanup**: Purged old Java signer prototypes (`app/signer/`, 42 MB), deprecated `.so` libraries, obsolete PCAPs, and research markdown notes.

## v1.5.5 — Stream Watchdog Event Propagation, Self-Healing Auto-Retry & Snapshot Hard-Timeout

### 🩺 Self-Healing Stream Auto-Recovery
- **Complete Event Propagation Pipeline**: `NativeMediaEngine` and `AqaraCameraBridge` now properly capture, normalize, and forward `unhealthy` stall events emitted by the native C++ engine to the application watchdog loop.
- **Persistent Exponential Auto-Retry**: If a camera experiences a Wi-Fi dropout or power cycle (resulting in initial reconnection failure), the bridge now automatically schedules retries with exponential backoff (10s $\rightarrow$ 60s) instead of abandoning the stream.
- **FFmpeg Snapshotter Hangs**: Added hard 7-second timeout to prevent snapshots from deadlocking on audio-only streams.
- **Gaussian-Blurred Offline HUD Card Generator**: Generates an informative standby image with Gaussian blur (`gblur=sigma=22`) based on the camera's last live frame. Displays camera name, detailed current reconnect status, active seconds ticker (`Offline for Xs`), and formatted timestamp.
- **Zero-Drop RTSP Preservation**: The C++ RTSP server stays alive and listening during P2P network stalls or camera Wi-Fi reconnects. Clients (Home Assistant, go2rtc, WebRTC, VLC) remain connected without TCP disconnections or broken pipes.
- **Modern Glaze C++23 JSON Serialization**: Refactored native IPC server to use StephenBerry/Glaze high-performance typed JSON reflection for zero-allocation command parsing and event dispatch.
- **Process & Timer Cleanup**: Cleanly close readline interfaces and unref background timer loops to prevent zombie processes and memory leaks.
- **RTSP Disconnect Log Deduplication**: Prevented multi-NAL `Broken pipe` / `Connection reset by peer` terminal log spam when RTSP players close connections.
- **Boot Stream Restore Deduplication**: Eliminated duplicate stream restore on MQTT connect.

## v1.5.4 — Dedicated Video Stream Watchdog, Direct LAN Routing & Polling Log Deduplication

### 📹 Dedicated Video Stream Watchdog & Recovery
- **Independent Video Traffic Tracking**: `P2pClient` now tracks `last_video_traffic_ms_` separately from audio traffic. Continuous audio streams (e.g. on E1 cameras) no longer mask frozen/stalled video frames.
- **Progressive Stream Recovery**: If video traffic pauses for >6s, the native engine requests a new IDR keyframe and resends `0x101C`/`0x1002` stream start commands; after 20s of silence, it emits an `unhealthy` event to trigger full tunnel reconnect.
- **Direct LAN IP Routing**: Automatically binds `cameraIp` and port `32108` in `ensureCameraBridge`, ensuring direct low-latency LAN communication and eliminating WAN/relay disconnects.
- **Accurate RTSP Slug Mapping**: Bridges now explicitly set `rtspPath: live/${slug}` matching the Home Assistant entity and snapshot endpoints.

### 🧹 Polling Log Deduplication
- Sensor and switch polling logs now output to the console only when attribute values change (`📊 Camera attr: oldVal ➔ newVal`), completely eliminating terminal spam during steady-state operation.
- Reassembler periodic audio logs silenced in non-debug mode.

## v1.5.3 — Stream Health Watchdog & Home Assistant Persistent `/data` Volume

### 🩺 Stream Health Watchdog & Auto-Recovery
- **Snapshot-Driven Stream Health**: `FrameSnapshotter` continuously monitors video frame capture. If 3 consecutive snapshot attempts fail (30s without valid frames) or the stream freezes, it flags the stream as unhealthy.
- **Smart Auto-Reconnect**: Automatically restarts the P2P tunnel and RTSP pipeline for degraded cameras with intelligent cooldowns (20s backoff) to prevent thrashing.
- **Immediate State Recovery**: Resets error counts and confirms health as soon as fresh frames arrive.

### 💾 Home Assistant OS Persistent Volume (`/data`)
- **Docker / Add-on Persistence**: Dynamic data directory resolution prioritizes Home Assistant's mounted `/data` volume for `app_state.json`, `rtsp_ports.json`, and `frames/`. State is completely preserved across add-on updates and host reboots.
- **Instant Boot Restoration**: Saved camera P2P streams are auto-restored immediately on add-on startup in parallel with MQTT connection.

## v1.5.2 — P2P State Persistence Across Reboots & Instant Stream Entities Update

### 💾 P2P Stream State Persistence
- **Persistent State across Reboots**: P2P stream switch state is now stored to disk (`data/p2p_state.json`). When the Home Assistant add-on or Docker container reboots, all cameras that had P2P active automatically resume streaming without manual intervention.
- **No Overwriting on Discovery**: Add-on boot no longer forces `OFF` over retained MQTT topics on reconnect.

### 🖼️ Real-Time Snapshot & Sensor Entity Updates
- **Bridge Event Alignment**: Added missing `rtsp_ready` event dispatching in `AqaraCameraBridge` when native session starts, ensuring immediate snapshotter startup.
- **Immediate State Synchronization**: Upon enabling P2P stream, `p2p_rtsp_stream`, `talkback_rtmp`, and `snapshot_url` sensors are immediately published to MQTT with active URLs.
- **Immediate Snapshot Capture**: `FrameSnapshotter` captures and serves snapshots immediately as soon as the stream starts.

## v1.5.1 — Clean Inactive Entity States & Auto-Allocated HTTP Snapshot Port

### 🖼️ HTTP Snapshot Port (Default 8580 & Auto-Correction)
- **Port Range Alignment**: Moved default HTTP frame snapshot server from the busy port `8080` to `8580` (within the camera `85xx` port block).
- **Auto Port Allocation**: If `8580` (or `HTTP_PORT`) is already in use by another service, `findFreePort` automatically probes and binds to the next available free port.
- **Localhost RTSP Ingest**: `FrameSnapshotter` connects directly to `127.0.0.1` for local frame grabbing, avoiding external LAN interface routing, firewall blocks, or hairpin NAT issues.

### 🧹 Clean `null` States for Inactive Stream Entities
- **Accurate MQTT States**: When P2P stream is OFF or stopped, `p2p_rtsp_stream`, `snapshot_url`, and `talkback_rtmp` sensor states are set to `null` instead of retaining stale/inaccessible URLs.
- **Native RTSP Sensor**: Publishes `null` when native RTSP stream URL is unavailable.

## v1.5.0 — Native C++ Streaming Engine, Zero-Drift Audio & Stream Stability

### 🚀 High-Performance Native C++ Engine (`aqara-streamer`)
- **Native Pipeline**: Replaced Node.js AVIO packet reassembly, ChaCha20 decryption, and RTSP serving with a high-performance native C++17 engine (`app/native`). Zero external dependencies, pure POSIX sockets, and multi-threaded IPC.
- **Dynamic Auto-Build**: Built-in build guard (`build-guard.ts`) automatically compiles and hashes native sources across platforms with zero configuration.

### 🔊 Zero-Drift Audio & RTSP Stability
- **Audio RTP Timing Fix**: Strict RFC 3640 / RFC 6416 audio clock progression (+1024 samples per AAC frame at 16 kHz), completely resolving the 24 ms/sec drift and eliminating periodic 15–20s audio dropouts.
- **Audio Deduplication**: Exact hardware timestamp deduplication in `AvioReassembler::process_completed_audio` to discard retransmitted PPCS audio datagrams.
- **RTSP Parameter Keepalive**: Added `GET_PARAMETER`, `SET_PARAMETER`, and `OPTIONS` with `Session:` header to keep go2rtc, WebRTC, VLC, and FFmpeg connections alive indefinitely.

### 📹 Stream Startup & Protocol Alignment (Frida Reverse-Engineering)
- **Official Handshake Sequence**: Aligned P2P handshake with official Aqara Home app captures:
  - `0x1000` (Login): Clean JSON payload with `timestamp`, `app_sign`, `app_public_key`.
  - `0x1001` (Login OK): Immediately dispatches `0x101C` (channel 3) and `0x1002` (channel 0).
  - `0x1003` (Session Ready): Sets target quality and requests live IDR keyframe `0x1018`.
  - Added support for `0x82` PPCS RDT data datagrams.
- **Watchdog Stream Stabilization**: Removed periodic `0x1002`/`0x1024` watchdog commands during active streaming (which were causing camera encoder resets and audio dropouts). Kept alive via standard `0xE0` ALIVE pings.

### 🔑 Security & Key Management
- **Ephemeral X25519 Keys**: Removed static disk-cached keys (`data/keys`). Every session generates fresh ephemeral X25519 ECDH keypairs and signs them on-the-fly via cloud API.

### 🧹 Stream Cleanliness & Artifact Elimination
- **Live Edge PLAY**: Removed stale 10-second GOP dumps on `PLAY`. Connecting clients immediately receive a fresh live IDR keyframe with in-band SPS/PPS, eliminating the 10-second grey macroblock smear on connect.

### 🏠 Home Assistant & Docker Support
- **Multi-Arch Docker Builds**: Full support for `amd64`, `aarch64`, `armv7`, `armhf`, and `i386` architectures.
- **Full HA Integration**: Host networking, sequential multi-camera RTSP port allocation (8555+), RTMP talkback, PTZ controls, spotlight, and motion sensors.

## v1.4.6 — Fix: dotenv import hoisting

- **Root cause**: ES module `import` hoisting caused `aqara.ts` to load and capture `process.env.TOKEN = ""` before `dotenv.config()` ran. The `TOKEN` and `USER_ID` module-level variables were frozen at empty strings, so API requests lacked the `Token` and `Userid` headers.
- **Fix**: Replaced module-level `let TOKEN`/`let USER_ID` captures with `getToken()`/`getUserId()` functions that read `process.env.TOKEN`/`process.env.USER_ID` at call time. `login()` now writes to `process.env` directly.
- **Build**: `dist/` rebuilt.

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
