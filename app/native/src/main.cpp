#include <iostream>
#include <csignal>
#include "ipc/server.hpp"

int main() {
    // Ignore SIGPIPE so broken client sockets don't crash the server
    std::signal(SIGPIPE, SIG_IGN);

    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);

    aqara::IpcServer server;
    server.run_stdio();

    return 0;
}
