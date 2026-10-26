#include "chacha20.hpp"
#include <cstring>
#include <algorithm>

namespace aqara {

static inline uint32_t rotl32(uint32_t x, int n) {
    return (x << n) | (x >> (32 - n));
}

static inline void quarter_round(uint32_t& a, uint32_t& b, uint32_t& c, uint32_t& d) {
    a += b;
    d ^= a;
    d = rotl32(d, 16);
    c += d;
    b ^= c;
    b = rotl32(b, 12);
    a += b;
    d ^= a;
    d = rotl32(d, 8);
    c += d;
    b ^= c;
    b = rotl32(b, 7);
}

static inline uint32_t read_u32_le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

static inline void write_u32_le(uint8_t* p, uint32_t v) {
    p[0] = static_cast<uint8_t>(v & 0xff);
    p[1] = static_cast<uint8_t>((v >> 8) & 0xff);
    p[2] = static_cast<uint8_t>((v >> 16) & 0xff);
    p[3] = static_cast<uint8_t>((v >> 24) & 0xff);
}

void ChaCha20::generate_block(const uint8_t key[32], const uint8_t nonce[8], uint64_t counter, uint8_t out[64]) {
    uint32_t st[16];
    st[0] = 0x61707865;  // "expa"
    st[1] = 0x3320646e;  // "nd 3"
    st[2] = 0x79622d32;  // "2-by"
    st[3] = 0x6b206574;  // "te k"

    for (int i = 0; i < 8; ++i) {
        st[4 + i] = read_u32_le(key + i * 4);
    }
    st[12] = static_cast<uint32_t>(counter & 0xffffffff);
    st[13] = static_cast<uint32_t>((counter >> 32) & 0xffffffff);
    st[14] = read_u32_le(nonce);
    st[15] = read_u32_le(nonce + 4);

    uint32_t w[16];
    std::memcpy(w, st, sizeof(st));

    for (int i = 0; i < 10; ++i) {
        quarter_round(w[0], w[4], w[8], w[12]);
        quarter_round(w[1], w[5], w[9], w[13]);
        quarter_round(w[2], w[6], w[10], w[14]);
        quarter_round(w[3], w[7], w[11], w[15]);

        quarter_round(w[0], w[5], w[10], w[15]);
        quarter_round(w[1], w[6], w[11], w[12]);
        quarter_round(w[2], w[7], w[8], w[13]);
        quarter_round(w[3], w[4], w[9], w[14]);
    }

    for (int i = 0; i < 16; ++i) {
        write_u32_le(out + i * 4, w[i] + st[i]);
    }
}

void ChaCha20::xor_stream(const uint8_t key[32], const uint8_t nonce[8], uint64_t counter, const uint8_t* in,
                          uint8_t* out, size_t len) {
    uint8_t block[64];
    size_t off = 0;
    while (off < len) {
        generate_block(key, nonce, counter + (off / 64), block);
        size_t chunk = std::min(static_cast<size_t>(64), len - off);
        for (size_t i = 0; i < chunk; ++i) {
            out[off + i] = in[off + i] ^ block[i];
        }
        off += chunk;
    }
}

bool ChaCha20::decrypt_video_payload(uint8_t* payload, size_t len, const uint8_t key[32]) {
    if (len < 10)
        return false;
    const uint8_t* nonce = payload;  // 8 bytes
    uint8_t nal_count = payload[8];
    size_t table_end = 9 + nal_count * 8;

    if (nal_count == 0) {
        return true;  // No encryption table, payload is raw
    }
    if (table_end >= len)
        return false;

    const uint8_t* table = payload + 9;
    uint8_t* tail = payload + table_end;
    const size_t tail_len = len - table_end;
    // Validate the complete table before touching encrypted bytes. A damaged
    // datagram must not wrap offsets or produce a partially decrypted frame.
    for (uint8_t i = 0; i < nal_count; ++i) {
        const size_t off = read_u32_le(table + i * 8);
        const size_t nal_len = read_u32_le(table + i * 8 + 4);
        if (off > tail_len || nal_len > tail_len - off)
            return false;
    }

    uint8_t block[64];
    generate_block(key, nonce, 0, block);
    const uint8_t* ks = block;  // 16 bytes keystream slice

    for (uint8_t i = 0; i < nal_count; ++i) {
        const size_t off = read_u32_le(table + i * 8);
        const size_t nal_len = read_u32_le(table + i * 8 + 4);

        // A block ending exactly at the NAL boundary is clear on the wire.
        // Decrypting it corrupts every NAL whose length is 48 modulo 160.
        for (size_t pos = 32; pos + 16 < nal_len; pos += 160) {
            const size_t abs_off = off + pos;
            for (int k = 0; k < 16; ++k) {
                tail[abs_off + k] ^= ks[k];
            }
        }
    }
    return true;
}

bool ChaCha20::decrypt_audio_payload(uint8_t* payload, size_t len, const uint8_t key[32]) {
    if (len < 40)
        return false;  // 32-byte AVIO header + 8-byte nonce
    const uint32_t payload_len = read_u32_le(payload + 28);
    if (payload_len <= 8 || 32ULL + payload_len > len)
        return false;

    const uint8_t* nonce = payload + 32;
    uint8_t* audio_data = payload + 40;
    const size_t audio_len = payload_len - 8;
    xor_stream(key, nonce, 0, audio_data, audio_data, audio_len);
    return true;
}

}  // namespace aqara
