#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
#include "server.hpp"

namespace aqara {

template<typename T>
static inline T clamp_val(T v, T lo, T hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static std::string base64_encode(const uint8_t* data, size_t len) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t n = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len)
            n |= static_cast<uint32_t>(data[i + 1]) << 8;
        if (i + 2 < len)
            n |= static_cast<uint32_t>(data[i + 2]);

        out.push_back(tbl[(n >> 18) & 0x3f]);
        out.push_back(tbl[(n >> 12) & 0x3f]);
        out.push_back((i + 1 < len) ? tbl[(n >> 6) & 0x3f] : '=');
        out.push_back((i + 2 < len) ? tbl[n & 0x3f] : '=');
    }
    return out;
}

static std::string hex_encode(const uint8_t* data, size_t len) {
    std::ostringstream ss;
    for (size_t i = 0; i < len; ++i) {
        ss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(data[i]);
    }
    return ss.str();
}

RtspServer::RtspServer(int port, const std::string& path, KeyframeCallback kf_cb)
    : port_(port), path_(path), kf_req_cb_(std::move(kf_cb)) {
    last_video_send_time_ = std::chrono::steady_clock::now();
    last_audio_send_time_ = std::chrono::steady_clock::now();
}

RtspServer::~RtspServer() {
    stop();
}

bool RtspServer::start() {
    server_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd_ < 0)
        return false;

    int opt = 1;
    setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#ifdef SO_REUSEPORT
    setsockopt(server_fd_, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));
#endif

    bool bound = false;
    for (int offset = 0; offset < 20; ++offset) {
        int try_port = port_ + offset;
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(try_port);

        if (bind(server_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
            port_ = try_port;
            bound = true;
            break;
        }
    }

    if (!bound) {
        close(server_fd_);
        server_fd_ = -1;
        return false;
    }

    if (listen(server_fd_, 16) < 0) {
        close(server_fd_);
        server_fd_ = -1;
        return false;
    }

    running_ = true;
    accept_thread_ = std::thread(&RtspServer::accept_loop, this);
    std::cout << "[RTSP-Native] Server listening on port " << port_ << " path /" << path_ << std::endl;
    return true;
}

void RtspServer::stop() {
    if (!running_)
        return;
    running_ = false;

    if (server_fd_ >= 0) {
        close(server_fd_);
        server_fd_ = -1;
    }

    if (accept_thread_.joinable()) {
        accept_thread_.join();
    }

    std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
    for (auto& pair : clients_) {
        close(pair.second->socket_fd);
    }
    clients_.clear();
}

void RtspServer::hold_for_new_idr() {
    {
        std::lock_guard<std::mutex> lock(keyframe_mutex_);
        cached_keyframe_ = VideoFrame{};
    }
    std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
    for (auto& pair : clients_) {
        if (pair.second->is_playing) {
            pair.second->wait_idr = true;
        }
    }
}

void RtspServer::accept_loop() {
    while (running_) {
        sockaddr_in client_addr{};
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(server_fd_, reinterpret_cast<sockaddr*>(&client_addr), &client_len);
        if (client_fd < 0) {
            if (!running_)
                break;
            continue;
        }

        int flag = 1;
        setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
        int sndbuf = 1048576;
        setsockopt(client_fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));

        char ip_str[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &(client_addr.sin_addr), ip_str, INET_ADDRSTRLEN);

        auto client = std::make_unique<RtspClient>();
        client->socket_fd = client_fd;
        client->ip = ip_str;
        client->port = ntohs(client_addr.sin_port);
        client->session_id = std::to_string(std::chrono::system_clock::now().time_since_epoch().count());

        {
            std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
            clients_[client_fd] = std::move(client);
        }

        std::thread([this, client_fd]() { handle_client(client_fd); }).detach();
    }
}

