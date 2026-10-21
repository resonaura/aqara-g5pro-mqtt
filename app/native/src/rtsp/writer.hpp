#pragma once

#include <sys/socket.h>
#include <poll.h>
#include <fcntl.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace aqara {

// One ordered writer owns all writes (responses and interleaved RTP) for one
// client. A blocked TCP peer must never block camera receipt, ACKs or other peers.
// The server owns the descriptor and closes it only after stop() has joined.
class RTSPWriter {
public:
    using Failure = std::function<void(const char*)>;
    RTSPWriter(int fd, Failure failure = {}, size_t limit = 8 * 1024 * 1024,
               std::chrono::milliseconds max_age = std::chrono::seconds(2))
        : fd_(fd), failure_(std::move(failure)), limit_(limit), max_age_(max_age) {
#ifdef SO_NOSIGPIPE
        int enabled = 1;
        setsockopt(fd_, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
#endif
        const int flags = fcntl(fd_, F_GETFL, 0);
        if (flags < 0 || fcntl(fd_, F_SETFL, flags | O_NONBLOCK) < 0) {
            stopping_ = true;
            shutdown(fd_, SHUT_RDWR);
            if (failure_)
                failure_("nonblocking_setup");
        }
        thread_ = std::thread([this]() { run(); });
    }
    ~RTSPWriter() {
        stop();
    }
    RTSPWriter(const RTSPWriter&) = delete;
    RTSPWriter& operator=(const RTSPWriter&) = delete;

    bool enqueue(std::vector<uint8_t> bytes) {
        if (bytes.empty())
            return true;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (stopping_)
                return false;
            // Include the in-flight write in the memory budget.
            if (bytes.size() <= limit_ - pending_) {
                pending_ += bytes.size();
                queue_.push_back({std::move(bytes), std::chrono::steady_clock::now()});
                ready_.notify_one();
                return true;
            }
        }
        fail("queue_limit");
        return false;
    }
    void stop() {
        std::lock_guard<std::mutex> stop_lock(stop_mutex_);
        if (joined_)
            return;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopping_ = true;
            queue_.clear();
        }
        shutdown(fd_, SHUT_RDWR);  // Interrupt a blocked send before joining.
        ready_.notify_one();
        if (thread_.joinable())
            thread_.join();
        joined_ = true;
    }

private:
    struct Chunk {
        std::vector<uint8_t> bytes;
        std::chrono::steady_clock::time_point queued_at;
    };
    void fail(const char* reason) {
        bool report = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            report = !stopping_;
            stopping_ = true;
            queue_.clear();
        }
        shutdown(fd_, SHUT_RDWR);
        ready_.notify_one();
        if (report && failure_)
            failure_(reason);
    }
    void run() {
        while (true) {
            Chunk chunk;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                ready_.wait(lock, [this]() { return stopping_ || !queue_.empty(); });
                if (stopping_)
                    return;
                chunk = std::move(queue_.front());
                queue_.pop_front();
            }
            size_t offset = 0;
            while (offset < chunk.bytes.size()) {
                if (std::chrono::steady_clock::now() - chunk.queued_at > max_age_) {
                    fail("queue_deadline");
                    return;
                }
#ifdef MSG_NOSIGNAL
                const int flags = MSG_NOSIGNAL | MSG_DONTWAIT;
#else
                const int flags = MSG_DONTWAIT;
#endif
                const ssize_t sent = send(fd_, chunk.bytes.data() + offset, chunk.bytes.size() - offset, flags);
                if (sent > 0) {
                    offset += static_cast<size_t>(sent);
                    continue;
                }
                if (sent < 0 && errno == EINTR)
                    continue;
                if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    const auto age = std::chrono::steady_clock::now() - chunk.queued_at;
                    const auto remaining =
                        std::chrono::duration_cast<std::chrono::milliseconds>(max_age_ - age).count();
                    if (remaining <= 0) {
                        fail("queue_deadline");
                        return;
                    }
                    pollfd writable{fd_, POLLOUT, 0};
                    const int result = poll(&writable, 1, static_cast<int>(remaining));
                    if (result >= 0 || errno == EINTR)
                        continue;
                }
                fail("socket_write");
                return;
            }
            std::lock_guard<std::mutex> lock(mutex_);
            pending_ -= chunk.bytes.size();
        }
    }
    int fd_;
    Failure failure_;
    size_t limit_, pending_ = 0;
    std::chrono::milliseconds max_age_;
    std::mutex mutex_, stop_mutex_;
    bool joined_ = false;
    std::condition_variable ready_;
    std::deque<Chunk> queue_;
    bool stopping_ = false;
    std::thread thread_;
};

}  // namespace aqara
