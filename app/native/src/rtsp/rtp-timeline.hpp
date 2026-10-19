#pragma once
#include <cstdint>

namespace aqara {
// Keep one RTP timeline across camera reconnects and disposable offline encoders.
class RtpTimeline {
public:
    explicit RtpTimeline(uint32_t initial) : output_(initial) {}
    uint32_t map(uint32_t input, uint64_t source, uint32_t step) {
        const uint32_t delta = input - input_;
        output_ += initialized_ && source == source_ && delta <= step * 10 ? delta : step;
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
    uint32_t input_ = 0;
    uint64_t source_ = 0;
    bool initialized_ = false;
};
}  // namespace aqara
