#pragma once

#include <string>
#include <cstdint>
#include <optional>
#include <glaze/glaze.hpp>

namespace aqara {

struct EventReady {
    std::string event = "ready";
};

struct EventPong {
    std::string event = "pong";
};

struct EventSessionStarted {
    std::string event = "session_started";
    std::string did;
    int rtsp_port = 0;
};

struct EventSessionStopped {
    std::string event = "session_stopped";
    std::string did;
};

struct EventP2PConnected {
    std::string event = "p2p_connected";
    std::string did;
    std::string ip;
    int port = 0;
};

struct EventSessionReady {
    std::string event = "session_ready";
    std::string did;
};

struct EventKeyframe {
    std::string event = "keyframe";
    std::string did;
    std::string video_codec;
};

struct EventKeyframeRequested {
    std::string event = "keyframe_requested";
    std::string did;
};

struct EventRequestKeyframe {
    std::string event = "request_keyframe";
    std::string did;
};

struct EventQualitySet {
    std::string event = "quality_set";
    std::string did;
    int channel = 0;
};

struct EventPTZSent {
    std::string event = "ptz_sent";
    std::string did;
    std::string direction;
};

struct EventPTZRejected {
    std::string event = "ptz_rejected";
    std::string did;
    std::string direction;
    std::string reason;
};

struct EventPTZResponse {
    std::string event = "ptz_response";
    std::string did;
    size_t body_bytes = 0;
    uint32_t ioctl = 0;
    std::optional<int> code;
    std::string outcome = "unknown";
};

struct EventTalkbackStarted {
    std::string event = "talkback_started";
    std::string did;
};

struct EventTalkbackReady {
    std::string event = "talkback_ready";
    std::string did;
};

struct EventTalkbackStopped {
    std::string event = "talkback_stopped";
    std::string did;
};

struct EventUnhealthy {
    std::string event = "unhealthy";
    std::string did;
    std::string reason;
};

struct EventMediaRecovery {
    std::string event = "media_recovery";
    std::string did;
    std::string action;
    int64_t video_age_ms = -1, decoded_age_ms = -1;
};

struct EventMediaHealth {
    std::string event = "media_health";
    std::string did;
    bool connected = false, session_ready = false;
    uint64_t packets = 0, duplicates = 0, reordered = 0, sequence_gaps = 0;
    uint64_t video_frames = 0, audio_frames = 0, discarded_bytes = 0;
    uint64_t malformed_frames = 0, keyframe_requests = 0;
    uint64_t missing_packets = 0, late_packets = 0, max_late_ms = 0, max_gap_wait_ms = 0;
    uint64_t recovered_gaps = 0, max_recovered_wait_ms = 0, max_video_wait_ms = 500;
    uint64_t split_audio_headers = 0;
    int receive_buffer_bytes = 0;
    uint64_t max_packet_work_us = 0;
    int64_t video_age_ms = -1, audio_age_ms = -1, decoded_age_ms = -1;
};

struct EventSnapshot {
    std::string event = "snapshot";
    std::string did;
    std::string data_base64;
};

struct EventError {
    std::string event = "error";
    std::string did;
    std::string message;
    std::string operation;
};

template<typename T>
inline std::string to_json(const T& val) {
    return glz::write_json(val).value_or("{}");
}

}  // namespace aqara
