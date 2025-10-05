# Changelog

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