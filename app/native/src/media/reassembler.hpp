#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <vector>

namespace aqara {

struct VideoFrame {
    std::vector<uint8_t> annex_b_data;
    bool is_keyframe;
    uint16_t width;
    uint16_t height;
    uint32_t codec_id;  // 0x004E = H264, 0x004F = H265
};

struct AudioFrame {
    std::vector<uint8_t> aac_adts_data;
};

using VideoCallback = std::function<void(const VideoFrame&)>;
using AudioCallback = std::function<void(const AudioFrame&)>;
using KeyframeRequestCallback = std::function<void()>;

class AvioReassembler {
public:
    AvioReassembler(const uint8_t video_key[32], const uint8_t audio_key[32]);
    ~AvioReassembler() = default;

    void set_callbacks(VideoCallback video_cb, AudioCallback audio_cb, KeyframeRequestCallback kf_req_cb);

    // Push an incoming raw UDP datagram with 16-bit sequence number
    void push_packet(uint16_t seq, const uint8_t* data, size_t len);

    void reset();

private:
    void handle_packet_immediate(uint16_t seq, const uint8_t* data, size_t len);
    void flush_current_frame();
    void process_completed_avio(const uint8_t* data, size_t len);

    uint8_t video_key_[32];
    uint8_t audio_key_[32];

    VideoCallback video_cb_;
    AudioCallback audio_cb_;
    KeyframeRequestCallback kf_req_cb_;

    // Sequence tracking & jitter reorder buffer
    int expected_seq_ = -1;
    std::map<uint16_t, std::vector<uint8_t>> reorder_buf_;

    // Fragment accumulation for currently assembling AVIO frame
    std::vector<uint8_t> current_frame_buf_;
    size_t current_expected_len_ = 0;
    uint16_t frame_start_seq_ = 0;
    bool assembling_ = false;

    // Stashed SPS/PPS parameter sets
    std::vector<uint8_t> sps_;
    std::vector<uint8_t> pps_;
    std::vector<uint8_t> vps_;

    // Audio residue buffer
    std::vector<uint8_t> audio_residue_;
};

}  // namespace aqara
