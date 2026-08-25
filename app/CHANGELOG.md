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