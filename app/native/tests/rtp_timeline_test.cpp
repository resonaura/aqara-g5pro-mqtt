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
}
