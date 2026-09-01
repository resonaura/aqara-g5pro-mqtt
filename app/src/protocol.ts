/**
 * Aqara P2P & PPCS Protocol Definitions.
 *
 * Provides strongly-typed enums and byte-level constants for both the
 * PPCS transport layer (UDP packet types) and the Lumi application layer
 * (Channel 0/3 command frames).
 */

/**
 * PPCS Transport Packet Types (0xF1 Magic PPPP Header)
 *
 * Used at the UDP transport layer for discovery, NAT hole punching,
 * tunnel keepalive, and reliable data frame transport.
 */
export enum PpcsMsgType {
  HELLO = 0x00, // Initial discovery handshake probe
  QUERY = 0x20, // Local LAN endpoint query request
  LAN_BROADCAST = 0x30, // LAN subnet broadcast probe
  PUNCH = 0x41, // UDP hole-punching packet
  READY = 0x42, // UDP tunnel readiness signal from camera (RDY)
  READY_ACK = 0x43, // Acknowledgment for tunnel readiness (RDY_ACK)
  ALT_DRW = 0x82, // Alternate DRW transport marker
  DRW = 0xd0, // Encrypted Data Read/Write payload (Media / Commands)
  DRW_ACK = 0xd1, // Acknowledgment for DRW packet sequence
  DRW_EXTRA = 0xd8, // Extended DRW data transport
  ALIVE = 0xe0, // Tunnel keepalive ping (sent periodically)
  ALIVE_ACK = 0xe1, // Tunnel keepalive pong response
}

/**
 * Lumi Application Layer Command Types (Embedded in Channel 0 DRW Lumi Frames)
 *
 * Frame structure:
 *  - 4 bytes: Magic ASCII "lumi"
 *  - 2 bytes (LE): uint16 command/message type
 *  - 2 bytes (LE): uint16 payload length
 *  - 4 bytes (LE): uint32 sequence number
 *  - 4 bytes (LE): reserved / zero
 *  - N bytes: JSON or binary payload
 */
export enum LumiCmdType {
  LOGIN_REQ = 0x1000, // Authenticate session with cloud-signed token & timestamp
  LOGIN_RESP = 0x1001, // Camera authentication approval response (Login OK)
  SESSION_START_REQ = 0x1002, // Initiate live stream session on channel 0
  SESSION_START_RESP = 0x1003, // Stream pipeline ready acknowledgment
  AUDIO_START = 0x1004, // Audio stream request
  AUDIO_START_RESP = 0x1005, // Audio stream response
  AUDIO_SEND = 0x1006, // Audio data transmission
  AUDIO_SEND_RESP = 0x1007, // Audio transmission response
  AUDIO_STOP = 0x1008, // Stop audio streaming
  PTZ_OR_TALK_START = 0x100a, // PTZ motor control (JSON) or Start Two-Way Talkback (binary)
  TALKBACK_RESP = 0x100b, // Talkback audio channel prepared confirmation
  TALK_STOP = 0x100c, // Stop Two-Way Talkback audio transmission
  SET_QUALITY = 0x100e, // Switch live stream resolution / quality channel
  SET_QUALITY_RESP = 0x100f, // Quality channel response
  KEYFRAME_REQ = 0x1018, // Force immediate IDR (Instantaneous Decoder Refresh) keyframe
  KEYFRAME_RESP = 0x1019, // Keyframe generation acknowledgment
  STREAM_START_REQ = 0x101c, // Request Channel 3 video stream delivery
  STREAM_START_RESP = 0x101d, // Channel 3 stream response
  KEEPALIVE = 0x1024, // Legacy keepalive ping
  KEEPALIVE_RESP = 0x1025, // Legacy keepalive pong
}
