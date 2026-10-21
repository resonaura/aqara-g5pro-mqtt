#include <arpa/inet.h>
#include <unistd.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <source_location>
#include "rtsp/server.hpp"

static void check(bool value, const std::source_location at = std::source_location::current()) {
    if (!value) {
        std::fprintf(stderr, "RTSP check failed at line %u\n", at.line());
        std::abort();
    }
}
static void request(int fd, const std::string& text) {
    check(send(fd, text.data(), text.size(), 0) == static_cast<ssize_t>(text.size()));
    std::string response;
    char byte;
    while (!response.ends_with("\r\n\r\n")) {
        check(recv(fd, &byte, 1, 0) == 1);
        response += byte;
        check(response.size() < 4096);
    }
    check(response.starts_with("RTSP/1.0 200 OK"));
}
static int viewer(int port, bool slow, bool audio = false) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    check(fd >= 0);
    if (slow) {
        int buffer = 4096;
        check(setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buffer, sizeof(buffer)) == 0);
    }
    timeval timeout{3, 0};
    check(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    check(connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    const auto url = "rtsp://127.0.0.1:" + std::to_string(port) + "/live/test";
    request(fd,
            "SETUP " + url + "/track0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n");
    if (audio)
        request(fd, "SETUP " + url +
                        "/track1 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n");
    request(fd, "PLAY " + url + " RTSP/1.0\r\nCSeq: 3\r\nSession: test\r\n\r\n");
    return fd;
}
static uint32_t timestamp(int fd, uint8_t channel, size_t audio_bytes = 0) {
    const auto read = [fd](uint8_t* out, size_t size) {
        while (size) {
            const auto n = recv(fd, out, size, 0);
            check(n > 0);
            out += n;
            size -= static_cast<size_t>(n);
        }
    };
    uint8_t header[4];
    read(header, sizeof(header));
    check(header[0] == '$' && header[1] == channel);
    std::vector<uint8_t> packet((size_t(header[2]) << 8) | header[3]);
    check(packet.size() >= 12);
    read(packet.data(), packet.size());
    if (audio_bytes) {
        check(packet.size() == 16 + audio_bytes);
        check(((size_t(packet[14]) << 5) | (packet[15] >> 3)) == audio_bytes);
    }
    return (uint32_t(packet[4]) << 24) | (uint32_t(packet[5]) << 16) | (uint32_t(packet[6]) << 8) | packet[7];
}
int main() {
    using namespace std::chrono;
    {
        aqara::RTSPServer clock_server(0, "live/test");
        check(clock_server.start());
        aqara::VideoFrame video{.annex_b_data = {0, 0, 0, 1, 0x65, 0x11},
                                .is_keyframe = true,
                                .width = 1920,
                                .height = 1080,
                                .codec_id = 0x4e,
                                .timestamp_ms = 1000};
        clock_server.broadcast_video(video);
        const int reader = viewer(clock_server.get_port(), false, true);
        const auto first_video = timestamp(reader, 0);
        aqara::AudioFrame audio{.aac_adts_data = {0x21, 0x10}, .timestamp_ms = 1000};
        clock_server.broadcast_audio(audio);
        const auto first_audio = timestamp(reader, 2);
        // A camera outage discards audio as well as pictures. Both tracks must
        // retain the same two seconds rather than compressing the missing AAC.
        video.timestamp_ms = audio.timestamp_ms = 3000;
        clock_server.broadcast_video(video);
        clock_server.broadcast_audio(audio);
        check(timestamp(reader, 0) - first_video == 2 * 90000);
        check(timestamp(reader, 2) - first_audio == 2 * 16000);
        audio.timestamp_ms += 64;
        clock_server.broadcast_audio(audio);
        check(timestamp(reader, 2) - first_audio == 2 * 16000 + 1024);
        // Large legal AAC units must reach the reader complete, rather than
        // advertising their full length while sending only 2,048 bytes.
        audio.aac_adts_data.assign(3000, 0x21);
        audio.timestamp_ms += 64;
        clock_server.broadcast_audio(audio);
        check(timestamp(reader, 2, 3000) - first_audio == 2 * 16000 + 2048);
        // Malformed/truncated ADTS and oversized AUs must not poison the next
        // valid packet or consume its timestamp/sequence position.
        audio.aac_adts_data = {0xff, 0xf1, 0x60};
        clock_server.broadcast_audio(audio);
        audio.aac_adts_data = {0xff, 0xf1, 0x60, 0x40, 0x01, 0x7f, 0xfc, 0x11, 0x22};
        clock_server.broadcast_audio(audio);
        audio.aac_adts_data.assign(8192, 0x21);
        clock_server.broadcast_audio(audio);
        audio.aac_adts_data = {0x21, 0x10};
        audio.timestamp_ms += 64;
        clock_server.broadcast_audio(audio);
        check(timestamp(reader, 2, 2) - first_audio == 2 * 16000 + 3072);
        clock_server.stop();
        close(reader);
    }
    aqara::RTSPServer server(0, "live/test");
    check(server.start());
    aqara::RTSPServer conflict(server.get_port(), "live/another-camera");
    check(!conflict.start());  // Never share or silently steal another camera's URL.
    const int slow = viewer(server.get_port(), true);
    const int healthy = viewer(server.get_port(), false);
    std::atomic<size_t> received{0};
    std::thread reader([&]() {
        uint8_t bytes[65536];
        while (true) {
            const auto n = recv(healthy, bytes, sizeof(bytes), 0);
            if (n <= 0)
                return;
            received += static_cast<size_t>(n);
        }
    });
    aqara::VideoFrame frame{.annex_b_data = {0, 0, 0, 1, 0x65},
                            .is_keyframe = true,
                            .width = 2688,
                            .height = 1520,
                            .codec_id = 0x4e,
                            .timestamp_ms = 1000};
    frame.annex_b_data.resize(512 * 1024, 0x55);
    milliseconds max_callback{0};
    for (int i = 0; i < 32; ++i) {
        const auto began = steady_clock::now();
        server.broadcast_video(frame);
        max_callback = std::max(max_callback, duration_cast<milliseconds>(steady_clock::now() - began));
        frame.timestamp_ms += 50;
        std::this_thread::sleep_for(milliseconds(10));
    }
    const auto deadline = steady_clock::now() + seconds(3);
    while (received < frame.annex_b_data.size() * 32 && steady_clock::now() < deadline)
        std::this_thread::sleep_for(milliseconds(10));
    check(received >= frame.annex_b_data.size() * 32);
#ifndef AQARA_SANITIZED_TEST
    check(max_callback < milliseconds(150));  // The old synchronous sender blocks >250 ms.
#endif
    server.stop();
    reader.join();
    close(healthy);
    close(slow);
    std::printf("32 large access units: maximum producer callback %lld ms; healthy viewer received %zu bytes\n",
                static_cast<long long>(max_callback.count()), received.load());
}
