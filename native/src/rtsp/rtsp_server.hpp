#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>
#include <sstream>
#include <iostream>
#include <map>
#include <set>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <arpa/inet.h>
#include "rtp_packetizer.hpp"
#include "../sync/jitter_buffer.hpp"

namespace aqara {

struct RtspClientSession {
    int socket_fd = -1;
    std::string session_id;
    int cseq = 0;
    int video_channel = 0;
    int audio_channel = 2;
    bool is_playing = false;
    bool received_keyframe = false;
};

class RtspServer {
public:
    RtspServer(int port, const std::string &stream_path, bool is_hevc = false)
        : port_(port), stream_path_(stream_path), is_hevc_(is_hevc), running_(false) {
        ssrc_video_ = 0x11223344;
        ssrc_audio_ = 0x55667788;
    }

    ~RtspServer() {
        stop();
    }

    bool start() {
        server_fd_ = socket(AF_INET, SOCK_STREAM, 0);
        if (server_fd_ < 0) return false;

        int opt = 1;
        setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(port_);

        if (bind(server_fd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
            close(server_fd_);
            return false;
        }

        if (listen(server_fd_, 16) < 0) {
            close(server_fd_);
            return false;
        }

        running_ = true;
        server_thread_ = std::thread(&RtspServer::listen_loop, this);
        return true;
    }

    void stop() {
        running_ = false;
        if (server_fd_ >= 0) {
            close(server_fd_);
            server_fd_ = -1;
        }
        if (server_thread_.joinable()) {
            server_thread_.join();
        }
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto &c : clients_) {
            if (c->socket_fd >= 0) {
                close(c->socket_fd);
                c->socket_fd = -1;
            }
        }
        clients_.clear();
    }

    void broadcast_video(const std::vector<uint8_t> &annexb_data, bool is_keyframe, uint32_t rtp_timestamp) {
        if (annexb_data.empty()) return;

        auto nal_units = RtpPacketizer::split_annexb_nalus(annexb_data.data(), annexb_data.size());
        if (nal_units.empty()) return;

        // Cache SPS/PPS
        for (const auto &nal : nal_units) {
            if (nal.empty()) continue;
            uint8_t t = nal[0] & 0x1F;
            if (t == 7) sps_ = nal;
            if (t == 8) pps_ = nal;
        }

        // If keyframe and we have cached SPS/PPS, ensure they are prepended
        std::vector<std::vector<uint8_t>> final_nals;
        if (is_keyframe && !sps_.empty() && !pps_.empty()) {
            bool has_sps = false;
            for (const auto &nal : nal_units) {
                if ((nal[0] & 0x1F) == 7) { has_sps = true; break; }
            }
            if (!has_sps) {
                final_nals.push_back(sps_);
                final_nals.push_back(pps_);
            }
        }
        for (auto &nal : nal_units) {
            final_nals.push_back(std::move(nal));
        }

        // If keyframe, cache it for instant start of future connecting clients
        if (is_keyframe) {
            std::lock_guard<std::mutex> lock(clients_mutex_);
            cached_keyframe_data_ = annexb_data;
            cached_keyframe_ts_ = rtp_timestamp;
            for (auto &c : clients_) {
                if (c->is_playing) c->received_keyframe = true;
            }
        }

        for (size_t n = 0; n < final_nals.size(); n++) {
            bool is_last = (n == final_nals.size() - 1);
            auto rtp_packets = RtpPacketizer::packetize_h264(
                final_nals[n], rtp_timestamp, video_seq_, ssrc_video_, is_last
            );
            for (const auto &pkt : rtp_packets) {
                send_interleaved_rtp(0, pkt.data(), pkt.size());
            }
        }
    }

