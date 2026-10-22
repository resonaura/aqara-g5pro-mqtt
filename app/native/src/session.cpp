#include <cstdlib>
#include <cstring>
#include <iostream>
#include "session.hpp"
#include "ipc/events.hpp"

namespace aqara {

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

StreamSession::StreamSession(const SessionConfig& config, std::function<void(const std::string&)> event_cb)
    : config_(config), event_cb_(std::move(event_cb)) {
    auto vkey = hex_to_bytes(config_.video_key_hex);
    auto akey = hex_to_bytes(config_.audio_key_hex);

    uint8_t vk[32] = {0};
    uint8_t ak[32] = {0};
    if (vkey.size() >= 32)
        std::memcpy(vk, vkey.data(), 32);
    if (akey.size() >= 32)
        std::memcpy(ak, akey.data(), 32);

    reassembler_ = std::make_shared<AVIOReassembler>(vk, ak);
    rtsp_server_ = std::make_unique<RTSPServer>(config_.rtsp_port, config_.rtsp_path, [this]() {
        // RTSP PLAY may request an IDR, but it must not reset the shared P2P
        // reassembly state or gate existing readers. New clients have their own
        // wait_idr state; opening a preview must not pause ongoing recording.
        if (auto client = p2p_client())
            client->request_keyframe();
    });

    rtsp_server_->set_initial_codec(config_.video_codec == "hevc");
    reassembler_->set_callbacks(
        [this](const VideoFrame& vf) {
            if (vf.is_keyframe && !seen_first_keyframe_) {
                seen_first_keyframe_ = true;
                if (event_cb_)
                    event_cb_(to_json(
                        EventKeyframe{.did = config_.did, .video_codec = vf.codec_id == 0x004F ? "hevc" : "h264"}));
            }

            if (vf.height > 0) {
                current_height_ = vf.height;
                // Switch quality ONLY if current camera resolution differs from target
                if (!quality_switched_ && seen_first_keyframe_) {
                    bool needs_switch = false;
                    const bool is_g5 = (config_.did.find("agl004") != std::string::npos ||
                                        config_.did.find("lumi3") != std::string::npos);

                    if (is_g5) {
                        // G5 Pro: channel 3=1520p (max), channel 0=1080p (mid), channel 2=360p (low)
                        if (config_.p2p_quality_channel == 3 && vf.height < 1400) {
                            needs_switch = true;
                        } else if (config_.p2p_quality_channel == 0 && (vf.height < 1000 || vf.height > 1200)) {
                            needs_switch = true;
                        } else if (config_.p2p_quality_channel == 2 && vf.height > 500) {
                            needs_switch = true;
                        }
                    } else {
                        // Standard cameras / E1: channel 0=1296p (max), channel 1=1080p (mid), channel 2=360p (low)
                        if (config_.p2p_quality_channel == 0 && vf.height < 1200) {
                            needs_switch = true;
                        } else if (config_.p2p_quality_channel == 1 && (vf.height < 900 || vf.height > 1150)) {
                            needs_switch = true;
                        } else if (config_.p2p_quality_channel == 2 && vf.height > 500) {
                            needs_switch = true;
                        }
                    }

                    if (needs_switch) {
                        quality_switched_ = true;
                        std::cerr << "[NativeSession] Camera " << config_.did << " running at " << vf.width << "x"
                                  << vf.height << " (desired channel " << config_.p2p_quality_channel
                                  << "), upgrading resolution via 0x100E" << std::endl;
                        if (auto client = p2p_client()) {
                            client->set_quality(config_.p2p_quality_channel);
                        }
                    }
                }
            }

            if (rtsp_server_)
                rtsp_server_->broadcast_video(vf);
        },
        [this](const AudioFrame& af) {
            if (rtsp_server_)
                rtsp_server_->broadcast_audio(af);
        },
        [this]() {
            if (rtsp_server_)
                rtsp_server_->hold_for_new_idr();
            if (auto client = p2p_client())
                client->request_keyframe();
            if (event_cb_)
                event_cb_(to_json(EventRequestKeyframe{.did = config_.did}));
        });

    P2PConfig pcfg;
    pcfg.did = config_.did;
    pcfg.p2p_id = config_.p2p_id;
    pcfg.init_string = config_.init_string;
    pcfg.app_pub_hex = config_.app_pub_hex;
    pcfg.app_sign = config_.app_sign;
    pcfg.sign_time = config_.sign_time;
    pcfg.dev_pub_hex = config_.dev_pub_hex;
    pcfg.video_key_hex = config_.video_key_hex;
    pcfg.audio_key_hex = config_.audio_key_hex;
    pcfg.camera_ip = config_.camera_ip;
    pcfg.camera_port = config_.camera_port;
    pcfg.p2p_quality_channel = config_.p2p_quality_channel;

    p2p_client_ = std::make_shared<P2PClient>(pcfg, reassembler_, event_cb_);
}

StreamSession::~StreamSession() {
    stop();
}

bool StreamSession::start_output() {
    if (output_started_)
        return true;
    if (!rtsp_server_->start()) {
        std::cerr << "[NativeSession] Failed to start RTSP server on port " << config_.rtsp_port << std::endl;
        return false;
    }

    int video_ingest = config_.udp_video_port > 0 ? config_.udp_video_port : (10000 + (config_.rtsp_port - 8555) * 4);
    int audio_ingest = config_.udp_audio_port > 0 ? config_.udp_audio_port : (video_ingest + 2);
    if (!rtsp_server_->start_udp_ingest(video_ingest, audio_ingest)) {
        rtsp_server_->stop();
        return false;
    }
    output_started_ = true;
    return true;
}

bool StreamSession::start() {
    if (!start_output())
        return false;
    const auto client = p2p_client();
    if (!client || !client->start()) {
        std::cerr << "[NativeSession] Failed to start P2P client for " << config_.did << std::endl;
        rtsp_server_->stop();
        return false;
    }

    std::cerr << "[NativeSession] Stream session active for " << config_.did
              << " rtsp=rtsp://0.0.0.0:" << config_.rtsp_port << "/" << config_.rtsp_path << std::endl;
    return true;
}

bool StreamSession::restart_p2p(const SessionConfig& new_cfg) {
    // Unpublish first. RTSP callbacks retain their own reference; never hold the
    // publication lock while joining a receiver that may request a keyframe.
    const auto previous = exchange_p2p(nullptr);
    if (previous)
        previous->stop();

    // The old receiver has now joined: its frame callbacks can no longer read
    // these keys/configuration or update the per-session quality flags.
    config_ = new_cfg;
    seen_first_keyframe_ = false;
    quality_switched_ = false;
    if (rtsp_server_)
        rtsp_server_->hold_for_new_idr();

    auto vkey = hex_to_bytes(config_.video_key_hex);
    auto akey = hex_to_bytes(config_.audio_key_hex);
    uint8_t vk[32] = {0};
    uint8_t ak[32] = {0};
    if (vkey.size() >= 32)
        std::memcpy(vk, vkey.data(), 32);
    if (akey.size() >= 32)
        std::memcpy(ak, akey.data(), 32);

    reassembler_->set_keys(vk, ak);

    P2PConfig pcfg;
    pcfg.did = config_.did;
    pcfg.p2p_id = config_.p2p_id;
    pcfg.init_string = config_.init_string;
    pcfg.app_pub_hex = config_.app_pub_hex;
    pcfg.app_sign = config_.app_sign;
    pcfg.sign_time = config_.sign_time;
    pcfg.dev_pub_hex = config_.dev_pub_hex;
    pcfg.video_key_hex = config_.video_key_hex;
    pcfg.audio_key_hex = config_.audio_key_hex;
    pcfg.camera_ip = config_.camera_ip;
    pcfg.camera_port = config_.camera_port;
    pcfg.p2p_quality_channel = config_.p2p_quality_channel;

    std::cerr << "[NativeSession] Preserving RTSP server on port " << config_.rtsp_port
              << " while resurrecting P2P tunnel for " << config_.did << std::endl;

    auto client = std::make_shared<P2PClient>(pcfg, reassembler_, event_cb_);
    exchange_p2p(client);
    return client->start();
}

void StreamSession::stop() {
    output_started_ = false;
    if (auto client = exchange_p2p(nullptr)) {
        client->stop();
    }
    if (rtsp_server_) {
        rtsp_server_->stop();
    }
}

void StreamSession::request_keyframe() {
    if (rtsp_server_)
        rtsp_server_->hold_for_new_idr();
    if (auto client = p2p_client())
        client->request_keyframe();
}

void StreamSession::set_quality(int channel) {
    if (auto client = p2p_client())
        client->set_quality(channel);
}

bool StreamSession::ptz(const std::string& direction) {
    if (auto client = p2p_client())
        return client->ptz(direction);
    return false;
}

void StreamSession::start_talkback() {
    if (auto client = p2p_client())
        client->start_talkback();
}

void StreamSession::stop_talkback() {
    if (auto client = p2p_client())
        client->stop_talkback();
}

void StreamSession::send_talkback(const uint8_t* adts, size_t len) {
    if (auto client = p2p_client())
        client->send_talkback_frame(adts, len);
}

std::vector<uint8_t> StreamSession::get_snapshot_annexb() const {
    if (rtsp_server_)
        return rtsp_server_->get_latest_annexb();
    return {};
}

}  // namespace aqara
