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