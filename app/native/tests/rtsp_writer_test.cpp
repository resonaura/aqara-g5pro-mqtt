#include <unistd.h>
#include <arpa/inet.h>
#include <cstdlib>
#include <string>
#include <cstdio>
#include <source_location>
#include "rtsp/writer.hpp"

static void check(bool value, const std::source_location location = std::source_location::current()) {
    if (!value) {
        std::fprintf(stderr, "check failed at line %u\n", location.line());
        std::abort();
    }
}
struct Pair {
    int fd[2];
    Pair() {
        const int listener = socket(AF_INET, SOCK_STREAM, 0);
        check(listener >= 0);
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        check(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
        check(listen(listener, 1) == 0);
        socklen_t size = sizeof(address);
        check(getsockname(listener, reinterpret_cast<sockaddr*>(&address), &size) == 0);
        fd[1] = socket(AF_INET, SOCK_STREAM, 0);
        check(fd[1] >= 0);
        int buffer = 4096;
        check(setsockopt(fd[1], SOL_SOCKET, SO_RCVBUF, &buffer, sizeof(buffer)) == 0);
        check(connect(fd[1], reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
        fd[0] = accept(listener, nullptr, nullptr);
        check(fd[0] >= 0);
        close(listener);
        check(setsockopt(fd[0], SOL_SOCKET, SO_SNDBUF, &buffer, sizeof(buffer)) == 0);
    }
    ~Pair() {
        close(fd[0]);
        close(fd[1]);
    }
};
int main() {
    using namespace std::chrono;
    {
        Pair pair;
        aqara::RTSPWriter writer(pair.fd[0]);
        const std::string control = "RTSP/1.0 200 OK\r\n\r\n";
        std::vector<uint8_t> media(512 * 1024);
        for (size_t i = 0; i < media.size(); ++i)
            media[i] = static_cast<uint8_t>(i);
        std::vector<uint8_t> actual(control.size() + media.size());
        std::thread reader([&]() {
            size_t offset = 0;
            while (offset < actual.size()) {
                const auto n = recv(pair.fd[1], actual.data() + offset, actual.size() - offset, 0);
                check(n > 0);
                offset += static_cast<size_t>(n);
            }
        });
        check(writer.enqueue({control.begin(), control.end()}));
        check(writer.enqueue(media));
        reader.join();
        check(std::equal(control.begin(), control.end(), actual.begin()));
        check(std::equal(media.begin(), media.end(), actual.begin() + control.size()));
        writer.stop();
        // A destructor/second stop must never touch a reused descriptor.
        writer.stop();
        check(!writer.enqueue({1}));
    }
    {
        Pair slow, healthy;
        std::atomic<int> failures{0};
        aqara::RTSPWriter stalled(
            slow.fd[0],
            [&](const char* reason) {
                check(std::string(reason) == "queue_limit");
                ++failures;
            },
            4 * 1024 * 1024);
        aqara::RTSPWriter active(healthy.fd[0]);
        const auto began = steady_clock::now();
        check(stalled.enqueue(std::vector<uint8_t>(2 * 1024 * 1024, 7)));
        check(stalled.enqueue(std::vector<uint8_t>(2 * 1024 * 1024, 8)));
        check(!stalled.enqueue({9}));  // In-flight bytes still count toward the cap.
        check(steady_clock::now() - began < milliseconds(100));
        check(failures == 1);
        check(active.enqueue({1, 2, 3, 4}));
        uint8_t received[4]{};
        check(recv(healthy.fd[1], received, sizeof(received), MSG_WAITALL) == 4);
        check(received[0] == 1 && received[3] == 4);
        stalled.stop();
        check(failures == 1);
    }
    {
        Pair pair;
        std::atomic<bool> expired{false};
        aqara::RTSPWriter writer(
            pair.fd[0],
            [&](const char* reason) {
                check(std::string(reason) == "queue_deadline");
                expired = true;
            },
            2 * 1024 * 1024, milliseconds(50));
        check(writer.enqueue(std::vector<uint8_t>(1024 * 1024, 5)));
        const auto deadline = steady_clock::now() + seconds(2);
        while (!expired && steady_clock::now() < deadline)
            std::this_thread::sleep_for(milliseconds(1));
        check(expired);
        writer.stop();
    }
    {
        Pair pair;
        aqara::RTSPWriter writer(pair.fd[0]);
        check(writer.enqueue(std::vector<uint8_t>(1024 * 1024, 5)));
        uint8_t byte;
        check(recv(pair.fd[1], &byte, 1, 0) == 1);  // Writer is now active.
        const auto began = steady_clock::now();
        writer.stop();
        check(steady_clock::now() - began < milliseconds(100));
    }
}
