#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <mutex>
#include <thread>
#include "session.hpp"

// Link StreamSession to a deterministic P2P fixture: no camera/network traffic.
// A command can remain on the old client's stack while restart joins it and
// publishes its replacement; the old object must outlive that command.
namespace {
std::mutex gate_mutex;
std::condition_variable gate;
std::map<const aqara::P2PClient*, int> commands;
bool blocked = false;
int entered = 0;
int constructed = 0;
int destroyed = 0;
int destroyed_active = 0;
std::function<void()> receiver_callback;
}  // namespace
namespace aqara {
P2PClient::P2PClient(const P2PConfig& config, std::shared_ptr<AVIOReassembler> assembler,
                     std::function<void(const std::string&)> cb)
    : config_(config), reassembler_(std::move(assembler)), event_cb_(std::move(cb)) {
    std::lock_guard<std::mutex> lock(gate_mutex);
    commands[this] = 0;
    ++constructed;
}
P2PClient::~P2PClient() {
    std::lock_guard<std::mutex> lock(gate_mutex);
    if (commands.at(this))
        ++destroyed_active;
    commands.erase(this);
    ++destroyed;
}
bool P2PClient::start() {
    running_ = true;
    return true;
}
void P2PClient::stop() {
    running_ = false;
    // Joining a receiver must not hold the publication lock needed by its IDR callback.
    if (receiver_callback) {
        std::thread receiver(receiver_callback);
        receiver.join();
    }
}
void P2PClient::request_keyframe() {
    {
        std::unique_lock<std::mutex> lock(gate_mutex);
        ++commands.at(this);
        ++entered;
        gate.notify_all();
        gate.wait(lock, [] { return !blocked; });
    }
    assert(config_.did == "lifetime-fixture");
    std::lock_guard<std::mutex> lock(gate_mutex);
    --commands.at(this);
}
void P2PClient::set_quality(int) {}
bool P2PClient::ptz(const std::string&) {
    return true;
}
void P2PClient::start_talkback() {}
void P2PClient::stop_talkback() {}
void P2PClient::send_talkback_frame(const uint8_t*, size_t) {}
}  // namespace aqara
int main() {
    aqara::SessionConfig config;
    config.did = "lifetime-fixture";
    config.video_key_hex = config.audio_key_hex = std::string(64, '0');
    {
        aqara::StreamSession session(config, {});
        blocked = true;
        std::thread reader([&] { session.request_keyframe(); });
        {
            std::unique_lock<std::mutex> lock(gate_mutex);
            assert(gate.wait_for(lock, std::chrono::seconds(3), [] { return entered > 0; }));
        }
        assert(session.restart_p2p(config));
        {
            std::lock_guard<std::mutex> lock(gate_mutex);
            assert(destroyed == 0);
            assert(constructed == 2);
            blocked = false;
        }
        gate.notify_all();
        reader.join();
        assert(destroyed == 1);
        receiver_callback = [&] { session.request_keyframe(); };
        std::atomic<bool> done{false};
        std::vector<std::thread> readers;
        for (int i = 0; i < 8; ++i)
            readers.emplace_back([&] {
                while (!done)
                    session.request_keyframe();
            });
        for (int i = 0; i < 100; ++i)
            assert(session.restart_p2p(config));
        session.stop();
        done = true;
        for (auto& thread : readers)
            thread.join();
        receiver_callback = {};
    }
    assert(destroyed_active == 0);
    assert(constructed == destroyed);
    assert(commands.empty());
}