void RtspServer::handle_client(int client_fd) {
    char buf[4096];
    std::string accumulated;

    while (running_) {
        ssize_t n = recv(client_fd, buf, sizeof(buf) - 1, 0);
        if (n <= 0)
            break;

        accumulated.append(buf, n);

        while (!accumulated.empty()) {
            if (static_cast<uint8_t>(accumulated[0]) == 0x24) {  // '$'
                if (accumulated.size() < 4)
                    break;
                uint16_t pkt_len = (static_cast<uint8_t>(accumulated[2]) << 8) | static_cast<uint8_t>(accumulated[3]);
                if (accumulated.size() < 4 + pkt_len)
                    break;
                accumulated.erase(0, 4 + pkt_len);
                continue;
            }

            size_t pos = accumulated.find("\r\n\r\n");
            if (pos == std::string::npos) {
                if (static_cast<uint8_t>(accumulated[0]) < 0x20 || static_cast<uint8_t>(accumulated[0]) > 0x7E) {
                    accumulated.erase(0, 1);
                    continue;
                }
                break;
            }

            std::string req = accumulated.substr(0, pos + 4);
            accumulated.erase(0, pos + 4);

            std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
            auto it = clients_.find(client_fd);
            if (it != clients_.end()) {
                process_rtsp_request(*(it->second), req);
            }
        }
    }

    std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
    auto it = clients_.find(client_fd);
    if (it != clients_.end()) {
        close(client_fd);
        clients_.erase(it);
    }
}

static std::string get_cseq(const std::string& req) {
    size_t pos = req.find("CSeq:");
    if (pos == std::string::npos)
        pos = req.find("cseq:");
    if (pos == std::string::npos)
        return "1";
    size_t end = req.find("\r\n", pos);
    std::string val = req.substr(pos + 5, end - (pos + 5));
    val.erase(0, val.find_first_not_of(" \t"));
    val.erase(val.find_last_not_of(" \t") + 1);
    return val;
}

static void parse_request_line(const std::string& req, std::string& method, std::string& url) {
    size_t line_end = req.find("\r\n");
    std::string first_line = (line_end != std::string::npos) ? req.substr(0, line_end) : req;
    std::istringstream iss(first_line);
    iss >> method >> url;
    size_t qmark = url.find('?');
    if (qmark != std::string::npos) {
        url = url.substr(0, qmark);
    }
}

