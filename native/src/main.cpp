#include <iostream>
#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include <atomic>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <sstream>
#include <iomanip>
#include "crypto/chacha20.hpp"
#include "crypto/hsalsa20.hpp"
#include "p2p/ppcs_protocol.hpp"
#include "p2p/packet_reassembler.hpp"
#include "p2p/udp_receiver.hpp"
#include "sync/jitter_buffer.hpp"
#include "rtsp/rtsp_server.hpp"
#include "audio/talkback_sender.hpp"

using namespace aqara;

static const std::string b64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static std::vector<uint8_t> base64_decode(const std::string &in) {
    std::vector<uint8_t> out;
    std::vector<int> T(256, -1);
    for (int i = 0; i < 64; i++) T[(uint8_t)b64_chars[i]] = i;
    int val = 0, valb = -8;
    for (uint8_t c : in) {
        if (T[c] == -1) continue;
        val = (val << 6) + T[c];
        valb += 6;
        if (valb >= 0) {
            out.push_back(uint8_t((val >> valb) & 0xFF));
            valb -= 8;
        }
    }
    return out;
}

std::array<uint8_t, 32> parse_hex_key(const std::string &hex) {
    std::array<uint8_t, 32> key{};
    for (size_t i = 0; i < 32 && (i * 2 + 1) < hex.size(); i++) {
        std::string byte_str = hex.substr(i * 2, 2);
        key[i] = (uint8_t)std::stoul(byte_str, nullptr, 16);
    }
    return key;
}

