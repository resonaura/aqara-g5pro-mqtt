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
    std::vector<uint8_t> decoded;
    reassembler.set_callbacks({}, [&](const aqara::AudioFrame& frame) {
        ++audio_frames;
        decoded = frame.aac_adts_data;
    }, {});

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

    // Independent PPCS channels have independent 16-bit sequence spaces.
    // Different timestamps pass through.
    put_u32_le(frame, 8, 100);  // ms_part = 100
    put_u32_le(frame, 12, 1);  // s_part = 1 -> ts_ms = 1100
    reassembler.push_packet(1, 400, frame.data(), frame.size());
    assert(audio_frames == 2);

    // Duplicate timestamp frame is dropped
    reassembler.push_packet(1, 401, frame.data(), frame.size());
    assert(audio_frames == 2); // Still 2, duplicate dropped!

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
    aqara::ChaCha20::xor_stream(key, video.data() + 32, 0, video_plain.data(), video.data() + 40, video_plain.size());
    interleaved.push_packet(4, 100, video.data(), 20);
    std::vector<uint8_t> mixed;
    mixed.insert(mixed.end(), video.begin() + 20, video.begin() + 27);
    mixed.insert(mixed.end(), frame.begin(), frame.end());
    interleaved.push_packet(4, 101, mixed.data(), mixed.size());
    interleaved.push_packet(4, 102, video.data() + 27, video.size() - 27);
    assert(video_frames == 1);

    // Test regional TUTK master decoding from InitString
    std::vector<std::string> masters;
    std::string out_key;
    const std::string test_init = "EBGAEIBIKHJJGFJKEOGCFAEPHPMAHONDGJFPBKCPAJJMLFKBDBAGCJPBGOLKIKLKAJMJKFDOOFMOBECEJIMM:mysecretkey";
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
