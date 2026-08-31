#pragma once

#include <cstddef>
#include <cstdint>

namespace aqara {

class ChaCha20 {
public:
    // Generate one 64-byte ChaCha20 keystream block (DJB variant: 8-byte nonce, 64-bit counter)
    static void generate_block(const uint8_t key[32], const uint8_t nonce[8], uint64_t counter, uint8_t out[64]);

    // Standard stream cipher XOR (counter starting at 0)
    static void xor_stream(const uint8_t key[32], const uint8_t nonce[8], uint64_t counter, const uint8_t* in,
                           uint8_t* out, size_t len);

    // In-place video payload decryption according to Aqara sparse NAL table layout
    static bool decrypt_video_payload(uint8_t* payload, size_t len, const uint8_t key[32]);

    // Audio payload decryption
    static bool decrypt_audio_payload(uint8_t* payload, size_t len, const uint8_t key[32]);
};

}  // namespace aqara
