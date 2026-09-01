#include "reassembler.hpp"
#include "../crypto/chacha20.hpp"
#include <algorithm>
#include <cstring>
#include <iostream>

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

AVIOReassembler::AVIOReassembler(const uint8_t video_key[32], const uint8_t audio_key[32]) {
    std::memcpy(video_key_, video_key, 32);
    std::memcpy(audio_key_, audio_key, 32);
}

void AVIOReassembler::set_callbacks(VideoCallback video_cb, AudioCallback audio_cb, KeyframeRequestCallback kf_req_cb) {
    video_cb_ = std::move(video_cb);
    audio_cb_ = std::move(audio_cb);
    kf_req_cb_ = std::move(kf_req_cb);
}

void AVIOReassembler::set_keys(const uint8_t video_key[32], const uint8_t audio_key[32]) {
    if (video_key)
        std::memcpy(video_key_, video_key, 32);
    if (audio_key)
        std::memcpy(audio_key_, audio_key, 32);
    reset();
}

void AVIOReassembler::reset() {
    channels_.clear();
    last_audio_ts_ms_ = 0;
}

static inline bool is_avio_video_header_safe(const uint8_t* data, size_t len) {
    if (len < 32)
        return false;
    const uint16_t codec = read_u16_le(data);
    if (codec != 0x004E && codec != 0x004F && codec != 0x0050)
        return false;
    const uint32_t payload_len = read_u32_le(data + 28);
    return payload_len >= 16 && payload_len <= 2 * 1024 * 1024;
}

static inline bool is_avio_audio_header_safe(const uint8_t* data, size_t len) {
    if (len < 32 || read_u16_le(data) != 0x0088)
        return false;
    // Observed Aqara AAC AVIO frames use flags 0x000e.
    if (read_u16_le(data + 2) != 0x000e)
        return false;
    const uint32_t payload_len = read_u32_le(data + 28);
    if (payload_len <= 8 || payload_len > 4096)
        return false;
    return true;
}

void AVIOReassembler::recover_from_sequence_gap(uint8_t channel, ChannelState& state, uint16_t next_seq) {
    sequence_gaps_++;
    discarded_bytes_ += state.stream_buf.size();
    state.stream_buf.clear();
    state.pending_audio.clear();
    state.pending_audio_expected = 0;
    state.gap_notified = false;
    state.expected_seq = next_seq;
    std::cerr << "[AVIO] channel=" << static_cast<int>(channel) << " sequence gap, resync at seq=" << next_seq
              << " gaps=" << sequence_gaps_ << std::endl;
    if (kf_req_cb_)
        kf_req_cb_();
}

void AVIOReassembler::push_packet(uint8_t channel, uint16_t seq, const uint8_t* data, size_t len) {
    if (!data || len == 0)
        return;
    packets_received_++;
    ChannelState& state = channels_[channel];

    if (state.expected_seq == -1)
        state.expected_seq = seq;

    const int16_t diff = static_cast<int16_t>(seq - static_cast<uint16_t>(state.expected_seq));
    if (diff == 0) {
        handle_packet_immediate(channel, state, seq, data, len);
        state.expected_seq = static_cast<uint16_t>(seq + 1);

        while (true) {
            auto it = state.reorder_buf.find(static_cast<uint16_t>(state.expected_seq));
            if (it == state.reorder_buf.end())
                break;
            handle_packet_immediate(channel, state, it->first, it->second.data(), it->second.size());
            state.reorder_buf.erase(it);
            state.expected_seq = static_cast<uint16_t>(state.expected_seq + 1);
        }
        if (state.reorder_buf.empty())
            state.gap_notified = false;
        return;
    }

    if (diff < 0) {
        packets_duplicate_++;
        return;
    }

    if (diff < 64) {
        if (!state.gap_notified) {
            state.gap_notified = true;
            if (kf_req_cb_)
                kf_req_cb_();
        }
        state.reorder_buf.try_emplace(seq, data, data + len);
        if (state.reorder_buf.size() < 16)
            return;

        // The missing datagram did not arrive within the jitter window. Never
        // concatenate later fragments onto a damaged frame: discard residue,
        // request an IDR, then resume at the nearest buffered sequence.
        auto nearest = state.reorder_buf.begin();
        uint16_t best_distance = 0xffff;
        const uint16_t expected = static_cast<uint16_t>(state.expected_seq);
        for (auto it = state.reorder_buf.begin(); it != state.reorder_buf.end(); ++it) {
            const uint16_t distance = static_cast<uint16_t>(it->first - expected);
            if (distance < best_distance) {
                best_distance = distance;
                nearest = it;
            }
        }
        const uint16_t restart_seq = nearest->first;
        recover_from_sequence_gap(channel, state, restart_seq);

        while (true) {
            auto it = state.reorder_buf.find(static_cast<uint16_t>(state.expected_seq));
            if (it == state.reorder_buf.end())
                break;
            handle_packet_immediate(channel, state, it->first, it->second.data(), it->second.size());
            state.reorder_buf.erase(it);
            state.expected_seq = static_cast<uint16_t>(state.expected_seq + 1);
        }
        return;
    }

    // Session reset or a jump larger than the reorder window.
    state.reorder_buf.clear();
    recover_from_sequence_gap(channel, state, seq);
    handle_packet_immediate(channel, state, seq, data, len);
    state.expected_seq = static_cast<uint16_t>(seq + 1);
}

