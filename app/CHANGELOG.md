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