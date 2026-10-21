#pragma once

#include <cstddef>
#include <atomic>
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
    uint64_t timestamp_ms = 0;
};

struct AudioFrame {
    std::vector<uint8_t> aac_adts_data;
    uint64_t timestamp_ms = 0;
};

using VideoCallback = std::function<void(const VideoFrame&)>;
using AudioCallback = std::function<void(const AudioFrame&)>;
using KeyframeRequestCallback = std::function<void()>;

struct MediaStatistics {
    uint64_t packets = 0, duplicates = 0, reordered = 0, sequence_gaps = 0;
    uint64_t video_frames = 0, audio_frames = 0, discarded_bytes = 0;
    uint64_t malformed_frames = 0, keyframe_requests = 0;
};

class AVIOReassembler {
public:
    AVIOReassembler(const uint8_t video_key[32], const uint8_t audio_key[32]);
    ~AVIOReassembler() = default;

    void set_callbacks(VideoCallback video_cb, AudioCallback audio_cb, KeyframeRequestCallback kf_req_cb);
    void set_keys(const uint8_t video_key[32], const uint8_t audio_key[32]);
    void push_packet(uint8_t channel, uint16_t seq, const uint8_t* data, size_t len);
    void reset();
    int64_t last_video_frame_ms() const { return last_video_frame_ms_.load(); }
    MediaStatistics statistics() const {
        return {packets_received_.load(), packets_duplicate_.load(), packets_reordered_.load(),
                sequence_gaps_.load(),    video_frames_.load(),      audio_frames_.load(),
                discarded_bytes_.load(),  malformed_frames_.load(),  keyframe_requests_.load()};
    }

private:
    struct ChannelState {
        int expected_seq = -1;
        std::map<uint16_t, std::vector<uint8_t>> reorder_buf;
        std::vector<uint8_t> stream_buf;
        std::vector<uint8_t> pending_audio;
        size_t pending_audio_expected = 0;
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

    std::atomic<int64_t> last_video_frame_ms_{0};
    std::atomic<uint64_t> packets_received_{0};
    std::atomic<uint64_t> packets_duplicate_{0};
    std::atomic<uint64_t> sequence_gaps_{0};
    std::atomic<uint64_t> video_frames_{0};
    std::atomic<uint64_t> audio_frames_{0};
    std::atomic<uint64_t> discarded_bytes_{0};
    std::atomic<uint64_t> packets_reordered_{0}, malformed_frames_{0}, keyframe_requests_{0};
    uint64_t last_audio_ts_ms_ = 0;
};

}  // namespace aqara
