#pragma once

#include <string>
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

struct EventP2pConnected {
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

struct EventPtzExecuted {
    std::string event = "ptz_executed";
    std::string did;
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
};

struct EventError {
    std::string event = "error";
    std::string did;
    std::string message;
};

template <typename T>
inline std::string to_json(const T& val) {
    return glz::write_json(val).value_or("{}");
}

} // namespace aqara
