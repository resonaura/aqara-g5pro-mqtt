#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <chrono>
#include <cstring>
#include <iostream>
#include "cipher.hpp"
#include "client.hpp"
#include "../ipc/events.hpp"

namespace aqara {

static std::vector<std::string> get_broadcast_ips() {
    std::vector<std::string> ips;
    struct ifaddrs* ifaddr = nullptr;
    if (getifaddrs(&ifaddr) == -1)
        return ips;
    for (struct ifaddrs* ifa = ifaddr; ifa != nullptr; ifa = ifa->ifa_next) {
        if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET)
            continue;
        if (ifa->ifa_flags & IFF_LOOPBACK)
            continue;
        if ((ifa->ifa_flags & IFF_BROADCAST) && ifa->ifa_dstaddr) {
            char bcast[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(ifa->ifa_dstaddr)->sin_addr, bcast, INET_ADDRSTRLEN);
            ips.emplace_back(bcast);
        }
    }
    freeifaddrs(ifaddr);
    return ips;
}

static std::string get_primary_local_ip() {
    struct ifaddrs* ifaddr = nullptr;
    if (getifaddrs(&ifaddr) == -1)
        return "127.0.0.1";
    std::string best = "127.0.0.1";
    for (struct ifaddrs* ifa = ifaddr; ifa != nullptr; ifa = ifa->ifa_next) {
        if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET)
            continue;
        if (ifa->ifa_flags & IFF_LOOPBACK)
            continue;
        char host[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(ifa->ifa_addr)->sin_addr, host, INET_ADDRSTRLEN);
        std::string s(host);
        if (s.rfind("192.168.", 0) == 0 || s.rfind("10.", 0) == 0 || s.rfind("172.", 0) == 0) {
            best = s;
            break;
        }
    }
    freeifaddrs(ifaddr);
    return best;
}

static const char* TUTK_MASTERS[] = {"54.71.80.151",  "54.214.103.243", "3.23.78.166",   "106.75.105.109",
                                     "117.50.21.84",  "106.75.105.110", "117.50.21.85",  "117.50.19.124",
                                     "106.75.76.108", "117.50.19.125",  "106.75.76.109", "117.50.62.24",
                                     "117.50.62.25"};

static const uint8_t TALKBACK_LEAD[11] = {0xff, 0xf9, 0x60, 0x40, 0x01, 0x7f, 0xfc, 0x00, 0xd0, 0x00, 0x07};

static int64_t current_time_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

P2pClient::P2pClient(const P2pConfig& config, std::shared_ptr<AvioReassembler> reassembler,
                     std::function<void(const std::string&)> event_cb)
    : config_(config), reassembler_(reassembler), event_cb_(std::move(event_cb)) {
    std::string key_str = config_.init_string;
    size_t colon_pos = key_str.rfind(':');
    if (colon_pos != std::string::npos) {
        key_str = key_str.substr(colon_pos + 1);
    }
    if (key_str.empty()) {
        key_str = "aqaraus19kn";
    }
    ppcs_key_.assign(key_str.begin(), key_str.end());
    punch_buf_ = PpcsCipher::punch_payload(config_.p2p_id);

    if (!config_.camera_ip.empty() && config_.camera_port > 0) {
        camera_addr_.sin_family = AF_INET;
        camera_addr_.sin_port = htons(config_.camera_port);
        inet_pton(AF_INET, config_.camera_ip.c_str(), &camera_addr_.sin_addr);
    }
}

P2pClient::~P2pClient() {
    stop();
}

