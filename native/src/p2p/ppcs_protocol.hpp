#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <string>

namespace aqara {

constexpr uint16_t CODEC_H264  = 0x004E;
constexpr uint16_t CODEC_HEVC  = 0x004F;
constexpr uint16_t CODEC_AUDIO = 0x0088;

#pragma pack(push, 1)
struct AvioHeader {
    uint16_t codec_id;      // 0x004E, 0x004F, 0x0088
    uint16_t flags;         // 0x000E, 0x0001
    uint32_t unknown1;
    uint32_t timestamp;     // Hardware timestamp ms
    uint32_t unknown2;
    uint32_t sample_rate;   // For audio: 8 or 16 (kHz)
    uint32_t unknown3;
    uint32_t seq;           // Frame sequence number
    uint32_t payload_len;   // Declared encrypted payload length
    uint8_t  nonce[8];      // 8-byte ChaCha20 nonce
};
#pragma pack(pop)

static_assert(sizeof(AvioHeader) == 40, "AvioHeader must be exactly 40 bytes");

} // namespace aqara
