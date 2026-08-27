#include <iostream>
#include <cassert>
#include <vector>
#include "../src/crypto/chacha20.hpp"
#include "../src/crypto/hsalsa20.hpp"
#include "../src/rtsp/rtp_packetizer.hpp"
#include "../src/sync/jitter_buffer.hpp"
#include "../src/p2p/packet_reassembler.hpp"

using namespace aqara;

void test_chacha20() {
    uint8_t key[32] = {1, 2, 3, 4};
    uint8_t nonce[8] = {5, 6, 7, 8};
    uint8_t data[64] = "Hello world from C++ native Aqara ChaCha20 engine!";
    uint8_t original[64];
    std::memcpy(original, data, 64);

    chacha20_xor(key, nonce, 0, data, 64);
    assert(std::memcmp(data, original, 64) != 0); // Encrypted

    chacha20_xor(key, nonce, 0, data, 64);
    assert(std::memcmp(data, original, 64) == 0); // Decrypted back
    std::cout << "✔ ChaCha20 symmetric encryption test passed\n";
}

void test_hsalsa20() {
    uint8_t key[32] = {0x11, 0x22};
    uint8_t in[16] = {0x33, 0x44};
    uint8_t out[32];
    hsalsa20(key, in, out);
    bool non_zero = false;
    for (int i = 0; i < 32; i++) {
        if (out[i] != 0) non_zero = true;
    }
    assert(non_zero);
    std::cout << "✔ HSalsa20 key derivation test passed\n";
}

void test_rtp_packetizer() {
    std::vector<uint8_t> h264 = {
        0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1E, // SPS
        0, 0, 0, 1, 0x68, 0xCE, 0x3C, 0x80, // PPS
        0, 0, 0, 1, 0x65, 0x88, 0x80        // IDR
    };
    auto nals = RtpPacketizer::split_annexb_nalus(h264.data(), h264.size());
    assert(nals.size() == 3);
    assert((nals[0][0] & 0x1F) == 7);
    assert((nals[1][0] & 0x1F) == 8);
    assert((nals[2][0] & 0x1F) == 5);

    uint16_t seq = 100;
    auto pkts = RtpPacketizer::packetize_h264(nals[2], 90000, seq, 0x12345678, true);
    assert(pkts.size() == 1);
    assert((pkts[0][1] & 0x80) != 0); // Marker bit set
    assert(seq == 101);

    std::cout << "✔ RTP Packetizer Annex B splitting and H.264 NAL packing passed\n";
}

#include "../src/audio/talkback_sender.hpp"

void test_jitter_buffer() {
    JitterBuffer jb;
    jb.init();

    uint32_t v1 = jb.get_video_rtp_timestamp();
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    uint32_t v2 = jb.get_video_rtp_timestamp();
    assert(v2 > v1);

    uint32_t a1 = jb.get_audio_rtp_timestamp();
    uint32_t a2 = jb.get_audio_rtp_timestamp();
    assert(a2 == a1 + 1024); // Exact 1024-sample step

    std::cout << "✔ JitterBuffer timestamp monotonicity and audio spacing passed\n";
}

void test_talkback_sender() {
    std::vector<uint8_t> share_key(32, 0x5A);
    std::vector<uint8_t> ppcs_key(20, 0x33);
    TalkbackSender sender(share_key, ppcs_key);
    sender.set_active(true);

    uint8_t sample_pcm[160] = {0};
    for (int i = 0; i < 160; i++) sample_pcm[i] = (uint8_t)i;

    auto start_cmd = sender.build_start_command(0, 100);
    assert(start_cmd.size() == 16);
    assert(start_cmd[0] == 0); // Channel 0
    assert(start_cmd[4] == 0x0a && start_cmd[5] == 0x10); // 0x100a

    auto drw_pkt = sender.build_channel2_drw_packet(sample_pcm, 160);
    assert(drw_pkt.size() == 4 + 8 + 160);
    assert(drw_pkt[0] == 2); // Channel 2
    assert(drw_pkt[1] == 0); // Flags

    // Verify round-trip ChaCha20 decryption of Channel 2 audio payload
    uint8_t nonce[8];
    std::memcpy(nonce, drw_pkt.data() + 4, 8);
    uint8_t decrypted[160];
    std::memcpy(decrypted, drw_pkt.data() + 12, 160);
    chacha20_xor(share_key.data(), nonce, 0, decrypted, 160);
    assert(std::memcmp(decrypted, sample_pcm, 160) == 0);

    auto stop_cmd = sender.build_stop_command(1, 101);
    assert(stop_cmd.size() == 16);
    assert(stop_cmd[4] == 0x0c && stop_cmd[5] == 0x10); // 0x100c

    std::cout << "✔ TalkbackSender Channel 0 commands & Channel 2 ChaCha20 encryption passed\n";
}

int main() {
    std::cout << "Running C++ Native Engine Unit Tests...\n";
    test_chacha20();
    test_hsalsa20();
    test_rtp_packetizer();
    test_jitter_buffer();
    test_talkback_sender();
    std::cout << "All C++ Unit Tests Passed Successfully!\n";
    return 0;
}
