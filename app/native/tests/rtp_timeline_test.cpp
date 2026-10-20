#include <cstdlib>
#include "rtsp/rtp-timeline.hpp"
static void check(bool value) {
    if (!value)
        std::abort();
}
int main() {
    aqara::RtpTimeline clock(1000);
    check(clock.map(900000, 0, 4500) == 5500);
    check(clock.map(904500, 0, 4500) == 10000);
    check(clock.map(904500, 0, 4500) == 10000);  // multiple NAL packets, one picture
    check(clock.map(42, 1, 90000) == 100000);    // camera -> offline encoder
    check(clock.map(90042, 1, 90000) == 190000);
    check(clock.map(17, 2, 90000) == 280000);  // crashed encoder gets a new SSRC
    check(clock.map(100, 0, 4500) == 284500);  // live camera restarted its source clock
    check(clock.map(4600, 0, 4500) == 289000);
    check(clock.map(2, 0, 4500) == 293500);  // backward source timestamp is bounded
    aqara::RtpTimeline wrap(0);
    check(wrap.map(0xfffffff0, 0, 100) == 100);
    check(wrap.map(0x10, 0, 100) == 132);
    check(wrap.advance(1024) == 1156);

    // One hour with repeated two-second video losses: audio keeps sampling.
    // Every retained picture must stay on its original capture clock.
    aqara::RtpTimeline video(0);
    const auto first = video.map(0, 0, 4500);
    for (uint32_t frame = 1; frame <= 72000; ++frame) {
        if (frame % 200 < 40)
            continue;
        check(video.map(frame * 4500, 0, 4500) - first == frame * 4500);
    }
    aqara::RtpTimeline audio(0, 16000);
    check(audio.map(0, 1, 1024) == 1024);
    check(audio.map(32000, 1, 1024) == 33024);     // Two-second source gap is retained.
    check(audio.map(10000000, 1, 1024) == 34048);  // Implausible clock jump stays bounded.
}