void AVIOReassembler::handle_packet_immediate(uint8_t channel, ChannelState& state, uint16_t, const uint8_t* data,
                                              size_t len) {
    static constexpr size_t MAX_STREAM_BUFFER = 4 * 1024 * 1024;

    auto append_video_bytes = [&](const uint8_t* bytes, size_t count) {
        if (count == 0)
            return;
        if (state.stream_buf.size() + count > MAX_STREAM_BUFFER) {
            discarded_bytes_ += state.stream_buf.size();
            state.stream_buf.clear();
            if (kf_req_cb_)
                kf_req_cb_();
        }
        state.stream_buf.insert(state.stream_buf.end(), bytes, bytes + count);
        parse_stream_buffer(channel, state);
    };

    if (!state.pending_audio.empty()) {
        const size_t needed = state.pending_audio_expected - state.pending_audio.size();
        const size_t take = std::min(needed, len);
        state.pending_audio.insert(state.pending_audio.end(), data, data + take);
        data += take;
        len -= take;
        if (state.pending_audio.size() < state.pending_audio_expected)
            return;
        process_completed_audio(state.pending_audio.data(), state.pending_audio.size());
        state.pending_audio.clear();
        state.pending_audio_expected = 0;
    }

    // Audio does not necessarily begin at UDP offset zero. Aqara can finish a
    // video fragment and append a complete 0x0088 frame in the same DRW body,
    // or place audio between two fragments of one video frame. Peel every
    // strongly validated audio header before feeding the remaining bytes to
    // the video stream assembler.
    while (len > 0) {
        size_t audio_offset = len;
        for (size_t i = 0; i + 32 <= len; ++i) {
            if (is_avio_audio_header_safe(data + i, len - i)) {
                audio_offset = i;
                break;
            }
        }

        if (audio_offset == len) {
            append_video_bytes(data, len);
            return;
        }

        append_video_bytes(data, audio_offset);
        data += audio_offset;
        len -= audio_offset;

        const size_t audio_len = 32ULL + read_u32_le(data + 28);
        if (audio_len > len) {
            state.pending_audio.assign(data, data + len);
            state.pending_audio_expected = audio_len;
            return;
        }
        process_completed_audio(data, audio_len);
        data += audio_len;
        len -= audio_len;
    }
}

