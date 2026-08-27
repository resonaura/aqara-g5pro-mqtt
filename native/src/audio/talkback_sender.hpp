#pragma once

#include <cstdint>
#include <vector>
#include <string>
#include <chrono>
#include <random>
#include <cstring>
#include <thread>
#include <mutex>
#include <queue>
#include <atomic>
#include "../crypto/chacha20.hpp"
#include "../p2p/ppcs_protocol.hpp"

namespace aqara {

class TalkbackSender {
public:
    TalkbackSender(const std::vector<uint8_t>& share_key, const std::vector<uint8_t>& ppcs_key = {})
        : share_key_(share_key), ppcs_key_(ppcs_key), ch2_seq_(0), talkback_active_(false) {
        std::random_device rd;
        rng_.seed(rd());
    }

    void set_active(bool active) {
        talkback_active_ = active;
        if (active) {
            ch2_seq_ = 0;
            start_time_ = std::chrono::steady_clock::now();
        }
    }

    bool is_active() const {
        return talkback_active_;
    }

    /**
     * Build Channel 0 start talkback DRW command (0x100a)
     */
    std::vector<uint8_t> build_start_command(uint16_t ch0_seq, uint32_t cmd_seq) {
        return build_lumi_drw(0, ch0_seq, 0x100a, cmd_seq);
    }

    /**
     * Build Channel 0 stop talkback DRW command (0x100c)
     */
    std::vector<uint8_t> build_stop_command(uint16_t ch0_seq, uint32_t cmd_seq) {
        return build_lumi_drw(0, ch0_seq, 0x100c, cmd_seq);
    }

    /**
     * Encrypt an audio frame for Channel 2 transmission.
     * Frame format: [8-byte random nonce] + ChaCha20(key=shareKey, nonce=8B, ctr=0)
     */
    std::vector<uint8_t> encrypt_audio_frame(const uint8_t* pcm_data, size_t pcm_len) {
        if (!pcm_data || pcm_len == 0) return {};

        std::vector<uint8_t> frame(8 + pcm_len);
        
        // 1. Generate 8-byte random nonce in [0..8]
        uint8_t nonce[8];
        for (int i = 0; i < 8; i++) {
            nonce[i] = (uint8_t)(rng_() & 0xFF);
            frame[i] = nonce[i];
        }

        // 2. Encrypt audio payload into [8..]
        std::memcpy(frame.data() + 8, pcm_data, pcm_len);
        chacha20_xor(share_key_.data(), nonce, 0, frame.data() + 8, pcm_len);

        return frame;
    }

    /**
     * Build complete Channel 2 DRW UDP packet with encrypted audio frame
     */
    std::vector<uint8_t> build_channel2_drw_packet(const uint8_t* pcm_data, size_t pcm_len) {
        auto enc_frame = encrypt_audio_frame(pcm_data, pcm_len);
        if (enc_frame.empty()) return {};

        // DRW header: [Channel (uint8_t), Flags (uint8_t), Sequence (uint16_t LE)]
        std::vector<uint8_t> packet(4 + enc_frame.size());
        packet[0] = 2; // Channel 2
        packet[1] = 0; // Flags
        packet[2] = (uint8_t)(ch2_seq_ & 0xFF);
        packet[3] = (uint8_t)((ch2_seq_ >> 8) & 0xFF);
        ch2_seq_++;

        std::memcpy(packet.data() + 4, enc_frame.data(), enc_frame.size());
        return packet;
    }

private:
    static std::vector<uint8_t> build_lumi_drw(uint8_t channel, uint16_t ch_seq, uint16_t cmd_type, uint32_t cmd_seq) {
        // Build 12-byte Lumi header + 4-byte DRW header
        std::vector<uint8_t> payload(12);
        payload[0] = (uint8_t)(cmd_type & 0xFF);
        payload[1] = (uint8_t)((cmd_type >> 8) & 0xFF);
        payload[2] = 0;
        payload[3] = 0;
        payload[4] = (uint8_t)(cmd_seq & 0xFF);
        payload[5] = (uint8_t)((cmd_seq >> 8) & 0xFF);
        payload[6] = (uint8_t)((cmd_seq >> 16) & 0xFF);
        payload[7] = (uint8_t)((cmd_seq >> 24) & 0xFF);
        payload[8] = 0;
        payload[9] = 0;
        payload[10] = 0;
        payload[11] = 0;

        std::vector<uint8_t> packet(4 + payload.size());
        packet[0] = channel;
        packet[1] = 0;
        packet[2] = (uint8_t)(ch_seq & 0xFF);
        packet[3] = (uint8_t)((ch_seq >> 8) & 0xFF);
        std::memcpy(packet.data() + 4, payload.data(), payload.size());
        return packet;
    }

    std::vector<uint8_t> share_key_;
    std::vector<uint8_t> ppcs_key_;
    uint16_t ch2_seq_;
    bool talkback_active_;
    std::chrono::steady_clock::time_point start_time_;
    std::mt19937 rng_;
};

} // namespace aqara