bool P2pClient::start() {
    udp_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (udp_fd_ < 0)
        return false;

    int opt = 1;
    setsockopt(udp_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    setsockopt(udp_fd_, SOL_SOCKET, SO_BROADCAST, &opt, sizeof(opt));

    int rcvbuf = 8 * 1024 * 1024;
    setsockopt(udp_fd_, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));

    sockaddr_in local_addr{};
    local_addr.sin_family = AF_INET;
    local_addr.sin_addr.s_addr = INADDR_ANY;
    local_addr.sin_port = 0;  // ephemeral port

    if (bind(udp_fd_, reinterpret_cast<sockaddr*>(&local_addr), sizeof(local_addr)) < 0) {
        close(udp_fd_);
        udp_fd_ = -1;
        return false;
    }

    running_ = true;
    last_p2p_traffic_ms_ = current_time_ms();

    receiver_thread_ = std::thread(&P2pClient::receiver_loop, this);
    discovery_thread_ = std::thread(&P2pClient::discovery_loop, this);
    watchdog_thread_ = std::thread(&P2pClient::watchdog_loop, this);

    std::cout << "[P2P-Native] Started P2P client for " << config_.did << " p2p_id=" << config_.p2p_id << std::endl;
    return true;
}

void P2pClient::stop() {
    if (!running_)
        return;
    running_ = false;

    if (udp_fd_ >= 0) {
        close(udp_fd_);
        udp_fd_ = -1;
    }

    if (receiver_thread_.joinable())
        receiver_thread_.join();
    if (discovery_thread_.joinable())
        discovery_thread_.join();
    if (watchdog_thread_.joinable())
        watchdog_thread_.join();
}

void P2pClient::send_raw_packet(const uint8_t* data, size_t len, const sockaddr_in& dest) {
    if (running_ && udp_fd_ >= 0 && data && len > 0) {
        ssize_t ret = sendto(udp_fd_, data, len, 0, reinterpret_cast<const sockaddr*>(&dest), sizeof(dest));
        if (ret < 0 && running_ && errno != EBADF) {
            char ip_str[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &(dest.sin_addr), ip_str, INET_ADDRSTRLEN);
            std::cerr << "[P2P-Native] sendto failed to " << ip_str << ":" << ntohs(dest.sin_port)
                      << " err=" << strerror(errno) << std::endl;
        }
    }
}

void P2pClient::send_raw_packet(const uint8_t* data, size_t len, const std::string& ip, int port) {
    sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port);
    inet_pton(AF_INET, ip.c_str(), &dest.sin_addr);
    send_raw_packet(data, len, dest);
}

void P2pClient::send_enc_drw(uint8_t channel, uint16_t seq, const uint8_t* payload, size_t len) {
    if (!is_connected_ || udp_fd_ < 0)
        return;

    std::vector<uint8_t> drw(4 + len);
    drw[0] = 0xD1;  // DRW_MARKER
    drw[1] = channel;
    drw[2] = static_cast<uint8_t>((seq >> 8) & 0xff);
    drw[3] = static_cast<uint8_t>(seq & 0xff);
    if (payload && len > 0) {
        std::memcpy(drw.data() + 4, payload, len);
    }

    auto pkt = PpcsCipher::build_pppp(0xD0, drw.data(), drw.size());
    PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), pkt.data(), pkt.size());
    send_raw_packet(pkt.data(), pkt.size(), camera_addr_);
}

void P2pClient::queue_ack(uint8_t channel, uint16_t seq) {
    if (channel >= 8)
        return;
    std::lock_guard<std::mutex> lock(ack_mutex_);
    pending_acks_[channel].insert(seq);
}

