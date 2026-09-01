#include "cipher.hpp"
#include <cstring>
#include <sstream>
#include <algorithm>

namespace aqara {

static const uint8_t PPCS_TABLE[256] = {
    0x7c, 0x9c, 0xe8, 0x4a, 0x13, 0xde, 0xdc, 0xb2, 0x2f, 0x21, 0x23, 0xe4, 0x30, 0x7b, 0x3d, 0x8c, 0xbc, 0x0b, 0x27,
    0x0c, 0x3c, 0xf7, 0x9a, 0xe7, 0x08, 0x71, 0x96, 0x00, 0x97, 0x85, 0xef, 0xc1, 0x1f, 0xc4, 0xdb, 0xa1, 0xc2, 0xeb,
    0xd9, 0x01, 0xfa, 0xba, 0x3b, 0x05, 0xb8, 0x15, 0x87, 0x83, 0x28, 0x72, 0xd1, 0x8b, 0x5a, 0xd6, 0xda, 0x93, 0x58,
    0xfe, 0xaa, 0xcc, 0x6e, 0x1b, 0xf0, 0xa3, 0x88, 0xab, 0x43, 0xc0, 0x0d, 0xb5, 0x45, 0x38, 0x4f, 0x50, 0x22, 0x66,
    0x20, 0x7f, 0x07, 0x5b, 0x14, 0x98, 0x1d, 0x9b, 0xa7, 0x2a, 0xb9, 0xa8, 0xcb, 0xf1, 0xfc, 0x49, 0x47, 0x06, 0x3e,
    0xb1, 0x0e, 0x04, 0x3a, 0x94, 0x5e, 0xee, 0x54, 0x11, 0x34, 0xdd, 0x4d, 0xf9, 0xec, 0xc7, 0xc9, 0xe3, 0x78, 0x1a,
    0x6f, 0x70, 0x6b, 0xa4, 0xbd, 0xa9, 0x5d, 0xd5, 0xf8, 0xe5, 0xbb, 0x26, 0xaf, 0x42, 0x37, 0xd8, 0xe1, 0x02, 0x0a,
    0xae, 0x5f, 0x1c, 0xc5, 0x73, 0x09, 0x4e, 0x69, 0x24, 0x90, 0x6d, 0x12, 0xb3, 0x19, 0xad, 0x74, 0x8a, 0x29, 0x40,
    0xf5, 0x2d, 0xbe, 0xa5, 0x59, 0xe0, 0xf4, 0x79, 0xd2, 0x4b, 0xce, 0x89, 0x82, 0x48, 0x84, 0x25, 0xc6, 0x91, 0x2b,
    0xa2, 0xfb, 0x8f, 0xe9, 0xa6, 0xb0, 0x9e, 0x3f, 0x65, 0xf6, 0x03, 0x31, 0x2e, 0xac, 0x0f, 0x95, 0x2c, 0x5c, 0xed,
    0x39, 0xb7, 0x33, 0x6c, 0x56, 0x7e, 0xb4, 0xa0, 0xfd, 0x7a, 0x81, 0x53, 0x51, 0x86, 0x8d, 0x9f, 0x77, 0xff, 0x6a,
    0x80, 0xdf, 0xe2, 0xbf, 0x10, 0xd7, 0x75, 0x64, 0x57, 0x76, 0xf3, 0x55, 0xcd, 0xd0, 0xc8, 0x18, 0xe6, 0x36, 0x41,
    0x62, 0xcf, 0x99, 0xf2, 0x32, 0x4c, 0x67, 0x60, 0x61, 0x92, 0xca, 0xd3, 0xea, 0x63, 0x7d, 0x16, 0xb6, 0x8e, 0xd4,
    0x68, 0x35, 0xc3, 0x52, 0x9d, 0x46, 0x44, 0x1e, 0x17,
};

void PPCSCipher::encrypt(const uint8_t* key, size_t key_len, uint8_t* data, size_t data_len) {
    if (!key || key_len == 0 || !data || data_len == 0)
        return;
    size_t klen = std::min(key_len, static_cast<size_t>(20));

    uint32_t total = 0;
    uint32_t sx = 0;
    uint32_t s3 = 0;
    for (size_t i = 0; i < klen; ++i) {
        uint32_t b = key[i];
        total += b;
        sx ^= b;
        s3 += (b * 0xab) / 512;
    }

    uint8_t seeds[4] = {static_cast<uint8_t>(total & 0xff), static_cast<uint8_t>((-static_cast<int>(total)) & 0xff),
                        static_cast<uint8_t>(s3 & 0xff), static_cast<uint8_t>(sx & 0xff)};

    data[0] = PPCS_TABLE[seeds[0]] ^ data[0];
    uint8_t fb = data[0];
    for (size_t i = 1; i < data_len; ++i) {
        data[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i];
        fb = data[i];
    }
}

void PPCSCipher::decrypt(const uint8_t* key, size_t key_len, uint8_t* data, size_t data_len) {
    if (!key || key_len == 0 || !data || data_len == 0)
        return;
    size_t klen = std::min(key_len, static_cast<size_t>(20));

    uint32_t total = 0;
    uint32_t sx = 0;
    uint32_t s3 = 0;
    for (size_t i = 0; i < klen; ++i) {
        uint32_t b = key[i];
        total += b;
        sx ^= b;
        s3 += (b * 0xab) / 512;
    }

    uint8_t seeds[4] = {static_cast<uint8_t>(total & 0xff), static_cast<uint8_t>((-static_cast<int>(total)) & 0xff),
                        static_cast<uint8_t>(s3 & 0xff), static_cast<uint8_t>(sx & 0xff)};

    uint8_t fb = data[0];
    data[0] = PPCS_TABLE[seeds[0]] ^ data[0];
    for (size_t i = 1; i < data_len; ++i) {
        uint8_t orig = data[i];
        data[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i];
        fb = orig;
    }
}

std::vector<uint8_t> PPCSCipher::build_pppp(uint8_t msg_type, const uint8_t* payload, size_t len) {
    std::vector<uint8_t> out(4 + len);
    out[0] = 0xF1;  // PPCS_MAGIC
    out[1] = msg_type;
    out[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    out[3] = static_cast<uint8_t>(len & 0xff);
    if (payload && len > 0) {
        std::memcpy(out.data() + 4, payload, len);
    }
    return out;
}

std::vector<uint8_t> PPCSCipher::punch_payload(const std::string& p2p_id) {
    std::vector<uint8_t> b(20, 0);
    // Format: PRE-123456-SUF
    std::stringstream ss(p2p_id);
    std::string pre, num_str, suf;
    std::getline(ss, pre, '-');
    std::getline(ss, num_str, '-');
    std::getline(ss, suf, '-');

    size_t pre_len = std::min(pre.length(), static_cast<size_t>(7));
    std::memcpy(b.data(), pre.data(), pre_len);

    uint32_t n = 0;
    try {
        n = static_cast<uint32_t>(std::stoul(num_str));
    } catch (...) {
    }

    b[9] = static_cast<uint8_t>((n >> 16) & 0xff);
    b[10] = static_cast<uint8_t>((n >> 8) & 0xff);
    b[11] = static_cast<uint8_t>(n & 0xff);

    size_t suf_len = std::min(suf.length(), static_cast<size_t>(8));
    std::memcpy(b.data() + 12, suf.data(), suf_len);

    return b;
}

std::vector<uint8_t> PPCSCipher::build_lumi_frame(uint32_t type, const uint8_t* payload, size_t len, uint32_t seq) {
    std::vector<uint8_t> f(16 + len);
    std::memcpy(f.data(), "lumi", 4);
    f[4] = static_cast<uint8_t>(type & 0xff);
    f[5] = static_cast<uint8_t>((type >> 8) & 0xff);
    f[6] = static_cast<uint8_t>((type >> 16) & 0xff);
    f[7] = static_cast<uint8_t>((type >> 24) & 0xff);

    f[8] = static_cast<uint8_t>(seq & 0xff);
    f[9] = static_cast<uint8_t>((seq >> 8) & 0xff);
    f[10] = static_cast<uint8_t>((seq >> 16) & 0xff);
    f[11] = static_cast<uint8_t>((seq >> 24) & 0xff);

    f[12] = static_cast<uint8_t>(len & 0xff);
    f[13] = static_cast<uint8_t>((len >> 8) & 0xff);
    f[14] = static_cast<uint8_t>((len >> 16) & 0xff);
    f[15] = static_cast<uint8_t>((len >> 24) & 0xff);

    if (payload && len > 0) {
        std::memcpy(f.data() + 16, payload, len);
    }
    return f;
}

std::vector<uint8_t> PPCSCipher::build_talkback_ppcs_body(const uint8_t* adts, size_t len) {
    std::vector<uint8_t> body(32 + len, 0);
    body[28] = static_cast<uint8_t>(len & 0xff);
    body[29] = static_cast<uint8_t>((len >> 8) & 0xff);
    body[30] = static_cast<uint8_t>((len >> 16) & 0xff);
    body[31] = static_cast<uint8_t>((len >> 24) & 0xff);
    if (adts && len > 0) {
        std::memcpy(body.data() + 32, adts, len);
    }
    return body;
}

}  // namespace aqara
