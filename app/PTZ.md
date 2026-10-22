# Camera movement diagnostics

Motor commands use the existing authenticated P2P session, without changing video transport. Each press is a momentary nudge (`up`, `down`, `left`, `right`); `stop` halts movement. Continuous commands are rejected, and commands are never retained for reconnection.

The wire request is Lumi IOCTL 4138 (0x102A) with a string `action`. Talk retains its separate IOCTL 4106 (0x100A). The protocol values and action vocabulary are documented by [Aqara-LANLink](https://github.com/absent42/Aqara-LANLink/blob/main/custom_components/aqara_lanlink/ptz/commands.py); the bridge uses its own existing encrypted framing and transport.

The private rotating diagnostic journal distinguishes:

- `native.ptz_sent`: a valid command was dispatched to a ready session, not proof that the motor moved.
- `native.ptz_rejected`: invalid direction, worker not ready, or camera session not ready. No command is queued.
- `native.ptz_response`: the camera returned the motor response type 0x102B. This also does not independently prove physical movement.

Camera identifiers are hashed in the persistent journal. Ordinary native channel-0 logs include the response type and redacted body for diagnosis.

Automated acceptance uses a loopback UDP peer: decrypt every directional/stop packet, check its command/channel/header/body, verify Talk remains separate, and verify invalid/not-ready commands send nothing. It never connects to a household camera. The current physical Camera E1 motor behavior still needs an attended confirmation.
