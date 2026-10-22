#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <atomic>
#include <chrono>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>
#include "p2p/client.hpp"
namespace aqara {
// Initialize only a loopback transport. Discovery/authentication never run.
struct P2PClientTestAccess {
    static int prepare(P2PClient& client, const sockaddr_in& endpoint) {
        const int fd = socket(AF_INET, SOCK_DGRAM, 0);
        assert(fd >= 0);
        sockaddr_in local{};
        local.sin_family = AF_INET;
        local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        assert(bind(fd, reinterpret_cast<sockaddr*>(&local), sizeof(local)) == 0);
        timeval timeout{};
        timeout.tv_usec = 20000;
        assert(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0);
        client.udp_fd_ = fd;
        client.running_ = client.is_connected_ = true;
        client.set_camera_endpoint(endpoint);
        client.receiver_thread_ = std::thread(&P2PClient::receiver_loop, &client);
        return fd;
    }
    static void send(P2PClient& client) {
        const uint8_t data = 0x7f;
        client.send_raw_packet(&data, 1, client.camera_endpoint());
    }
    static void endpoint(P2PClient& client, const sockaddr_in& value) { client.set_camera_endpoint(value); }
    static int receive_buffer(const P2PClient& client) { return client.receive_buffer_bytes_.load(); }
};
}  // namespace aqara
int main() {
    const int sink = socket(AF_INET, SOCK_DGRAM, 0);
    assert(sink >= 0);
    sockaddr_in endpoint{};
    endpoint.sin_family = AF_INET;
    endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(bind(sink, reinterpret_cast<sockaddr*>(&endpoint), sizeof(endpoint)) == 0);
    socklen_t size = sizeof(endpoint);
    assert(getsockname(sink, reinterpret_cast<sockaddr*>(&endpoint), &size) == 0);
    for (int i = 0; i < 30; ++i) {
        aqara::P2PConfig config;
        config.did = "loopback-transport-fixture";
        const uint8_t key[32]{};
        auto assembler = std::make_shared<aqara::AVIOReassembler>(key, key);
        aqara::P2PClient client(config, assembler, {});
        const int old_fd = aqara::P2PClientTestAccess::prepare(client, endpoint);
        std::atomic<bool> done{false};
        std::vector<std::thread> senders;
        for (int j = 0; j < 4; ++j)
            senders.emplace_back([&] {
                while (!done)
                    aqara::P2PClientTestAccess::send(client);
            });
        std::thread discovery([&] {
            while (!done)
                aqara::P2PClientTestAccess::endpoint(client, endpoint);
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        int actual_buffer = 0;
        socklen_t option_size = sizeof(actual_buffer);
        assert(getsockopt(old_fd, SOL_SOCKET, SO_RCVBUF, &actual_buffer, &option_size) == 0);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (!aqara::P2PClientTestAccess::receive_buffer(client) && std::chrono::steady_clock::now() < deadline)
            std::this_thread::yield();
        assert(actual_buffer > 0 && aqara::P2PClientTestAccess::receive_buffer(client) == actual_buffer);
        std::thread stop_again([&] { client.stop(); });
        client.stop();
        stop_again.join();
        uint8_t data[256];
        while (recv(sink, data, sizeof(data), MSG_DONTWAIT) >= 0) {
        }
        const int replacement = socket(AF_INET, SOCK_DGRAM, 0);
        assert(replacement >= 0);
        if (replacement != old_fd) {
            assert(dup2(replacement, old_fd) == old_fd);
            close(replacement);
        }
        assert(fcntl(old_fd, F_GETFD) >= 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        done = true;
        for (auto& sender : senders)
            sender.join();
        discovery.join();
        client.stop();
        // Late writes/stops must not touch the reused descriptor.
        assert(fcntl(old_fd, F_GETFD) >= 0);
        assert(connect(old_fd, reinterpret_cast<sockaddr*>(&endpoint), sizeof(endpoint)) == 0);
        assert(recv(sink, data, sizeof(data), MSG_DONTWAIT) < 0);
        assert(recv(old_fd, data, sizeof(data), MSG_DONTWAIT) < 0);
        close(old_fd);
    }
    close(sink);
}
