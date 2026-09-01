#pragma once

#include <string>
#include <vector>
#include <memory>
#include <thread>
#include <atomic>
#include <functional>
#include <mutex>
#include <set>
#include <netinet/in.h>
#include "../media/reassembler.hpp"

namespace aqara {

struct P2PConfig {
    std::string did;
    std::string p2p_id;
    std::string init_string;
    std::string app_pub_hex;
    std::string app_sign;
    std::string sign_time;
    std::string dev_pub_hex;
    std::string video_key_hex;
    std::string audio_key_hex;
    std::string camera_ip;
    int camera_port = 0;
    int p2p_quality_channel = 0;
};

class P2PClient {
public:
    P2PClient(const P2PConfig& config, std::shared_ptr<AVIOReassembler> reassembler,
              std::function<void(const std::string&)> event_cb);
    ~P2PClient();

    bool start();
    void stop();

    void request_keyframe();
    void set_quality(int channel);
    void ptz(int action, int speed = 50);
    void start_talkback();
    void stop_talkback();
    void send_talkback_frame(const uint8_t* adts, size_t len);

    bool is_connected() const { return is_connected_; }

private:
    void discovery_loop();
    void receiver_loop();
    void watchdog_loop();

    void handle_packet(const uint8_t* data, size_t len, const sockaddr_in& src);
    void handle_channel0_data(const uint8_t* data, size_t len);
    void dispatch_channel0(uint32_t type, const uint8_t* body, size_t body_len);
    void send_login_if_due(int64_t min_interval_ms = 1000);
    void notify_connected(const sockaddr_in& endpoint);

    void send_enc_drw(uint8_t channel, uint16_t seq, const uint8_t* payload, size_t len);
    void send_raw_packet(const uint8_t* data, size_t len, const sockaddr_in& dest);
    void send_raw_packet(const uint8_t* data, size_t len, const std::string& ip, int port);

    void queue_ack(uint8_t channel, uint16_t seq);
    void flush_acks(uint8_t channel);

    P2PConfig config_;
    std::shared_ptr<AVIOReassembler> reassembler_;
    std::function<void(const std::string&)> event_cb_;

    std::vector<uint8_t> ppcs_key_;
    std::vector<uint8_t> punch_buf_;

    int udp_fd_ = -1;
    std::atomic<bool> running_{false};
    std::atomic<bool> is_connected_{false};
    std::atomic<bool> session_started_{false};
    std::atomic<bool> session_ready_{false};
    std::atomic<bool> connected_notified_{false};
    std::atomic<int64_t> last_login_sent_ms_{0};
    std::atomic<int64_t> session_ready_since_ms_{0};
    std::atomic<int64_t> last_media_traffic_ms_{0};
    std::atomic<int64_t> last_video_traffic_ms_{0};
    std::atomic<int64_t> last_audio_traffic_ms_{0};
    std::atomic<int64_t> last_stream_retry_ms_{0};

    sockaddr_in camera_addr_{};
    std::vector<sockaddr_in> endpoints_;
    std::mutex endpoints_mutex_;

    std::thread discovery_thread_;
    std::thread receiver_thread_;
    std::thread watchdog_thread_;

    uint32_t cmd_seq_ = 1;
    uint16_t ch0_seq_ = 0;
    uint16_t ch3_seq_ = 0;
    uint16_t talk_seq_ = 0;
    size_t talk_frames_sent_ = 0;

    std::mutex ack_mutex_;
    std::set<uint16_t> pending_acks_[8];

    std::atomic<int64_t> last_p2p_traffic_ms_{0};
};

}  // namespace aqara