void P2pClient::flush_acks(uint8_t channel) {
    if (channel >= 8 || !is_connected_)
        return;

    std::vector<uint16_t> seqs;
    {
        std::lock_guard<std::mutex> lock(ack_mutex_);
        if (pending_acks_[channel].empty())
            return;
        seqs.assign(pending_acks_[channel].begin(), pending_acks_[channel].end());
        pending_acks_[channel].clear();
    }

    size_t i = 0;
    while (i < seqs.size()) {
        size_t chunk_size = std::min(seqs.size() - i, static_cast<size_t>(32));
        size_t payload_len = 4 + chunk_size * 2;
        std::vector<uint8_t> ack_payload(payload_len, 0);
        ack_payload[0] = 0xD1;  // DRW_MARKER
        ack_payload[1] = channel;
        ack_payload[2] = static_cast<uint8_t>((chunk_size >> 8) & 0xff);
        ack_payload[3] = static_cast<uint8_t>(chunk_size & 0xff);

        for (size_t c = 0; c < chunk_size; ++c) {
            uint16_t s = seqs[i + c];
            ack_payload[4 + c * 2] = static_cast<uint8_t>((s >> 8) & 0xff);
            ack_payload[4 + c * 2 + 1] = static_cast<uint8_t>(s & 0xff);
        }

        auto ack_pkt = PpcsCipher::build_pppp(0xD1, ack_payload.data(), ack_payload.size());
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), ack_pkt.data(), ack_pkt.size());
        send_raw_packet(ack_pkt.data(), ack_pkt.size(), camera_addr_);
        i += chunk_size;
    }
}

void P2pClient::notify_connected(const sockaddr_in& endpoint) {
    if (connected_notified_.exchange(true))
        return;
    char ip[INET_ADDRSTRLEN] = {0};
    inet_ntop(AF_INET, &endpoint.sin_addr, ip, sizeof(ip));
    if (event_cb_) {
        event_cb_(to_json(EventP2pConnected{
            .did = config_.did,
            .ip = std::string(ip),
            .port = ntohs(endpoint.sin_port),
        }));
    }
}

void P2pClient::send_login_if_due(int64_t min_interval_ms) {
    if (!is_connected_ || session_started_)
        return;
    const int64_t now = current_time_ms();
    int64_t previous = last_login_sent_ms_.load();
    if (previous != 0 && now - previous < min_interval_ms)
        return;
    if (!last_login_sent_ms_.compare_exchange_strong(previous, now))
        return;

    std::string login_json = "{\"timestamp\":\"" +
                             (config_.sign_time.empty() ? std::to_string(now) : config_.sign_time) +
                             "\",\"app_sign\":\"" + config_.app_sign +
                             "\",\"app_public_key\":\"" + config_.app_pub_hex + "\"}";
    std::cout << "[P2P-Native] Sending 0x1000 Login for " << config_.did << std::endl;
    auto login_frame = PpcsCipher::build_lumi_frame(0x1000, reinterpret_cast<const uint8_t*>(login_json.data()),
                                                     login_json.length(), cmd_seq_++);
    send_enc_drw(0, ch0_seq_++, login_frame.data(), login_frame.size());
}

void P2pClient::request_keyframe() {
    auto frame = PpcsCipher::build_lumi_frame(0x1018, nullptr, 0, cmd_seq_++);
    send_enc_drw(0, ch0_seq_++, frame.data(), frame.size());
}

void P2pClient::set_quality(int channel) {
    std::string json = "{\"channel\":" + std::to_string(channel) + "}";
    auto frame =
        PpcsCipher::build_lumi_frame(0x100E, reinterpret_cast<const uint8_t*>(json.data()), json.length(), cmd_seq_++);
    send_enc_drw(0, ch0_seq_++, frame.data(), frame.size());
}

void P2pClient::ptz(int action, int speed) {
    std::string json = "{\"action\":" + std::to_string(action) + ",\"speed\":" + std::to_string(speed) + "}";
    auto frame =
        PpcsCipher::build_lumi_frame(0x100A, reinterpret_cast<const uint8_t*>(json.data()), json.length(), cmd_seq_++);
    send_enc_drw(0, ch0_seq_++, frame.data(), frame.size());
}

void P2pClient::start_talkback() {
    if (!is_connected_)
        return;
    std::cout << "[P2P-Native] Sending 0x100A startTalk to " << config_.did << std::endl;
    talk_seq_ = 0;
    talk_frames_sent_ = 0;
    auto frame = PpcsCipher::build_lumi_frame(0x100A, nullptr, 0, cmd_seq_++);
    send_enc_drw(0, ch0_seq_++, frame.data(), frame.size());
}