    void send_frame_to_single_session(std::shared_ptr<RtspClientSession> session, const std::vector<uint8_t> &annexb_data, bool is_keyframe, uint32_t rtp_timestamp) {
        if (annexb_data.empty() || !session || !session->is_playing) return;
        auto nal_units = RtpPacketizer::split_annexb_nalus(annexb_data.data(), annexb_data.size());
        if (nal_units.empty()) return;

        std::vector<std::vector<uint8_t>> final_nals;
        if (is_keyframe && !sps_.empty() && !pps_.empty()) {
            bool has_sps = false;
            for (const auto &nal : nal_units) {
                if ((nal[0] & 0x1F) == 7) { has_sps = true; break; }
            }
            if (!has_sps) {
                final_nals.push_back(sps_);
                final_nals.push_back(pps_);
            }
        }
        for (auto &nal : nal_units) final_nals.push_back(std::move(nal));

        for (size_t n = 0; n < final_nals.size(); n++) {
            bool is_last = (n == final_nals.size() - 1);
            auto rtp_packets = RtpPacketizer::packetize_h264(
                final_nals[n], rtp_timestamp, video_seq_, ssrc_video_, is_last
            );
            for (const auto &pkt : rtp_packets) {
                uint8_t hdr[4] = {0x24, (uint8_t)session->video_channel, (uint8_t)(pkt.size() >> 8), (uint8_t)(pkt.size() & 0xFF)};
                struct iovec iov[2];
                iov[0].iov_base = hdr; iov[0].iov_len = 4;
                iov[1].iov_base = const_cast<uint8_t*>(pkt.data()); iov[1].iov_len = pkt.size();
                struct msghdr msg{};
                msg.msg_iov = iov; msg.msg_iovlen = 2;
                sendmsg(session->socket_fd, &msg, MSG_NOSIGNAL);
            }
        }
    }

    void broadcast_audio(const std::vector<uint8_t> &raw_aac, uint32_t rtp_timestamp) {
        if (raw_aac.empty()) return;
        auto pkt = RtpPacketizer::packetize_aac(raw_aac, rtp_timestamp, audio_seq_, ssrc_audio_);
        send_interleaved_rtp(2, pkt.data(), pkt.size());
    }

    size_t active_clients() {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        size_t count = 0;
        for (const auto &c : clients_) {
            if (c->is_playing) count++;
        }
        return count;
    }

private:
    void send_interleaved_rtp(int default_channel, const uint8_t *data, size_t len) {
        bool is_audio = (default_channel >= 2);
        std::lock_guard<std::mutex> lock(clients_mutex_);

        for (auto it = clients_.begin(); it != clients_.end(); ) {
            auto &client = *it;
            if (!client->is_playing) {
                ++it;
                continue;
            }
            if (!is_audio && !client->received_keyframe) {
                ++it; // Drop P-frames until initial keyframe
                continue;
            }

            int chan = is_audio ? client->audio_channel : client->video_channel;
            uint8_t hdr[4];
            hdr[0] = 0x24; // '$'
            hdr[1] = (uint8_t)(chan & 0xFF);
            hdr[2] = (uint8_t)((len >> 8) & 0xFF);
            hdr[3] = (uint8_t)(len & 0xFF);

            struct iovec iov[2];
            iov[0].iov_base = hdr;
            iov[0].iov_len = 4;
            iov[1].iov_base = const_cast<uint8_t*>(data);
            iov[1].iov_len = len;

            struct msghdr msg{};
            msg.msg_iov = iov;
            msg.msg_iovlen = 2;

            ssize_t sent = sendmsg(client->socket_fd, &msg, MSG_NOSIGNAL);
            if (sent < 0 && (errno == EPIPE || errno == ECONNRESET)) {
                close(client->socket_fd);
                it = clients_.erase(it);
            } else {
                ++it;
            }
        }
    }

    void listen_loop() {
        while (running_) {
            sockaddr_in client_addr{};
            socklen_t client_len = sizeof(client_addr);
            int client_fd = accept(server_fd_, (struct sockaddr*)&client_addr, &client_len);
            if (client_fd < 0) {
                if (!running_) break;
                continue;
            }

            int flag = 1;
            setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

            std::thread(&RtspServer::handle_client, this, client_fd).detach();
        }
    }