void RtspServer::process_rtsp_request(RtspClient& client, const std::string& req) {
    std::string method, url;
    parse_request_line(req, method, url);
    std::string cseq = get_cseq(req);
    std::ostringstream resp;

    std::string content_base = url.empty() ? ("rtsp://0.0.0.0:" + std::to_string(port_) + "/" + path_ + "/")
                                           : (url.back() == '/' ? url : url + "/");

    if (method == "OPTIONS") {
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER\r\n\r\n";
    } else if (method == "DESCRIBE") {
        // DESCRIBE is a metadata probe, not a media subscription. Requesting
        // an IDR here causes needless bitrate spikes during HA polling.
        std::string sdp = generate_sdp("0.0.0.0");
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Content-Type: application/sdp\r\n"
             << "Content-Base: " << content_base << "\r\n"
             << "Content-Length: " << sdp.length() << "\r\n\r\n"
             << sdp;
    } else if (method == "SETUP") {
        bool is_audio = (url.find("track1") != std::string::npos || url.find("audio") != std::string::npos);
        std::string transport_resp;

        if (req.find("interleaved=") != std::string::npos || req.find("RTP/AVP/TCP") != std::string::npos) {
            int ch1 = is_audio ? 2 : 0;
            int ch2 = ch1 + 1;
            size_t pos = req.find("interleaved=");
            if (pos != std::string::npos) {
                sscanf(req.c_str() + pos, "interleaved=%d-%d", &ch1, &ch2);
            }
            if (is_audio) {
                client.audio_interleaved_channel = ch1;
            } else {
                client.video_interleaved_channel = ch1;
            }
            transport_resp =
                "RTP/AVP/TCP;unicast;interleaved=" + std::to_string(ch1) + "-" + std::to_string(ch2);
            resp << "RTSP/1.0 200 OK\r\n"
                 << "CSeq: " << cseq << "\r\n"
                 << "Session: " << client.session_id << ";timeout=60\r\n"
                 << "Transport: " << transport_resp << "\r\n\r\n";
        } else {
            // Reject same-host UDP requests with 461 so VLC and players immediately fallback to TCP interleaved
            resp << "RTSP/1.0 461 Unsupported Transport\r\n"
                 << "CSeq: " << cseq << "\r\n\r\n";
        }
    } else if (method == "PLAY") {
        client.is_playing = true;
        client.received_keyframe = false;
        client.wait_idr = true;
        if (kf_req_cb_) {
            kf_req_cb_();
        }

        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Session: " << client.session_id << "\r\n"
             << "Range: npt=0.000-\r\n"
             << "RTP-Info: url=" << content_base << "track0;seq=" << client.video_rtp_seq
             << ";rtptime=" << client.video_rtp_timestamp << ",url=" << content_base
             << "track1;seq=" << client.audio_rtp_seq << ";rtptime=" << client.audio_rtp_timestamp << "\r\n\r\n";

        std::string str = resp.str();
        send(client.socket_fd, str.data(), str.length(), 0);
        return;
    } else if (method == "TEARDOWN") {
        client.is_playing = false;
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n"
             << "Session: " << client.session_id << "\r\n\r\n";
    } else {
        resp << "RTSP/1.0 200 OK\r\n"
             << "CSeq: " << cseq << "\r\n\r\n";
    }

    std::string str = resp.str();
    send(client.socket_fd, str.data(), str.length(), 0);
}

std::string RtspServer::generate_sdp(const std::string& host_ip) {
    std::ostringstream sdp;
    sdp << "v=0\r\n"
        << "o=- 0 0 IN IP4 " << host_ip << "\r\n"
        << "s=Aqara Native Stream\r\n"
        << "c=IN IP4 0.0.0.0\r\n"
        << "t=0 0\r\n"
        << "a=control:*\r\n"
        << "a=range:npt=0-\r\n";

    // Video media track
    sdp << "m=video 0 RTP/AVP 96\r\n";
    if (is_hevc_) {
        sdp << "a=rtpmap:96 H265/90000\r\n";
        std::vector<std::string> props;
        if (!vps_.empty())
            props.push_back("sprop-vps=" + base64_encode(vps_.data(), vps_.size()));
        if (!sps_.empty())
            props.push_back("sprop-sps=" + base64_encode(sps_.data(), sps_.size()));
        if (!pps_.empty())
            props.push_back("sprop-pps=" + base64_encode(pps_.data(), pps_.size()));
        if (!props.empty()) {
            sdp << "a=fmtp:96 ";
            for (size_t i = 0; i < props.size(); ++i) {
                if (i > 0)
                    sdp << ";";
                sdp << props[i];
            }
            sdp << "\r\n";
        }
    } else {
        sdp << "a=rtpmap:96 H264/90000\r\n"
            << "a=fmtp:96 packetization-mode=1";
        if (sps_.size() >= 4) {
            sdp << ";profile-level-id=" << hex_encode(sps_.data() + 1, 3);
        }
        if (!sps_.empty() && !pps_.empty()) {
            sdp << ";sprop-parameter-sets=" << base64_encode(sps_.data(), sps_.size()) << ","
                << base64_encode(pps_.data(), pps_.size());
        }
        sdp << "\r\n";
    }
    sdp << "a=control:track0\r\n";

    // Audio media track
    sdp << "m=audio 0 RTP/AVP 97\r\n"
        << "a=rtpmap:97 MPEG4-GENERIC/16000/1\r\n"
        << "a=fmtp:97 "
           "streamtype=5;profile-level-id=1;mode=AAC-hbr;config=1408;sizelength=13;indexlength=3;indexdeltalength=3\r\n"
        << "a=control:track1\r\n";

    return sdp.str();
}