void P2pClient::stop_talkback() {
    if (!is_connected_)
        return;
    std::cout << "[P2P-Native] Sending 0x100C stopTalk to " << config_.did << std::endl;
    auto frame = PpcsCipher::build_lumi_frame(0x100C, nullptr, 0, cmd_seq_++);
    send_enc_drw(0, ch0_seq_++, frame.data(), frame.size());
}

void P2pClient::send_talkback_frame(const uint8_t* adts, size_t len) {
    if (!is_connected_ || !adts || len == 0)
        return;

    std::vector<uint8_t> body;
    // Check if payload is already wrapped with 32-byte PPCS header
    if (len >= 32 && adts[0] == 0 && adts[1] == 0 && adts[2] == 0 && adts[3] == 0) {
        body.assign(adts, adts + len);
    } else {
        if (talk_frames_sent_ == 0 && std::memcmp(adts, TALKBACK_LEAD, 11) != 0) {
            auto lead_body = PpcsCipher::build_talkback_ppcs_body(TALKBACK_LEAD, 11);
            for (int r = 0; r < 3; ++r) {
                send_enc_drw(2, talk_seq_, lead_body.data(), lead_body.size());
            }
            talk_seq_++;
        }
        body = PpcsCipher::build_talkback_ppcs_body(adts, len);
    }

    uint16_t current_seq = talk_seq_++;
    talk_frames_sent_++;

    // Native PPCS reliability: send 3 identical datagrams with identical sequence number
    for (int r = 0; r < 3; ++r) {
        send_enc_drw(2, current_seq, body.data(), body.size());
    }
}

