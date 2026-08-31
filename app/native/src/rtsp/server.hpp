#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#include "../media/reassembler.hpp"

namespace aqara {

struct RtspClient {
    int socket_fd;
    std::string ip;
    int port;
    bool is_playing = false;
    bool received_keyframe = false;
    bool wait_idr = false;
    std::string session_id;

    // TCP Interleaved transport
    int video_interleaved_channel = -1;
    int audio_interleaved_channel = -1;

    // UDP transport
    int client_rtp_port = 0;
    int client_rtcp_port = 0;

    // RTP state is per RTSP client. Global sequence counters make every client
    // observe artificial packet loss when Home Assistant opens multiple readers.
    uint16_t video_rtp_seq = 0;
    uint32_t video_rtp_timestamp = 0;
    uint32_t video_ssrc = 0x12345678;
    uint16_t audio_rtp_seq = 0;
    uint32_t audio_rtp_timestamp = 0;
    uint32_t audio_ssrc = 0x87654321;
};

class RtspServer {
public:
    using KeyframeCallback = std::function<void()>;
    RtspServer(int port, const std::string& path, KeyframeCallback kf_cb = nullptr);
    ~RtspServer();

    bool start();
    void stop();

    void broadcast_video(const VideoFrame& vf);
    void broadcast_audio(const AudioFrame& af);

    void hold_for_new_idr();

    int get_port() const { return port_; }
    const std::string& get_path() const { return path_; }

private:
    void accept_loop();
    void handle_client(int client_fd);
    void process_rtsp_request(RtspClient& client, const std::string& req);

    std::string generate_sdp(const std::string& host_ip);
    void send_interleaved_rtp(RtspClient& client, int channel, const uint8_t* rtp_pkt, size_t len);
    void send_video_to_client(RtspClient& client, const VideoFrame& vf);

    int port_;
    std::string path_;
    KeyframeCallback kf_req_cb_;
    std::atomic<bool> running_{false};
    int server_fd_ = -1;
    std::thread accept_thread_;

    std::recursive_mutex clients_mutex_;
    std::unordered_map<int, std::unique_ptr<RtspClient>> clients_;

    // Media parameters
    std::vector<uint8_t> sps_;
    std::vector<uint8_t> pps_;
    std::vector<uint8_t> vps_;
    bool is_hevc_ = false;

    std::mutex keyframe_mutex_;
    VideoFrame cached_keyframe_;

    std::chrono::steady_clock::time_point last_video_send_time_;
    std::chrono::steady_clock::time_point last_audio_send_time_;
};

}  // namespace aqara