void RtspServer::send_interleaved_rtp(RtspClient& client, int channel, const uint8_t* rtp_pkt, size_t len) {
    if (channel < 0 || !rtp_pkt || len == 0 || len > 0xffff)
        return;

    // sendmsg() is allowed to return a short write. That happens most often on
    // high-motion frames because their bitrate and number of RTP fragments grow.
    // Treating a short write as success truncates RTP packets and produces exactly
    // the moving-block corruption seen by clients. Serialize and send all bytes.
    std::vector<uint8_t> framed(4 + len);
    framed[0] = 0x24;  // '$'
    framed[1] = static_cast<uint8_t>(channel & 0xff);
    framed[2] = static_cast<uint8_t>((len >> 8) & 0xff);
    framed[3] = static_cast<uint8_t>(len & 0xff);
    std::memcpy(framed.data() + 4, rtp_pkt, len);

    size_t offset = 0;
    while (offset < framed.size()) {
#ifdef MSG_NOSIGNAL
        const int flags = MSG_NOSIGNAL;
#else
        const int flags = 0;
#endif
        const ssize_t written = send(client.socket_fd, framed.data() + offset, framed.size() - offset, flags);
        if (written > 0) {
            offset += static_cast<size_t>(written);
            continue;
        }
        if (written < 0 && errno == EINTR)
            continue;
        client.is_playing = false;
        std::cerr << "[RTSP-Native] RTP send failed for " << client.ip << ":" << client.port
                  << " sent=" << offset << "/" << framed.size()
                  << " err=" << (written < 0 ? std::strerror(errno) : "peer closed") << std::endl;
        return;
    }
}

