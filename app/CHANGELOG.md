## 1.4.2

- **Docker FFmpeg + RTSP fixes**: `ffmpeg` in `app/Dockerfile`; `tsconfig.build.json` includes `src/scripts`; `package.json` JSON fixed
- **P2P → RTSP integrated** in main app (no `pnpm run rtsp`); FFmpeg on-demand when P2P ON (default OFF); talkback via RTMP

## 1.4.1

- **Fix**: `tsconfig.build.json` — removed `src/scripts` from exclude so `dist/scripts/setup.js` builds correctly for HA add-on
- **Fix**: `app/package.json` — corrected JSON syntax after version bump

### ✨ New Features

- **Docker: FFmpeg**...
- **Docker: FFmpeg in image**: Root `Dockerfile` now installs `ffmpeg` in the runtime stage, enabling the built-in video transcoder (error concealment, deblocking, HEVC→H.264 passthrough) for P2P RTSP streams
- **RTSP: seamless integration**: RTSP server is now fully integrated into the main app — it activates automatically when P2P Stream is turned ON via Home Assistant switch, and releases all resources when turned OFF. No separate `pnpm run rtsp` process needed
- **RTSP: on-demand FFmpeg**: FFmpeg transcoder is spawned only when P2P Stream is active, keeping CPU/memory usage minimal when streaming is disabled

### 🔇 Logging Optimizations

- **Reduced noise**: Main app no longer logs every MQTT message or attribute publish during polling. Only meaningful events are logged:
  - P2P Stream enable/disable actions
  - Talkback channel toggles
  - PTZ button presses
  - Camera connection/disconnection events
  - Stream ready notifications
  - Error conditions
- **Optimistic updates**: State change commands are now silent (previously logged every optimistic publish)
- **Polling**: Attribute updates from polling no longer flood logs (only spotlight state changes and SD card events)

## 1.3.1

- **Feature**: Optimistic state updates — expected state is published to MQTT instantly on command, confirmed by a real poll after 2s

## 1.3.0

- **Feature**: Generic Motion `binary_sensor` per camera — polls `detect_*_event` attribute timestamps, publishes ON on any detection event and OFF after `MOTION_RESET` seconds (default 30). Verified live on Camera E1
- **Feature**: RTSP Stream sensor for G5 Pro family — publishes the highest-quality stream URL from the cloud `rtsp_url` attribute (`ch1`…`ch4` = 1520p→360p on camera port 8554)
- **Verified**: Spotlight ON/OFF + brightness via `res/write` work end-to-end on G5 Pro

## 1.2.0

- **Feature**: Working authentication — request signature now includes the app `APPKEY` (`MD5("Appid=..&Nonce=..&Time=..[&Token=..][&body]&APPKEY")`, empty segments omitted). Fixes `code: 106 (Invalid sign)` on all requests
- **Feature**: Automatic login — if `TOKEN` is not set, the bridge logs in with `AQARA_USER`/`AQARA_PASS` credentials
- **Feature**: New `npm run login` script to verify credentials and list account devices
- **Fix**: POST bodies are serialized before signing so the signature matches the exact payload
- **Fix**: Setup wizard (`npm run setup`) uses the working signed login flow

## 1.1.1

- **Fix**: Added missing `Time` (Unix timestamp ms) and `Nonce` (random string) headers to Aqara API login request — root cause of `Login failed: Request failed. Please try again.`
- **Fix**: Added missing `App-Version`, `Lang`, `Phone-Model`, `PhoneId` headers to the main axios API client in `aqara.ts` — fixes `code: 106` error on all post-login API calls
- **Fix**: Added per-request `Time` and `Nonce` headers via axios interceptor for ongoing polling requests
- **Fix**: Moved `uuid` from `devDependencies` to `dependencies` (used in production code)
- **Debug**: Detailed login request/response logging including `msgDetails` field from API errors

## 1.1.0

- **New**: Multi-camera support - automatically discovers all Aqara cameras
- **New**: Smart spotlight detection - only creates light entities for supported cameras
- **New**: Improved camera filtering using lumi.camera model prefix
- **Breaking**: Removed SUBJECT_ID requirement from configuration
- **Breaking**: Setup script no longer requires camera selection
- **Fix**: Better error handling and logging with camera names
- **Update**: All documentation updated for multi-camera support

## 1.0.11

- Initial stable release with single camera support
- Full spotlight control (ON/OFF + brightness)
- All camera sensors and switches
- SD card monitoring
- MQTT Discovery integration
- Home Assistant add-on support
