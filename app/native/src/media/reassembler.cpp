#include "reassembler.hpp"
#include "../crypto/chacha20.hpp"
#include <cstring>

namespace aqara {

static inline uint32_t read_u32_le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

static inline uint16_t read_u16_le(const uint8_t* p) {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

static inline bool has_annex_b_prefix(const uint8_t* data, size_t len) {
    if (len < 3)
        return false;
    if (data[0] == 0 && data[1] == 0 && data[2] == 1)
        return true;
    if (len >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1)
        return true;
    return false;
}

AvioReassembler::AvioReassembler(const uint8_t video_key[32], const uint8_t audio_key[32]) {
    std::memcpy(video_key_, video_key, 32);
    std::memcpy(audio_key_, audio_key, 32);
}

void AvioReassembler::set_callbacks(VideoCallback video_cb, AudioCallback audio_cb, KeyframeRequestCallback kf_req_cb) {
    video_cb_ = std::move(video_cb);
    audio_cb_ = std::move(audio_cb);
    kf_req_cb_ = std::move(kf_req_cb);
}

void AvioReassembler::reset() {
    expected_seq_ = -1;
    reorder_buf_.clear();
    current_frame_buf_.clear();
    current_expected_len_ = 0;
    assembling_ = false;
}

void AvioReassembler::push_packet(uint16_t seq, const uint8_t* data, size_t len) {
    if (len == 0)
        return;

    if (expected_seq_ == -1) {
        expected_seq_ = seq;
    }

    int16_t diff = static_cast<int16_t>(seq - static_cast<uint16_t>(expected_seq_));

    if (diff == 0) {
        handle_packet_immediate(seq, data, len);
        expected_seq_ = (seq + 1) & 0xffff;

        while (!reorder_buf_.empty()) {
            auto it = reorder_buf_.find(static_cast<uint16_t>(expected_seq_));
            if (it == reorder_buf_.end())
                break;

            handle_packet_immediate(it->first, it->second.data(), it->second.size());
            reorder_buf_.erase(it);
            expected_seq_ = (expected_seq_ + 1) & 0xffff;
        }
    } else if (diff > 0 && diff < 64) {
        reorder_buf_[seq] = std::vector<uint8_t>(data, data + len);
        if (reorder_buf_.size() >= 16) {
            // Buffer backlog limit reached, drain in sequence order
            for (auto& pair : reorder_buf_) {
                handle_packet_immediate(pair.first, pair.second.data(), pair.second.size());
                expected_seq_ = (pair.first + 1) & 0xffff;
            }
            reorder_buf_.clear();
        }
    } else if (diff < 0) {
        // Late duplicate packet, discard
        return;
    } else {
        // Large jump / reset
        for (auto& pair : reorder_buf_) {
            handle_packet_immediate(pair.first, pair.second.data(), pair.second.size());
        }
        reorder_buf_.clear();
        expected_seq_ = seq;
        handle_packet_immediate(seq, data, len);
        expected_seq_ = (seq + 1) & 0xffff;
    }
}

static inline bool is_avio_video_header_safe(const uint8_t* data, size_t len) {
    if (len < 32)
        return false;
    uint16_t codec = static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
    if (codec != 0x004E && codec != 0x004F)
        return false;
    uint16_t flags = static_cast<uint16_t>(data[2]) | (static_cast<uint16_t>(data[3]) << 8);
    if (flags > 1)
        return false;
    uint32_t payload_len = read_u32_le(data + 28);
    return (payload_len >= 16 && payload_len <= 2000000);
}

static inline bool is_avio_audio_header_safe(const uint8_t* data, size_t len) {
    if (len < 40)
        return false;
    uint16_t codec = static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
    if (codec != 0x0088)
        return false;
    uint32_t payload_len = read_u32_le(data + 28);
    return (payload_len > 0 && payload_len <= 4096);
}

void AvioReassembler::handle_packet_immediate(uint16_t seq, const uint8_t* data, size_t len) {
    if (len < 4)
        return;

    const uint8_t* cur = data;
    size_t cur_len = len;

    // Peel all leading AVIO Audio (0x0088) frames
    while (cur_len >= 40 && is_avio_audio_header_safe(cur, cur_len)) {
        uint32_t audio_len = read_u32_le(cur + 28);
        size_t frame_len = 40 + audio_len;
        if (frame_len > cur_len)
            break;

        std::vector<uint8_t> audio_frame(cur, cur + frame_len);
        if (ChaCha20::decrypt_audio_payload(audio_frame.data(), audio_frame.size(), audio_key_)) {
            if (audio_cb_) {
                AudioFrame af;
                af.aac_adts_data.assign(audio_frame.data() + 40, audio_frame.data() + 40 + audio_len);
                audio_cb_(af);
            }
        }

        cur += frame_len;
        cur_len -= frame_len;
    }

    if (cur_len == 0)
        return;

    if (assembling_) {
        if (current_frame_buf_.size() + cur_len >= current_expected_len_) {
            size_t take = current_expected_len_ > current_frame_buf_.size()
                              ? (current_expected_len_ - current_frame_buf_.size())
                              : 0;
            if (take > 0 && take <= cur_len) {
                current_frame_buf_.insert(current_frame_buf_.end(), cur, cur + take);
                flush_current_frame();
                const uint8_t* rem = cur + take;
                size_t rem_len = cur_len - take;
                if (rem_len >= 32 && is_avio_video_header_safe(rem, rem_len)) {
                    assembling_ = true;
                    frame_start_seq_ = seq;
                    current_expected_len_ = 32 + read_u32_le(rem + 28);
                    current_frame_buf_.assign(rem, rem + rem_len);
                    if (current_frame_buf_.size() >= current_expected_len_) {
                        flush_current_frame();
                    }
                }
            } else {
                current_frame_buf_.insert(current_frame_buf_.end(), cur, cur + cur_len);
                if (current_frame_buf_.size() >= current_expected_len_) {
                    flush_current_frame();
                }
            }
        } else {
            current_frame_buf_.insert(current_frame_buf_.end(), cur, cur + cur_len);
        }
    } else {
        if (is_avio_video_header_safe(cur, cur_len)) {
            assembling_ = true;
            frame_start_seq_ = seq;
            current_expected_len_ = 32 + read_u32_le(cur + 28);
            current_frame_buf_.assign(cur, cur + cur_len);
            if (current_frame_buf_.size() >= current_expected_len_) {
                flush_current_frame();
            }
        }
    }
}

void AvioReassembler::flush_current_frame() {
    if (!assembling_ || current_frame_buf_.size() < 32) {
        assembling_ = false;
        current_frame_buf_.clear();
        current_expected_len_ = 0;
        return;
    }

    process_completed_avio(current_frame_buf_.data(), current_frame_buf_.size());
    assembling_ = false;
    current_frame_buf_.clear();
    current_expected_len_ = 0;
}

void AvioReassembler::process_completed_avio(const uint8_t* data, size_t len) {
    if (len < 32)
        return;

    uint16_t codec_id = read_u16_le(data);
    bool avio_keyframe = (read_u16_le(data + 2) & 0x0001) != 0;
    uint16_t width = read_u16_le(data + 16);
    uint16_t height = read_u16_le(data + 20);
    uint32_t payload_len = read_u32_le(data + 28);

    if (32 + payload_len > len)
        return;

    // Decrypt payload in-place
    std::vector<uint8_t> payload(data + 32, data + 32 + payload_len);
    ChaCha20::decrypt_video_payload(payload.data(), payload.size(), video_key_);

    if (payload.empty())
        return;

    uint8_t nal_count = payload.size() >= 9 ? payload[8] : 0;
    size_t table_end = 9 + nal_count * 8;

    std::vector<uint8_t> annex_b;
    const uint8_t start_code[4] = {0, 0, 0, 1};

    if (has_annex_b_prefix(payload.data() + table_end, payload.size() - table_end)) {
        // Tail already has Annex-B start codes (typically IDR with SPS/PPS)
        annex_b.assign(payload.begin() + table_end, payload.end());
    } else if (nal_count > 0 && table_end < payload.size()) {
        const uint8_t* table = payload.data() + 9;
        const uint8_t* tail = payload.data() + table_end;
        size_t tail_len = payload.size() - table_end;

        uint32_t first_off = read_u32_le(table);
        if (first_off > 0 && first_off < tail_len) {
            // In-band parameter sets before first table entry
            if (!has_annex_b_prefix(tail, first_off)) {
                annex_b.insert(annex_b.end(), start_code, start_code + 4);
            }
            annex_b.insert(annex_b.end(), tail, tail + first_off);
        }

        for (uint8_t i = 0; i < nal_count; ++i) {
            uint32_t off = read_u32_le(table + i * 8);
            uint32_t nal_len = read_u32_le(table + i * 8 + 4);
            if (nal_len == 0 || off + nal_len > tail_len)
                continue;

            const uint8_t* nal = tail + off;
            if (!has_annex_b_prefix(nal, nal_len)) {
                annex_b.insert(annex_b.end(), start_code, start_code + 4);
            }
            annex_b.insert(annex_b.end(), nal, nal + nal_len);
        }
    } else {
        // Fallback
        if (!has_annex_b_prefix(payload.data(), payload.size())) {
            annex_b.insert(annex_b.end(), start_code, start_code + 4);
        }
        annex_b.insert(annex_b.end(), payload.begin(), payload.end());
    }

    if (annex_b.empty())
        return;

    // Scan for SPS (type 7 / 33), PPS (type 8 / 34), VPS (type 32)
    size_t i = 0;
    bool is_hevc = (codec_id == 0x004F);
    bool found_idr = avio_keyframe;

    while (i + 4 < annex_b.size()) {
        size_t prefix_len = 0;
        if (annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 1)
            prefix_len = 3;
        else if (annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 0 && annex_b[i + 3] == 1)
            prefix_len = 4;

        if (prefix_len > 0) {
            size_t nal_start = i + prefix_len;
            size_t next_start = annex_b.size();
            for (size_t j = nal_start; j + 3 < annex_b.size(); ++j) {
                if (annex_b[j] == 0 && annex_b[j + 1] == 0 &&
                    (annex_b[j + 2] == 1 || (annex_b[j + 2] == 0 && annex_b[j + 3] == 1))) {
                    next_start = j;
                    break;
                }
            }
            size_t nal_len = next_start - nal_start;
            if (nal_len > 0) {
                uint8_t nal_type = is_hevc ? ((annex_b[nal_start] >> 1) & 0x3f) : (annex_b[nal_start] & 0x1f);
                if (!is_hevc) {
                    if (nal_type == 7)
                        sps_.assign(annex_b.begin() + nal_start, annex_b.begin() + next_start);
                    else if (nal_type == 8)
                        pps_.assign(annex_b.begin() + nal_start, annex_b.begin() + next_start);
                    else if (nal_type == 5)
                        found_idr = true;
                } else {
                    if (nal_type == 32)
                        vps_.assign(annex_b.begin() + nal_start, annex_b.begin() + next_start);
                    else if (nal_type == 33)
                        sps_.assign(annex_b.begin() + nal_start, annex_b.begin() + next_start);
                    else if (nal_type == 34)
                        pps_.assign(annex_b.begin() + nal_start, annex_b.begin() + next_start);
                    else if (nal_type >= 19 && nal_type <= 21)
                        found_idr = true;
                }
            }
            i = next_start;
        } else {
            i++;
        }
    }

    if (video_cb_) {
        VideoFrame vf;
        vf.annex_b_data = std::move(annex_b);
        vf.is_keyframe = found_idr;
        vf.width = width;
        vf.height = height;
        vf.codec_id = codec_id;
        video_cb_(vf);
    }
}

}  // namespace aqara
