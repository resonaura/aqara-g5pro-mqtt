#include <cstdlib>
#include <iostream>
#include "server.hpp"

namespace aqara {

static std::string json_get_string(const std::string& json, const std::string& key) {
    std::string pattern = "\"" + key + "\":";
    size_t pos = json.find(pattern);
    if (pos == std::string::npos) {
        pattern = "\"" + key + "\" :";
        pos = json.find(pattern);
    }
    if (pos == std::string::npos)
        return "";

    pos += pattern.length();
    while (pos < json.length() && (json[pos] == ' ' || json[pos] == '\t'))
        pos++;
    if (pos >= json.length() || json[pos] != '"')
        return "";

    pos++;  // skip opening quote
    size_t end = json.find('"', pos);
    if (end == std::string::npos)
        return "";
    return json.substr(pos, end - pos);
}

static int json_get_int(const std::string& json, const std::string& key, int def = 0) {
    std::string pattern = "\"" + key + "\":";
    size_t pos = json.find(pattern);
    if (pos == std::string::npos) {
        pattern = "\"" + key + "\" :";
        pos = json.find(pattern);
    }
    if (pos == std::string::npos)
        return def;

    pos += pattern.length();
    while (pos < json.length() && (json[pos] == ' ' || json[pos] == '\t'))
        pos++;

    try {
        return std::stoi(json.substr(pos));
    } catch (...) {
        return def;
    }
}

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
    send_event("{\"event\":\"ready\"}");

    std::string line;
    while (running_ && std::getline(std::cin, line)) {
        if (line.empty())
            continue;
        handle_command(line);
    }
}

void IpcServer::handle_command(const std::string& line) {
    std::string cmd = json_get_string(line, "cmd");

    if (cmd == "ping") {
        send_event("{\"event\":\"pong\"}");
    } else if (cmd == "start_session" || cmd == "start_p2p") {
        SessionConfig cfg;
        cfg.did = json_get_string(line, "did");
        cfg.p2p_id = json_get_string(line, "p2p_id");
        cfg.init_string = json_get_string(line, "init_string");
        cfg.app_pub_hex = json_get_string(line, "app_pub_hex");
        cfg.app_sign = json_get_string(line, "app_sign");
        cfg.sign_time = json_get_string(line, "sign_time");
        cfg.dev_pub_hex = json_get_string(line, "dev_pub_hex");
        cfg.video_key_hex = json_get_string(line, "video_key_hex");
        cfg.audio_key_hex = json_get_string(line, "audio_key_hex");
        cfg.camera_ip = json_get_string(line, "camera_ip");
        cfg.camera_port = json_get_int(line, "camera_port", 0);
        cfg.rtsp_port = json_get_int(line, "rtsp_port", 8555);
        cfg.rtsp_path = json_get_string(line, "rtsp_path");
        if (cfg.rtsp_path.empty())
            cfg.rtsp_path = "live/" + cfg.did;
        cfg.p2p_quality_channel = json_get_int(line, "p2p_quality_channel", 0);

        if (cfg.did.empty()) {
            send_event("{\"event\":\"error\",\"message\":\"Missing did in start_session\"}");
            return;
        }

        auto session = std::make_unique<StreamSession>(cfg, [this](const std::string& evt) { send_event(evt); });

        if (session->start()) {
            std::lock_guard<std::mutex> lock(sessions_mutex_);
            sessions_[cfg.did] = std::move(session);
            send_event("{\"event\":\"session_started\",\"did\":\"" + cfg.did +
                       "\",\"rtsp_port\":" + std::to_string(cfg.rtsp_port) + "}");
        } else {
            send_event("{\"event\":\"error\",\"did\":\"" + cfg.did + "\",\"message\":\"Failed to start session\"}");
        }
    } else if (cmd == "request_keyframe") {
        std::string did = json_get_string(line, "did");
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(did);
        if (it != sessions_.end()) {
            it->second->request_keyframe();
            send_event("{\"event\":\"keyframe_requested\",\"did\":\"" + did + "\"}");
        }
    } else if (cmd == "set_quality") {
        std::string did = json_get_string(line, "did");
        int channel = json_get_int(line, "channel", 0);
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(did);
        if (it != sessions_.end()) {
            it->second->set_quality(channel);
            send_event("{\"event\":\"quality_set\",\"did\":\"" + did + "\",\"channel\":" + std::to_string(channel) +
                       "}");
        }
    } else if (cmd == "ptz") {
        std::string did = json_get_string(line, "did");
        std::string dir = json_get_string(line, "direction");
        int action = 0;
        if (dir == "up")
            action = 1;
        else if (dir == "down")
            action = 2;
        else if (dir == "left")
            action = 3;
        else if (dir == "right")
            action = 4;
        else
            action = json_get_int(line, "action", 0);

        int speed = json_get_int(line, "speed", 50);

        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(did);
        if (it != sessions_.end()) {
            it->second->ptz(action, speed);
            send_event("{\"event\":\"ptz_executed\",\"did\":\"" + did + "\"}");
        }
    } else if (cmd == "start_talkback") {
        std::string did = json_get_string(line, "did");
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(did);
        if (it != sessions_.end()) {
            it->second->start_talkback();
            send_event("{\"event\":\"talkback_started\",\"did\":\"" + did + "\"}");
        }
    } else if (cmd == "stop_talkback") {
        std::string did = json_get_string(line, "did");
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(did);
        if (it != sessions_.end()) {
            it->second->stop_talkback();
            send_event("{\"event\":\"talkback_stopped\",\"did\":\"" + did + "\"}");
        }
    } else if (cmd == "send_talkback") {
        std::string did = json_get_string(line, "did");
        std::string hex_data = json_get_string(line, "data_hex");
        auto bytes = hex_to_bytes(hex_data);
        if (!bytes.empty()) {
            std::lock_guard<std::mutex> lock(sessions_mutex_);
            auto it = sessions_.find(did);
            if (it != sessions_.end()) {
                it->second->send_talkback(bytes.data(), bytes.size());
            }
        }
    } else if (cmd == "stop_session" || cmd == "stop_p2p") {
        std::string did = json_get_string(line, "did");
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        sessions_.erase(did);
        send_event("{\"event\":\"session_stopped\",\"did\":\"" + did + "\"}");
    } else if (cmd == "exit") {
        running_ = false;
    }
}

}  // namespace aqara
