#pragma once

#include <cstdint>
#include <chrono>
#include <atomic>
#include <mutex>
#include <thread>
#include <queue>
#include <condition_variable>
#include <cmath>

namespace aqara {

class JitterBuffer {
public:
    JitterBuffer() : base_time_(std::chrono::steady_clock::now()), initialized_(false) {}

    void init() {
        base_time_ = std::chrono::steady_clock::now();
        last_video_rtp_ = 0;
        last_audio_rtp_ = 0;
        initialized_ = true;
    }

    uint32_t get_video_rtp_timestamp() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_) init();

        auto now = std::chrono::steady_clock::now();
        uint64_t elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(now - base_time_).count();
        uint32_t rtp = (uint32_t)((elapsed_us * 90) / 1000);

        // Guard against non-monotonic timestamps (minimum +90 ticks = 1ms guard)
        uint32_t min_next = last_video_rtp_ + 90;
        if (rtp < min_next) {
            rtp = min_next;
        }
        last_video_rtp_ = rtp;
        return rtp;
    }

    uint32_t get_audio_rtp_timestamp() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_) init();

        auto now = std::chrono::steady_clock::now();
        uint64_t elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(now - base_time_).count();
        uint32_t wall_rtp = (uint32_t)((elapsed_us * 16) / 1000);

        uint32_t rtp;
        if (last_audio_rtp_ == 0) {
            rtp = wall_rtp;
        } else {
            uint32_t next_expected = last_audio_rtp_ + 1024;
            // Only jump forward if there was a real prolonged silence gap (>500ms), never jump backwards
            if (wall_rtp > next_expected + 8000) {
                rtp = wall_rtp;
            } else {
                rtp = next_expected;
            }
        }
        last_audio_rtp_ = rtp;
        return rtp;
    }

private:
    std::mutex mutex_;
    std::chrono::steady_clock::time_point base_time_;
    bool initialized_;
    uint32_t last_video_rtp_ = 0;
    uint32_t last_audio_rtp_ = 0;
};

} // namespace aqara