void P2pClient::discovery_loop() {
    sockaddr_in local_addr{};
    socklen_t addr_len = sizeof(local_addr);
    getsockname(udp_fd_, reinterpret_cast<sockaddr*>(&local_addr), &addr_len);
    uint16_t my_port = ntohs(local_addr.sin_port);

    uint8_t req20[36] = {0};
    if (punch_buf_.size() >= 20)
        std::memcpy(req20, punch_buf_.data(), 20);
    req20[20] = 2;
    req20[21] = 0;  // AF_INET
    req20[22] = static_cast<uint8_t>(my_port & 0xff);
    req20[23] = static_cast<uint8_t>((my_port >> 8) & 0xff);

    std::string local_ip = get_primary_local_ip();
    uint32_t ip_num = 0;
    inet_pton(AF_INET, local_ip.c_str(), &ip_num);
    const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(&ip_num);
    req20[24] = ip_bytes[3];
    req20[25] = ip_bytes[2];
    req20[26] = ip_bytes[1];
    req20[27] = ip_bytes[0];

    auto query_pkt = PpcsCipher::build_pppp(0x20, req20, 36);
    PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), query_pkt.data(), query_pkt.size());

    auto hello_pkt = PpcsCipher::build_pppp(0x00);
    PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), hello_pkt.data(), hello_pkt.size());

    auto punch_pkt = PpcsCipher::build_pppp(0x41, punch_buf_.data(), punch_buf_.size());
    PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), punch_pkt.data(), punch_pkt.size());

    uint8_t lan_bcast[4] = {0xF1, 0x30, 0x00, 0x00};
    auto bcasts = get_broadcast_ips();
    std::cout << "[P2P-Native] Discovery started on local port " << my_port << " local_ip=" << local_ip
              << std::endl;

    int attempts = 0;
    while (running_ && !is_connected_ && attempts < 150) {
        attempts++;

        // 1. Query TUTK Master Servers
        for (const char* master : TUTK_MASTERS) {
            send_raw_packet(hello_pkt.data(), hello_pkt.size(), master, 32100);
            send_raw_packet(query_pkt.data(), query_pkt.size(), master, 32100);
        }

        // 2. Query known endpoints
        {
            std::lock_guard<std::mutex> lock(endpoints_mutex_);
            for (const auto& ep : endpoints_) {
                send_raw_packet(punch_pkt.data(), punch_pkt.size(), ep);
            }
        }

        // 3. Direct camera IP / LAN
        if (!config_.camera_ip.empty() && config_.camera_port > 0) {
            send_raw_packet(punch_pkt.data(), punch_pkt.size(), camera_addr_);
        }
        for (const auto& b : bcasts) {
            send_raw_packet(lan_bcast, 4, b.c_str(), 32108);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
}

void P2pClient::receiver_loop() {
    uint8_t buffer[65536];

    while (running_) {
        sockaddr_in src_addr{};
        socklen_t src_len = sizeof(src_addr);
        ssize_t n = recvfrom(udp_fd_, buffer, sizeof(buffer), 0, reinterpret_cast<sockaddr*>(&src_addr), &src_len);

        if (n <= 0) {
            if (!running_)
                break;
            continue;
        }

        handle_packet(buffer, static_cast<size_t>(n), src_addr);
    }
}

static bool is_lan_ip(const sockaddr_in& addr) {
    uint32_t ip = ntohl(addr.sin_addr.s_addr);
    if ((ip >= 0x0A000000 && ip <= 0x0AFFFFFF) ||  // 10.0.0.0/8
        (ip >= 0xAC100000 && ip <= 0xAC1FFFFF) ||  // 172.16.0.0/12
        (ip >= 0xC0A80000 && ip <= 0xC0A8FFFF)) {  // 192.168.0.0/16
        return true;
    }
    return false;
}

static bool same_endpoint(const sockaddr_in& a, const sockaddr_in& b) {
    return a.sin_family == b.sin_family && a.sin_addr.s_addr == b.sin_addr.s_addr && a.sin_port == b.sin_port;
}

void P2pClient::handle_packet(const uint8_t* data, size_t len, const sockaddr_in& src) {
    if (len < 4)
        return;
    last_p2p_traffic_ms_ = current_time_ms();

    std::vector<uint8_t> dec(data, data + len);
    if (dec[0] != 0xF1) {
        PpcsCipher::decrypt(ppcs_key_.data(), ppcs_key_.size(), dec.data(), dec.size());
    }
    if (dec[0] != 0xF1) {
        char ip_str[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &(src.sin_addr), ip_str, INET_ADDRSTRLEN);
        std::cout << "[P2P-Native] Drop non-PPCS packet " << len << "B from " << ip_str << ":" << ntohs(src.sin_port)
                  << " byte0=0x" << std::hex << (int)data[0] << " dec0=0x" << (int)dec[0] << std::dec << std::endl;
        return;
    }

    uint8_t msg_type = dec[1];
    uint16_t payload_len = (static_cast<uint16_t>(dec[2]) << 8) | static_cast<uint16_t>(dec[3]);
    if (4 + payload_len > dec.size())
        return;

    char ip_str[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &(src.sin_addr), ip_str, INET_ADDRSTRLEN);
    const uint8_t* payload = dec.data() + 4;

    if ((msg_type == 0x40 || msg_type == 0x21) && payload_len >= 8) {
        // Master server response with camera endpoint
        uint16_t ep_port = static_cast<uint16_t>(payload[2]) | (static_cast<uint16_t>(payload[3]) << 8);

        char ip_buf[32];
        snprintf(ip_buf, sizeof(ip_buf), "%u.%u.%u.%u", payload[7], payload[6], payload[5], payload[4]);
        sockaddr_in ep{};
        ep.sin_family = AF_INET;
        ep.sin_port = htons(ep_port);
        inet_pton(AF_INET, ip_buf, &ep.sin_addr);

        char ip_buf2[32];
        snprintf(ip_buf2, sizeof(ip_buf2), "%u.%u.%u.%u", payload[4], payload[5], payload[6], payload[7]);
        sockaddr_in ep2{};
        ep2.sin_family = AF_INET;
        ep2.sin_port = htons(ep_port);
        inet_pton(AF_INET, ip_buf2, &ep2.sin_addr);

        {
            std::lock_guard<std::mutex> lock(endpoints_mutex_);
            endpoints_.push_back(ep);
            endpoints_.push_back(ep2);
        }

        auto punch_pkt = PpcsCipher::build_pppp(0x41, punch_buf_.data(), punch_buf_.size());
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), punch_pkt.data(), punch_pkt.size());
        send_raw_packet(punch_pkt.data(), punch_pkt.size(), ep);
        send_raw_packet(punch_pkt.data(), punch_pkt.size(), ep2);
    } else if (msg_type == 0x41) {
        // PUNCH from a candidate endpoint. Once connected, keep the winning
        // endpoint pinned instead of letting late LAN discovery steal it.
        if (!is_connected_ && (is_lan_ip(src) || !is_lan_ip(camera_addr_))) {
            camera_addr_ = src;
        }

        auto punch_pkt = PpcsCipher::build_pppp(0x41, punch_buf_.data(), punch_buf_.size());
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), punch_pkt.data(), punch_pkt.size());
        send_raw_packet(punch_pkt.data(), punch_pkt.size(), src);

        auto rdy_pkt = PpcsCipher::build_pppp(0x42, punch_buf_.data(), punch_buf_.size());
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), rdy_pkt.data(), rdy_pkt.size());
        send_raw_packet(rdy_pkt.data(), rdy_pkt.size(), src);
    } else if (msg_type == 0x42) {
        // RDY establishes the endpoint. Ignore late RDY packets from other
        // discovery candidates after a session is already active.
        const bool already_connected = is_connected_.load();
        if (already_connected && !same_endpoint(src, camera_addr_)) {
            if (!session_started_ && is_lan_ip(src)) {
                camera_addr_ = src;
                last_login_sent_ms_ = 0;
            } else {
                return;
            }
        } else if (!already_connected) {
            camera_addr_ = src;
        }

        auto rdy_ack = PpcsCipher::build_pppp(0x43);
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), rdy_ack.data(), rdy_ack.size());
        send_raw_packet(rdy_ack.data(), rdy_ack.size(), src);

        auto alive = PpcsCipher::build_pppp(0xE0);
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), alive.data(), alive.size());
        send_raw_packet(alive.data(), alive.size(), src);

        const bool first_handshake = !is_connected_.exchange(true);
        if (first_handshake) {
            std::cout << "[P2P-Native] RDY Handshake OK with " << ip_str << ":" << ntohs(src.sin_port) << std::endl;
            notify_connected(src);
        }
        // Cameras may repeat RDY while our ACK is in flight. Retry auth at most
        // once per second instead of creating a login storm for every RDY.
        send_login_if_due();

    } else if (msg_type == 0x43) {
        // Ignore late RDY_ACK packets from non-winning endpoints.
        const bool already_connected = is_connected_.load();
        if (already_connected && !same_endpoint(src, camera_addr_)) {
            if (!session_started_ && is_lan_ip(src)) {
                camera_addr_ = src;
                last_login_sent_ms_ = 0;
            } else {
                return;
            }
        } else if (!already_connected) {
            camera_addr_ = src;
        }
        const bool first_handshake = !is_connected_.exchange(true);
        if (first_handshake) {
            notify_connected(src);
            auto alive = PpcsCipher::build_pppp(0xE0);
            PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), alive.data(), alive.size());
            send_raw_packet(alive.data(), alive.size(), camera_addr_);
        }
        send_login_if_due();
    } else if (msg_type == 0xE0) {
        // ALIVE -> reply ALIVE_ACK
        auto ack = PpcsCipher::build_pppp(0xE1);
        PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), ack.data(), ack.size());
        send_raw_packet(ack.data(), ack.size(), src);
    } else if ((msg_type == 0xD0 || msg_type == 0xD8 || msg_type == 0x82) && payload_len >= 4 && payload[0] == 0xD1) {
        // flush_acks() targets camera_addr_. Reject data from a late candidate,
        // otherwise ACKs go to a different peer and the camera retries forever.
        if (is_connected_ && !same_endpoint(src, camera_addr_)) {
            if (!session_ready_ && is_lan_ip(src)) {
                camera_addr_ = src;
            } else {
                return;
            }
        }
        uint8_t channel = payload[1];
        uint16_t seq = (static_cast<uint16_t>(payload[2]) << 8) | static_cast<uint16_t>(payload[3]);
        if (channel != 0) {
            last_media_traffic_ms_ = current_time_ms();
        }
        if (channel == 1 || channel == 4 || channel == 5) {
            last_video_traffic_ms_ = current_time_ms();
        } else if (channel == 2) {
            last_audio_traffic_ms_ = current_time_ms();
        }
        const uint8_t* chan_data = payload + 4;
        size_t chan_len = payload_len - 4;

        queue_ack(channel, seq);
        flush_acks(channel);

        if (channel == 0) {
            handle_channel0_data(chan_data, chan_len);
        } else if (channel == 1 || channel == 4 || channel == 5) {
            if (!session_ready_) {
                session_ready_ = true;
                session_ready_since_ms_ = current_time_ms();
                if (event_cb_) {
                    event_cb_(to_json(EventSessionReady{.did = config_.did}));
                }
            }
            if (reassembler_)
                reassembler_->push_packet(channel, seq, chan_data, chan_len);
        } else if (channel == 2) {
            if (reassembler_)
                reassembler_->push_packet(channel, seq, chan_data, chan_len);
        }
    }
}