    void handle_client(int fd) {
        auto session = std::make_shared<RtspClientSession>();
        session->socket_fd = fd;
        session->session_id = std::to_string(std::rand() % 900000 + 100000);

        {
            std::lock_guard<std::mutex> lock(clients_mutex_);
            clients_.insert(session);
        }

        std::vector<uint8_t> buffer(4096);
        std::string request_str;

        while (running_) {
            ssize_t bytes_read = read(fd, buffer.data(), buffer.size());
            if (bytes_read <= 0) break;

            request_str.append(reinterpret_cast<char*>(buffer.data()), bytes_read);

            size_t pos;
            while ((pos = request_str.find("\r\n\r\n")) != std::string::npos) {
                std::string req = request_str.substr(0, pos);
                request_str.erase(0, pos + 4);

                std::istringstream stream(req);
                std::string line, method, url, proto;
                if (!(stream >> method >> url >> proto)) continue;

                int cseq = 0;
                while (std::getline(stream, line)) {
                    if (line.find("CSeq:") != std::string::npos) {
                        std::istringstream(line.substr(5)) >> cseq;
                    }
                }

                if (method == "OPTIONS") {
                    std::ostringstream resp;
                    resp << "RTSP/1.0 200 OK\r\n"
                         << "CSeq: " << cseq << "\r\n"
                         << "Public: OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, GET_PARAMETER\r\n\r\n";
                    std::string s = resp.str();
                    write(fd, s.data(), s.size());
                } else if (method == "DESCRIBE") {
                    std::string sdp = build_sdp();
                    std::ostringstream resp;
                    resp << "RTSP/1.0 200 OK\r\n"
                         << "CSeq: " << cseq << "\r\n"
                         << "Content-Type: application/sdp\r\n"
                         << "Content-Length: " << sdp.size() << "\r\n\r\n"
                         << sdp;
                    std::string s = resp.str();
                    write(fd, s.data(), s.size());
                } else if (method == "SETUP") {
                    if (url.find("trackID=1") != std::string::npos) {
                        session->audio_channel = 2;
                    } else {
                        session->video_channel = 0;
                    }
                    std::ostringstream resp;
                    resp << "RTSP/1.0 200 OK\r\n"
                         << "CSeq: " << cseq << "\r\n"
                         << "Transport: RTP/AVP/TCP;unicast;interleaved=" 
                         << (url.find("trackID=1") != std::string::npos ? "2-3" : "0-1") << "\r\n"
                         << "Session: " << session->session_id << "\r\n\r\n";
                    std::string s = resp.str();
                    write(fd, s.data(), s.size());
                } else if (method == "PLAY") {
                    session->is_playing = true;
                    std::ostringstream resp;
                    resp << "RTSP/1.0 200 OK\r\n"
                         << "CSeq: " << cseq << "\r\n"
                         << "Range: npt=0.000-\r\n"
                         << "Session: " << session->session_id << "\r\n\r\n";
                    std::string s = resp.str();
                    write(fd, s.data(), s.size());

                    // Instant Pre-warmed Burst
                    if (!cached_keyframe_data_.empty()) {
                        session->received_keyframe = true;
                        send_frame_to_single_session(session, cached_keyframe_data_, true, cached_keyframe_ts_);
                    }
                } else if (method == "TEARDOWN") {
                    std::ostringstream resp;
                    resp << "RTSP/1.0 200 OK\r\n"
                         << "CSeq: " << cseq << "\r\n"
                         << "Session: " << session->session_id << "\r\n\r\n";
                    std::string s = resp.str();
                    write(fd, s.data(), s.size());
                    break;
                }
            }
        }

        close(fd);
        std::lock_guard<std::mutex> lock(clients_mutex_);
        clients_.erase(session);
    }

    std::string build_sdp() {
        std::ostringstream sdp;
        sdp << "v=0\r\n"
            << "o=- 0 0 IN IP4 0.0.0.0\r\n"
            << "s=Aqara Native Media Stream\r\n"
            << "t=0 0\r\n"
            << "a=control:*\r\n"
            << "m=video 0 RTP/AVP 96\r\n"
            << "a=rtpmap:96 " << (is_hevc_ ? "H265/90000" : "H264/90000") << "\r\n"
            << "a=control:trackID=0\r\n"
            << "m=audio 0 RTP/AVP 97\r\n"
            << "a=rtpmap:97 MPEG4-GENERIC/16000/1\r\n"
            << "a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;config=1408;sizelength=13;indexlength=3;indexdeltalength=3\r\n"
            << "a=control:trackID=1\r\n";
        return sdp.str();
    }

    int port_;
    std::string stream_path_;
    bool is_hevc_;
    std::atomic<bool> running_;
    int server_fd_ = -1;
    std::thread server_thread_;

    std::mutex clients_mutex_;
    std::set<std::shared_ptr<RtspClientSession>> clients_;

    uint16_t video_seq_ = 0;
    uint16_t audio_seq_ = 0;
    uint32_t ssrc_video_;
    uint32_t ssrc_audio_;

    std::vector<uint8_t> sps_;
    std::vector<uint8_t> pps_;
    std::vector<uint8_t> cached_keyframe_data_;
    uint32_t cached_keyframe_ts_ = 0;
};

} // namespace aqara
