#pragma once

#include <string>
#include <memory>
#include <functional>
#include "p2p/client.hpp"
#include "media/reassembler.hpp"
#include "rtsp/server.hpp"

namespace aqara {

struct SessionConfig {
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
    int rtsp_port = 8555;
    std::string rtsp_path;
    int p2p_quality_channel = 0;
};

class StreamSession {
public:
    StreamSession(const SessionConfig& config, std::function<void(const std::string&)> event_cb);
    ~StreamSession();

    bool start();
    void stop();

    void request_keyframe();
    void set_quality(int channel);
    void ptz(int action, int speed = 50);
    void start_talkback();
    void stop_talkback();
    void send_talkback(const uint8_t* adts, size_t len);

    const std::string& get_did() const { return config_.did; }

private:
    SessionConfig config_;
    std::function<void(const std::string&)> event_cb_;

    std::shared_ptr<AvioReassembler> reassembler_;
    std::unique_ptr<RtspServer> rtsp_server_;
    std::unique_ptr<P2pClient> p2p_client_;
};

} // namespace aqara
