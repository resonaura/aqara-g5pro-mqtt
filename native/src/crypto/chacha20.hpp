#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <array>
#include <cstring>

namespace aqara {

inline uint32_t rotl32(uint32_t v, int c) {
    return (v << c) | (v >> (32 - c));
}

inline void chacha20_quarter_round(uint32_t &a, uint32_t &b, uint32_t &c, uint32_t &d) {
    a += b; d ^= a; d = rotl32(d, 16);
    c += d; b ^= c; b = rotl32(b, 12);
    a += b; d ^= a; d = rotl32(d, 8);
    c += d; b ^= c; b = rotl32(b, 7);
}

inline void chacha20_block(const uint8_t key[32], const uint8_t nonce[8], uint32_t counter, uint8_t out[64]) {
    uint32_t state[16];
    // "expand 32-byte k" constants
    state[0] = 0x61707865;
    state[1] = 0x3320646e;
    state[2] = 0x79622d32;
    state[3] = 0x6b206574;

    for (int i = 0; i < 8; i++) {
        state[4 + i] = (uint32_t)key[i * 4] |
                       ((uint32_t)key[i * 4 + 1] << 8) |
                       ((uint32_t)key[i * 4 + 2] << 16) |
                       ((uint32_t)key[i * 4 + 3] << 24);
    }

    state[12] = counter;
    state[13] = 0; // 64-bit block counter high (0)
    state[14] = (uint32_t)nonce[0] | ((uint32_t)nonce[1] << 8) | ((uint32_t)nonce[2] << 16) | ((uint32_t)nonce[3] << 24);
    state[15] = (uint32_t)nonce[4] | ((uint32_t)nonce[5] << 8) | ((uint32_t)nonce[6] << 16) | ((uint32_t)nonce[7] << 24);

    uint32_t working[16];
    std::memcpy(working, state, sizeof(state));

    for (int i = 0; i < 10; i++) {
        // Column rounds
        chacha20_quarter_round(working[0], working[4], working[8],  working[12]);
        chacha20_quarter_round(working[1], working[5], working[9],  working[13]);
        chacha20_quarter_round(working[2], working[6], working[10], working[14]);
        chacha20_quarter_round(working[3], working[7], working[11], working[15]);
        // Diagonal rounds
        chacha20_quarter_round(working[0], working[5], working[10], working[15]);
        chacha20_quarter_round(working[1], working[6], working[11], working[12]);
        chacha20_quarter_round(working[2], working[7], working[8],  working[13]);
        chacha20_quarter_round(working[3], working[4], working[9],  working[14]);
    }

    for (int i = 0; i < 16; i++) {
        uint32_t val = working[i] + state[i];
        out[i * 4 + 0] = (uint8_t)(val & 0xFF);
        out[i * 4 + 1] = (uint8_t)((val >> 8) & 0xFF);
        out[i * 4 + 2] = (uint8_t)((val >> 16) & 0xFF);
        out[i * 4 + 3] = (uint8_t)((val >> 24) & 0xFF);
    }
}

inline void chacha20_xor(const uint8_t key[32], const uint8_t nonce[8], uint32_t counter, uint8_t *data, size_t len) {
    uint8_t block[64];
    size_t off = 0;
    while (off < len) {
        chacha20_block(key, nonce, counter + (uint32_t)(off / 64), block);
        size_t chunk = (len - off < 64) ? (len - off) : 64;
        for (size_t i = 0; i < chunk; i++) {
            data[off + i] ^= block[i];
        }
        off += chunk;
    }
}

} // namespace aqara