void RtspServer::send_video_to_client(RtspClient& client, const VideoFrame& vf) {
    if (vf.annex_b_data.empty() || !client.is_playing)
        return;
    int ch = client.video_interleaved_channel;
    if (ch < 0)
        return;

    const uint8_t* data = vf.annex_b_data.data();
    size_t len = vf.annex_b_data.size();
    size_t i = 0;
    bool is_hevc = (vf.codec_id == 0x004F);

    std::vector<std::pair<const uint8_t*, size_t>> nals;
    while (i < len) {
        size_t prefix_len = 0;
        if (i + 3 <= len && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)
            prefix_len = 3;
        else if (i + 4 <= len && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1)
            prefix_len = 4;

        if (prefix_len > 0) {
            size_t nal_start = i + prefix_len;
            size_t next_start = len;
            for (size_t j = nal_start; j + 3 < len; ++j) {
                if (data[j] == 0 && data[j + 1] == 0 && (data[j + 2] == 1 || (data[j + 2] == 0 && data[j + 3] == 1))) {
                    next_start = j;
                    break;
                }
            }
            if (next_start > nal_start) {
                nals.push_back({data + nal_start, next_start - nal_start});
            }
            i = next_start;
        } else {
            i++;
        }
    }

    const size_t MAX_PAYLOAD = 1380;
    for (size_t n = 0; n < nals.size(); ++n) {
        const uint8_t* nal = nals[n].first;
        size_t nal_len = nals[n].second;
        bool is_last_nal = (n == nals.size() - 1);

        if (nal_len <= MAX_PAYLOAD) {
            uint8_t rtp_pkt[12 + MAX_PAYLOAD];
            rtp_pkt[0] = 0x80;
            rtp_pkt[1] = (is_last_nal ? 0x80 : 0x00) | 96;
            rtp_pkt[2] = static_cast<uint8_t>((client.video_rtp_seq >> 8) & 0xff);
            rtp_pkt[3] = static_cast<uint8_t>(client.video_rtp_seq & 0xff);
            rtp_pkt[4] = static_cast<uint8_t>((client.video_rtp_timestamp >> 24) & 0xff);
            rtp_pkt[5] = static_cast<uint8_t>((client.video_rtp_timestamp >> 16) & 0xff);
            rtp_pkt[6] = static_cast<uint8_t>((client.video_rtp_timestamp >> 8) & 0xff);
            rtp_pkt[7] = static_cast<uint8_t>(client.video_rtp_timestamp & 0xff);
            rtp_pkt[8] = static_cast<uint8_t>((client.video_ssrc >> 24) & 0xff);
            rtp_pkt[9] = static_cast<uint8_t>((client.video_ssrc >> 16) & 0xff);
            rtp_pkt[10] = static_cast<uint8_t>((client.video_ssrc >> 8) & 0xff);
            rtp_pkt[11] = static_cast<uint8_t>(client.video_ssrc & 0xff);
            client.video_rtp_seq++;

            std::memcpy(rtp_pkt + 12, nal, nal_len);
            send_interleaved_rtp(client, ch, rtp_pkt, 12 + nal_len);
        } else if (is_hevc) {
            uint8_t nal_type = (nal[0] >> 1) & 0x3f;
            uint8_t hdr1 = (nal[0] & 0x81) | (49 << 1);
            uint8_t hdr2 = nal[1];
            size_t offset = 2;

            while (offset < nal_len) {
                size_t chunk_len = std::min(MAX_PAYLOAD, nal_len - offset);
                bool is_start = (offset == 2);
                bool is_end = (offset + chunk_len >= nal_len);

                uint8_t rtp_pkt[15 + MAX_PAYLOAD];
                rtp_pkt[0] = 0x80;
                rtp_pkt[1] = (is_last_nal && is_end ? 0x80 : 0x00) | 96;
                rtp_pkt[2] = static_cast<uint8_t>((client.video_rtp_seq >> 8) & 0xff);
                rtp_pkt[3] = static_cast<uint8_t>(client.video_rtp_seq & 0xff);
                rtp_pkt[4] = static_cast<uint8_t>((client.video_rtp_timestamp >> 24) & 0xff);
                rtp_pkt[5] = static_cast<uint8_t>((client.video_rtp_timestamp >> 16) & 0xff);
                rtp_pkt[6] = static_cast<uint8_t>((client.video_rtp_timestamp >> 8) & 0xff);
                rtp_pkt[7] = static_cast<uint8_t>(client.video_rtp_timestamp & 0xff);
                rtp_pkt[8] = static_cast<uint8_t>((client.video_ssrc >> 24) & 0xff);
                rtp_pkt[9] = static_cast<uint8_t>((client.video_ssrc >> 16) & 0xff);
                rtp_pkt[10] = static_cast<uint8_t>((client.video_ssrc >> 8) & 0xff);
                rtp_pkt[11] = static_cast<uint8_t>(client.video_ssrc & 0xff);
                client.video_rtp_seq++;

                uint8_t fu_header = nal_type;
                if (is_start)
                    fu_header |= 0x80;
                if (is_end)
                    fu_header |= 0x40;

                rtp_pkt[12] = hdr1;
                rtp_pkt[13] = hdr2;
                rtp_pkt[14] = fu_header;
                std::memcpy(rtp_pkt + 15, nal + offset, chunk_len);

                send_interleaved_rtp(client, ch, rtp_pkt, 15 + chunk_len);
                offset += chunk_len;
            }
        } else {
            uint8_t nal_header = nal[0];
            uint8_t nal_type = nal_header & 0x1f;
            uint8_t nal_nri = nal_header & 0x60;
            size_t offset = 1;

            while (offset < nal_len) {
                size_t chunk_len = std::min(MAX_PAYLOAD, nal_len - offset);
                bool is_start = (offset == 1);
                bool is_end = (offset + chunk_len >= nal_len);

                uint8_t rtp_pkt[14 + MAX_PAYLOAD];
                rtp_pkt[0] = 0x80;
                rtp_pkt[1] = (is_last_nal && is_end ? 0x80 : 0x00) | 96;
                rtp_pkt[2] = static_cast<uint8_t>((client.video_rtp_seq >> 8) & 0xff);
                rtp_pkt[3] = static_cast<uint8_t>(client.video_rtp_seq & 0xff);
                rtp_pkt[4] = static_cast<uint8_t>((client.video_rtp_timestamp >> 24) & 0xff);
                rtp_pkt[5] = static_cast<uint8_t>((client.video_rtp_timestamp >> 16) & 0xff);
                rtp_pkt[6] = static_cast<uint8_t>((client.video_rtp_timestamp >> 8) & 0xff);
                rtp_pkt[7] = static_cast<uint8_t>(client.video_rtp_timestamp & 0xff);
                rtp_pkt[8] = static_cast<uint8_t>((client.video_ssrc >> 24) & 0xff);
                rtp_pkt[9] = static_cast<uint8_t>((client.video_ssrc >> 16) & 0xff);
                rtp_pkt[10] = static_cast<uint8_t>((client.video_ssrc >> 8) & 0xff);
                rtp_pkt[11] = static_cast<uint8_t>(client.video_ssrc & 0xff);
                client.video_rtp_seq++;

                uint8_t fu_indicator = nal_nri | 28;
                uint8_t fu_header = nal_type;
                if (is_start)
                    fu_header |= 0x80;
                if (is_end)
                    fu_header |= 0x40;

                rtp_pkt[12] = fu_indicator;
                rtp_pkt[13] = fu_header;
                std::memcpy(rtp_pkt + 14, nal + offset, chunk_len);

                send_interleaved_rtp(client, ch, rtp_pkt, 14 + chunk_len);
                offset += chunk_len;
            }
        }
    }
}

