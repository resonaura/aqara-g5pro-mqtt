#include <cstdlib>
#include <iostream>
#include <glaze/glaze.hpp>
#include "server.hpp"
#include "events.hpp"

namespace aqara {

struct IpcCommandDto {
    std::string cmd;
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
    int channel = 0;
    std::string direction;
    int action = 0;
    int speed = 50;
    std::string data_hex;
};

static std::vector<uint8_t> hex_to_bytes(const std::string& hex) {
    std::vector<uint8_t> bytes;
    bytes.reserve(hex.length() / 2);
    for (size_t i = 0; i + 1 < hex.length(); i += 2) {
        std::string byteString = hex.substr(i, 2);
        uint8_t byte = static_cast<uint8_t>(strtol(byteString.c_str(), nullptr, 16));
        bytes.push_back(byte);
    }
    return bytes;
}

IpcServer::IpcServer() = default;

IpcServer::~IpcServer() {
    running_ = false;
    std::lock_guard<std::mutex> lock(sessions_mutex_);
    sessions_.clear();
}

void IpcServer::send_event(const std::string& json_str) {
    std::cout << json_str << std::endl;
}

void IpcServer::run_stdio() {
    running_ = true;
    send_event(to_json(EventReady{}));

    std::string line;
    while (running_ && std::getline(std::cin, line)) {
        if (line.empty())
            continue;
        handle_command(line);
    }
}

void IpcServer::handle_command(const std::string& line) {
    IpcCommandDto cmd_dto;
    auto ec = glz::read_json(cmd_dto, line);
    if (ec) {
        send_event(to_json(EventError{.message = "JSON parse error: " + glz::format_error(ec, line)}));
        return;
    }

    const std::string& cmd = cmd_dto.cmd;

    if (cmd == "ping") {
        send_event(to_json(EventPong{}));
    } else if (cmd == "start_session" || cmd == "start_p2p") {
        SessionConfig cfg;
        cfg.did = cmd_dto.did;
        cfg.p2p_id = cmd_dto.p2p_id;
        cfg.init_string = cmd_dto.init_string;
        cfg.app_pub_hex = cmd_dto.app_pub_hex;
        cfg.app_sign = cmd_dto.app_sign;
        cfg.sign_time = cmd_dto.sign_time;
        cfg.dev_pub_hex = cmd_dto.dev_pub_hex;
        cfg.video_key_hex = cmd_dto.video_key_hex;
        cfg.audio_key_hex = cmd_dto.audio_key_hex;
        cfg.camera_ip = cmd_dto.camera_ip;
        cfg.camera_port = cmd_dto.camera_port;
        cfg.rtsp_port = cmd_dto.rtsp_port > 0 ? cmd_dto.rtsp_port : 8555;
        cfg.rtsp_path = cmd_dto.rtsp_path.empty() ? ("live/" + cfg.did) : cmd_dto.rtsp_path;
        cfg.p2p_quality_channel = cmd_dto.p2p_quality_channel;

        if (cfg.did.empty()) {
            send_event(to_json(EventError{.message = "Missing did in start_session"}));
            return;
        }

        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cfg.did);
        if (it != sessions_.end()) {
            if (it->second->restart_p2p(cfg)) {
                send_event(to_json(EventSessionStarted{.did = cfg.did, .rtsp_port = cfg.rtsp_port}));
            } else {
                send_event(to_json(EventError{.did = cfg.did, .message = "Failed to resurrect P2P tunnel"}));
            }
            return;
        }

        auto session = std::make_unique<StreamSession>(cfg, [this](const std::string& evt) { send_event(evt); });

        if (session->start()) {
            sessions_[cfg.did] = std::move(session);
            send_event(to_json(EventSessionStarted{.did = cfg.did, .rtsp_port = cfg.rtsp_port}));
        } else {
            send_event(to_json(EventError{.did = cfg.did, .message = "Failed to start session"}));
        }
    } else if (cmd == "request_keyframe") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->request_keyframe();
            send_event(to_json(EventKeyframeRequested{.did = cmd_dto.did}));
        }
    } else if (cmd == "set_quality") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->set_quality(cmd_dto.channel);
            send_event(to_json(EventQualitySet{.did = cmd_dto.did, .channel = cmd_dto.channel}));
        }
    } else if (cmd == "ptz") {
        int action = 0;
        if (cmd_dto.direction == "up")
            action = 1;
        else if (cmd_dto.direction == "down")
            action = 2;
        else if (cmd_dto.direction == "left")
            action = 3;
        else if (cmd_dto.direction == "right")
            action = 4;
        else
            action = cmd_dto.action;

        int speed = cmd_dto.speed > 0 ? cmd_dto.speed : 50;

        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->ptz(action, speed);
            send_event(to_json(EventPtzExecuted{.did = cmd_dto.did}));
        }
    } else if (cmd == "start_talkback") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->start_talkback();
            send_event(to_json(EventTalkbackStarted{.did = cmd_dto.did}));
        }
    } else if (cmd == "stop_talkback") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(cmd_dto.did);
        if (it != sessions_.end()) {
            it->second->stop_talkback();
            send_event(to_json(EventTalkbackStopped{.did = cmd_dto.did}));
        }
    } else if (cmd == "send_talkback") {
        auto bytes = hex_to_bytes(cmd_dto.data_hex);
        if (!bytes.empty()) {
            std::lock_guard<std::mutex> lock(sessions_mutex_);
            auto it = sessions_.find(cmd_dto.did);
            if (it != sessions_.end()) {
                it->second->send_talkback(bytes.data(), bytes.size());
            }
        }
    } else if (cmd == "stop_session" || cmd == "stop_p2p") {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        sessions_.erase(cmd_dto.did);
        send_event(to_json(EventSessionStopped{.did = cmd_dto.did}));
    } else if (cmd == "exit") {
        running_ = false;
    }
}

} // namespace aqara
