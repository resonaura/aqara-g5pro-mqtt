#pragma once

#include <algorithm>
#include <cstdint>

namespace aqara {

// Only a missing video fragment waits. Learn from actual retransmissions,
// with a hard deadline and expiry instead of delaying every media packet.
class VideoReorderWindow {
public:
    int64_t wait_ms(int64_t now) const {
        return observed_at_ >= 0 && now >= observed_at_ && now - observed_at_ < 600000 ? learned_ms_ : 500;
    }

    void observe(int64_t wait, int64_t now) {
        if (wait < 500 || wait > 2000 || now < 0)
            return;
        learned_ms_ = std::max(wait_ms(now), std::min<int64_t>(1250, wait + 100));
        observed_at_ = now;
    }

private:
    int64_t learned_ms_ = 500;
    int64_t observed_at_ = -1;
};

}  // namespace aqara
