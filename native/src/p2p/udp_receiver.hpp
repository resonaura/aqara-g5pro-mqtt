#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <atomic>
#include <thread>
#include <functional>
#include <chrono>
#include <iostream>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <fcntl.h>

namespace aqara {

class UdpReceiver {
public:
    UdpReceiver(const std::string &target_ip, int target_port)
        : target_ip_(target_ip), target_port_(target_port), running_(false), sock_fd_(-1) {}

    ~UdpReceiver() {
        stop();
    }

    bool start(std::function<void(const uint8_t *data, size_t len)> on_data_cb) {
        sock_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock_fd_ < 0) return false;

        int rcvbuf = 2 * 1024 * 1024; // 2MB kernel receive buffer
        setsockopt(sock_fd_, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));

        sockaddr_in local_addr{};
        local_addr.sin_family = AF_INET;
        local_addr.sin_addr.s_addr = INADDR_ANY;
        local_addr.sin_port = 0; // Ephemeral port

        if (bind(sock_fd_, (struct sockaddr*)&local_addr, sizeof(local_addr)) < 0) {
            close(sock_fd_);
            return false;
        }

        memset(&target_addr_, 0, sizeof(target_addr_));
        target_addr_.sin_family = AF_INET;
        target_addr_.sin_port = htons(target_port_);
        inet_pton(AF_INET, target_ip_.c_str(), &target_addr_.sin_addr);

        running_ = true;
        recv_thread_ = std::thread([this, on_data_cb]() {
            std::vector<uint8_t> buffer(65536);
            while (running_) {
                sockaddr_in from_addr{};
                socklen_t from_len = sizeof(from_addr);
                ssize_t bytes = recvfrom(sock_fd_, buffer.data(), buffer.size(), 0,
                                         (struct sockaddr*)&from_addr, &from_len);
                if (bytes > 0 && running_) {
                    on_data_cb(buffer.data(), (size_t)bytes);
                } else if (bytes < 0) {
                    if (!running_) break;
                }
            }
        });

        return true;
    }

    void send_packet(const uint8_t *data, size_t len) {
        if (sock_fd_ >= 0) {
            sendto(sock_fd_, data, len, 0, (struct sockaddr*)&target_addr_, sizeof(target_addr_));
        }
    }

    void stop() {
        running_ = false;
        if (sock_fd_ >= 0) {
            close(sock_fd_);
            sock_fd_ = -1;
        }
        if (recv_thread_.joinable()) {
            recv_thread_.join();
        }
    }

private:
    std::string target_ip_;
    int target_port_;
    std::atomic<bool> running_;
    int sock_fd_;
    sockaddr_in target_addr_;
    std::thread recv_thread_;
};

} // namespace aqara
