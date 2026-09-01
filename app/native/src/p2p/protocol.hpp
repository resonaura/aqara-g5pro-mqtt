#pragma once

#include <cstdint>

namespace aqara {

/**
 * PPCS Transport Packet Types (Magic prefix 0xF1)
 *
 * Used at the UDP transport layer for discovery, NAT hole punching,
 * tunnel keepalive, and reliable data frame transport.
 */
enum class PpcsMsgType : uint8_t {
    HELLO = 0x00,          // Initial discovery handshake probe
    QUERY = 0x20,          // Local LAN endpoint query request
    LAN_BROADCAST = 0x30,  // LAN subnet broadcast probe
    PUNCH = 0x41,          // UDP hole-punching packet
    READY = 0x42,          // UDP tunnel readiness signal from camera
    READY_ACK = 0x43,      // Acknowledgment for tunnel readiness
    ALT_DRW = 0x82,        // Alternate DRW transport marker
    DRW = 0xD0,            // Encrypted Data Read/Write payload (Media / Commands)
    DRW_ACK = 0xD1,        // Acknowledgment for DRW packet sequence
    DRW_EXTRA = 0xD8,      // Extended DRW data transport
    ALIVE = 0xE0,          // Tunnel keepalive ping (sent periodically)
    ALIVE_ACK = 0xE1       // Tunnel keepalive pong response
};

/**
 * Lumi Application Layer Command Types (Embedded in Lumi frames inside Channel 0 DRW packets)
 *
 * Frame structure:
 *  - 4 bytes: Magic ASCII "lumi"
 *  - 2 bytes (LE): uint16 command/message type
 *  - 2 bytes (LE): uint16 payload length
 *  - 4 bytes (LE): uint32 sequence number
 *  - 4 bytes (LE): reserved / zero
 *  - N bytes: JSON or binary payload
 */
enum class LumiCmdType : uint32_t {
    LOGIN_REQ = 0x1000,           // Authenticate session with cloud-signed token & timestamp
    LOGIN_RESP = 0x1001,          // Camera authentication approval response (Login OK)
    SESSION_START_REQ = 0x1002,   // Initiate live stream session on channel 0
    SESSION_START_RESP = 0x1003,  // Stream pipeline ready acknowledgment
    PTZ_OR_TALK_START = 0x100A,   // PTZ motor control (JSON) or Start Two-Way Talkback (binary)
    TALKBACK_RESP = 0x100B,       // Talkback audio channel prepared confirmation
    TALK_STOP = 0x100C,           // Stop Two-Way Talkback audio transmission
    SET_QUALITY = 0x100E,         // Switch live stream resolution / quality channel
    KEYFRAME_REQ = 0x1018,        // Force immediate IDR (Instantaneous Decoder Refresh) keyframe
    KEYFRAME_RESP = 0x1019,       // Keyframe generation acknowledgment
    STREAM_START_REQ = 0x101C     // Request Channel 3 video stream delivery
};

}  // namespace aqara