void RtspServer::broadcast_video(const VideoFrame& vf) {
    if (vf.annex_b_data.empty())
        return;
    is_hevc_ = (vf.codec_id == 0x004F);

    if (vf.is_keyframe) {
        std::lock_guard<std::mutex> lock(keyframe_mutex_);
        cached_keyframe_ = vf;
    }

    // Harvest SPS/PPS/VPS
    const uint8_t* data = vf.annex_b_data.data();
    size_t len = vf.annex_b_data.size();
    size_t i = 0;

    while (i < len) {
        size_t prefix_len = 0;
        if (i + 3 <= len && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)
            prefix_len = 3;
        else if (i + 4 <= len && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1)
            prefix_len = 4;

        if (prefix_len > 0) {
            size_t nal_start = i + prefix_len;
            size_t next_start = len;
            for (size_t j = nal_start; j + 3 < len; ++j) {
                if (data[j] == 0 && data[j + 1] == 0 && (data[j + 2] == 1 || (data[j + 2] == 0 && data[j + 3] == 1))) {
                    next_start = j;
                    break;
                }
            }
            if (next_start > nal_start) {
                const uint8_t* nal = data + nal_start;
                size_t nal_len = next_start - nal_start;

                uint8_t nal_type = is_hevc_ ? ((nal[0] >> 1) & 0x3f) : (nal[0] & 0x1f);
                if (!is_hevc_) {
                    if (nal_type == 7)
                        sps_.assign(nal, nal + nal_len);
                    else if (nal_type == 8)
                        pps_.assign(nal, nal + nal_len);
                } else {
                    if (nal_type == 32)
                        vps_.assign(nal, nal + nal_len);
                    else if (nal_type == 33)
                        sps_.assign(nal, nal + nal_len);
                    else if (nal_type == 34)
                        pps_.assign(nal, nal + nal_len);
                }
            }
            i = next_start;
        } else {
            i++;
        }
    }

    std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
    for (auto& pair : clients_) {
        RtspClient& client = *(pair.second);
        if (!client.is_playing)
            continue;

        if (client.wait_idr) {
            if (vf.is_keyframe) {
                client.wait_idr = false;
                client.received_keyframe = true;
            } else {
                continue;  // Hold P-frame until fresh IDR arrives
            }
        }

        client.video_rtp_timestamp += 4500;
        send_video_to_client(client, vf);
    }
}

