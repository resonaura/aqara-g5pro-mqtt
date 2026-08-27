#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <map>
#include <memory>
#include <functional>
#include <iostream>
#include <cstring>
#include "ppcs_protocol.hpp"
#include "../crypto/chacha20.hpp"

namespace aqara {

struct DecryptedVideoFrame {
    uint16_t codec_id;
    uint32_t timestamp_ms;
    uint32_t seq;
    bool is_keyframe;
    std::vector<uint8_t> data; // Annex B H.264 / HEVC bitstream
};

struct DecryptedAudioFrame {
    uint32_t timestamp_ms;
    std::vector<uint8_t> data; // Raw AAC access unit
};

class PacketReassembler {
public:
    PacketReassembler(const std::array<uint8_t, 32> &session_key)
        : key_(session_key) {}

    void on_video_frame(std::function<void(DecryptedVideoFrame&&)> cb) {
        video_cb_ = std::move(cb);
    }

    void on_audio_frame(std::function<void(DecryptedAudioFrame&&)> cb) {
        audio_cb_ = std::move(cb);
    }

    void process_channel1_packet(uint32_t idx, const uint8_t *data, size_t len) {
        if (len < 4) return;

        // 1. Audio AVIO frames (0x0088)
        uint16_t magic = (uint16_t)data[0] | ((uint16_t)data[1] << 8);
        if (magic == CODEC_AUDIO && len >= sizeof(AvioHeader)) {
            const auto *hdr = reinterpret_cast<const AvioHeader*>(data);
            uint32_t pay_len = hdr->payload_len;
            if (pay_len > 0 && pay_len <= 4096 && (40 + pay_len) <= len) {
                // Strict 8-byte nonce deduplication
                if (has_last_audio_nonce_ && std::memcmp(last_audio_nonce_, hdr->nonce, 8) == 0) {
                    return; // Duplicate UDP retransmission
                }
                std::memcpy(last_audio_nonce_, hdr->nonce, 8);
                has_last_audio_nonce_ = true;

                process_audio_packet(hdr, data + 40, pay_len);
                return;
            }
        }

        // 2. Video AVIO frames (0x004E / 0x004F)
        bool is_avio_head = (magic == CODEC_H264 || magic == CODEC_HEVC) &&
                            len >= 41 &&
                            // payload_len > 0
                            (*(const uint32_t*)(data + 28) > 0) &&
                            (*(const uint32_t*)(data + 28) <= 2000000) &&
                            (data[40] <= 16); // nalCount <= 16

        if (is_avio_head) {
            if (curr_expected_len_ > 0 && curr_accumulated_len_ >= curr_expected_len_) {
                flush_video_frame();
            } else if (!video_frags_.empty()) {
                // Broken incomplete frame — discard cleanly to prevent corruption / vertical stripes
                video_frags_.clear();
                curr_expected_len_ = 0;
                curr_accumulated_len_ = 0;
            }

            frame_start_seq_ = idx;
            curr_expected_len_ = 32 + (*(const uint32_t*)(data + 28));
            curr_accumulated_len_ = 0;
        }

        if (curr_expected_len_ == 0) return;

        uint32_t diff = (idx - frame_start_seq_) & 0xFFFF;
        uint32_t max_pkts = (curr_expected_len_ / 800) + 16;
        if (diff >= 32768 || diff > max_pkts) {
            return;
        }

        if (video_frags_.find(idx) == video_frags_.end()) {
            video_frags_[idx] = std::vector<uint8_t>(data, data + len);
            curr_accumulated_len_ += len;
        }

        if (curr_accumulated_len_ >= curr_expected_len_) {
            flush_video_frame();
        }
    }

private:
    void process_audio_packet(const AvioHeader *hdr, const uint8_t *enc_payload, size_t pay_len) {
        std::vector<uint8_t> dec(pay_len);
        std::memcpy(dec.data(), enc_payload, pay_len);
        chacha20_xor(key_.data(), hdr->nonce, 0, dec.data(), dec.size());

        // Multi-frame ADTS unpacker
        size_t off = 0;
        size_t frame_count = 0;
        while (off < dec.size()) {
            const uint8_t *rem = dec.data() + off;
            size_t rem_len = dec.size() - off;
            if (rem_len >= 7 && rem[0] == 0xFF && (rem[1] & 0xF0) == 0xF0) {
                bool has_crc = (rem[1] & 0x01) == 0;
                size_t hdr_len = has_crc ? 9 : 7;
                size_t adts_len = (((size_t)(rem[3] & 0x03) << 11) | ((size_t)rem[4] << 3) | ((size_t)(rem[5] & 0xE0) >> 5));
                if (adts_len <= hdr_len || adts_len > rem_len) {
                    break;
                }
                if (audio_cb_) {
                    DecryptedAudioFrame frame;
                    frame.timestamp_ms = hdr->timestamp;
                    frame.data.assign(rem + hdr_len, rem + adts_len);
                    audio_cb_(std::move(frame));
                }
                off += adts_len;
                frame_count++;
            } else {
                if (frame_count == 0 && audio_cb_) {
                    DecryptedAudioFrame frame;
                    frame.timestamp_ms = hdr->timestamp;
                    frame.data = std::move(dec);
                    audio_cb_(std::move(frame));
                }
                break;
            }
        }
    }