void P2pClient::handle_channel0_data(const uint8_t* data, size_t len) {
    size_t off = 0;
    while (off + 16 <= len && std::memcmp(data + off, "lumi", 4) == 0) {
        uint32_t type = static_cast<uint32_t>(data[off + 4]) | (static_cast<uint32_t>(data[off + 5]) << 8) |
                        (static_cast<uint32_t>(data[off + 6]) << 16) | (static_cast<uint32_t>(data[off + 7]) << 24);

        uint32_t body_len = static_cast<uint32_t>(data[off + 12]) | (static_cast<uint32_t>(data[off + 13]) << 8) |
                            (static_cast<uint32_t>(data[off + 14]) << 16) |
                            (static_cast<uint32_t>(data[off + 15]) << 24);

        if (off + 16 + body_len > len)
            break;
        dispatch_channel0(type, data + off + 16, body_len);
        off += 16 + body_len;
    }
}

void P2pClient::dispatch_channel0(uint32_t type, const uint8_t* body, size_t body_len) {
    std::string body_str = (body && body_len > 0) ? std::string(reinterpret_cast<const char*>(body), body_len) : "";
    std::cout << "[P2P-Native] Channel 0 frame for " << config_.did << " type=0x" << std::hex << type << std::dec
              << " body_len=" << body_len << " body=" << body_str << std::endl;

    if (type == 0x1001) {
        // A DRW response may be retransmitted or even batched several times.
        // Advance the auth state exactly once, independently of session_ready_.
        if (!session_started_.exchange(true)) {
            std::cout << "[P2P-Native] 0x1001 Login OK for " << config_.did
                      << ", sending 0x101C stream start & 0x1002 session start" << std::endl;
            // Match official client ordering from Frida: channel 3
            // stream/record-list request first (0x101C), then channel 0 live-session start (0x1002).
            auto stream_frame = PpcsCipher::build_lumi_frame(0x101C, nullptr, 0, cmd_seq_++);
            send_enc_drw(3, ch3_seq_++, stream_frame.data(), stream_frame.size());

            auto session_frame = PpcsCipher::build_lumi_frame(0x1002, nullptr, 0, cmd_seq_++);
            send_enc_drw(0, ch0_seq_++, session_frame.data(), session_frame.size());
        }
    } else if (type == 0x1003) {
        if (!session_ready_) {
            session_ready_ = true;
            std::cout << "[P2P-Native] 0x1003 Session Ready for " << config_.did
                      << ", requesting keyframe (0x1018)" << std::endl;
            session_ready_since_ms_ = current_time_ms();
            request_keyframe();

            if (event_cb_) {
                event_cb_(to_json(EventSessionReady{.did = config_.did}));
            }
        }
    } else if (type == 0x100B) {
        std::cout << "[P2P-Native] Talkback channel prepared (0x100B)" << std::endl;
        if (event_cb_) {
            event_cb_(to_json(EventTalkbackReady{.did = config_.did}));
        }
    }
}

