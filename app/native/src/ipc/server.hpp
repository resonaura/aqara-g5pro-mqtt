#pragma once

#include <string>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <atomic>
#include "../session.hpp"

namespace aqara {

class IpcServer {
public:
    IpcServer();
    ~IpcServer();

    // Run using standard I/O (stdin/stdout line-delimited JSON)
    void run_stdio();

    void send_event(const std::string& json_str);

private:
    void handle_command(const std::string& line);

    std::mutex sessions_mutex_;
    std::unordered_map<std::string, std::unique_ptr<StreamSession>> sessions_;
    std::atomic<bool> running_{false};
};

}  // namespace aqara
