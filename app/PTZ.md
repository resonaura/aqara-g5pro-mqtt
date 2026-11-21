# Camera movement diagnostics

Motor commands use the existing authenticated P2P session, without changing video transport. Each press is a momentary nudge (`up`, `down`, `left`, `right`); `stop` halts movement. Continuous commands are rejected, and commands are never retained for reconnection.

The wire request is Lumi IOCTL 4138 (0x102A) with a string `action`. Talk retains its separate IOCTL 4106 (0x100A). The protocol values and action vocabulary are documented by [Aqara-LANLink](https://github.com/absent42/Aqara-LANLink/blob/main/custom_components/aqara_lanlink/ptz/commands.py); the bridge uses its own existing encrypted framing and transport.

The private rotating diagnostic journal distinguishes:

- `native.ptz_sent`: a valid command was dispatched to a ready session, not proof that the motor moved.
- `native.ptz_rejected`: invalid direction, worker not ready, or camera session not ready. No command is queued.
- `native.ptz_response`: a camera reply, including E1 rejections returned on request opcode 0x102A. The bounded diagnostic carries only the opcode, numeric code, body length and `acknowledged` / `rejected` / `unknown` outcome. An acknowledgement does not independently prove physical movement.

Camera identifiers are hashed in the persistent journal. Ordinary native channel-0 logs include the response type and redacted body for diagnosis.

Automated acceptance uses a loopback UDP peer: decrypt every directional/stop packet, check its command/channel/header/body, verify Talk remains separate, and verify invalid/not-ready commands send nothing. It never connects to a household camera.

The Camera E1 (`lumi.camera.acn006` and `lumi.camera.acn007`, firmware `4.5.20_0020`, identical MD5) `ppcs` daemon only implements commands `0x1000` and `0x1002..0x1024`, so it rejects local P2P `0x102A` with `code=-1` (`unsupport cmd`). On Camera E1, motor movement runs inside the `ai`/`ha_master` daemons via Aqara cloud resource `14.88.85` (`ptz_position`), which accepts bounded pan/tilt coordinates (`x ∈ [-175, +175]`, `y ∈ [-15, +52]`, `x_dir=2`, `y_dir=2`). The bridge routes `acn006`/`acn007` PTZ buttons directly through `CloudPTZController` (verified physically on Camera E1 `4.5.20_0020`), keeps local P2P `0x102A` for models whose `ppcs` firmware implements `parse_ptz_ctrl` (verified in G350 `4.5.80_0010.0017` and G520 `4.5.84_0008.0017` binaries, plus G3), and automatically falls back to `CloudPTZController` if another model rejects `0x102A` with `code=-1`. No free-form response body is copied to the structured diagnostic journal.