void RtspServer::broadcast_audio(const AudioFrame& af) {
    if (af.aac_adts_data.empty())
        return;

    const uint8_t* data = af.aac_adts_data.data();
    size_t len = af.aac_adts_data.size();

    // Check if the decrypted payload contains ADTS headers or raw AAC access units
    const uint8_t* raw_aac = data;
    size_t raw_len = len;

    if (len >= 7 && data[0] == 0xff && (data[1] & 0xf0) == 0xf0) {
        // Has ADTS header: parse ADTS frame length
        bool has_crc = (data[1] & 0x01) == 0;
        size_t hdr_len = has_crc ? 9 : 7;
        size_t frame_len =
            ((static_cast<size_t>(data[3] & 0x03) << 11) | (static_cast<size_t>(data[4]) << 3) |
             ((static_cast<size_t>(data[5] & 0xe0) >> 5)));

        if (frame_len >= hdr_len && frame_len <= len) {
            raw_aac = data + hdr_len;
            raw_len = frame_len - hdr_len;
        } else if (len > hdr_len) {
            raw_aac = data + hdr_len;
            raw_len = len - hdr_len;
        }
    }

    if (raw_len == 0)
        return;

    std::lock_guard<std::recursive_mutex> lock(clients_mutex_);
    for (auto& pair : clients_) {
        RtspClient& client = *(pair.second);
        if (!client.is_playing)
            continue;
        int ch = client.audio_interleaved_channel;
        if (ch < 0)
            continue;

        client.audio_rtp_timestamp += 1024;  // 1024 samples per AAC frame at 16000 Hz

        uint8_t rtp_pkt[16 + 2048];
        rtp_pkt[0] = 0x80;
        rtp_pkt[1] = 0x80 | 97;
        rtp_pkt[2] = static_cast<uint8_t>((client.audio_rtp_seq >> 8) & 0xff);
        rtp_pkt[3] = static_cast<uint8_t>(client.audio_rtp_seq & 0xff);
        rtp_pkt[4] = static_cast<uint8_t>((client.audio_rtp_timestamp >> 24) & 0xff);
        rtp_pkt[5] = static_cast<uint8_t>((client.audio_rtp_timestamp >> 16) & 0xff);
        rtp_pkt[6] = static_cast<uint8_t>((client.audio_rtp_timestamp >> 8) & 0xff);
        rtp_pkt[7] = static_cast<uint8_t>(client.audio_rtp_timestamp & 0xff);
        rtp_pkt[8] = static_cast<uint8_t>((client.audio_ssrc >> 24) & 0xff);
        rtp_pkt[9] = static_cast<uint8_t>((client.audio_ssrc >> 16) & 0xff);
        rtp_pkt[10] = static_cast<uint8_t>((client.audio_ssrc >> 8) & 0xff);
        rtp_pkt[11] = static_cast<uint8_t>(client.audio_ssrc & 0xff);
        client.audio_rtp_seq++;

        // RFC 3640 AU-header: 16-bit header section length (16), followed by (size << 3)
        uint16_t au_hdr = static_cast<uint16_t>((raw_len << 3) & 0xffff);
        rtp_pkt[12] = 0x00;
        rtp_pkt[13] = 0x10;  // 16-bit AU header length
        rtp_pkt[14] = static_cast<uint8_t>((au_hdr >> 8) & 0xff);
        rtp_pkt[15] = static_cast<uint8_t>(au_hdr & 0xff);

        size_t copy_len = std::min(raw_len, static_cast<size_t>(2048));
        std::memcpy(rtp_pkt + 16, raw_aac, copy_len);

        send_interleaved_rtp(client, ch, rtp_pkt, 16 + copy_len);
    }
}

}  // namespace aqara