void P2pClient::watchdog_loop() {
    int tick = 0;
    while (running_) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        if (!running_)
            break;
        tick++;

        if (is_connected_) {
            // Keepalive ALIVE every 2 seconds
            if (tick % 2 == 0) {
                auto alive = PpcsCipher::build_pppp(0xE0);
                PpcsCipher::encrypt(ppcs_key_.data(), ppcs_key_.size(), alive.data(), alive.size());
                send_raw_packet(alive.data(), alive.size(), camera_addr_);
            }

            if (!session_started_) {
                if (tick % 3 == 0) {
                    send_login_if_due(2500);
                }
            } else if (!session_ready_) {
                if (tick % 2 == 0) {
                    auto session_frame = PpcsCipher::build_lumi_frame(0x1002, nullptr, 0, cmd_seq_++);
                    send_enc_drw(0, ch0_seq_++, session_frame.data(), session_frame.size());
                }
            } else if (session_ready_) {
                const int64_t now = current_time_ms();
                const int64_t video_at = last_video_traffic_ms_.load();
                const int64_t ready_at = session_ready_since_ms_.load();

                // Only retry if no video traffic has arrived within 4s of session ready, or if video stopped for > 6s
                if (video_at == 0 && ready_at > 0 && now - ready_at > 4000 &&
                    now - last_stream_retry_ms_.load() > 5000) {
                    last_stream_retry_ms_ = now;
                    std::cout << "[P2P-Native] No video after session ready for " << config_.did
                              << ", retrying stream start" << std::endl;
                    auto stream_frame = PpcsCipher::build_lumi_frame(0x101C, nullptr, 0, cmd_seq_++);
                    send_enc_drw(3, ch3_seq_++, stream_frame.data(), stream_frame.size());
                    auto session_frame = PpcsCipher::build_lumi_frame(0x1002, nullptr, 0, cmd_seq_++);
                    send_enc_drw(0, ch0_seq_++, session_frame.data(), session_frame.size());
                    request_keyframe();
                } else if (video_at > 0 && now - video_at > 6000 &&
                           now - last_stream_retry_ms_.load() > 5000) {
                    last_stream_retry_ms_ = now;
                    std::cout << "[P2P-Native] Video stream stalled (" << (now - video_at) / 1000 << "s) for "
                              << config_.did << ", requesting keyframe" << std::endl;
                    request_keyframe();

                    if (now - video_at > 12000) {
                        auto stream_frame = PpcsCipher::build_lumi_frame(0x101C, nullptr, 0, cmd_seq_++);
                        send_enc_drw(3, ch3_seq_++, stream_frame.data(), stream_frame.size());
                        auto session_frame = PpcsCipher::build_lumi_frame(0x1002, nullptr, 0, cmd_seq_++);
                        send_enc_drw(0, ch0_seq_++, session_frame.data(), session_frame.size());
                    }

                    if (now - video_at > 20000 && event_cb_) {
                        std::cout << "[P2P-Native] Video stream unresponsive for " << config_.did
                                  << ", emitting unhealthy event" << std::endl;
                        event_cb_(to_json(EventUnhealthy{.did = config_.did}));
                    }
                }
            }
        }
    }
}

}  // namespace aqara
