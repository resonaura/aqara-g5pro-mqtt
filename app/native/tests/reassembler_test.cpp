// These regressions must execute in Release builds as well as sanitizer builds.
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <vector>
#include "crypto/chacha20.hpp"
#include "media/reassembler.hpp"
#include "p2p/cipher.hpp"

static void put_u32_le(std::vector<uint8_t>& b, size_t offset, uint32_t value) {
    b[offset] = static_cast<uint8_t>(value);
    b[offset + 1] = static_cast<uint8_t>(value >> 8);
    b[offset + 2] = static_cast<uint8_t>(value >> 16);
    b[offset + 3] = static_cast<uint8_t>(value >> 24);
}

int main() {
    uint8_t key[32];
    for (int i = 0; i < 32; ++i)
        key[i] = static_cast<uint8_t>(i + 1);

    aqara::AVIOReassembler reassembler(key, key);
    int audio_frames = 0;
    int gap_requests = 0;
    std::vector<uint8_t> decoded;
    reassembler.set_callbacks(
        {},
        [&](const aqara::AudioFrame& frame) {
            ++audio_frames;
            decoded = frame.aac_adts_data;
        },
        [&]() { ++gap_requests; });

    const std::vector<uint8_t> plaintext = {0xff, 0xf1, 0x60, 0x40, 0x01, 0x7f, 0xfc, 0x11, 0x22};
    std::vector<uint8_t> frame(32 + 8 + plaintext.size(), 0);
    frame[0] = 0x88;
    frame[2] = 0x0e;
    put_u32_le(frame, 28, static_cast<uint32_t>(8 + plaintext.size()));
    for (int i = 0; i < 8; ++i)
        frame[32 + i] = static_cast<uint8_t>(0xa0 + i);
    aqara::ChaCha20::xor_stream(key, frame.data() + 32, 0, plaintext.data(), frame.data() + 40, plaintext.size());

    // Fragmented and reordered UDP delivery on media channel 4.
    reassembler.push_packet(4, 10, frame.data(), 17);
    reassembler.push_packet(4, 12, frame.data() + 34, frame.size() - 34);
    reassembler.push_packet(4, 11, frame.data() + 17, 17);
    assert(audio_frames == 1);
    assert(decoded == plaintext);
    assert(gap_requests == 0);  // Jitter must not interrupt healthy video readers.

    // Independent PPCS channels have independent 16-bit sequence spaces.
    // Different timestamps pass through.
    put_u32_le(frame, 8, 100);  // ms_part = 100
    put_u32_le(frame, 12, 1);   // s_part = 1 -> ts_ms = 1100
    reassembler.push_packet(1, 400, frame.data(), frame.size());
    assert(audio_frames == 2);

    // Duplicate timestamp frame is dropped
    reassembler.push_packet(1, 401, frame.data(), frame.size());
    assert(audio_frames == 2);  // Still 2, duplicate dropped!

    // Mic audio may be inserted between two UDP fragments of one video AVIO
    // frame. It must be peeled out instead of becoming part of the video bytes.
    int video_frames = 0;
    aqara::AVIOReassembler interleaved(key, key);
    interleaved.set_callbacks([&](const aqara::VideoFrame&) { ++video_frames; }, {}, {});
    std::vector<uint8_t> video(48, 0);
    video[0] = 0x4e;
    video[2] = 1;
    put_u32_le(video, 28, 16);
    for (int i = 0; i < 8; ++i)
        video[32 + i] = static_cast<uint8_t>(0x10 + i);
    const std::vector<uint8_t> video_plain = {0, 0, 0, 1, 0x65, 1, 2, 3};
    // Untabled video keeps its short Annex-B NAL clear after the nonce.
    std::copy(video_plain.begin(), video_plain.end(), video.begin() + 40);
    interleaved.push_packet(4, 100, video.data(), 20);
    std::vector<uint8_t> mixed;
    mixed.insert(mixed.end(), video.begin() + 20, video.begin() + 27);
    mixed.insert(mixed.end(), frame.begin(), frame.end());
    interleaved.push_packet(4, 101, mixed.data(), mixed.size());
    interleaved.push_packet(4, 102, video.data() + 27, video.size() - 27);
    assert(video_frames == 1);
    assert(interleaved.last_video_frame_ms() > 0);
    interleaved.reset();
    assert(interleaved.last_video_frame_ms() == 0);
    assert(reassembler.last_video_frame_ms() == 0);  // Audio and raw datagrams cannot mark video healthy.

    // Malformed encryption tables are rejected before offset arithmetic or
    // partial decryption. Bad access units must request a fresh IDR, not reach RTSP.
    aqara::AVIOReassembler validated(key, key);
    int valid_frames = 0;
    int idr_requests = 0;
    std::vector<uint8_t> annex_b;
    validated.set_callbacks(
        [&](const aqara::VideoFrame& frame) {
            ++valid_frames;
            annex_b = frame.annex_b_data;
        },
        {}, [&]() { ++idr_requests; });
    auto malformed = video;
    malformed[40] = 255;  // Table would extend beyond this complete AVIO frame.
    validated.push_packet(4, 1, malformed.data(), malformed.size());
    assert(valid_frames == 0);
    assert(idr_requests == 1);
    assert(validated.last_video_frame_ms() == 0);

    std::vector<uint8_t> table_payload(9 + 8 + 64, 0);
    table_payload[8] = 1;
    put_u32_le(table_payload, 9, 0xfffffff0);
    put_u32_le(table_payload, 13, 64);
    const auto before = table_payload;
    assert(!aqara::ChaCha20::decrypt_video_payload(table_payload.data(), table_payload.size(), key));
    assert(table_payload == before);
    put_u32_le(table_payload, 9, 48);
    put_u32_le(table_payload, 13, 32);  // Truncated NAL, with no integer overflow.
    assert(!aqara::ChaCha20::decrypt_video_payload(table_payload.data(), table_payload.size(), key));
    put_u32_le(table_payload, 9, 0);
    put_u32_le(table_payload, 13, 64);
    assert(aqara::ChaCha20::decrypt_video_payload(table_payload.data(), table_payload.size(), key));

    // A clean keyframe still passes after a rejected frame, without resetting
    // the packet sequence. Both legal start-code lengths remain byte-exact.
    validated.push_packet(4, 2, video.data(), video.size());
    assert(valid_frames == 1);
    assert(annex_b == video_plain);
    auto short_prefix = video;
    short_prefix.erase(short_prefix.begin() + 40);
    short_prefix.push_back(0x44);
    put_u32_le(short_prefix, 28, 16);
    validated.push_packet(4, 3, short_prefix.data(), short_prefix.size());
    assert(valid_frames == 2);
    assert(annex_b == std::vector<uint8_t>({0, 0, 1, 0x65, 1, 2, 3, 0x44}));

    // Confirmed packet loss still requests one fresh IDR after the bounded
    // reorder window is exhausted, discarding only the incomplete access unit.
    int64_t jitter_now = 0;
    aqara::AVIOReassembler lost(key, key, [&]() { return jitter_now; });
    int loss_requests = 0, recovered_frames = 0;
    lost.set_callbacks([&](const aqara::VideoFrame&) { ++recovered_frames; }, {}, [&]() { ++loss_requests; });
    lost.push_packet(4, 100, video.data(), 20);
    for (uint16_t seq = 102; seq < 117; ++seq)
        lost.push_packet(4, seq, video.data(), video.size());
    assert(loss_requests == 0);
    lost.push_packet(4, 117, video.data(), video.size());
    assert(loss_requests == 0);
    jitter_now = 149;
    lost.flush_expired();
    assert(loss_requests == 0);
    jitter_now = 150;
    lost.flush_expired();
    assert(loss_requests == 0);
    jitter_now = 499;
    lost.flush_expired();
    assert(loss_requests == 0);
    jitter_now = 500;
    lost.flush_expired();
    assert(loss_requests == 1);
    assert(recovered_frames == 16);
    const auto health = lost.statistics();
    assert(health.packets == 17);
    assert(health.reordered == 16 && health.sequence_gaps == 1);
    assert(health.video_frames == 16 && health.keyframe_requests == 1);
    assert(health.discarded_bytes == 20 && health.malformed_frames == 0);
    assert(health.missing_packets == 1 && health.max_gap_wait_ms == 500);
    jitter_now = 750;
    lost.push_packet(4, 101, video.data(), video.size());
    assert(lost.statistics().late_packets == 1 && lost.statistics().max_late_ms == 750);
    lost.push_packet(4, 101, video.data(), video.size());
    lost.push_packet(4, 102, video.data(), video.size());
    assert(lost.statistics().late_packets == 1);           // Duplicate retransmits are not new late fragments.
    assert(recovered_frames == 16 && loss_requests == 1);  // Never replay discarded frames or duplicate IDR requests.

    // Late tracking is bounded across wrap, expires, and cannot leak between sessions.
    aqara::AVIOReassembler late(key, key, [&]() { return jitter_now; });
    late.push_packet(1, 65534, video.data(), video.size());
    late.push_packet(1, 0, video.data(), video.size());
    jitter_now += 500;
    late.flush_expired();
    jitter_now += 100;
    late.push_packet(1, 65535, video.data(), video.size());
    assert(late.statistics().missing_packets == 1 && late.statistics().late_packets == 1);
    late.push_packet(1, 2, video.data(), video.size());
    jitter_now += 500;
    late.flush_expired();
    jitter_now += 2001;
    late.push_packet(1, 1, video.data(), video.size());
    assert(late.statistics().late_packets == 1);
    late.push_packet(1, 4, video.data(), video.size());
    jitter_now += 500;
    late.flush_expired();
    late.reset();
    late.push_packet(1, 4, video.data(), video.size());
    late.push_packet(1, 3, video.data(), video.size());
    assert(late.statistics().late_packets == 1);
    aqara::AVIOReassembler bounded_late(key, key, [&]() { return jitter_now; });
    bounded_late.push_packet(1, 0, video.data(), video.size());
    bounded_late.push_packet(1, 5000, video.data(), video.size());
    for (uint16_t seq = 1; seq < 5000; ++seq)
        bounded_late.push_packet(1, seq, video.data(), video.size());
    assert(bounded_late.statistics().missing_packets == 4999);
    assert(bounded_late.statistics().late_packets == 1024);

    // A retransmission after a 48-packet keyframe burst must not be treated
    // as loss just because the previous sixteen-packet limit was exceeded.
    int64_t reorder_now = 0;
    aqara::AVIOReassembler burst(key, key, [&]() { return reorder_now; });
    int burst_frames = 0, burst_requests = 0;
    burst.set_callbacks([&](const aqara::VideoFrame&) { ++burst_frames; }, {}, [&]() { ++burst_requests; });
    burst.push_packet(4, 65500, video.data(), video.size());
    for (uint32_t seq = 65502; seq <= 65549; ++seq)
        burst.push_packet(4, static_cast<uint16_t>(seq), video.data(), video.size());
    assert(burst_frames == 1 && burst_requests == 0);
    reorder_now = 100;
    burst.push_packet(4, 65501, video.data(), video.size());
    assert(burst_frames == 50 && burst_requests == 0);
    assert(burst.statistics().sequence_gaps == 0);
    burst.flush_expired();
    assert(burst_requests == 0);

    // Real 4 MP IDRs exceed 512 KiB / 256 UDP fragments. One late fragment
    // arrived as late as 472 ms on the real Outdoor stream. Keep the complete
    // frame across the former 150-ms deadline and sequence-number wrap.
    int64_t large_now = 0;
    aqara::AVIOReassembler large_burst(key, key, [&]() { return large_now; });
    int large_frames = 0, large_requests = 0;
    std::vector<uint8_t> large_decoded;
    large_burst.set_callbacks(
        [&](const aqara::VideoFrame& frame) {
            ++large_frames;
            large_decoded = frame.annex_b_data;
        },
        {}, [&]() { ++large_requests; });
    large_burst.push_packet(4, 65400, video.data(), video.size());
    auto large_video = video;
    large_video.resize(600 * 1024 + 40, 0x11);
    put_u32_le(large_video, 28, static_cast<uint32_t>(large_video.size() - 32));
    constexpr size_t fragment_bytes = 1200;
    large_burst.push_packet(4, 65401, large_video.data(), fragment_bytes);
    uint16_t large_sequence = 65403;
    for (size_t offset = fragment_bytes * 2; offset < large_video.size(); offset += fragment_bytes)
        large_burst.push_packet(4, large_sequence++, large_video.data() + offset,
                                std::min(fragment_bytes, large_video.size() - offset));
    assert(large_frames == 1 && large_requests == 0);
    large_now = 150;
    large_burst.flush_expired();
    assert(large_frames == 1 && large_requests == 0);
    large_now = 471;
    large_burst.flush_expired();
    assert(large_frames == 1 && large_requests == 0);
    large_now = 472;
    large_burst.push_packet(4, 65402, large_video.data() + fragment_bytes, fragment_bytes);
    assert(large_frames == 2 && large_requests == 0);
    assert(large_decoded == std::vector<uint8_t>(large_video.begin() + 40, large_video.end()));
    assert(large_burst.statistics().sequence_gaps == 0);

    // Observed Outdoor retransmissions reached 1,135 ms. A discarded fragment
    // teaches this channel a bounded window for the next burst, preserving a
    // complete 600 KiB IDR instead of discarding it again at 500 ms.
    int64_t adaptive_now = 0;
    aqara::AVIOReassembler adaptive(key, key, [&]() { return adaptive_now; });
    int adaptive_frames = 0, adaptive_requests = 0;
    std::vector<uint8_t> adaptive_decoded;
    adaptive.set_callbacks(
        [&](const aqara::VideoFrame& item) {
            ++adaptive_frames;
            adaptive_decoded = item.annex_b_data;
        },
        {}, [&]() { ++adaptive_requests; });
    adaptive.push_packet(4, 0, video.data(), video.size());
    adaptive.push_packet(4, 2, video.data(), video.size());
    adaptive_now = 500;
    adaptive.flush_expired();
    assert(adaptive_requests == 1);
    adaptive_now = 1135;
    adaptive.push_packet(4, 1, video.data(), video.size());
    adaptive_now = 1200;
    adaptive.push_packet(4, 3, large_video.data(), fragment_bytes);
    uint16_t adaptive_sequence = 5;
    for (size_t offset = fragment_bytes * 2; offset < large_video.size(); offset += fragment_bytes)
        adaptive.push_packet(4, adaptive_sequence++, large_video.data() + offset,
                             std::min(fragment_bytes, large_video.size() - offset));
    adaptive_now = 1700;
    adaptive.flush_expired();
    assert(adaptive_requests == 1);
    adaptive_now = 2335;
    adaptive.push_packet(4, 4, large_video.data() + fragment_bytes, fragment_bytes);
    assert(adaptive_frames == 3 && adaptive_requests == 1);
    assert(adaptive_decoded == std::vector<uint8_t>(large_video.begin() + 40, large_video.end()));
    assert(adaptive.statistics().sequence_gaps == 1);
    assert(adaptive.statistics().recovered_gaps == 1);
    assert(adaptive.statistics().max_recovered_wait_ms == 1135);
    assert(adaptive.statistics().max_video_wait_ms == 1235);
    adaptive.push_packet(4, adaptive_sequence, video.data(), video.size());
    assert(adaptive_frames == 4);  // Healthy in-order traffic is still immediate.
    adaptive.push_packet(4, static_cast<uint16_t>(adaptive_sequence + 2), video.data(), video.size());
    adaptive_now += 1234;
    adaptive.flush_expired();
    assert(adaptive_requests == 1);
    ++adaptive_now;
    adaptive.flush_expired();
    assert(adaptive_requests == 2);  // Genuine loss still has a finite deadline.
    adaptive.reset();
    adaptive.push_packet(4, 0, video.data(), video.size());
    adaptive.push_packet(4, 2, video.data(), video.size());
    adaptive_now += 500;
    adaptive.flush_expired();
    assert(adaptive_requests == 3);  // Session reset forgets the learned deadline.

    aqara::VideoReorderWindow window;
    assert(window.wait_ms(0) == 500);
    window.observe(-1, 0);
    window.observe(400, 0);
    window.observe(2001, 0);
    assert(window.wait_ms(0) == 500);
    window.observe(1135, 0);
    assert(window.wait_ms(100) == 1235);
    window.observe(1999, 100);
    assert(window.wait_ms(599999) == 1250);  // A hard cap, even for later arrivals.
    assert(window.wait_ms(600100) == 500);   // Forget old network conditions.
    assert(window.wait_ms(99) == 500);       // Never retain a future clock sample.

    // Sparse traffic still has a deadline, and recovered late duplicates must
    // not request another IDR or advance media twice.
    burst.push_packet(4, 15, video.data(), video.size());  // expected=14 after wrap
    reorder_now = 600;
    burst.flush_expired();
    assert(burst_requests == 1 && burst_frames == 51);
    burst.push_packet(4, 14, video.data(), video.size());
    assert(burst_requests == 1 && burst_frames == 51);
    assert(burst.statistics().duplicates == 1);

    // A producer cannot grow the reorder queue indefinitely at a fixed clock.
    aqara::AVIOReassembler pressure(key, key, []() { return int64_t(0); });
    int pressure_requests = 0;
    pressure.set_callbacks({}, {}, [&]() { ++pressure_requests; });
    pressure.push_packet(4, 0, video.data(), video.size());
    for (uint16_t seq = 2; seq < 2052; ++seq)
        pressure.push_packet(4, seq, video.data(), video.size());
    assert(pressure_requests == 1);
    assert(pressure.statistics().packets == 2051);

    aqara::AVIOReassembler byte_pressure(key, key, []() { return int64_t(0); });
    int byte_requests = 0;
    byte_pressure.set_callbacks({}, {}, [&]() { ++byte_requests; });
    byte_pressure.push_packet(4, 0, video.data(), video.size());
    std::vector<uint8_t> large_packet(65536, 0x11);
    for (uint16_t seq = 2; seq < 35; ++seq)
        byte_pressure.push_packet(4, seq, large_packet.data(), large_packet.size());
    assert(byte_requests == 1 && byte_pressure.statistics().sequence_gaps == 1);

    // Losing an audio-only channel fragment cannot invalidate healthy video
    // or force its readers to wait for another (large) keyframe.
    int64_t audio_now = 0;
    aqara::AVIOReassembler audio_loss(key, key, [&]() { return audio_now; });
    int continuing_video = 0, continuing_audio = 0, audio_loss_idrs = 0;
    audio_loss.set_callbacks([&](const aqara::VideoFrame&) { ++continuing_video; },
                             [&](const aqara::AudioFrame&) { ++continuing_audio; }, [&]() { ++audio_loss_idrs; });
    audio_loss.push_packet(4, 0, video.data(), video.size());
    audio_loss.push_packet(2, 10, frame.data(), 40);
    audio_loss.push_packet(2, 12, frame.data(), frame.size());
    audio_now = 150;
    audio_loss.flush_expired();
    audio_loss.push_packet(4, 1, video.data(), video.size());
    assert(continuing_video == 2 && continuing_audio == 1);
    assert(audio_loss_idrs == 0);
    assert(audio_loss.statistics().sequence_gaps == 1);
    assert(audio_loss.statistics().discarded_bytes == 40);
    assert(audio_loss.statistics().keyframe_requests == 0);
    audio_now = 1135;
    audio_loss.push_packet(2, 11, frame.data(), frame.size());
    audio_loss.push_packet(2, 14, frame.data(), frame.size());
    audio_now += 150;
    audio_loss.flush_expired();
    assert(audio_loss.statistics().sequence_gaps == 2);
    assert(audio_loss.statistics().max_video_wait_ms == 500);
    assert(audio_loss_idrs == 0);  // Audio cannot learn the video deadline.
    // Reject unsupported channel IDs and impossible datagrams before allocation.
    pressure.push_packet(255, 1, video.data(), video.size());
    pressure.push_packet(4, 1, video.data(), 65537);
    assert(pressure.statistics().packets == 2051);

    // Test regional TUTK master decoding from InitString
    std::vector<std::string> masters;
    std::string out_key;
    const std::string test_init =
        "EBGAEIBIKHJJGFJKEOGCFAEPHPMAHONDGJFPBKCPAJJMLFKBDBAGCJPBGOLKIKLKAJMJKFDOOFMOBECEJIMM:mysecretkey";
    bool ok = aqara::PPCSCipher::decode_init_string(test_init, masters, out_key);
    assert(ok);
    assert(masters.size() == 3);
    assert(masters[0] == "112.74.108.149");
    assert(masters[1] == "54.84.37.235");
    assert(masters[2] == "54.254.195.28");
    assert(out_key == "mysecretkey");

    std::cout << "reassembler and init_string test passed" << std::endl;
    return 0;
}
