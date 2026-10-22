#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstring>
#include <sys/socket.h>
#include <unistd.h>
#include "p2p/client.hpp"
#include "p2p/cipher.hpp"

namespace aqara {
struct P2PClientTestAccess {
    static void prepare(P2PClient& client, const sockaddr_in& endpoint) {
        client.udp_fd_ = socket(AF_INET, SOCK_DGRAM, 0);
        assert(client.udp_fd_ >= 0);
        client.running_ = client.is_connected_ = client.session_ready_ = true;
        client.ppcs_key_.assign({'f', 'i', 'x', 't', 'u', 'r', 'e'});
        client.set_camera_endpoint(endpoint);
    }
    static void ready(P2PClient& client, bool value) { client.session_ready_ = value; }
    static void response(P2PClient& client) { client.dispatch_channel0(0x102B, nullptr, 0); }
};
}  // namespace aqara

int main() {
    // A loopback-only peer checks the encrypted transport's actual wire bytes.
    // Neither discovery nor any real camera connection is started.
    const int sink = socket(AF_INET, SOCK_DGRAM, 0);
    assert(sink >= 0);
    sockaddr_in endpoint{};
    endpoint.sin_family = AF_INET;
    endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(bind(sink, reinterpret_cast<sockaddr*>(&endpoint), sizeof(endpoint)) == 0);
    socklen_t size = sizeof(endpoint);
    assert(getsockname(sink, reinterpret_cast<sockaddr*>(&endpoint), &size) == 0);
    timeval timeout{};
    timeout.tv_usec = 100000;
    assert(setsockopt(sink, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0);
    aqara::P2PConfig config;
    config.did = "ptz-loopback-fixture";
    const uint8_t key[32]{};
    auto assembler = std::make_shared<aqara::AVIOReassembler>(key, key);
    std::vector<std::string> events;
    aqara::P2PClient client(config, assembler, [&](const std::string& e) { events.push_back(e); });
    aqara::P2PClientTestAccess::prepare(client, endpoint);
    uint8_t packet[512]{};
    const uint8_t fixture_key[] = {'f', 'i', 'x', 't', 'u', 'r', 'e'};
    unsigned sequence = 1;
    for (const std::string direction : {"up", "down", "left", "right", "stop"}) {
        assert(client.ptz(direction));
        auto count = recv(sink, packet, sizeof(packet), 0);
        assert(count > 24);
        aqara::PPCSCipher::decrypt(fixture_key, sizeof(fixture_key), packet, count);
        assert(packet[0] == 0xF1 && packet[1] == 0xD0);
        assert(packet[4] == 0xD1 && packet[5] == 0);  // command channel
        assert(std::memcmp(packet + 8, "lumi", 4) == 0);
        // Independent wire contract: IOCTL 4138, never Talk's 4106.
        assert(packet[12] == 0x2A && packet[13] == 0x10 && packet[14] == 0 && packet[15] == 0);
        assert(packet[16] == sequence++);
        assert(packet[20] == count - 24 && packet[21] == 0 && packet[22] == 0 && packet[23] == 0);
        assert(std::string(reinterpret_cast<char*>(packet + 24), count - 24) == "{\"action\":\"" + direction + "\"}");
    }
    for (const std::string invalid : {"", "reboot", "left_always", "right_always", "up_always", "0", "left\""})
        assert(!client.ptz(invalid));
    assert(recv(sink, packet, sizeof(packet), 0) < 0);
    aqara::P2PClientTestAccess::ready(client, false);
    assert(!client.ptz("up"));
    assert(recv(sink, packet, sizeof(packet), 0) < 0);
    aqara::P2PClientTestAccess::ready(client, true);
    aqara::P2PClientTestAccess::response(client);
    assert(events.size() == 1 && events[0].find("ptz_response") != std::string::npos);
    assert(events[0].find("executed") == std::string::npos);
    // Talk keeps its existing binary command and never sends a PTZ body.
    client.start_talkback();
    auto count = recv(sink, packet, sizeof(packet), 0);
    assert(count == 24);
    aqara::PPCSCipher::decrypt(fixture_key, sizeof(fixture_key), packet, count);
    assert(packet[12] == 0x0A && packet[13] == 0x10 && packet[20] == 0);
    close(sink);
}
