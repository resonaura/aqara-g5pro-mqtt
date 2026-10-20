#pragma once
#include <cstdint>

namespace aqara {
// Keep one RTP timeline across camera reconnects and disposable offline encoders.
class RtpTimeline {
public:
    explicit RtpTimeline(uint32_t initial, uint32_t clock_rate = 90000) : output_(initial), clock_rate_(clock_rate) {}
    uint32_t map(uint32_t input, uint64_t source, uint32_t step) {
        const uint32_t delta = input - input_;
        // Missing pictures still consume capture time (RFC 3550 section 5.1).
        // Bounding by ten frame steps compressed every IDR wait into 50 ms,
        // so long-lived video clients drifted minutes behind continuous audio.
        // Retain real forward gaps through the recovery window; source changes,
        // backward clocks and implausible jumps still start a bounded new epoch.
        output_ += initialized_ && source == source_ && delta <= clock_rate_ * 30 ? delta : step;
        source_ = source;
        input_ = input;
        initialized_ = true;
        return output_;
    }
    uint32_t advance(uint32_t step) {
        initialized_ = false;
        output_ += step;
        return output_;
    }

private:
    uint32_t output_;
    uint32_t clock_rate_;
    uint32_t input_ = 0;
    uint64_t source_ = 0;
    bool initialized_ = false;
};
}  // namespace aqara
