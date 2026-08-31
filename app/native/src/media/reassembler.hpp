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
    uint32_t codec_id;
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
    void push_packet(uint8_t channel, uint16_t seq, const uint8_t* data, size_t len);
    void reset();

private:
    struct ChannelState {
        int expected_seq = -1;
        std::map<uint16_t, std::vector<uint8_t>> reorder_buf;
        std::vector<uint8_t> stream_buf;
    };

    void handle_packet_immediate(uint8_t channel, ChannelState& state, uint16_t seq, const uint8_t* data, size_t len);
    void parse_stream_buffer(uint8_t channel, ChannelState& state);
    void process_completed_avio(const uint8_t* data, size_t len);
    void process_completed_audio(const uint8_t* data, size_t len);
    void recover_from_sequence_gap(uint8_t channel, ChannelState& state, uint16_t next_seq);

    uint8_t video_key_[32];
    uint8_t audio_key_[32];

    VideoCallback video_cb_;
    AudioCallback audio_cb_;
    KeyframeRequestCallback kf_req_cb_;

    std::map<uint8_t, ChannelState> channels_;

    std::vector<uint8_t> sps_;
    std::vector<uint8_t> pps_;
    std::vector<uint8_t> vps_;

    uint64_t packets_received_ = 0;
    uint64_t packets_duplicate_ = 0;
    uint64_t sequence_gaps_ = 0;
    uint64_t video_frames_ = 0;
    uint64_t audio_frames_ = 0;
    uint64_t discarded_bytes_ = 0;
};

}  // namespace aqara