int main(int argc, char **argv) {
    std::string did = "camera";
    std::string ip = "127.0.0.1";
    int port = 32108;
    std::string key_hex = "0000000000000000000000000000000000000000000000000000000000000000";
    int rtsp_port = 8555;
    bool is_hevc = false;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--did" && i + 1 < argc) did = argv[++i];
        else if (arg == "--ip" && i + 1 < argc) ip = argv[++i];
        else if (arg == "--port" && i + 1 < argc) port = std::stoi(argv[++i]);
        else if (arg == "--key" && i + 1 < argc) key_hex = argv[++i];
        else if (arg == "--rtsp-port" && i + 1 < argc) rtsp_port = std::stoi(argv[++i]);
        else if (arg == "--hevc") is_hevc = true;
    }

    auto session_key = parse_hex_key(key_hex);

    std::cerr << "🚀 [aqara-media-core] Starting for DID=" << did 
              << " Target=" << ip << ":" << port 
              << " RTSP Port=" << rtsp_port << "\n";

    JitterBuffer clock_sync;
    clock_sync.init();

    RtspServer rtsp(rtsp_port, "/live/" + did, is_hevc);
    if (!rtsp.start()) {
        std::cerr << "❌ [aqara-media-core] Failed to start RTSP server on port " << rtsp_port << "\n";
        return 1;
    }

    PacketReassembler reassembler(session_key);

    std::atomic<uint64_t> video_frame_count{0};
    std::atomic<uint64_t> total_bytes_received{0};
    std::atomic<bool> is_live{false};

    // Video Pacer Queue
    struct PacerEntry {
        DecryptedVideoFrame frame;
        uint32_t rtp_timestamp;
    };

    std::mutex queue_mutex;
    std::queue<PacerEntry> pacer_queue;
    std::atomic<bool> pacer_running{true};

    reassembler.on_video_frame([&](DecryptedVideoFrame &&frame) {
        uint32_t rtp_ts = clock_sync.get_video_rtp_timestamp();
        video_frame_count++;
        is_live = true;

        std::lock_guard<std::mutex> lock(queue_mutex);
        if (pacer_queue.size() > 60) {
            // Buffer overflow drop old frames
            while (pacer_queue.size() > 2) pacer_queue.pop();
        }
        pacer_queue.push({std::move(frame), rtp_ts});
    });

    reassembler.on_audio_frame([&](DecryptedAudioFrame &&frame) {
        uint32_t rtp_ts = clock_sync.get_audio_rtp_timestamp();
        rtsp.broadcast_audio(frame.data, rtp_ts);
    });

    // Dedicated high-precision sub-millisecond pacer thread
    std::thread pacer_thread([&]() {
        while (pacer_running) {
            PacerEntry entry;
            bool has_entry = false;
            {
                std::lock_guard<std::mutex> lock(queue_mutex);
                if (!pacer_queue.empty()) {
                    entry = std::move(pacer_queue.front());
                    pacer_queue.pop();
                    has_entry = true;
                }
            }

            if (has_entry) {
                rtsp.broadcast_video(entry.frame.data, entry.frame.is_keyframe, entry.rtp_timestamp);
            }

            // Sleep 20ms (50Hz pacing) with true high-resolution precision
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    });

    UdpReceiver udp(ip, port);
    bool udp_ok = udp.start([&](const uint8_t *data, size_t len) {
        total_bytes_received += len;
        // Strip PPCS framing or pass direct DRW payload
        if (len >= 4) {
            // DRW packet index is at offset 2 (uint16_t LE)
            uint16_t drw_idx = (uint16_t)data[2] | ((uint16_t)data[3] << 8);
            reassembler.process_channel1_packet(drw_idx, data + 4, len - 4);
        }
    });

    if (!udp_ok) {
        std::cerr << "❌ [aqara-media-core] Failed to bind UDP socket\n";
        pacer_running = false;
        if (pacer_thread.joinable()) pacer_thread.join();
        return 1;
    }

    // Telemetry output thread (JSON to stdout)
    std::thread telemetry_thread([&]() {
        uint64_t last_frames = 0;
        uint64_t last_bytes = 0;
        auto last_time = std::chrono::steady_clock::now();

        while (pacer_running) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            auto now = std::chrono::steady_clock::now();
            double elapsed = std::chrono::duration<double>(now - last_time).count();
            last_time = now;

            uint64_t cur_frames = video_frame_count.load();
            uint64_t cur_bytes = total_bytes_received.load();

            double fps = (double)(cur_frames - last_frames) / elapsed;
            double kbps = (double)(cur_bytes - last_bytes) / elapsed / 1024.0;

            last_frames = cur_frames;
            last_bytes = cur_bytes;

            std::cout << "{\"type\":\"metrics\",\"did\":\"" << did 
                      << "\",\"fps\":" << std::fixed << std::setprecision(1) << fps
                      << ",\"kbps\":" << std::fixed << std::setprecision(1) << kbps
                      << ",\"frames\":" << cur_frames
                      << ",\"clients\":" << rtsp.active_clients()
                      << ",\"live\":" << (is_live ? "true" : "false")
                      << "}" << std::endl;
        }
    });

    // Read stdin for IPC commands
    TalkbackSender talkback(std::vector<uint8_t>(session_key.begin(), session_key.end()));
    uint16_t ch0_seq = 10;
    uint32_t cmd_seq = 100;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        if (line == "exit" || line == "quit" || line.find("\"cmd\":\"stop\"") != std::string::npos) {
            break;
        }

        if (line.find("\"cmd\":\"start_talkback\"") != std::string::npos) {
            talkback.set_active(true);
            auto start_pkt = talkback.build_start_command(ch0_seq++, cmd_seq++);
            udp.send_packet(start_pkt.data(), start_pkt.size());
            std::cout << "{\"type\":\"talkback\",\"status\":\"started\"}" << std::endl;
        } else if (line.find("\"cmd\":\"stop_talkback\"") != std::string::npos) {
            auto stop_pkt = talkback.build_stop_command(ch0_seq++, cmd_seq++);
            udp.send_packet(stop_pkt.data(), stop_pkt.size());
            talkback.set_active(false);
            std::cout << "{\"type\":\"talkback\",\"status\":\"stopped\"}" << std::endl;
        } else if (line.find("\"cmd\":\"send_talkback_audio\"") != std::string::npos) {
            auto b64_pos = line.find("\"audio_b64\":\"");
            if (b64_pos != std::string::npos) {
                b64_pos += 13;
                auto end_pos = line.find("\"", b64_pos);
                std::string b64_str = line.substr(b64_pos, end_pos - b64_pos);
                auto raw_audio = base64_decode(b64_str);

                // Send 160-byte frames (20ms) on Channel 2
                size_t offset = 0;
                while (offset < raw_audio.size()) {
                    size_t chunk_len = std::min((size_t)160, raw_audio.size() - offset);
                    auto pkt = talkback.build_channel2_drw_packet(raw_audio.data() + offset, chunk_len);
                    udp.send_packet(pkt.data(), pkt.size());
                    offset += chunk_len;
                    std::this_thread::sleep_for(std::chrono::milliseconds(20));
                }
                std::cout << "{\"type\":\"talkback\",\"status\":\"sent\",\"bytes\":" << raw_audio.size() << "}" << std::endl;
            }
        }
    }

    pacer_running = false;
    if (pacer_thread.joinable()) pacer_thread.join();
    if (telemetry_thread.joinable()) telemetry_thread.join();
    udp.stop();
    rtsp.stop();

    std::cerr << "👋 [aqara-media-core] Stopped cleanly.\n";
    return 0;
}
