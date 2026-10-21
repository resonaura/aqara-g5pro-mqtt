#pragma once

#include <algorithm>
#include <cstdint>

namespace aqara {

// Receiver progress uses steady-clock milliseconds, never wall-clock time or
// packet counts: duplicate/encrypted traffic is not proof of a usable picture.
class FrameWatchdog {
public:
    enum class Action { none, keyframe, restart_stream, reconnect };

    Action poll(int64_t now, int64_t ready_at, int64_t frame_at) {
        if (ready_at <= 0)
            return Action::none;
        const int64_t progress = std::max(ready_at, frame_at);
        if (progress != progress_) {
            progress_ = progress;
            stage_ = 0;
        }
        const int64_t age = std::max<int64_t>(0, now - progress);
        const int stage = age >= 15000 ? 3 : age >= 6000 ? 2 : age >= 3000 ? 1 : 0;
        if (stage <= stage_)
            return Action::none;
        stage_ = stage;
        return stage == 3 ? Action::reconnect : stage == 2 ? Action::restart_stream : Action::keyframe;
    }

private:
    int64_t progress_ = 0;
    int stage_ = 0;
};

}  // namespace aqara
