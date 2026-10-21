#include <cstdlib>
#include "p2p/frame-watchdog.hpp"

static void check(bool value) {
    if (!value)
        std::abort();
}

int main() {
    using Watchdog = aqara::FrameWatchdog;
    using Action = Watchdog::Action;
    Watchdog watchdog;
    check(watchdog.poll(100000, 0, 0) == Action::none);  // No authenticated session.
    check(watchdog.poll(3999, 1000, 0) == Action::none);
    check(watchdog.poll(4000, 1000, 0) == Action::keyframe);
    check(watchdog.poll(6999, 1000, 0) == Action::none);
    check(watchdog.poll(7000, 1000, 0) == Action::restart_stream);
    check(watchdog.poll(15999, 1000, 0) == Action::none);
    check(watchdog.poll(16000, 1000, 0) == Action::reconnect);
    check(watchdog.poll(40000, 1000, 0) == Action::none);  // Each action once per stall.

    // Healthy complete frames reset escalation, even after a long outage.
    check(watchdog.poll(41000, 1000, 40950) == Action::none);
    check(watchdog.poll(43950, 1000, 40950) == Action::keyframe);
    check(watchdog.poll(46950, 1000, 40950) == Action::restart_stream);
    check(watchdog.poll(55950, 1000, 40950) == Action::reconnect);

    // A one-second watchdog must actually reach the stream restart. The old
    // 6s/11s retry schedule skipped its >12s branch before reconnecting at 15s.
    Watchdog ticks;
    int keyframes = 0, restarts = 0, reconnects = 0;
    for (int64_t time = 1000; time <= 31000; time += 1000) {
        const auto action = ticks.poll(time, 1000, 0);
        keyframes += action == Action::keyframe;
        restarts += action == Action::restart_stream;
        reconnects += action == Action::reconnect;
    }
    check(keyframes == 1 && restarts == 1 && reconnects == 1);

    Watchdog delayed;
    check(delayed.poll(9000, 1000, 0) == Action::restart_stream);
    check(delayed.poll(17000, 1000, 0) == Action::reconnect);
    check(delayed.poll(17001, 17000, 1000) == Action::none);  // New session, old frame.
    check(delayed.poll(20000, 17000, 1000) == Action::keyframe);
    check(delayed.poll(17000, 17000, 18000) == Action::none);  // Defensive future timestamp.

    // Ordinary jitter and frequent packet traffic never affect the clock. Only
    // complete frames advance it; audio-only or duplicate traffic cannot do so.
    Watchdog healthy;
    for (int64_t now = 1000; now < 3600000; now += 1000)
        check(healthy.poll(now, 1000, now - 100) == Action::none);
}
