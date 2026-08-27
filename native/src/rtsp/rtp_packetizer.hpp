#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <cstring>
#include <string>

namespace aqara {

class RtpPacketizer {
public:
    static std::vector<std::vector<uint8_t>> split_annexb_nalus(const uint8_t *data, size_t len) {
        std::vector<std::vector<uint8_t>> nals;
        size_t i = 0;
        while (i < len) {
            // Find start code
            size_t sc_len = 0;
            if (i + 3 <= len && data[i] == 0 && data[i+1] == 0 && data[i+2] == 1) {
                sc_len = 3;
            } else if (i + 4 <= len && data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1) {
                sc_len = 4;
            } else {
                i++;
                continue;
            }

            size_t start = i + sc_len;
            size_t next = start;
            while (next < len) {
                if (next + 3 <= len && data[next] == 0 && data[next+1] == 0 && data[next+2] == 1) break;
                if (next + 4 <= len && data[next] == 0 && data[next+1] == 0 && data[next+2] == 0 && data[next+3] == 1) break;
                next++;
            }

            if (next > start) {
                nals.emplace_back(data + start, data + next);
            }
            i = next;
        }
        return nals;
    }

    static std::vector<std::vector<uint8_t>> packetize_h264(
        const std::vector<uint8_t> &nal,
        uint32_t timestamp,
        uint16_t &seq,
        uint32_t ssrc,
        bool is_last_nal
    ) {
        std::vector<std::vector<uint8_t>> packets;
        if (nal.empty()) return packets;

        constexpr size_t MAX_PAYLOAD = 1380;

        if (nal.size() <= MAX_PAYLOAD) {
            std::vector<uint8_t> pkt(12 + nal.size());
            pkt[0] = 0x80;
            pkt[1] = (is_last_nal ? 0x80 : 0x00) | 96; // Payload Type 96
            pkt[2] = (uint8_t)((seq >> 8) & 0xFF);
            pkt[3] = (uint8_t)(seq & 0xFF);
            seq++;
            pkt[4] = (uint8_t)((timestamp >> 24) & 0xFF);
            pkt[5] = (uint8_t)((timestamp >> 16) & 0xFF);
            pkt[6] = (uint8_t)((timestamp >> 8) & 0xFF);
            pkt[7] = (uint8_t)(timestamp & 0xFF);
            pkt[8] = (uint8_t)((ssrc >> 24) & 0xFF);
            pkt[9] = (uint8_t)((ssrc >> 16) & 0xFF);
            pkt[10] = (uint8_t)((ssrc >> 8) & 0xFF);
            pkt[11] = (uint8_t)(ssrc & 0xFF);

            std::memcpy(pkt.data() + 12, nal.data(), nal.size());
            packets.push_back(std::move(pkt));
        } else {
            // RFC 6184 FU-A
            uint8_t nal_header = nal[0];
            uint8_t nal_type = nal_header & 0x1F;
            uint8_t nal_nri = nal_header & 0x60;
            uint8_t fu_indicator = nal_nri | 28;

            size_t offset = 1;
            while (offset < nal.size()) {
                size_t chunk_len = (nal.size() - offset < MAX_PAYLOAD) ? (nal.size() - offset) : MAX_PAYLOAD;
                bool is_start = (offset == 1);
                bool is_end = (offset + chunk_len >= nal.size());

                uint8_t fu_header = nal_type;
                if (is_start) fu_header |= 0x80;
                if (is_end) fu_header |= 0x40;

                std::vector<uint8_t> pkt(12 + 2 + chunk_len);
                pkt[0] = 0x80;
                pkt[1] = (is_last_nal && is_end ? 0x80 : 0x00) | 96;
                pkt[2] = (uint8_t)((seq >> 8) & 0xFF);
                pkt[3] = (uint8_t)(seq & 0xFF);
                seq++;
                pkt[4] = (uint8_t)((timestamp >> 24) & 0xFF);
                pkt[5] = (uint8_t)((timestamp >> 16) & 0xFF);
                pkt[6] = (uint8_t)((timestamp >> 8) & 0xFF);
                pkt[7] = (uint8_t)(timestamp & 0xFF);
                pkt[8] = (uint8_t)((ssrc >> 24) & 0xFF);
                pkt[9] = (uint8_t)((ssrc >> 16) & 0xFF);
                pkt[10] = (uint8_t)((ssrc >> 8) & 0xFF);
                pkt[11] = (uint8_t)(ssrc & 0xFF);

                pkt[12] = fu_indicator;
                pkt[13] = fu_header;
                std::memcpy(pkt.data() + 14, nal.data() + offset, chunk_len);

                packets.push_back(std::move(pkt));
                offset += chunk_len;
            }
        }
        return packets;
    }

    static std::vector<uint8_t> packetize_aac(
        const std::vector<uint8_t> &raw_aac,
        uint32_t timestamp,
        uint16_t &seq,
        uint32_t ssrc
    ) {
        // RFC 3640 AAC-hbr packet
        // 12 bytes RTP header + 4 bytes AU header + AAC payload
        std::vector<uint8_t> pkt(12 + 4 + raw_aac.size());
        pkt[0] = 0x80;
        pkt[1] = 0x80 | 97; // Marker=1, Payload Type 97
        pkt[2] = (uint8_t)((seq >> 8) & 0xFF);
        pkt[3] = (uint8_t)(seq & 0xFF);
        seq++;
        pkt[4] = (uint8_t)((timestamp >> 24) & 0xFF);
        pkt[5] = (uint8_t)((timestamp >> 16) & 0xFF);
        pkt[6] = (uint8_t)((timestamp >> 8) & 0xFF);
        pkt[7] = (uint8_t)(timestamp & 0xFF);
        pkt[8] = (uint8_t)((ssrc >> 24) & 0xFF);
        pkt[9] = (uint8_t)((ssrc >> 16) & 0xFF);
        pkt[10] = (uint8_t)((ssrc >> 8) & 0xFF);
        pkt[11] = (uint8_t)(ssrc & 0xFF);

        // AU-headers-length = 16 bits (0x00, 0x10)
        pkt[12] = 0x00;
        pkt[13] = 0x10;
        // AU-header = (size << 3)
        uint16_t au_hdr = (uint16_t)((raw_aac.size() << 3) & 0xFFFF);
        pkt[14] = (uint8_t)((au_hdr >> 8) & 0xFF);
        pkt[15] = (uint8_t)(au_hdr & 0xFF);

        std::memcpy(pkt.data() + 16, raw_aac.data(), raw_aac.size());
        return pkt;
    }
};

} // namespace aqara