    void flush_video_frame() {
        if (video_frags_.empty()) return;

        // Flatten sorted fragments
        std::vector<uint8_t> full;
        full.reserve(curr_accumulated_len_);
        for (const auto &kv : video_frags_) {
            full.insert(full.end(), kv.second.begin(), kv.second.end());
        }

        size_t expected = curr_expected_len_;
        video_frags_.clear();
        curr_expected_len_ = 0;
        curr_accumulated_len_ = 0;

        if (full.size() < 32 || (expected > 0 && full.size() < expected)) {
            return;
        }

        uint16_t codec_id = (uint16_t)full[0] | ((uint16_t)full[1] << 8);
        if (codec_id != CODEC_H264 && codec_id != CODEC_HEVC) return;

        uint32_t ts = *(const uint32_t*)(full.data() + 8);
        uint32_t seq = *(const uint32_t*)(full.data() + 24);
        uint32_t pay_len = *(const uint32_t*)(full.data() + 28);

        if (full.size() < 32 + pay_len) return;

        const uint8_t *payload = full.data() + 32;
        std::vector<uint8_t> raw_video;

        if (pay_len >= 9) {
            uint8_t nonce[8];
            std::memcpy(nonce, payload, 8);
            uint8_t nal_count = payload[8];
            size_t table_end = 9 + (size_t)nal_count * 8;

            if (nal_count > 0 && table_end <= pay_len) {
                // Selective NAL decryption
                raw_video.assign(payload + table_end, payload + pay_len);
                
                uint8_t ks[64];
                chacha20_block(key_.data(), nonce, 0, ks);

                const uint8_t *table = payload + 9;
                for (size_t i = 0; i < nal_count; i++) {
                    uint32_t nal_off = *(const uint32_t*)(table + i * 8);
                    uint32_t nal_len = *(const uint32_t*)(table + i * 8 + 4);
                    
                    for (size_t pos = 32; pos + 16 <= nal_len; pos += 160) {
                        size_t abs = nal_off + pos;
                        if (abs + 16 > raw_video.size()) break;
                        for (size_t k = 0; k < 16; k++) {
                            raw_video[abs + k] ^= ks[k];
                        }
                    }
                }
            } else {
                raw_video.assign(payload + 9, payload + pay_len);
            }
        } else {
            raw_video.assign(payload, payload + pay_len);
        }

        bool is_keyframe = has_idr_slice(raw_video.data(), raw_video.size());

        if (video_cb_) {
            DecryptedVideoFrame frame;
            frame.codec_id = codec_id;
            frame.timestamp_ms = ts;
            frame.seq = seq;
            frame.is_keyframe = is_keyframe;
            frame.data = std::move(raw_video);
            video_cb_(std::move(frame));
        }
    }

    static bool has_idr_slice(const uint8_t *data, size_t len) {
        if (len < 5) return false;
        for (size_t i = 0; i + 4 < len; i++) {
            if (data[i] == 0 && data[i+1] == 0) {
                if (data[i+2] == 1) {
                    uint8_t t = data[i+3];
                    if ((t & 0x1F) == 5) return true; // H.264 IDR
                    uint8_t hevc_t = (t >> 1) & 0x3F;
                    if (hevc_t == 19 || hevc_t == 20) return true; // HEVC IDR
                } else if (data[i+2] == 0 && data[i+3] == 1) {
                    uint8_t t = data[i+4];
                    if ((t & 0x1F) == 5) return true; // H.264 IDR
                    uint8_t hevc_t = (t >> 1) & 0x3F;
                    if (hevc_t == 19 || hevc_t == 20) return true; // HEVC IDR
                }
            }
        }
        return false;
    }

    std::array<uint8_t, 32> key_;
    uint8_t last_audio_nonce_[8] = {0};
    bool has_last_audio_nonce_ = false;

    uint32_t frame_start_seq_ = 0;
    size_t curr_expected_len_ = 0;
    size_t curr_accumulated_len_ = 0;
    std::map<uint32_t, std::vector<uint8_t>> video_frags_;

    std::function<void(DecryptedVideoFrame&&)> video_cb_;
    std::function<void(DecryptedAudioFrame&&)> audio_cb_;
};

} // namespace aqara
