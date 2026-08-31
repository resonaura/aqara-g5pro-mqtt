#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <string>

namespace aqara {

class PpcsCipher {
public:
    static void encrypt(const uint8_t* key, size_t key_len, uint8_t* data, size_t data_len);
    static void decrypt(const uint8_t* key, size_t key_len, uint8_t* data, size_t data_len);

    static std::vector<uint8_t> build_pppp(uint8_t msg_type, const uint8_t* payload = nullptr, size_t len = 0);
    static std::vector<uint8_t> punch_payload(const std::string& p2p_id);
    static std::vector<uint8_t> build_lumi_frame(uint32_t type, const uint8_t* payload, size_t len, uint32_t seq);
    static std::vector<uint8_t> build_talkback_ppcs_body(const uint8_t* adts, size_t len);
};

}  // namespace aqara
