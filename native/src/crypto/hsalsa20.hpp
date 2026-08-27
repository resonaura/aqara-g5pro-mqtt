#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <cstring>
#include "chacha20.hpp"

namespace aqara {

inline void salsa20_core(uint32_t out[16], const uint32_t in[16]) {
    uint32_t x[16];
    std::memcpy(x, in, 64);

    for (int i = 0; i < 10; i++) {
        x[ 4] ^= rotl32(x[ 0] + x[12],  7);
        x[ 8] ^= rotl32(x[ 4] + x[ 0],  9);
        x[12] ^= rotl32(x[ 8] + x[ 4], 13);
        x[ 0] ^= rotl32(x[12] + x[ 8], 18);

        x[ 9] ^= rotl32(x[ 5] + x[ 1],  7);
        x[13] ^= rotl32(x[ 9] + x[ 5],  9);
        x[ 1] ^= rotl32(x[13] + x[ 9], 13);
        x[ 5] ^= rotl32(x[ 1] + x[13], 18);

        x[14] ^= rotl32(x[10] + x[ 6],  7);
        x[ 2] ^= rotl32(x[14] + x[10],  9);
        x[ 6] ^= rotl32(x[ 2] + x[14], 13);
        x[10] ^= rotl32(x[ 6] + x[ 2], 18);

        x[ 3] ^= rotl32(x[15] + x[11],  7);
        x[ 7] ^= rotl32(x[ 3] + x[15],  9);
        x[11] ^= rotl32(x[ 7] + x[ 3], 13);
        x[15] ^= rotl32(x[11] + x[ 7], 18);

        x[ 1] ^= rotl32(x[ 0] + x[ 3],  7);
        x[ 2] ^= rotl32(x[ 1] + x[ 0],  9);
        x[ 3] ^= rotl32(x[ 2] + x[ 1], 13);
        x[ 0] ^= rotl32(x[ 3] + x[ 2], 18);

        x[ 6] ^= rotl32(x[ 5] + x[ 4],  7);
        x[ 7] ^= rotl32(x[ 6] + x[ 5],  9);
        x[ 4] ^= rotl32(x[ 7] + x[ 6], 13);
        x[ 5] ^= rotl32(x[ 4] + x[ 7], 18);

        x[11] ^= rotl32(x[10] + x[ 9],  7);
        x[ 8] ^= rotl32(x[11] + x[10],  9);
        x[ 9] ^= rotl32(x[ 8] + x[11], 13);
        x[10] ^= rotl32(x[ 9] + x[ 8], 18);

        x[12] ^= rotl32(x[15] + x[14],  7);
        x[13] ^= rotl32(x[12] + x[15],  9);
        x[14] ^= rotl32(x[13] + x[12], 13);
        x[15] ^= rotl32(x[14] + x[13], 18);
    }

    std::memcpy(out, x, 64);
}

inline void hsalsa20(const uint8_t key[32], const uint8_t in[16], uint8_t out[32]) {
    uint32_t x[16];
    // "expand 32-byte k" constants
    x[0]  = 0x61707865;
    x[1]  = (uint32_t)key[0]  | ((uint32_t)key[1]  << 8) | ((uint32_t)key[2]  << 16) | ((uint32_t)key[3]  << 24);
    x[2]  = (uint32_t)key[4]  | ((uint32_t)key[5]  << 8) | ((uint32_t)key[6]  << 16) | ((uint32_t)key[7]  << 24);
    x[3]  = (uint32_t)key[8]  | ((uint32_t)key[9]  << 8) | ((uint32_t)key[10] << 16) | ((uint32_t)key[11] << 24);
    x[4]  = (uint32_t)key[12] | ((uint32_t)key[13] << 8) | ((uint32_t)key[14] << 16) | ((uint32_t)key[15] << 24);
    x[5]  = 0x3320646e;
    x[6]  = (uint32_t)in[0]   | ((uint32_t)in[1]   << 8) | ((uint32_t)in[2]   << 16) | ((uint32_t)in[3]   << 24);
    x[7]  = (uint32_t)in[4]   | ((uint32_t)in[5]   << 8) | ((uint32_t)in[6]   << 16) | ((uint32_t)in[7]   << 24);
    x[8]  = (uint32_t)in[8]   | ((uint32_t)in[9]   << 8) | ((uint32_t)in[10]  << 16) | ((uint32_t)in[11]  << 24);
    x[9]  = (uint32_t)in[12]  | ((uint32_t)in[13]  << 8) | ((uint32_t)in[14]  << 16) | ((uint32_t)in[15]  << 24);
    x[10] = 0x79622d32;
    x[11] = (uint32_t)key[16] | ((uint32_t)key[17] << 8) | ((uint32_t)key[18] << 16) | ((uint32_t)key[19] << 24);
    x[12] = (uint32_t)key[20] | ((uint32_t)key[21] << 8) | ((uint32_t)key[22] << 16) | ((uint32_t)key[23] << 24);
    x[13] = (uint32_t)key[24] | ((uint32_t)key[25] << 8) | ((uint32_t)key[26] << 16) | ((uint32_t)key[27] << 24);
    x[14] = (uint32_t)key[28] | ((uint32_t)key[29] << 8) | ((uint32_t)key[30] << 16) | ((uint32_t)key[31] << 24);
    x[15] = 0x6b206574;

    uint32_t res[16];
    salsa20_core(res, x);

    // HSalsa20 extracts words 0, 5, 10, 15, 6, 7, 8, 9
    const int indices[8] = {0, 5, 10, 15, 6, 7, 8, 9};
    for (int i = 0; i < 8; i++) {
        uint32_t val = res[indices[i]];
        out[i * 4 + 0] = (uint8_t)(val & 0xFF);
        out[i * 4 + 1] = (uint8_t)((val >> 8) & 0xFF);
        out[i * 4 + 2] = (uint8_t)((val >> 16) & 0xFF);
        out[i * 4 + 3] = (uint8_t)((val >> 24) & 0xFF);
    }
}

} // namespace aqara