void AVIOReassembler::parse_stream_buffer(uint8_t channel, ChannelState& state) {
    (void)channel;
    while (state.stream_buf.size() >= 32) {
        const uint8_t* data = state.stream_buf.data();

        if (is_avio_audio_header_safe(data, state.stream_buf.size())) {
            const size_t frame_len =
                32ULL + read_u32_le(data + 28);  // dataLen includes the 8B nonce plus encrypted AAC
            if (frame_len > state.stream_buf.size())
                return;
            process_completed_audio(data, frame_len);
            state.stream_buf.erase(state.stream_buf.begin(),
                                   state.stream_buf.begin() + static_cast<std::ptrdiff_t>(frame_len));
            continue;
        }

        if (is_avio_video_header_safe(data, state.stream_buf.size())) {
            const size_t frame_len = 32ULL + read_u32_le(data + 28);
            if (frame_len > state.stream_buf.size())
                return;
            process_completed_avio(data, frame_len);
            state.stream_buf.erase(state.stream_buf.begin(),
                                   state.stream_buf.begin() + static_cast<std::ptrdiff_t>(frame_len));
            continue;
        }

        // We may be resuming after a lost UDP datagram. Search for the next
        // complete header, but retain 31 trailing bytes so split headers survive.
        size_t next = 1;
        for (; next + 32 <= state.stream_buf.size(); ++next) {
            if (is_avio_audio_header_safe(data + next, state.stream_buf.size() - next) ||
                is_avio_video_header_safe(data + next, state.stream_buf.size() - next)) {
                break;
            }
        }
        if (next + 32 > state.stream_buf.size()) {
            const size_t drop = state.stream_buf.size() - 31;
            discarded_bytes_ += drop;
            state.stream_buf.erase(state.stream_buf.begin(),
                                   state.stream_buf.begin() + static_cast<std::ptrdiff_t>(drop));
            return;
        }
        discarded_bytes_ += next;
        state.stream_buf.erase(state.stream_buf.begin(), state.stream_buf.begin() + static_cast<std::ptrdiff_t>(next));
    }
}

void AVIOReassembler::process_completed_audio(const uint8_t* data, size_t len) {
    if (len < 32)
        return;
    const uint32_t ms_part = read_u32_le(data + 8);
    const uint32_t s_part = read_u32_le(data + 12);
    const uint64_t ts_ms = static_cast<uint64_t>(s_part) * 1000 + ms_part;

    // Deduplicate retransmitted / redundant audio frames
    if (ts_ms != 0 && ts_ms == last_audio_ts_ms_) {
        return;
    }
    last_audio_ts_ms_ = ts_ms;

    std::vector<uint8_t> frame(data, data + len);
    if (!ChaCha20::decrypt_audio_payload(frame.data(), frame.size(), audio_key_))
        return;

    const uint32_t payload_len = read_u32_le(frame.data() + 28);
    if (payload_len <= 8 || 32ULL + payload_len > frame.size())
        return;
    const size_t audio_len = payload_len - 8;

    AudioFrame af;
    af.aac_adts_data.assign(frame.begin() + 40, frame.begin() + 40 + audio_len);
    af.timestamp_ms = ts_ms;
    audio_frames_++;
    if (audio_frames_ == 1) {
        const bool adts =
            af.aac_adts_data.size() >= 2 && af.aac_adts_data[0] == 0xff && (af.aac_adts_data[1] & 0xf0) == 0xf0;
        std::cout << "[AVIO] audio initialized: bytes=" << audio_len << " ts_ms=" << ts_ms
                  << " adts=" << (adts ? "yes" : "no") << std::endl;
    }
    if (audio_cb_)
        audio_cb_(af);
}

void AVIOReassembler::process_completed_avio(const uint8_t* data, size_t len) {
    if (len < 32)
        return;

    uint16_t codec_id = read_u16_le(data);
    bool avio_keyframe = (read_u16_le(data + 2) & 0x0001) != 0;
    const uint32_t ms_part = read_u32_le(data + 8);
    const uint32_t s_part = read_u32_le(data + 12);
    const uint64_t ts_ms = static_cast<uint64_t>(s_part) * 1000 + ms_part;
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
        video_frames_++;
        VideoFrame vf;
        vf.annex_b_data = std::move(annex_b);
        vf.is_keyframe = found_idr;
        vf.width = width;
        vf.height = height;
        vf.codec_id = codec_id;
        vf.timestamp_ms = ts_ms;
        video_cb_(vf);
    }
}

}  // namespace aqara
