/**
 * Aqara G5 Pro / E1 Camera Bridge
 * Complete P2P video bridge with built-in RTSP server and Home Assistant integration
 */
import axios from "axios";
import * as crypto from "crypto";
import * as dgram from "dgram";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import { AqaraStreamDecryptor } from "./decryptor.js";
import { isPortAllowed } from "./ports.js";

// ============= Type Definitions =============

export interface P2PInfo {
  p2pId: string;
  devP2pPublicKey: string;
  initStringApp: string;
}

export interface P2PSignResponse {
  sign: string;
  p2pDevPublicKey: string;
  time: string;
}

export interface P2PFrameHeader {
  frmNo: number;
  codecId: number;
  flags: number;
  camIndex: number;
  iFrameIndex: number;
  timestamp: number;
}

export interface VideoFrame {
  header: P2PFrameHeader;
  data: Buffer;
  timestamp: number;
}

export interface BridgeOptions {
  did: string;
  token: string;
  cameraIp?: string;
  cameraPort?: number;
  baseUrl?: string;
  appId?: string;
  appKey?: string;
  rtspPort?: number;
  videoKey?: string;
  deviceName?: string;
  model?: string;
  /** 0x101C videoStream: 0=1520p, 1=1080p, 2=Low. Default 0 (max). */
  p2pQualityChannel?: number;
}

// ============= Constants =============

export const PPCS_MAGIC = 0xf1;
export const MSG_PUNCH_PKT = 0x41;
export const MSG_P2P_RDY = 0x42;
export const MSG_P2P_RDY_ACK = 0x43;
export const MSG_DRW = 0xd0;
export const MSG_DRW_ACK = 0xd1;
export const MSG_ALIVE = 0xe0;
export const MSG_ALIVE_ACK = 0xe1;
export const PPPP_LAN_PORT = 32108;
export const DRW_MARKER = 0xd1;

export const LUMI_TYPE_LOGIN = 0x1000;
export const LUMI_TYPE_LOGIN_RESP = 0x1001;
export const LUMI_TYPE_SESSION_START = 0x1002;
export const LUMI_TYPE_SESSION_START_RESP = 0x1003;
export const LUMI_TYPE_KEYFRAME_REQ = 0x1018;
export const LUMI_TYPE_KEYFRAME_RESP = 0x1019;
export const LUMI_TYPE_STREAM_START = 0x101c;
export const LUMI_TYPE_STREAM_START_RESP = 0x101d;
export const LUMI_TYPE_QUALITY = 0x100e; // set video stream quality (live switch)
export const LUMI_TYPE_QUALITY_RESP = 0x100f; // quality change ack (changeStreamResolution 成功)

/**
 * 16-byte StartVideoCmdContent / SET_STREAM_INFO body.
 * Git 007650c (pre-talkback) used these bytes; 27db08b put JSON on 0x100E and
 * quality stuck on 360p. Firmware: 0x100E SET_STREAM_INFO, not 0x101C
 * (GET_RECORDLIST on ch3).
 *   u32le[0] channel=4
 *   u32le[1] videoStream: 0=1520p, 1=1080p, 2=Low/SD
 *   u32le[2] resolution=0 (highest)
 *   u32le[3] streamType=0 (live)
 */
export function buildStreamStartBody(
  channel = 4,
  videoStream = 0,
  streamType = 0,
): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(channel >>> 0, 0);
  b.writeUInt32LE(videoStream >>> 0, 4);
  b.writeUInt32LE(0, 8);
  b.writeUInt32LE(streamType >>> 0, 12);
  return b;
}

export type VideoStreamOption = {
  title: string;
  channel: number;
  minWidth: number;
};

/**
 * iOS `config_getVideoStreamTitleArrayWithDevice:` /
 * `config_getVideoStreamValueArrayWithDevice:`.
 * Live-confirmed: `{"channel":0}` is 360p (640x360). HD is a higher index.
 */
export function videoStreamLadder(model: string): VideoStreamOption[] {
  const m = (model || "").toLowerCase();
  if (m.includes("acn006")) {
    return [
      { title: "1296p", channel: 1, minWidth: 1200 },
      { title: "720p", channel: 2, minWidth: 700 },
      { title: "360p", channel: 0, minWidth: 0 },
    ];
  }
  if (m.includes("agl004") || m.includes("g5")) {
    return [
      { title: "1520p", channel: 1, minWidth: 1400 },
      { title: "1080p", channel: 2, minWidth: 1000 },
      { title: "360p", channel: 0, minWidth: 0 },
    ];
  }
  return [
    { title: "high", channel: 1, minWidth: 1200 },
    { title: "mid", channel: 2, minWidth: 700 },
    { title: "sd", channel: 0, minWidth: 0 },
  ];
}

export function pickMaxVideoStream(
  model: string,
  envOverride?: string,
): VideoStreamOption {
  const ladder = videoStreamLadder(model);
  if (envOverride === "0" || envOverride === "1" || envOverride === "2") {
    const ch = parseInt(envOverride, 10);
    return ladder.find((s) => s.channel === ch) || ladder[0];
  }
  return ladder[0];
}
export const LUMI_TYPE_KEEPALIVE = 0x1024;
export const LUMI_TYPE_KEEPALIVE_RESP = 0x1025;

// Audio (live mic + two-way talkback), see REPORT4 §4.3
export const LUMI_TYPE_AUDIO_START = 0x1004;
export const LUMI_TYPE_AUDIO_START_RESP = 0x1005;
export const LUMI_TYPE_AUDIO_SEND = 0x1006; // talkback (app -> camera)
export const LUMI_TYPE_AUDIO_SEND_RESP = 0x1007;
export const LUMI_TYPE_AUDIO_STOP = 0x1008;
// Two-way talkback (app -> camera speaker), captured at the Objective-C P2P API:
//   p2pSendCMD(0x100A, channel 0)                         startTalk
//   p2pSendFrame(ADTS AAC-LC 16 kHz mono, channel 2)       audio
//   p2pSendCMD(0x100C, channel 0)                         stopTalk
// These frames are already below Aqara's P2P-session encryption layer.  They are
// not AVIO frames and are not separately ChaCha20-encrypted.
export const LUMI_TYPE_TALKBACK_START = 0x100a;
export const LUMI_TYPE_TALKBACK_START_RESP = 0x100b;
export const LUMI_TYPE_TALKBACK_STOP = 0x100c; // confirmed via stopTalk bt
export const LUMI_TYPE_TALKBACK_GETFRAME = 0x1018; // confirmed via startGetFrameRequest bt

// The real Aqara Home app opens talkback by first sending a fixed 11-byte
// AAC-LC ADTS "lead" frame (captured via Frida):
//   ff f9 60 40 01 7f fc 00 d0 00 07
// Decoded it is AAC LC, 16000 Hz, mono, no CRC (7-byte ADTS header) with a
// 4-byte payload. The camera needs this frame to initialise its talk decoder;
// without it, audio is silently dropped. It is sent unchanged on P2P channel 2.
export const TALKBACK_LEAD_FRAME = Buffer.from([
  0xff, 0xf9, 0x60, 0x40, 0x01, 0x7f, 0xfc, 0x00, 0xd0, 0x00, 0x07,
]);

/**
 * Exact channel-2 body generated by Aqara Home's p2pSendFrame() after the
 * PPCS layer prepends its 32-byte media header.
 *
 * Official `/tmp/aqara_talk.pcap` (E1, decrypted with ppcsDecrypt):
 *   [0..28)  zeros
 *   [28..32) uint32LE(ADTS length)
 *   [32..  ) ADTS AAC-LC (starts 0xff 0xf9)
 *
 * The previous 36-byte layout put the length at offset 32 and ADTS at 36, so
 * the camera read length=0 from offset 28 and never handed the frame to the
 * speaker decoder — 0x100A/0x100B still succeeded.
 */
export function buildTalkbackPpcsBody(adts: Buffer): Buffer {
  const body = Buffer.alloc(32 + adts.length);
  body.writeUInt32LE(adts.length, 28);
  adts.copy(body, 32);
  return body;
}
// Pan / Tilt / Zoom
export const LUMI_TYPE_PTZ = 0x100e; // 0x100E = quality; PTZ is 0x100A but separate
// Note: talkback uses 0x100A (LUMI_TYPE_TALKBACK_START), PTZ must not collide
// Fixed by using JSON payload for PTZ to distinguish at camera
// Audio AVIO codec id on media channel
export const AVIO_AUDIO = 0x0088;
export const AVIO_VIDEO_H264 = 0x004e;
export const AVIO_VIDEO_HEVC = 0x004f;

/** True if `data[offset:]` starts with a video AVIO header (H264 0x004E / HEVC 0x004F). */
export function isAvioVideoHeader(data: Buffer, offset = 0): boolean {
  if (data.length < offset + 32) return false;
  const codec = data.readUInt16LE(offset);
  if (codec !== AVIO_VIDEO_H264 && codec !== AVIO_VIDEO_HEVC) return false;
  const flags = data.readUInt16LE(offset + 2);
  if (flags > 1) return false;
  const payloadLen = data.readUInt32LE(offset + 28);
  return payloadLen >= 16 && payloadLen <= 2_000_000;
}

/** First offset of a video AVIO header, or -1. Caps the scan so IDR NALs are not walked. */
export function findAvioOffset(data: Buffer): number {
  if (isAvioVideoHeader(data, 0)) return 0;
  const last = Math.min(Math.max(0, data.length - 32), 1536);
  for (let i = 1; i <= last; i++) {
    if (isAvioVideoHeader(data, i)) return i;
  }
  return -1;
}

/**
 * Pull every complete video AVIO frame off the front of a byte stream.
 * Channel-1 datagrams are 1024-byte PPCS payloads, not one-frame-per-packet:
 * the last datagram of an IDR often already contains the next P-frame header.
 * Returning that tail as `remainder` is what lets P-frames reach RTSP.
 */
export function splitAvioFrames(buf: Buffer): {
  frames: Buffer[];
  remainder: Buffer;
} {
  const frames: Buffer[] = [];
  let offset = 0;
  while (isAvioVideoHeader(buf, offset)) {
    const total = 32 + buf.readUInt32LE(offset + 28);
    if (total < 33 || total > 2_000_032) break;
    if (offset + total > buf.length) break;
    frames.push(buf.subarray(offset, offset + total));
    offset += total;
  }
  return { frames, remainder: buf.subarray(offset) };
}

export const PPCS_TABLE = Buffer.from(
  "7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc1" +
    "1fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a3" +
    "88ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb1" +
    "0e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af42" +
    "37d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479" +
    "d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7" +
    "336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c8" +
    "18e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17",
  "hex",
);

export const DEFAULT_CONFIG = {
  APP_ID: "444c476ef7135e53330f46e7",
  APP_KEY: "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi",
  BASE_URL: "https://aiot-rpc-usa.aqara.com",
  PPPP_LAN_PORT: 32108,
  RTSP_PORT: 8554,
} as const;

export const TUTK_MASTER_SERVERS = [
  "54.71.80.151",
  "54.214.103.243",
  "3.23.78.166",
];

// ============= Crypto & Packet Helpers =============

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

export function getLocalIpv4(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (
        iface.family === "IPv4" &&
        !iface.internal &&
        iface.address.startsWith("192.168.")
      ) {
        return iface.address;
      }
    }
  }
  return "192.168.5.191";
}

function stripV4Mapped(addr: string): string {
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/** All IPv4 addresses on this host, including loopback. */
let cachedLocalV4: Set<string> | null = null;
function localIPv4Set(): Set<string> {
  if (cachedLocalV4) return cachedLocalV4;
  const out = new Set<string>(["127.0.0.1", "0.0.0.0"]);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      if (iface.family === "IPv4") out.add(iface.address);
    }
  }
  cachedLocalV4 = out;
  return out;
}

export { slugifyStreamName } from "./slug.js";

function walkAnnexBNals(data: Buffer, fn: (nal: Buffer) => void): void {
  if (!data || data.length < 4) return;
  const len = data.length;
  let i = 0;
  while (i < len - 3) {
    let prefixLen = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) prefixLen = 3;
    else if (
      i + 3 < len &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    )
      prefixLen = 4;
    if (prefixLen === 0) {
      i++;
      continue;
    }
    const nalStart = i + prefixLen;
    let next = len;
    for (let j = nalStart; j < len - 3; j++) {
      if (
        data[j] === 0 &&
        data[j + 1] === 0 &&
        (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1))
      ) {
        next = j;
        break;
      }
    }
    if (next > nalStart) fn(data.subarray(nalStart, next));
    i = next;
  }
}

export function isAnnexBKeyframe(data: Buffer, isHevc: boolean): boolean {
  if (!data || data.length < 5) return false;
  const len = data.length;
  let i = 0;
  while (i < len - 4) {
    let prefixLen = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) prefixLen = 3;
    else if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    )
      prefixLen = 4;
    if (prefixLen === 0) {
      i++;
      continue;
    }
    const nalByte = data[i + prefixLen];
    if (isHevc) {
      const t = (nalByte >> 1) & 0x3f;
      if (t === 19 || t === 20 || t === 21) return true;
    } else {
      const t = nalByte & 0x1f;
      if (t === 5) return true;
    }
    i += prefixLen + 1;
  }
  return false;
}

export function ppcsEncrypt(key: Buffer, data: Buffer): Buffer {
  if (!key || !data || !key.length || !data.length) return data;
  const key20 = key.subarray(0, 20);
  let total = 0;
  let sx = 0;
  let s3 = 0;
  for (const b of key20) {
    total += b;
    sx ^= b;
    s3 += Math.floor((b * 0xab) / 512);
  }
  const seeds = [total & 0xff, -total & 0xff, s3 & 0xff, sx & 0xff];
  const out = Buffer.alloc(data.length);
  out[0] = PPCS_TABLE[seeds[0]] ^ data[0];
  let fb = out[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i];
    fb = out[i];
  }
  return out;
}

export function ppcsDecrypt(key: Buffer, data: Buffer): Buffer {
  if (!key || !data || !key.length || !data.length) return data;
  const key20 = key.subarray(0, 20);
  let total = 0;
  let sx = 0;
  let s3 = 0;
  for (const b of key20) {
    total += b;
    sx ^= b;
    s3 += Math.floor((b * 0xab) / 512);
  }
  const seeds = [total & 0xff, -total & 0xff, s3 & 0xff, sx & 0xff];
  const out = Buffer.alloc(data.length);
  out[0] = PPCS_TABLE[seeds[0]] ^ data[0];
  let fb = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i];
    fb = data[i];
  }
  return out;
}

export function buildPPPP(
  msgType: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(payload.length, 0);
  return Buffer.concat([Buffer.from([PPCS_MAGIC, msgType]), lenBuf, payload]);
}

export function punchPayload(p2pId: string): Buffer {
  const [pre, num, suf] = p2pId.split("-");
  const b = Buffer.alloc(20);
  b.write(pre || "", 0, "ascii");
  b[7] = 0;
  b[8] = 0;
  const n = parseInt(num || "0", 10);
  b[9] = (n >> 16) & 0xff;
  b[10] = (n >> 8) & 0xff;
  b[11] = n & 0xff;
  b.write(suf || "", 12, "ascii");
  return b;
}

export function buildLumiFrame(
  type: number,
  payload: Buffer,
  seq: number = 1,
): Buffer {
  const f = Buffer.alloc(16);
  f.write("lumi", 0, "ascii");
  f.writeUInt32LE(type, 4);
  f.writeUInt32LE(seq, 8);
  f.writeUInt32LE(payload.length, 12);
  return Buffer.concat([f, payload]);
}

// ============= RTSP Server Implementation =============

/** Valid AAC-LC 16 kHz mono silent AU (raw, no ADTS) from ffmpeg anullsrc. */
const SILENT_AAC_RAW = Buffer.from([0x01, 0x18, 0x20, 0x07]);

function ntpTimestamp(): { sec: number; frac: number } {
  const unixMs = Date.now();
  const unixSec = Math.floor(unixMs / 1000);
  const ntpSec = (unixSec + 2208988800) >>> 0;
  const frac = Math.round(((unixMs % 1000) / 1000) * 0x100000000) >>> 0;
  return { sec: ntpSec, frac };
}

interface RtspClient {
  socket: net.Socket;
  session: string;
  isPlaying: boolean;
  receivedKeyframe: boolean;
  cseq: number;
  videoChannel?: number;
  audioChannel?: number;
  transport: "tcp" | "udp";
  udpAddr?: string;
  videoRtpPort?: number;
  audioRtpPort?: number;
  firstRtpLogged?: boolean;
  /** True after PLAY media (IDR/AAC) has been pushed. */
  mediaPumped?: boolean;
}

export class RtspServer extends EventEmitter {
  private server: net.Server | null = null;
  private rtpUdp: dgram.Socket | null = null;
  private rtpUdp6: dgram.Socket | null = null;
  private rtpUdpPort: number = 0;
  private port: number;
  private did: string;
  private clients: Set<RtspClient> = new Set();
  private rtpSeq: number = 1 + Math.floor(Math.random() * 0xfffe);
  private rtpSsrc: number = Math.floor(Math.random() * 0xffffffff);
  private videoRtpTimestamp: number =
    1 + Math.floor(Math.random() * 0x0fffffff);
  private lastVideoSendAt: number = 0;
  private audioRtpSeq: number = 1 + Math.floor(Math.random() * 0xfffe);
  private audioRtpSsrc: number = Math.floor(Math.random() * 0xffffffff);
  private audioRtpTimestamp: number =
    1 + Math.floor(Math.random() * 0x0fffffff);
  private baseWallClock: number = 0;

  // ── Jitter / Pacing buffer ──────────────────────────────────────────────
  // Video frames arrive in bursts over UDP; we drain them at a smooth rate
  // so VLC / RTSP clients never see back-to-back frames with near-zero gap.
  private videoQueue: Buffer[] = [];
  private videoPacer: NodeJS.Timeout | null = null;
  // Target drain interval in ms.  30 fps → 33 ms; 20 fps → 50 ms.
  // We use 33 ms as a safe default; the pacer naturally skips ticks when
  // no frames are queued.
  private readonly PACER_INTERVAL_MS = 33;
  // Maximum queue depth before we start dropping the oldest P-frames to
  // prevent unbounded latency accumulation.
  private readonly MAX_QUEUE_DEPTH = 6;

  public isHevc: boolean = false;
  /** Incoming camera mic: AAC-ADTS or G.711 A-law. Detected from the first frame. */
  public audioMode: "aac" | "pcma" = "aac";
  public vps: Buffer | null = null;
  public sps: Buffer | null = null;
  public pps: Buffer | null = null;
  public lastKeyframe: Buffer | null = null;
  /** Last camera-mic ADTS frame, replayed on PLAY so the audio track is live. */
  public lastAudio: Buffer | null = null;
  private rtcpTimer: NodeJS.Timeout | null = null;
  private videoPktCount = 0;
  private videoOctetCount = 0;
  private audioPktCount = 0;
  private audioOctetCount = 0;
  private gopCache: Buffer[] = [];
  // DESCRIBE requests that arrived before SPS/PPS were known are held here
  private pendingDescribes: Array<{
    socket: net.Socket;
    cseq: number | string;
  }> = [];

  /** Call after SPS/PPS are set to flush any pending DESCRIBE responses. */
  public flushPendingDescribes(): void {
    while (this.pendingDescribes.length > 0) {
      const { socket, cseq } = this.pendingDescribes.shift()!;
      this.sendDescribeResponse(socket, cseq);
    }
  }

  private sendDescribeResponse(
    socket: net.Socket,
    cseq: number | string,
    requestUrl?: string,
  ): void {
    const rawUrl = (requestUrl || `rtsp://0.0.0.0:${this.port}/`).split("?")[0];
    const contentBase = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
    let videoSdp = "";
    if (this.isHevc) {
      let fmtp = "a=fmtp:96";
      const props: string[] = [];
      if (this.vps) props.push(`sprop-vps=${this.vps.toString("base64")}`);
      if (this.sps) props.push(`sprop-sps=${this.sps.toString("base64")}`);
      if (this.pps) props.push(`sprop-pps=${this.pps.toString("base64")}`);
      if (props.length) fmtp += " " + props.join(";");
      videoSdp =
        `m=video 0 RTP/AVP 96\r\n` +
        `a=rtpmap:96 H265/90000\r\n` +
        (props.length ? `${fmtp}\r\n` : "") +
        `a=control:track0\r\n`;
    } else {
      let fmtpLine = "a=fmtp:96 packetization-mode=1";
      if (this.sps && this.sps.length >= 4) {
        fmtpLine += `;profile-level-id=${this.sps.subarray(1, 4).toString("hex")}`;
      }
      if (this.sps && this.pps) {
        fmtpLine += `;sprop-parameter-sets=${this.sps.toString("base64")},${this.pps.toString("base64")}`;
      }
      videoSdp =
        `m=video 0 RTP/AVP 96\r\n` +
        `a=rtpmap:96 H264/90000\r\n` +
        `${fmtpLine}\r\n` +
        `a=control:track0\r\n`;
    }

    const audioSdp =
      this.audioMode === "pcma"
        ? `m=audio 0 RTP/AVP 8\r\n` +
          `a=rtpmap:8 PCMA/8000/1\r\n` +
          `a=control:track1\r\n`
        : `m=audio 0 RTP/AVP 97\r\n` +
          `a=rtpmap:97 MPEG4-GENERIC/16000/1\r\n` +
          `a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;config=1408;sizelength=13;indexlength=3;indexdeltalength=3\r\n` +
          `a=control:track1\r\n`;

    const sdp =
      `v=0\r\n` +
      `o=- ${Date.now()} 1 IN IP4 0.0.0.0\r\n` +
      `s=Aqara Camera (${this.did})\r\n` +
      `c=IN IP4 0.0.0.0\r\n` +
      `t=0 0\r\n` +
      `a=control:*\r\n` +
      `a=range:npt=now-\r\n` +
      `a=recvonly\r\n` +
      videoSdp +
      audioSdp;

    const response =
      `RTSP/1.0 200 OK\r\n` +
      `CSeq: ${cseq}\r\n` +
      `Content-Type: application/sdp\r\n` +
      `Content-Base: ${contentBase}\r\n` +
      `Content-Length: ${Buffer.byteLength(sdp)}\r\n\r\n` +
      sdp;
    try {
      socket.write(response);
    } catch {}
  }

  constructor(port: number, did: string) {
    super();
    this.port = port;
    this.did = did;
    // Codec is taken from the first AVIO frame (0x004E H264 / 0x004F HEVC).
    // The G5 Pro DID used to force HEVC, but live AVIO is 0x004E H264 — SDP
    // said H265, players got H264, and no picture appeared.
  }

  /** The port the server actually bound to (may differ if the desired port was taken). */
  public get listenPort(): number {
    return this.port;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleClient(socket);
      });

      let attempt = 0;
      const tryListen = () => {
        this.server!.listen(this.port, () => {
          this.rtpUdp = dgram.createSocket("udp4");
          this.rtpUdp6 = dgram.createSocket("udp6");
          this.rtpUdp.on("error", (e) =>
            console.warn(`[RTSP] UDP4 error: ${e.message}`),
          );
          this.rtpUdp6.on("error", () => {});
          let started = false;
          const finishStart = () => {
            if (started) return;
            started = true;
            try {
              this.rtpUdp6!.bind(0);
            } catch {}
            this.emit("listening", this.port);
            this.startVideoPacer();
            this.startRtcp();
            resolve();
          };
          this.rtpUdp.once("error", () => finishStart());
          this.rtpUdp.bind(0, () => {
            try {
              const addr = this.rtpUdp!.address();
              this.rtpUdpPort = typeof addr === "object" ? addr.port : 0;
            } catch {
              this.rtpUdpPort = 0;
            }
            finishStart();
          });
        });
      };

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < 64) {
          // Preferred port is taken — step to the next allowed port and retry,
          // so the server still comes up on a free sequential port.
          attempt++;
          do {
            this.port = this.port + 1;
          } while (!isPortAllowed(this.port));
          this.emit(
            "warn",
            `RTSP port ${this.port - 1} in use, retrying on ${this.port}`,
          );
          tryListen();
          return;
        }
        this.emit("error", err);
        reject(err);
      });

      tryListen();
    });
  }

  /** Start the video pacing timer (idempotent). */
  private startVideoPacer(): void {
    if (this.videoPacer) return;
    this.videoPacer = setInterval(() => {
      if (this.videoQueue.length === 0) return;
      // Backlog: skip to the next IDR. Never drop a P-frame and then send a
      // later P-frame that still references it — that is the motion pixelation.
      if (this.videoQueue.length > 45) {
        while (
          this.videoQueue.length > 1 &&
          !this.frameIsKeyframe(this.videoQueue[0])
        ) {
          this.videoQueue.shift();
        }
      }
      const drain = this.videoQueue.length > 8 ? 2 : 1;
      for (let i = 0; i < drain && this.videoQueue.length > 0; i++) {
        const frame = this.videoQueue.shift();
        if (frame) this.sendFrameNow(frame);
      }
    }, this.PACER_INTERVAL_MS);
  }

  /** Stop and clean up the video pacer. */
  public stopVideoPacer(): void {
    if (this.videoPacer) {
      clearInterval(this.videoPacer);
      this.videoPacer = null;
    }
    this.videoQueue.length = 0;
  }

  private startRtcp(): void {
    if (this.rtcpTimer) return;
    this.rtcpTimer = setInterval(() => {
      for (const c of this.clients) {
        if (c.isPlaying && !c.socket.destroyed) this.sendRtcpForClient(c);
      }
    }, 1000);
  }

  private stopRtcp(): void {
    if (this.rtcpTimer) {
      clearInterval(this.rtcpTimer);
      this.rtcpTimer = null;
    }
  }

  private handleClient(socket: net.Socket): void {
    const client: RtspClient = {
      socket,
      session: crypto.randomBytes(4).toString("hex"),
      isPlaying: false,
      receivedKeyframe: false,
      cseq: 1,
      transport: "tcp",
    };
    this.clients.add(client);
    try {
      socket.setNoDelay(true);
    } catch {}

    let buf = Buffer.alloc(0);

    socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);

      while (buf.length > 0) {
        // Handle interleaved binary data (e.g. client RTCP packets starting with '$')
        if (buf[0] === 0x24) {
          if (buf.length < 4) break;
          const pktLen = buf.readUInt16BE(2);
          if (buf.length < 4 + pktLen) break;
          buf = buf.subarray(4 + pktLen);
          continue;
        }

        // Search for RTSP header boundary (\r\n\r\n)
        const idx = buf.indexOf(Buffer.from("\r\n\r\n"));
        if (idx === -1) {
          // If buffer starts with unknown non-ascii data, discard leading byte
          if (buf[0] < 0x20 || buf[0] > 0x7e) {
            buf = buf.subarray(1);
            continue;
          }
          break;
        }

        const reqStr = buf.subarray(0, idx).toString("utf8");
        buf = buf.subarray(idx + 4);
        if (reqStr.trim().length > 0) {
          this.handleRtspRequest(client, reqStr);
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(client);
    });

    socket.on("error", () => {
      this.clients.delete(client);
    });
  }

  /**
   * Push the cached IDR (and audio) after PLAY. Idempotent: VLC also calls
   * GET_PARAMETER once interleaved mode is on — we must not dump the IDR twice.
   * No cork: a 200-packet corked IDR arrives as one giant TCP blob and Live555
   * often drops it. Audio is not sent without video; that starts VLC's clock
   * on a silent track and it disconnects before the picture.
   */
  private pumpPlayMedia(client: RtspClient): void {
    if (!client.isPlaying || client.socket.destroyed || client.mediaPumped)
      return;
    if (!this.lastKeyframe || !this.lastKeyframe.length) {
      client.receivedKeyframe = false;
      console.log("[RTSP] PLAY with no cached IDR yet — waiting for camera");
      return;
    }
    client.mediaPumped = true;
    client.receivedKeyframe = true;
    console.log(
      `[RTSP] PLAY replay keyframe ${this.lastKeyframe.length}B ${client.transport}`,
    );
    const beforePkts = this.videoPktCount;
    this.sendFrameNow(this.lastKeyframe, client);
    console.log(
      `[RTSP] PLAY sent ${this.videoPktCount - beforePkts} video RTP packets`,
    );
    if (this.lastAudio && this.lastAudio.length) {
      this.broadcastAudio(this.lastAudio, undefined, client);
    } else {
      this.sendSingleAacFrame(SILENT_AAC_RAW, undefined, client);
    }
  }

  private handleRtspRequest(client: RtspClient, req: string): void {
    const lines = req.split("\r\n");
    const firstLine = lines[0] || "";
    const [method, url] = firstLine.split(" ");
    if (process.env.DEBUG) console.log(`[RTSP REQ] ${method} ${url || ""}`);

    const cseqLine = lines.find((l) => l.toLowerCase().startsWith("cseq:"));
    const cseq = cseqLine
      ? parseInt(cseqLine.split(":")[1].trim(), 10)
      : client.cseq;

    switch (method) {
      case "OPTIONS": {
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case "GET_PARAMETER":
      case "SET_PARAMETER": {
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        // VLC sends GET_PARAMETER once Live555 is in interleaved mode.
        // That's the safest moment to start RTP if PLAY media was deferred.
        if (client.isPlaying) this.pumpPlayMedia(client);
        break;
      }

      case "DESCRIBE": {
        // Never stall the handshake. VLC pipelines SETUP behind DESCRIBE; a
        // 2s hold made it process SETUP/PLAY first, then drop the session.
        this.sendDescribeResponse(client.socket, cseq, url);
        this.emit("need_keyframe");
        break;
      }

      case "SETUP": {
        const isAudioTrack = (url || "").includes("track1");
        const defaultInterleaved = isAudioTrack ? "2-3" : "0-1";

        const transportLine =
          lines.find((l) => l.toLowerCase().startsWith("transport:")) || "";
        const transportVal = transportLine.split(":")[1]?.trim() || "";

        let chosenChannel = isAudioTrack ? 2 : 0;
        let transportHeader = `RTP/AVP/TCP;unicast;interleaved=${defaultInterleaved}`;
        const interleavedMatch = transportVal.match(
          /interleaved=([0-9]+)-[0-9]+/,
        );
        const clientPortMatch = transportVal.match(
          /client_port=([0-9]+)-([0-9]+)/,
        );
        const wantsTcp =
          /RTP\/AVP\/TCP/i.test(transportVal) || !!interleavedMatch;

        if (wantsTcp && interleavedMatch) {
          chosenChannel = parseInt(interleavedMatch[1], 10);
          transportHeader = `RTP/AVP/TCP;unicast;interleaved=${interleavedMatch[1]}-${chosenChannel + 1}`;
          client.transport = "tcp";
        } else if (clientPortMatch && !wantsTcp) {
          const rtpPort = parseInt(clientPortMatch[1], 10);
          const rtcpPort = parseInt(clientPortMatch[2], 10);
          const remote = stripV4Mapped(
            client.socket.remoteAddress || "127.0.0.1",
          );
          // Same-host VLC/ffplay (LAN IP or loopback): UDP hairpins out the
          // NIC and never reaches the player's socket. Returning 200 with a
          // TCP Transport while they asked for UDP leaves them waiting on
          // UDP — 461 makes VLC retry interleaved TCP, which we know works.
          if (localIPv4Set().has(remote)) {
            console.log(
              `[RTSP] SETUP ${isAudioTrack ? "audio" : "video"} udp ${remote}:${rtpPort} -> 461 (retry TCP)`,
            );
            client.socket.write(
              `RTSP/1.0 461 Unsupported Transport\r\n` +
                `CSeq: ${cseq}\r\n\r\n`,
            );
            break;
          }
          client.udpAddr = remote;
          client.transport = "udp";
          if (isAudioTrack) client.audioRtpPort = rtpPort;
          else client.videoRtpPort = rtpPort;
          const srv = this.rtpUdpPort || 0;
          const src = stripV4Mapped(
            client.socket.localAddress || getLocalIpv4(),
          );
          transportHeader =
            `RTP/AVP;unicast;destination=${remote};source=${src}` +
            `;client_port=${rtpPort}-${rtcpPort}` +
            `;server_port=${srv}-${srv ? srv + 1 : 1}`;
        } else {
          client.transport = "tcp";
        }
        console.log(
          `[RTSP] SETUP ${isAudioTrack ? "audio" : "video"} ${client.transport}` +
            (client.transport === "udp"
              ? ` ${client.udpAddr}:${isAudioTrack ? client.audioRtpPort : client.videoRtpPort}`
              : ` interleaved=${chosenChannel}-${chosenChannel + 1}`),
        );

        if (isAudioTrack) {
          client.audioChannel = chosenChannel;
        } else {
          client.videoChannel = chosenChannel;
        }

        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Transport: ${transportHeader}\r\n` +
          `Session: ${client.session};timeout=60\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case "PLAY": {
        client.isPlaying = true;
        const rawUrl = (url || `rtsp://0.0.0.0:${this.port}/`).split("?")[0];
        const contentBase = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
        const vSeq = this.rtpSeq & 0xffff;
        const aSeq = this.audioRtpSeq & 0xffff;
        const vTs = this.videoRtpTimestamp >>> 0;
        const aTs = this.audioRtpTimestamp >>> 0;
        const rtpInfo =
          `url=${contentBase}track0;seq=${vSeq};rtptime=${vTs}` +
          `,url=${contentBase}track1;seq=${aSeq};rtptime=${aTs}`;
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n` +
          `Cache-Control: no-cache\r\n` +
          `Range: npt=0.000-\r\n` +
          `RTP-Info: ${rtpInfo}\r\n\r\n`;

        client.mediaPumped = false;
        if (client.socket instanceof net.Socket) {
          client.socket.write(response, () => {
            setTimeout(() => this.pumpPlayMedia(client), 100);
          });
        } else {
          client.socket.write(response);
          this.pumpPlayMedia(client);
        }
        this.emit("need_keyframe");
        break;
      }

      case "PAUSE": {
        client.isPlaying = false;
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case "TEARDOWN": {
        client.isPlaying = false;
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        client.socket.end();
        break;
      }
    }
  }

  /**
   * Broadcast audio frame (AAC MPEG4-GENERIC) as RFC 3640 compliant RTP packets.
   *
   * AAC LC at 16000 Hz always has exactly 1024 samples per frame.
   * RFC 3640 §4.1: RTP timestamp MUST increment by the number of audio samples
   * contained in the AU — NOT by wall-clock elapsed time.
   * Using wall-clock (Date.now()) causes the "saw wave" jitter because system
   * timer resolution is coarser than the 64ms AAC frame interval.
   */
  public broadcastAudio(
    audioData: Buffer,
    timestampMs?: number,
    targetClient?: RtspClient,
  ): void {
    if (!audioData.length) return;
    this.lastAudio = Buffer.from(audioData);
    if (!targetClient && this.clients.size === 0) return;

    let offset = 0;
    for (let i = 0; i + 7 <= audioData.length; i++) {
      if (audioData[i] === 0xff && (audioData[i + 1] & 0xf0) === 0xf0) {
        offset = i;
        break;
      }
    }
    const isAdts =
      audioData.length - offset >= 7 &&
      audioData[offset] === 0xff &&
      (audioData[offset + 1] & 0xf0) === 0xf0;

    if (!isAdts) {
      // SDP advertises AAC. Don't flip the session to PCMA mid-play.
      return;
    }

    this.audioMode = "aac";
    let frameCount = 0;

    while (offset < audioData.length) {
      const remaining = audioData.subarray(offset);
      if (
        remaining.length >= 7 &&
        remaining[0] === 0xff &&
        (remaining[1] & 0xf0) === 0xf0
      ) {
        const hasCrc = (remaining[1] & 0x01) === 0;
        const hdrLen = hasCrc ? 9 : 7;
        const adtsLen =
          ((remaining[3] & 0x03) << 11) |
          (remaining[4] << 3) |
          ((remaining[5] & 0xe0) >> 5);
        if (adtsLen <= hdrLen || adtsLen > remaining.length) {
          break;
        }
        const rawAac = remaining.subarray(hdrLen, adtsLen);
        this.sendSingleAacFrame(
          rawAac,
          frameCount === 0 ? timestampMs : undefined,
          targetClient,
        );
        offset += adtsLen;
        frameCount++;
      } else {
        if (frameCount === 0) {
          this.sendSingleAacFrame(audioData, timestampMs, targetClient);
        }
        break;
      }
    }
  }

  private sendPcmaFrame(pcma: Buffer): void {
    if (!pcma.length) return;
    // G.711 A-law: 1 byte = 1 sample, 8000 Hz. Observed 20 ms packets = 160 bytes.
    this.audioRtpTimestamp = (this.audioRtpTimestamp + pcma.length) >>> 0;
    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 0x80 | 8;
    rtpHeader.writeUInt16BE(this.audioRtpSeq++ & 0xffff, 2);
    rtpHeader.writeUInt32BE(this.audioRtpTimestamp, 4);
    rtpHeader.writeUInt32BE(this.audioRtpSsrc, 8);
    this.sendInterleavedRtp(2, Buffer.concat([rtpHeader, pcma]));
  }

  private sendSingleAacFrame(
    rawAac: Buffer,
    timestampMs?: number,
    targetClient?: RtspClient,
  ): void {
    if (!rawAac.length) return;

    // AAC LC: 1024 samples/frame at 16 kHz. Do not resync to wall clock —
    // that produced audible dropouts whenever a UDP burst drifted >200 ms.
    if (typeof timestampMs === "number" && timestampMs > 0) {
      this.audioRtpTimestamp =
        Math.floor((timestampMs * 16) % 0xffffffff) >>> 0;
    }
    const rtpTimestamp = this.audioRtpTimestamp >>> 0;
    this.audioRtpTimestamp = (this.audioRtpTimestamp + 1024) >>> 0;

    // RFC 3640 AAC-hbr packet format:
    // [0..1] AU-headers-length = 16 bits (number of bits in the AU-header section)
    // [2..3] AU-header = (auSize << 3) | index (index=0 for single AU)
    // [4..]  Raw AAC frame data
    const auLen = rawAac.length;
    const auHdrBuf = Buffer.alloc(4);
    auHdrBuf.writeUInt16BE(16, 0); // AU-headers-length: 16 bits
    auHdrBuf.writeUInt16BE((auLen << 3) & 0xffff, 2); // AU-header: size+index

    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 0x80 | 97; // Marker bit set, payload type 97
    rtpHeader.writeUInt16BE(this.audioRtpSeq++ & 0xffff, 2);
    rtpHeader.writeUInt32BE(rtpTimestamp, 4);
    rtpHeader.writeUInt32BE(this.audioRtpSsrc, 8);

    this.sendInterleavedRtp(
      2,
      Buffer.concat([rtpHeader, auHdrBuf, rawAac]),
      targetClient,
    );
  }

  /**
   * Enqueue a video frame for smooth, paced delivery to RTSP clients.
   *
   * Frames arrive from the camera in UDP bursts.  Without pacing, a burst of
   * 5 P-frames at once causes VLC's clock to jump (all arrive within ~1 ms),
   * then freeze for the inter-burst gap.  We place frames in a small queue and
   * drain them at a steady 33 ms interval via the pacing timer.
   *
   * If the queue grows beyond ~1.5s the pacer skips to the next IDR instead of
   * dropping isolated P-frames (which pixelate on motion).
   */
  public broadcastFrame(
    frameData: Buffer,
    _timestampMs?: number,
    targetClient?: RtspClient,
  ): void {
    if (!frameData.length) return;
    // Direct send for single-client targeted frames or if pacer is not active
    if (targetClient || !this.videoPacer) {
      this.sendFrameNow(frameData, targetClient);
      return;
    }
    this.videoQueue.push(frameData);
  }

  /** Check whether an Annex-B frame buffer starts with a keyframe NAL. */
  private frameIsKeyframe(frameData: Buffer): boolean {
    let i = 0;
    const len = frameData.length;
    while (i < len - 4) {
      let prefixLen = 0;
      if (
        frameData[i] === 0 &&
        frameData[i + 1] === 0 &&
        frameData[i + 2] === 1
      )
        prefixLen = 3;
      else if (
        frameData[i] === 0 &&
        frameData[i + 1] === 0 &&
        frameData[i + 2] === 0 &&
        frameData[i + 3] === 1
      )
        prefixLen = 4;
      if (prefixLen === 0) {
        i++;
        continue;
      }
      const nalByte = frameData[i + prefixLen];
      if (this.isHevc) {
        const t = (nalByte >> 1) & 0x3f;
        if (
          t === 19 ||
          t === 20 ||
          t === 21 ||
          t === 32 ||
          t === 33 ||
          t === 34
        )
          return true;
      } else {
        const t = nalByte & 0x1f;
        if (t === 5 || t === 7 || t === 8) return true;
      }
      i += prefixLen + 1;
    }
    return false;
  }

  /**
   * Internal: immediately transmit a video frame as RFC 6184 / RFC 7798 RTP packets.
   * Called by the pacing timer or directly for targeted single-client sends.
   */
  public sendFrameNow(frameData: Buffer, targetClient?: RtspClient): void {
    if (!frameData.length) return;

    // Split frame into NAL units (Annex B format)
    const nalUnits: Buffer[] = [];
    let start = 0;
    const len = frameData.length;

    while (start < len) {
      let prefixLen = 0;
      if (
        start + 3 <= len &&
        frameData[start] === 0 &&
        frameData[start + 1] === 0 &&
        frameData[start + 2] === 1
      ) {
        prefixLen = 3;
      } else if (
        start + 4 <= len &&
        frameData[start] === 0 &&
        frameData[start + 1] === 0 &&
        frameData[start + 2] === 0 &&
        frameData[start + 3] === 1
      ) {
        prefixLen = 4;
      }

      if (prefixLen > 0) {
        const nalStart = start + prefixLen;
        let nextStart = len;
        for (let i = nalStart; i < len - 3; i++) {
          if (
            frameData[i] === 0 &&
            frameData[i + 1] === 0 &&
            (frameData[i + 2] === 1 ||
              (frameData[i + 2] === 0 && frameData[i + 3] === 1))
          ) {
            nextStart = i;
            break;
          }
        }
        if (nextStart > nalStart) {
          const rawNal = frameData.subarray(nalStart, nextStart);
          if (rawNal.length > 0) {
            if (this.isHevc) {
              const nalType = (rawNal[0] >> 1) & 0x3f;
              if (nalType <= 40) nalUnits.push(rawNal);
            } else {
              const nalType = rawNal[0] & 0x1f;
              if (nalType >= 1 && nalType <= 19) nalUnits.push(rawNal);
            }
          }
        }
        start = nextStart;
      } else {
        start++;
      }
    }

    if (nalUnits.length === 0 && frameData.length > 0) {
      let payload = frameData;
      if (
        payload.length >= 4 &&
        payload[0] === 0 &&
        payload[1] === 0 &&
        payload[2] === 0 &&
        payload[3] === 1
      ) {
        payload = payload.subarray(4);
      } else if (
        payload.length >= 3 &&
        payload[0] === 0 &&
        payload[1] === 0 &&
        payload[2] === 1
      ) {
        payload = payload.subarray(3);
      }
      if (payload.length) nalUnits.push(payload);
    }

    let isKeyframe = false;
    let hasSps = false;
    let hasPps = false;
    let hasVps = false;
    for (const nal of nalUnits) {
      if (!nal || !nal.length) continue;
      if (this.isHevc) {
        const nalType = (nal[0] >> 1) & 0x3f;
        if (nalType === 32) {
          this.vps = Buffer.from(nal);
          hasVps = true;
        }
        if (nalType === 33) {
          this.sps = Buffer.from(nal);
          hasSps = true;
        }
        if (nalType === 34) {
          this.pps = Buffer.from(nal);
          hasPps = true;
        }
        if (nalType === 19 || nalType === 20 || nalType === 21)
          isKeyframe = true;
      } else {
        const nalType = nal[0] & 0x1f;
        if (nalType === 7) {
          this.sps = Buffer.from(nal);
          hasSps = true;
        }
        if (nalType === 8) {
          this.pps = Buffer.from(nal);
          hasPps = true;
        }
        if (nalType === 5) isKeyframe = true;
      }
    }

    // In-band parameter set injection: ensure SPS/PPS (and VPS for HEVC) always precede every IDR keyframe
    if (isKeyframe) {
      if (this.isHevc) {
        const missing: Buffer[] = [];
        if (!hasVps && this.vps) missing.push(this.vps);
        if (!hasSps && this.sps) missing.push(this.sps);
        if (!hasPps && this.pps) missing.push(this.pps);
        if (missing.length > 0) nalUnits.unshift(...missing);
      } else {
        const missing: Buffer[] = [];
        if (!hasSps && this.sps) missing.push(this.sps);
        if (!hasPps && this.pps) missing.push(this.pps);
        if (missing.length > 0) nalUnits.unshift(...missing);
      }
      this.lastKeyframe = frameData;
      this.gopCache = [frameData];
      if (targetClient) {
        targetClient.receivedKeyframe = true;
      } else {
        for (const c of this.clients) {
          if (c.isPlaying) c.receivedKeyframe = true;
        }
      }
    } else if (this.gopCache.length > 0 && this.gopCache.length < 30) {
      this.gopCache.push(frameData);
    }

    // Once we have codec parameters, flush any DESCRIBE responses that were
    // held pending the first keyframe.
    const hasParams = this.isHevc
      ? this.vps && this.sps && this.pps
      : this.sps && this.pps;
    if (hasParams && this.pendingDescribes.length > 0) {
      this.flushPendingDescribes();
    }

    // 90 kHz clock from real inter-frame time so VLC's A/V sync matches the
    // camera instead of a fake 30 fps. Clamp so a hitch does not freeze the
    // timeline, and a catch-up drain does not compress it to zero.
    // PLAY replay keeps the advertised RTP-Info timestamp.
    let rtpTimestamp: number;
    if (targetClient) {
      rtpTimestamp = this.videoRtpTimestamp >>> 0;
      this.lastVideoSendAt = Date.now();
    } else {
      const now = Date.now();
      let deltaMs = this.lastVideoSendAt ? now - this.lastVideoSendAt : 33;
      if (deltaMs < 20) deltaMs = 20;
      if (deltaMs > 80) deltaMs = 33;
      this.lastVideoSendAt = now;
      rtpTimestamp = (this.videoRtpTimestamp + Math.round(deltaMs * 90)) >>> 0;
      this.videoRtpTimestamp = rtpTimestamp;
    }
    const MAX_PAYLOAD_SIZE = 1380;

    for (let n = 0; n < nalUnits.length; n++) {
      const nal = nalUnits[n];
      if (!nal || !nal.length) continue;
      const isLastNal = n === nalUnits.length - 1;

      if (nal.length <= MAX_PAYLOAD_SIZE) {
        const rtpHeader = Buffer.alloc(12);
        rtpHeader[0] = 0x80;
        rtpHeader[1] = (isLastNal ? 0x80 : 0x00) | 96;
        rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xffff, 2);
        rtpHeader.writeUInt32BE(rtpTimestamp, 4);
        rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

        this.sendInterleavedRtp(
          0,
          Buffer.concat([rtpHeader, nal]),
          targetClient,
        );
      } else if (this.isHevc) {
        // RFC 7798 H.265 Fragmentation Unit (FU)
        const nalType = (nal[0] >> 1) & 0x3f;
        const payloadHdr1 = (nal[0] & 0x81) | (49 << 1); // FU type 49
        const payloadHdr2 = nal[1];
        let offset = 2;

        while (offset < nal.length) {
          const chunkLen = Math.min(MAX_PAYLOAD_SIZE, nal.length - offset);
          const isStart = offset === 2;
          const isEnd = offset + chunkLen >= nal.length;

          const rtpHeader = Buffer.alloc(12);
          rtpHeader[0] = 0x80;
          rtpHeader[1] = (isLastNal && isEnd ? 0x80 : 0x00) | 96;
          rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xffff, 2);
          rtpHeader.writeUInt32BE(rtpTimestamp, 4);
          rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

          let fuHeader = nalType;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const fuPayloadHdr = Buffer.from([
            payloadHdr1,
            payloadHdr2,
            fuHeader,
          ]);
          const payloadChunk = nal.subarray(offset, offset + chunkLen);

          this.sendInterleavedRtp(
            0,
            Buffer.concat([rtpHeader, fuPayloadHdr, payloadChunk]),
            targetClient,
          );
          offset += chunkLen;
        }
      } else {
        // RFC 6184 H.264 FU-A Fragmentation
        const nalHeader = nal[0];
        const nalType = nalHeader & 0x1f;
        const nalNri = nalHeader & 0x60;
        let offset = 1;

        while (offset < nal.length) {
          const chunkLen = Math.min(MAX_PAYLOAD_SIZE, nal.length - offset);
          const isStart = offset === 1;
          const isEnd = offset + chunkLen >= nal.length;

          const rtpHeader = Buffer.alloc(12);
          rtpHeader[0] = 0x80;
          rtpHeader[1] = (isLastNal && isEnd ? 0x80 : 0x00) | 96;
          rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xffff, 2);
          rtpHeader.writeUInt32BE(rtpTimestamp, 4);
          rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

          const fuIndicator = nalNri | 28;
          let fuHeader = nalType;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const fuHeaderBuf = Buffer.from([fuIndicator, fuHeader]);
          const payloadChunk = nal.subarray(offset, offset + chunkLen);

          this.sendInterleavedRtp(
            0,
            Buffer.concat([rtpHeader, fuHeaderBuf, payloadChunk]),
            targetClient,
          );
          offset += chunkLen;
        }
      }
    }
  }

  private _rtpCount = 0;
  private sendInterleavedRtp(
    defaultChannel: number,
    rtpPacket: Buffer,
    targetClient?: RtspClient,
  ): void {
    const isAudio = defaultChannel >= 2;
    if (isAudio) {
      this.audioPktCount++;
      this.audioOctetCount += Math.max(0, rtpPacket.length - 12);
    } else {
      this.videoPktCount++;
      this.videoOctetCount += Math.max(0, rtpPacket.length - 12);
    }
    const deliver = (client: RtspClient) => {
      if (!client.isPlaying || client.socket.destroyed) return;
      if (!isAudio && !client.receivedKeyframe) return;
      if (client.transport === "udp") {
        const port = isAudio ? client.audioRtpPort : client.videoRtpPort;
        if (!port || !client.udpAddr) return;
        this.sendUdpRtp(rtpPacket, client.udpAddr, port);
        if (!client.firstRtpLogged) {
          client.firstRtpLogged = true;
          console.log(
            `[RTSP] first RTP ${isAudio ? "audio" : "video"} udp ${client.udpAddr}:${port} ${rtpPacket.length}B`,
          );
        }
        return;
      }
      const chan = isAudio
        ? (client.audioChannel ?? defaultChannel)
        : (client.videoChannel ?? defaultChannel);
      const tcpHeader = Buffer.alloc(4);
      tcpHeader[0] = 0x24;
      tcpHeader[1] = chan & 0xff;
      tcpHeader.writeUInt16BE(rtpPacket.length, 2);
      try {
        client.socket.write(Buffer.concat([tcpHeader, rtpPacket]));
      } catch {
        /* ignore */
      }
      if (!client.firstRtpLogged) {
        client.firstRtpLogged = true;
        console.log(
          `[RTSP] first RTP ${isAudio ? "audio" : "video"} tcp interleaved=${chan} ${rtpPacket.length}B`,
        );
      }
    };

    if (targetClient) {
      deliver(targetClient);
      return;
    }
    for (const client of this.clients) deliver(client);
  }

  private sendRtcpForClient(client: RtspClient): void {
    if (!client.isPlaying || client.socket.destroyed) return;
    this.sendRtcpPacket(
      client,
      false,
      this.buildRtcpSr(
        this.rtpSsrc,
        this.videoRtpTimestamp,
        this.videoPktCount,
        this.videoOctetCount,
      ),
    );
    this.sendRtcpPacket(
      client,
      true,
      this.buildRtcpSr(
        this.audioRtpSsrc,
        this.audioRtpTimestamp,
        this.audioPktCount,
        this.audioOctetCount,
      ),
    );
  }

  private buildRtcpSr(
    ssrc: number,
    rtpTs: number,
    pktCount: number,
    octetCount: number,
  ): Buffer {
    const ntp = ntpTimestamp();
    const buf = Buffer.alloc(28);
    buf[0] = 0x80;
    buf[1] = 200; // SR
    buf.writeUInt16BE(6, 2);
    buf.writeUInt32BE(ssrc >>> 0, 4);
    buf.writeUInt32BE(ntp.sec, 8);
    buf.writeUInt32BE(ntp.frac, 12);
    buf.writeUInt32BE(rtpTs >>> 0, 16);
    buf.writeUInt32BE(pktCount >>> 0, 20);
    buf.writeUInt32BE(octetCount >>> 0, 24);
    return buf;
  }

  private sendRtcpPacket(
    client: RtspClient,
    isAudio: boolean,
    packet: Buffer,
  ): void {
    if (client.transport === "udp") {
      const rtpPort = isAudio ? client.audioRtpPort : client.videoRtpPort;
      if (!rtpPort || !client.udpAddr) return;
      this.sendUdpRtp(packet, client.udpAddr, rtpPort + 1);
      return;
    }
    const chan = isAudio
      ? (client.audioChannel ?? 2) + 1
      : (client.videoChannel ?? 0) + 1;
    const tcpHeader = Buffer.alloc(4);
    tcpHeader[0] = 0x24;
    tcpHeader[1] = chan & 0xff;
    tcpHeader.writeUInt16BE(packet.length, 2);
    try {
      client.socket.write(Buffer.concat([tcpHeader, packet]));
    } catch {
      /* ignore */
    }
  }

  private sendUdpRtp(packet: Buffer, addr: string, port: number): void {
    const v4mapped = stripV4Mapped(addr);
    const isV6 = v4mapped.includes(":");
    const sock = isV6 ? this.rtpUdp6 : this.rtpUdp;
    if (!sock) return;
    const dests = new Set<string>([v4mapped]);
    // Same-host VLC/ffplay often SETUPs via the LAN IP (192.168.x) while the
    // RTP socket is bound on 0.0.0.0. macOS hairpins that UDP out the NIC
    // and the player never sees it. Also deliver to loopback.
    if (!isV6 && localIPv4Set().has(v4mapped)) dests.add("127.0.0.1");
    for (const dest of dests) {
      try {
        sock.send(packet, port, dest);
      } catch (e: any) {
        console.warn(
          `[RTSP] UDP send ${dest}:${port} failed: ${e?.message || e}`,
        );
      }
    }
  }

  public hasPlayingClients(): boolean {
    for (const c of this.clients) {
      if (c.isPlaying) return true;
    }
    return false;
  }

  public stop(): void {
    this.stopVideoPacer();
    this.stopRtcp();
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
    if (this.rtpUdp) {
      try {
        this.rtpUdp.close();
      } catch {}
      this.rtpUdp = null;
    }
    if (this.rtpUdp6) {
      try {
        this.rtpUdp6.close();
      } catch {}
      this.rtpUdp6 = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ============= AqaraCameraBridge Class =============

export class AqaraCameraBridge extends EventEmitter {
  private did: string;
  private token: string;
  private model: string;
  /** Set from cloud quality list; 0 is Low Resolution. */
  private p2pQualityChannel: number;
  private cameraIp: string | null = null;
  private cameraPort: number = 0;
  private baseUrl: string;
  private appId: string;
  private appKey: string;
  private rtspPort: number;

  private socket: dgram.Socket | null = null;
  private rtspServer: RtspServer | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discoveryDeadline: number = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private mediaKeepaliveTimer: NodeJS.Timeout | null = null;
  private cmdSeq: number = 10;
  private p2pConnectedAt: number = 0;
  private _loggedQuality: boolean = false;
  private _qualityAcked: boolean = false;

  // --- Self-healing P2P state ---
  private desiredStreamActive: boolean = false; // user wants the stream up (HA p2p_stream ON)
  private resurrecting: boolean = false; // a reconnect attempt is in flight
  private p2pEstablishing: boolean = false; // connect()/discovery in progress (don't double-run)
  private reconnectAttempts: number = 0;
  private lastVideoFrameAt: number = 0; // for stall detection
  private lastResurrectAt: number = 0; // for backoff
  private stallTimeoutMs: number =
    Math.max(3, parseInt(process.env.STREAM_STALL_TIMEOUT_SEC || "8", 10)) *
    1000;
  private reconnectBackoffMs: number =
    Math.max(2, parseInt(process.env.RECONNECT_BACKOFF_SEC || "4", 10)) * 1000;
  private ch0Seq: number = 0;
  private ch3Seq: number = 0;
  private isConnected: boolean = false;
  private isStreamStarted: boolean = false;
  private skipVideo: boolean = false;
  private talkbackOnly: boolean = false;

  private p2pInfo: P2PInfo | null = null;
  private ppcsKeyBuf: Buffer = Buffer.alloc(0);
  private punchBuf: Buffer = Buffer.alloc(0);
  private appPub: string = "";
  private appSign: string = "";
  private signTime: string = "";
  private endpoints: Array<{ ip: string; port: number }> = [];

  // Frame reassembly state
  private frames: Record<string, { buf: Buffer; parts: number[] }> = {};
  public frameCount: number = 0;
  private hasSeenKeyframe: boolean = false;
  private decryptor: AqaraStreamDecryptor | null = null;

  constructor(options: BridgeOptions) {
    super();
    this.did = options.did;
    this.token = options.token;
    this.model = options.model || "";
    // JSON 0x100E channel. 0=360p, 1=HD. Default HD.
    this.p2pQualityChannel =
      typeof options.p2pQualityChannel === "number"
        ? options.p2pQualityChannel
        : 1;
    this.cameraIp = options.cameraIp || null;
    this.cameraPort = options.cameraPort || 0;
    this.baseUrl = options.baseUrl || DEFAULT_CONFIG.BASE_URL;
    this.appId = options.appId || DEFAULT_CONFIG.APP_ID;
    this.appKey = options.appKey || DEFAULT_CONFIG.APP_KEY;
    this.rtspPort = options.rtspPort || DEFAULT_CONFIG.RTSP_PORT;
    const videoKey =
      options.videoKey ||
      "fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf";
    this.decryptor = new AqaraStreamDecryptor(videoKey);
  }

  private signHeaders(body: string = ""): Record<string, string> {
    const time = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString("hex").toUpperCase();
    let pre = `Appid=${this.appId}&Nonce=${nonce}&Time=${time}`;
    if (this.token) pre += `&Token=${this.token}`;
    if (body) pre += `&${body}`;
    pre += `&${this.appKey}`;

    return {
      lang: "en",
      "app-version": "6.1.6",
      "sys-type": "1",
      "sys-version": "14",
      "phone-model": "Pixel 7",
      appid: this.appId,
      nonce,
      time,
      sign: md5(pre),
      ...(this.token ? { token: this.token } : {}),
      "content-type": "application/json",
    };
  }

  /**
   * Fetch P2P configuration and exchange signed public keys
   */
  public async initCloudSession(): Promise<{
    appPub: string;
    sign: string;
  }> {
    // Always generate fresh handshake with cloud unless explicitly requested
    if (
      process.env.USE_SESSION_CACHE === "true" &&
      this.applyCachedSession() &&
      this.keyPair
    ) {
      const appPub = Buffer.from(
        (this.keyPair.publicKey.export({ format: "jwk" }) as any).x,
        "base64url",
      ).toString("hex");
      return { appPub, sign: this.appSign };
    }

    const infoUrl = `${this.baseUrl}/app/v1.0/lumi/devex/camera/p2p/info?did=${encodeURIComponent(this.did)}`;
    const infoResp = await axios.get(infoUrl, {
      headers: this.signHeaders(`did=${this.did}`),
      timeout: 15000,
    });

    if (infoResp.data?.code !== 0) {
      throw new Error(
        `Failed to get P2P info: ${JSON.stringify(infoResp.data)}`,
      );
    }

    this.p2pInfo = infoResp.data.result;
    const initStringApp = this.p2pInfo?.initStringApp || "";
    const keyPart = initStringApp.includes(":")
      ? initStringApp.split(":")[1]
      : initStringApp || "aqaraus19kn";
    this.ppcsKeyBuf = Buffer.from(keyPart, "ascii");
    if (process.env.DEBUG)
      console.log("🔑 [PPCS] session key:", this.ppcsKeyBuf.toString("hex"));
    this.punchBuf = punchPayload(this.p2pInfo?.p2pId || "AQARAUS-207160-BRSYM");

    // Generate ephemeral X25519 keypair
    const kp = crypto.generateKeyPairSync("x25519");
    this.keyPair = kp;
    const appPub = Buffer.from(
      (kp.publicKey.export({ format: "jwk" }) as any).x,
      "base64url",
    ).toString("hex");

    const signBody = JSON.stringify({
      did: this.did,
      p2pAppPublicKey: appPub,
      devPwd: "",
    });

    const signResp = await axios.post(
      `${this.baseUrl}/app/v1.0/lumi/devex/camera/p2p/sign`,
      signBody,
      {
        headers: this.signHeaders(signBody),
        timeout: 15000,
      },
    );

    if (signResp.data?.code !== 0) {
      throw new Error(
        `Failed to get P2P sign: ${JSON.stringify(signResp.data)}`,
      );
    }

    const signResult = signResp.data.result;
    this.appPub = appPub;
    this.appSign = signResult.sign;
    this.signTime = signResult.time;

    // Derive session X25519 Shared Secret key for video decryption
    if (this.p2pInfo?.devP2pPublicKey) {
      try {
        const devPubBuf = Buffer.from(this.p2pInfo.devP2pPublicKey, "hex");
        const devKeyObj = crypto.createPublicKey({
          key: {
            kty: "OKP",
            crv: "X25519",
            x: devPubBuf.toString("base64url"),
          },
          format: "jwk",
        });
        const sharedSecret = crypto.diffieHellman({
          privateKey: kp.privateKey,
          publicKey: devKeyObj,
        });
        const sharedKeyHex = sharedSecret.toString("hex");
        const videoKeyHex = AqaraStreamDecryptor.deriveKey(
          this.did,
          sharedSecret,
        ).toString("hex");
        this.decryptor = new AqaraStreamDecryptor(videoKeyHex);
        this.emit(
          "info",
          `Computed X25519 shared: ${sharedKeyHex}, video key (sha256(did|shared)): ${videoKeyHex}`,
        );
      } catch (err: any) {
        this.emit(
          "warn",
          `Failed to derive X25519 shared secret: ${err.message}`,
        );
      }
    }

    this.saveSessionCache();

    return {
      appPub,
      sign: signResult.sign,
    };
  }

  /**
   * Connect to the camera over P2P/LAN and start RTSP broadcasting
   */
  public async start(options?: { skipVideo?: boolean }): Promise<void> {
    this.desiredStreamActive = !options?.skipVideo;
    this.startWatchdog();
    try {
      await this.connect(options?.skipVideo);
    } catch (err: any) {
      this.p2pEstablishing = false; // let the watchdog retry
      throw err;
    }
  }

  public async connect(skipVideo?: boolean): Promise<void> {
    this.p2pEstablishing = true;
    this.skipVideo = !!skipVideo;
    this.talkbackOnly = !!skipVideo;
    await this.initCloudSession();
    this.socket = dgram.createSocket("udp4");

    // Start RTSP Server — but only once. On resurrection we MUST keep the
    // existing server (and its connected RTSP clients) alive; only the P2P
    // feed underneath is torn down and rebuilt.
    if (!this.rtspServer) {
      try {
        this.rtspServer = new RtspServer(this.rtspPort, this.did);
        this.rtspServer.isHevc = false;
        this.rtspServer.on("need_keyframe", () => {
          // 0x1018 GET_FRAME is a snapshot. Repeating it after the first IDR
          // aborts the live GOP (one still, then watchdog).
          if (this.isConnected && !this.hasSeenKeyframe) {
            this.requestLiveKeyframe();
          }
        });
        await this.rtspServer.start();
        this.emit(
          "rtsp_listening",
          `rtsp://0.0.0.0:${this.rtspServer.listenPort}/live/${this.did}`,
        );
      } catch (err: any) {
        this.emit(
          "warn",
          `RTSP server failed to start on port ${this.rtspPort}: ${err.message}`,
        );
      }
    }

    this.socket.on("message", (msg, rinfo) => {
      this.handleUdpPacket(msg, rinfo);
    });

    this.socket.on("error", (err) => {
      this.emit("error", err);
      // A dead socket means the P2P feed is gone — resurrect if the user still
      // wants the stream (the RTSP server itself stays up for clients).
      if (this.desiredStreamActive) this.resurrect();
    });

    await new Promise<void>((resolve) => {
      this.socket?.bind(0, () => {
        this.socket?.setBroadcast(true);
        try {
          // Maximize UDP receive buffer (8MB) to prevent kernel packet drops during bursts and 4K I-frames
          this.socket?.setRecvBufferSize(8 * 1024 * 1024);
        } catch {
          /* ignore if OS restricts */
        }
        resolve();
      });
    });

    const myPort = this.socket.address().port;
    const localIp = getLocalIpv4();

    // Query TUTK Master Servers for dynamic endpoint
    const req20 = Buffer.alloc(36);
    this.punchBuf.copy(req20, 0);
    req20.writeUInt16LE(2, 20); // AF_INET
    req20.writeUInt16LE(myPort, 22);
    const ipParts = localIp.split(".").map(Number);
    req20[24] = ipParts[3];
    req20[25] = ipParts[2];
    req20[26] = ipParts[1];
    req20[27] = ipParts[0];

    const queryPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(0x20, req20));
    const helloPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(0x00));
    const punchPkt = ppcsEncrypt(
      this.ppcsKeyBuf,
      buildPPPP(MSG_PUNCH_PKT, this.punchBuf),
    );

    // Stop discovery after a bounded time. Hammering the camera forever would
    // both waste resources and can disrupt an already-connected user/session.
    const timeoutSec = parseInt(
      process.env.P2P_DISCOVERY_TIMEOUT_SEC || "30",
      10,
    );
    this.discoveryDeadline = Date.now() + timeoutSec * 1000;

    this.discoveryTimer = setInterval(() => {
      if (this.isConnected) return;

      if (Date.now() > this.discoveryDeadline) {
        if (this.discoveryTimer) clearInterval(this.discoveryTimer);
        this.discoveryTimer = null;
        this.p2pEstablishing = false; // let the watchdog retry after backoff
        if (this.desiredStreamActive) {
          // Not reachable / busy right now — back off and let the watchdog
          // retry shortly instead of giving up on the stream forever.
          this.emit(
            "warn",
            `P2P discovery timed out after ${timeoutSec}s — will retry (stream still desired)`,
          );
        } else {
          this.emit(
            "error",
            new Error(
              `P2P discovery timed out after ${timeoutSec}s (camera not reachable / busy by another session)`,
            ),
          );
        }
        return;
      }

      for (const s of TUTK_MASTER_SERVERS) {
        this.socket?.send(helloPkt, 32100, s);
        this.socket?.send(queryPkt, 32100, s);
      }
      for (const ep of this.endpoints) {
        this.socket?.send(punchPkt, ep.port, ep.ip);
      }
      if (this.cameraIp && this.cameraPort) {
        this.socket?.send(punchPkt, this.cameraPort, this.cameraIp);
      }
      // Broadcast discovery
      this.socket?.send(
        Buffer.from([PPCS_MAGIC, 0x30, 0x00, 0x00]),
        PPPP_LAN_PORT,
        "255.255.255.255",
      );
    }, 200);
  }

  // ============= Self-Healing (keep the RTSP feed alive) =============

  /**
   * Watchdog: while the user wants the stream (`desiredStreamActive`), make sure
   * the P2P feed is actually alive. If it died or stalled (no video frame for
   * `stallTimeoutMs`), resurrect it with a fresh session — without ever tearing down the RTSP server,
   * so connected RTSP clients just see a brief gap, never a dead stream.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkLiveness(), 2000);
  }

  private checkLiveness(): void {
    if (!this.desiredStreamActive || this.resurrecting || this.p2pEstablishing)
      return;
    const now = Date.now();
    const dead = !this.isConnected;
    // Do NOT tear down a live P2P session that has not produced an IDR yet.
    // lastVideoFrameAt is stamped at punch/RDY, so an 8s stall was killing
    // the session while the camera was still warming — ⏳ forever, VLC PLAY
    // with no cached IDR. Only stall-detect after we have actually decoded
    // at least one keyframe.
    const stalled =
      this.isConnected &&
      this.hasSeenKeyframe &&
      now - this.lastVideoFrameAt > this.stallTimeoutMs;
    const firstFrameGaveUp =
      this.isConnected &&
      !this.hasSeenKeyframe &&
      this.p2pConnectedAt > 0 &&
      now - this.p2pConnectedAt > 45000;
    if (dead || stalled || firstFrameGaveUp) {
      this.resurrect();
    }
  }

  private async resurrect(): Promise<void> {
    if (this.resurrecting) return;
    if (Date.now() - this.lastResurrectAt < this.reconnectBackoffMs) return;
    this.resurrecting = true;
    this.lastResurrectAt = Date.now();
    this.reconnectAttempts++;
    this.emit(
      "warn",
      `🔌 [${this.did}] Feed lost (attempt #${this.reconnectAttempts}) — resurrecting with fresh session (RTSP server alive)`,
    );

    // Tear down only the P2P plumbing; keep RTSP server + connected clients alive
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.talkbackTimer) {
      clearInterval(this.talkbackTimer);
      this.talkbackTimer = null;
    }
    if (this.mediaKeepaliveTimer) {
      clearInterval(this.mediaKeepaliveTimer);
      this.mediaKeepaliveTimer = null;
    }
    this.clearTalkbackRetries();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    this.isConnected = false;
    this.isStreamStarted = false;
    this.hasAudioStarted = false;
    this.sessionStarted = false;
    this.p2pSessionReady = false;
    this.liveStreamRequested = false;
    this.pendingAcks.clear();
    this.ch0Seq = 0;
    this.ch3Seq = 0;
    this.resetVideoAssembly();
    this.lastAudioTs = -1;
    this.lastAudioNonce = null;
    this.emit("disconnected");

    try {
      await this.connect();
    } catch (err: any) {
      this.p2pEstablishing = false; // connect threw before discovery — allow retry
      this.emit(
        "warn",
        `Resurrection attempt #${this.reconnectAttempts} failed: ${err.message}`,
      );
    } finally {
      this.resurrecting = false;
    }
  }

  private sendEncDrw(chan: number, idx: number, data: Buffer): void {
    if (!this.socket || !this.cameraIp || !this.cameraPort) return;
    const inner = Buffer.concat([
      Buffer.from([DRW_MARKER, chan, (idx >> 8) & 0xff, idx & 0xff]),
      data,
    ]);
    const h = Buffer.alloc(4);
    h[0] = PPCS_MAGIC;
    h[1] = MSG_DRW;
    h.writeUInt16BE(inner.length, 2);
    const pkt = ppcsEncrypt(this.ppcsKeyBuf, Buffer.concat([h, inner]));
    this.socket.send(pkt, this.cameraPort, this.cameraIp);

    // Frida-style OUT log
    if (process.env.DEBUG) {
      const hexStr = inner
        .toString("hex")
        .replace(/(.{2})/g, "$1 ")
        .trim();
      const asciiStr = inner.toString("ascii").replace(/[^\x20-\x7e]/g, ".");
      const frameTypeHex =
        data.length >= 8 && data.subarray(0, 4).equals(Buffer.from("lumi"))
          ? data.readUInt16LE(4).toString(16).toUpperCase()
          : "ADTS";
      console.log(
        `[OUT] chan=${chan} idx=${idx} type=0x${frameTypeHex} len=${inner.length} hex=${hexStr} ascii=${asciiStr}`,
      );
    }
  }

  private pendingAcks: Map<number, number[]> = new Map();
  private ackTimer: NodeJS.Timeout | null = null;

  private queueAck(chan: number, idx: number): void {
    let list = this.pendingAcks.get(chan);
    if (!list) {
      list = [];
      this.pendingAcks.set(chan, list);
    }
    list.push(idx);

    if (list.length >= 8) {
      this.flushAcks(chan);
    }
  }

  private flushAcks(chan: number): void {
    const list = this.pendingAcks.get(chan);
    if (!list || list.length === 0) return;
    this.pendingAcks.set(chan, []);

    if (!this.socket || !this.cameraIp || !this.cameraPort) return;

    while (list.length > 0) {
      const chunk = list.splice(0, 32);
      const count = chunk.length;
      const payloadLen = 4 + count * 2;
      const ackPayload = Buffer.alloc(payloadLen);
      ackPayload[0] = DRW_MARKER;
      ackPayload[1] = chan;
      ackPayload.writeUInt16BE(count, 2);
      for (let i = 0; i < count; i++) {
        ackPayload.writeUInt16BE(chunk[i], 4 + i * 2);
      }
      const ackHdr = Buffer.alloc(4);
      ackHdr[0] = PPCS_MAGIC;
      ackHdr[1] = MSG_DRW_ACK;
      ackHdr.writeUInt16BE(payloadLen, 2);

      const pkt = ppcsEncrypt(
        this.ppcsKeyBuf,
        Buffer.concat([ackHdr, ackPayload]),
      );
      this.socket.send(pkt, this.cameraPort, this.cameraIp);
    }
  }

  private handleUdpPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < 4) return;
    const dec = ppcsDecrypt(this.ppcsKeyBuf, msg);
    const magic = dec[0];
    const msgType = dec[1];
    const len = dec.readUInt16BE(2);
    const payload = dec.subarray(4, 4 + len);

    if (magic !== PPCS_MAGIC) return;

    // TUTK Master Server response: type 0x40 returns dynamic camera endpoint
    if (msgType === 0x40 && payload.length >= 8) {
      const port = (payload[3] << 8) | payload[2];
      const ip = `${payload[7]}.${payload[6]}.${payload[5]}.${payload[4]}`;
      if (!this.endpoints.some((e) => e.ip === ip && e.port === port)) {
        this.endpoints.push({ ip, port });
      }
      const punchPkt = ppcsEncrypt(
        this.ppcsKeyBuf,
        buildPPPP(MSG_PUNCH_PKT, this.punchBuf),
      );
      this.socket?.send(punchPkt, port, ip);
      return;
    }

    if (msgType === MSG_PUNCH_PKT) {
      this.cameraIp = rinfo.address;
      this.cameraPort = rinfo.port;
      const punchPkt = ppcsEncrypt(
        this.ppcsKeyBuf,
        buildPPPP(MSG_PUNCH_PKT, this.punchBuf),
      );
      this.socket?.send(punchPkt, this.cameraPort, this.cameraIp);
      const rdyPkt = ppcsEncrypt(
        this.ppcsKeyBuf,
        buildPPPP(MSG_P2P_RDY, this.punchBuf),
      );
      this.socket?.send(rdyPkt, this.cameraPort, this.cameraIp);
      return;
    }

    if (msgType === MSG_P2P_RDY) {
      this.cameraIp = rinfo.address;
      this.cameraPort = rinfo.port;
      const rdyAck = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_P2P_RDY_ACK));
      this.socket?.send(rdyAck, this.cameraPort, this.cameraIp);

      if (!this.isConnected) {
        this.isConnected = true;
        this.p2pEstablishing = false;
        this.reconnectAttempts = 0;
        this.lastVideoFrameAt = Date.now();
        this.p2pConnectedAt = Date.now();
        this._loggedQuality = false;
        this._qualityAcked = false;
        this._ch3Log = 0;
        this.lastMediaIdx = -1;
        this.lastMediaPkt = null;
        if (this.discoveryTimer) clearInterval(this.discoveryTimer);
        this.emit("connected", { ip: this.cameraIp, port: this.cameraPort });
        if (this.skipVideo) {
          this.startSessionFlow(true); // talkback-only: login but no video stream
        } else {
          this.startSessionFlow(false); // full session with video
        }
      }
    } else if (msgType === MSG_ALIVE) {
      const ack = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE_ACK));
      this.socket?.send(ack, rinfo.port, rinfo.address);
    } else if (msgType === MSG_DRW_ACK && payload.length >= 4) {
      if (this.talkbackActive && process.env.DEBUG && payload[1] === 2) {
        console.log(
          `📨 [Talkback] camera DRW_ACK ch=2 seq=${payload.readUInt16BE(2)}`,
        );
      }
    } else if (
      (msgType === MSG_DRW || msgType === 0xd8) &&
      payload.length >= 4 &&
      payload[0] === DRW_MARKER
    ) {
      const chan = payload[1];
      const idx = payload.readUInt16BE(2);
      const data = payload.subarray(4);

      this.queueAck(chan, idx);
      // Media ACKs must go out immediately. Batching 8 during a 280-packet
      // IDR burst made the camera stop after the keyframe — no P-frames,
      // watchdog, VLC disconnect.
      if (chan === 1 || chan === 4) this.flushAcks(chan);

      if (chan === 0) {
        this.handleChannel0Data(data);
      } else if (chan === 2) {
        if (this.talkbackActive && process.env.DEBUG) {
          console.log(
            `📨 [Chan 2 Talkback] len=${data.length} hex=${data.subarray(0, Math.min(32, data.length)).toString("hex")}`,
          );
        }
      } else if (chan === 3) {
        this.handleChannel3Data(data);
      } else if (
        chan === 1 ||
        chan === 4 ||
        chan === 5 ||
        isAvioVideoHeader(data)
      ) {
        this.handleVideoData(idx, data);
      } else if (this._vidPktCount < 8) {
        console.log(
          `📨 [Chan ${chan}] DRW idx=${idx} ${data.length}B head=${data.subarray(0, Math.min(16, data.length)).toString("hex")}`,
        );
      }
    }
  }

  private startSessionFlow(talkbackOnly: boolean = false): void {
    if (!this.socket || !this.cameraIp || !this.cameraPort) return;

    // 1. Send E0 keepalive
    this.socket.send(
      ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE)),
      this.cameraPort,
      this.cameraIp,
    );

    // 2. Send Lumi Login (0x1000) with retry until camera responds
    let loginAttempts = 0;
    const sendLogin = () => {
      if (this.isStreamStarted || !this.isConnected || !this.socket) return;
      const loginJson = JSON.stringify({
        app_public_key: this.appPub,
        app_sign: this.appSign,
        device_id: this.did,
        timestamp: String(this.signTime || Date.now()),
      });
      if (process.env.DEBUG)
        console.log(`📤 [Login] Sending login attempt ${loginAttempts + 1}`);
      this.sendEncDrw(
        0,
        this.ch0Seq++,
        buildLumiFrame(LUMI_TYPE_LOGIN, Buffer.from(loginJson), this.cmdSeq++),
      );
      loginAttempts++;
      if (loginAttempts < 10 && !this.isStreamStarted) {
        setTimeout(sendLogin, 1000);
      }
    };
    setTimeout(sendLogin, 200);

    // 3. Fast 10ms ACK batch timer (always needed for reliable delivery)
    if (this.ackTimer) clearInterval(this.ackTimer);
    this.ackTimer = setInterval(() => {
      for (const ch of Array.from(this.pendingAcks.keys())) {
        this.flushAcks(ch);
      }
    }, 10);

    // 4. PPCS Keepalive timer (every 2.5s send MSG_ALIVE to maintain UDP NAT hole)
    this.keepaliveTimer = setInterval(() => {
      if (this.socket && this.cameraIp && this.cameraPort) {
        this.socket.send(
          ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE)),
          this.cameraPort,
          this.cameraIp,
        );
      }
    }, 2500);

    // 5. Do not poll 0x1018 (GET_FRAME snapshot) or empty 0x101C (record list).
    // Quality is set once by StartVideoCmdContent on 0x1003. Repeating JSON
    // 0x100E {"channel":0} was pinning the encoder on 360p after talkback.
    if (this.mediaKeepaliveTimer) clearInterval(this.mediaKeepaliveTimer);
    this.mediaKeepaliveTimer = setInterval(() => {
      if (!this.isConnected || this.talkbackOnly) return;
      if (
        process.env.STREAM_QUALITY_JSON &&
        process.env.STREAM_QUALITY_JSON !== "skip" &&
        !this._qualityAcked
      ) {
        this.sendQualitySwitch();
      }
    }, 5000);
  }

  private requestLiveKeyframe(): void {
    if (!this.isConnected) return;
    this.sendEncDrw(
      0,
      this.ch0Seq++,
      buildLumiFrame(LUMI_TYPE_KEYFRAME_REQ, Buffer.alloc(0), this.cmdSeq++),
    );
  }

  private sendStreamHeartbeat(): void {
    if (!this.isConnected) return;
    this.sendEncDrw(
      3,
      this.ch3Seq++,
      buildLumiFrame(LUMI_TYPE_STREAM_START, Buffer.alloc(0), this.cmdSeq++),
    );
  }

  private _ch3Log = 0;
  private handleChannel3Data(data: Buffer): void {
    if (this._ch3Log >= 6) return;
    this._ch3Log++;
    let off = 0;
    while (
      off + 16 <= data.length &&
      data.toString("ascii", off, off + 4) === "lumi"
    ) {
      const frameType = data.readUInt32LE(off + 4);
      const len = data.readUInt32LE(off + 12);
      if (len > data.length - off - 16) break;
      console.log(
        `📨 [${this.did}] ch3 Lumi type=0x${frameType.toString(16)} body=${len}B`,
      );
      off += 16 + len;
    }
    if (off === 0) {
      console.log(
        `📨 [${this.did}] ch3 DRW ${data.length}B head=${data.subarray(0, Math.min(16, data.length)).toString("hex")}`,
      );
    }
  }

  private async handleChannel0Data(data: Buffer): Promise<void> {
    // A single PPCS DRW packet may carry several concatenated Lumi frames
    // (e.g. login resp + talk-prepare resp batched together). Parse ALL of
    // them instead of just the first, otherwise responses like 0x100B get
    // silently dropped.
    let off = 0;
    while (
      off + 16 <= data.length &&
      data.toString("ascii", off, off + 4) === "lumi"
    ) {
      const frameType = data.readUInt32LE(off + 4);
      const len = data.readUInt32LE(off + 12);
      if (len > data.length - off - 16) break;
      const body = data.subarray(off + 16, off + 16 + len);
      if (process.env.DEBUG)
        console.log(
          "📨 [Chan 0] frameType: 0x" + frameType.toString(16),
          "len:",
          body.length,
        );
      await this.dispatchChannel0(frameType, body);
      off += 16 + len;
    }
  }

  private async dispatchChannel0(
    frameType: number,
    data: Buffer,
  ): Promise<void> {
    if (frameType === LUMI_TYPE_LOGIN_RESP) {
      const bodyStr = data.toString();
      if (process.env.DEBUG || data.length > 60)
        console.log(
          `📨 [${this.did}] Camera Lumi Login Resp (len=${data.length}):`,
          bodyStr,
        );
      if (process.env.DEBUG)
        console.log(
          `📥 [Login] Login response received, talkbackOnly=${this.talkbackOnly}, sessionStarted=${this.sessionStarted}`,
        );
      if (!this.sessionStarted) {
        this.sessionStarted = true;
        this.isStreamStarted = true;
        this._loggedResolution = false;
        this._loggedAudio = false;

        this.sendEncDrw(
          0,
          this.ch0Seq++,
          buildLumiFrame(
            LUMI_TYPE_SESSION_START,
            Buffer.alloc(0),
            this.cmdSeq++,
          ),
        );
      }
    } else if (frameType === LUMI_TYPE_SESSION_START_RESP) {
      this.p2pSessionReady = true;
      this.emit("p2p_session_ready");
      if (!this.talkbackOnly && !this.liveStreamRequested) {
        this.liveStreamRequested = true;
        this.sendQualitySwitch();
        this.requestLiveKeyframe();
        this.sendEncDrw(
          0,
          this.ch0Seq++,
          buildLumiFrame(LUMI_TYPE_AUDIO_START, Buffer.alloc(0), this.cmdSeq++),
        );
      }
    } else if (frameType === LUMI_TYPE_QUALITY_RESP) {
      this._qualityAcked = true;
      if (!this._loggedQuality) {
        this._loggedQuality = true;
        const txt = data.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
        console.log(
          `✅ [${this.did}] 0x100F changeStreamResolution channel=${this.streamQualityChannel()} ${data.length}B ${txt}`,
        );
        this.sendEncDrw(
          0,
          this.ch0Seq++,
          buildLumiFrame(
            LUMI_TYPE_SESSION_START,
            Buffer.alloc(0),
            this.cmdSeq++,
          ),
        );
      }
    } else if (frameType === LUMI_TYPE_KEYFRAME_RESP) {
      if (this.frameCount === 0 && this._vidPktCount < 2) {
        const txt = data.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
        console.log(
          `📨 [${this.did}] 0x1019 GET_FRAME resp ${data.length}B utf=${txt}`,
        );
      }
    } else if (frameType === LUMI_TYPE_AUDIO_START_RESP) {
      this.hasAudioStarted = true;
      if (process.env.DEBUG) console.log("🔊 [Audio] Start response received");
      this.emit("audio_started");
    } else if (frameType === LUMI_TYPE_AUDIO_SEND_RESP) {
      if (process.env.DEBUG)
        console.log("🔊 [Talkback] Camera accepted speaker channel");
      this.emit("talkback", "accepted");
    } else if (frameType === LUMI_TYPE_TALKBACK_START_RESP) {
      // 0x100B: "prepare for talk 成功" — the camera opened the speaker channel.
      console.log("🔊 [Talkback] Camera prepared talk channel (0x100B)");
      console.log("   🔍 0x100B body(hex):", data.toString("hex"));
      try {
        console.log(
          "   🔍 0x100B body(json):",
          JSON.stringify(JSON.parse(data.toString("utf8"))),
        );
      } catch {
        /* binary */
      }
      // The caller sends the one captured ADTS lead frame immediately before its
      // audio source begins. Keep the control response free of media writes: the
      // official app's encoder owns that timing.
      this.emit("talkback", "accepted");
    } else if (frameType === 0x100d) {
      // 0x100D acknowledges stopTalk (0x100C).
      if (process.env.DEBUG)
        console.log("🔊 [Talkback] Camera acknowledged 0x100C stop (0x100D)");
    } else if (this.frameCount <= 2) {
      console.log(
        `📨 [${this.did}] ch0 type=0x${frameType.toString(16)} len=${data.length}`,
      );
    }
  }

  /** JSON 0x100E channel and StartVideo.channel. 1=HD, 0=Low. Env STREAM_QUALITY overrides. */
  private streamQualityChannel(): number {
    const env = process.env.STREAM_QUALITY;
    if (env && /^\d+$/.test(env)) return parseInt(env, 10);
    return this.p2pQualityChannel;
  }

  /**
   * 0x100E changeStreamResolution. Aqara Home sends JSON `{"channel":N}`
   * (1=HD). Binary 16-byte StartVideo acks with empty 0x100F and no video.
   * STREAM_QUALITY_JSON overrides the body (probe harness).
   */
  private sendQualitySwitch(): void {
    if (!this.isConnected) return;
    if (process.env.STREAM_QUALITY_JSON === "skip") return;
    const body = this.buildQualityPayload();
    const utf = body.toString("utf8");
    const looksJson = utf.startsWith("{") || utf.startsWith("[");
    console.log(
      `📤 [${this.did}] 0x100E ${looksJson ? utf : body.toString("hex")}`,
    );
    this.sendEncDrw(
      0,
      this.ch0Seq++,
      buildLumiFrame(LUMI_TYPE_QUALITY, body, this.cmdSeq++),
    );
  }

  private buildQualityPayload(): Buffer {
    const raw = process.env.STREAM_QUALITY_JSON;
    if (raw && raw !== "skip") return Buffer.from(raw);
    return Buffer.from(
      JSON.stringify({ channel: this.streamQualityChannel() }),
    );
  }

  private frameStartSeq: number = 0;
  private videoFrags: Map<number, Buffer> = new Map();
  private currentExpectedLen: number = 0;
  private currentAccumulatedLen: number = 0;
  private sessionStarted: boolean = false;

  private resetVideoAssembly(): void {
    this.videoFrags.clear();
    this.currentExpectedLen = 0;
    this.currentAccumulatedLen = 0;
    this.mediaStreamBuffer = Buffer.alloc(0);
    this.frameStartSeq = 0;
    this._firstVideoPkt = true;
    this._vidPktCount = 0;
    this._postIdrLog = 0;
    this.frameCount = 0;
    this.lastMediaIdx = -1;
    this.lastMediaPkt = null;
  }
  /** True only after the camera has acknowledged 0x1002 with 0x1003. */
  private p2pSessionReady: boolean = false;
  private liveStreamRequested: boolean = false;
  private talkbackActive: boolean = false;
  private talkbackReady: boolean = false;
  private talkbackPrepare: Promise<boolean> | null = null;
  private talkbackTimer: NodeJS.Timeout | null = null;
  /** Retransmits mirror the native PPCS client's reliable media sends. */
  private talkbackRetryTimers: Set<NodeJS.Timeout> = new Set();
  private mediaStreamBuffer: Buffer = Buffer.alloc(0);
  private _firstVideoPkt: boolean = true;
  private _loggedResolution: boolean = false;
  private _loggedAudio: boolean = false;
  private _vidPktCount = 0;
  private _postIdrLog = 0;

  private lastAudioTs: number = -1;
  private lastAudioNonce: Buffer | null = null;
  private lastMediaIdx: number = -1;
  private lastMediaPkt: Buffer | null = null;

  private async handleVideoData(idx: number, data: Buffer): Promise<void> {
    this._vidPktCount++;
    this.emit("packet_data_ch1", idx, data);
    // PPCS retransmits the same DRW. A new IDR also restarts idx at 0 —
    // only skip an exact copy, not a new frame with the same index.
    if (
      this.lastMediaPkt &&
      idx === this.lastMediaIdx &&
      data.equals(this.lastMediaPkt)
    ) {
      return;
    }
    this.lastMediaIdx = idx;
    this.lastMediaPkt = Buffer.from(data);

    // 1. Audio AVIO frames (0x0088) — own datagrams on the same PPCS channel.
    // Do not fold them into the video byte stream.
    if (data.length >= 40 && data.readUInt16LE(0) === AVIO_AUDIO) {
      const payLen = data.readUInt32LE(28);
      const frameLen = 40 + payLen;
      if (payLen > 0 && payLen <= 4096 && frameLen <= data.length) {
        const nonce = data.subarray(32, 40);
        if (this.lastAudioNonce && nonce.equals(this.lastAudioNonce)) {
          return;
        }
        this.lastAudioNonce = Buffer.from(nonce);
        this.processAudioFrame(data.subarray(0, frameLen));
        return;
      }
    }

    const logPkt =
      this._vidPktCount <= 24 ||
      (this.frameCount >= 1 && this._postIdrLog < 16);
    if (logPkt) {
      if (this.frameCount >= 1 && this._vidPktCount > 24) this._postIdrLog++;
      console.log(
        `📦 [${this.did}] ch1 #${this._vidPktCount} idx=${idx} ${data.length}B head=${data.subarray(0, Math.min(8, data.length)).toString("hex")} rem=${this.mediaStreamBuffer.length} frames=${this.frameCount}`,
      );
    }

    if (this.mediaStreamBuffer.length) {
      if (isAvioVideoHeader(data)) {
        this.mediaStreamBuffer = Buffer.alloc(0);
      } else {
        data = Buffer.concat([this.mediaStreamBuffer, data]);
        this.mediaStreamBuffer = Buffer.alloc(0);
      }
    }

    // Only a datagram that *starts* with AVIO is a new frame. Scanning
    // encrypted NAL payload for 4e00 false-starts and drops the IDR.
    let isAvioHead = isAvioVideoHeader(data);
    if (!isAvioHead && this.currentExpectedLen === 0) {
      const off = findAvioOffset(data);
      if (off > 0) {
        data = data.subarray(off);
        isAvioHead = true;
      }
    }

    if (isAvioHead) {
      if (this.videoFrags.size > 0) {
        if (this.currentAccumulatedLen >= this.currentExpectedLen) {
          this.flushCurrentFrame();
        } else {
          this.videoFrags.clear();
          this.currentExpectedLen = 0;
          this.currentAccumulatedLen = 0;
        }
      }
      this.frameStartSeq = idx;
      this.currentExpectedLen = 32 + data.readUInt32LE(28);
      this.currentAccumulatedLen = 0;
      if (this.frameCount < 3) {
        console.log(
          `📐 [${this.did}] AVIO start idx=${idx} expect ${this.currentExpectedLen}B`,
        );
      }
    }

    if (this.currentExpectedLen === 0) {
      // Continuation without a parsed header. Stash until a header shows up.
      this.mediaStreamBuffer =
        data.length > 2_000_000 ? data.subarray(data.length - 32) : data;
      return;
    }

    const diff = (idx - this.frameStartSeq) & 0xffff;
    const maxPkts = Math.ceil(this.currentExpectedLen / 512) + 64;
    if (diff >= 32768 || diff > maxPkts) {
      return;
    }

    if (!this.videoFrags.has(idx)) {
      this.videoFrags.set(idx, data);
      this.currentAccumulatedLen += data.length;
      this.lastVideoFrameAt = Date.now();
    }

    if (
      this._vidPktCount % 40 === 0 &&
      this.currentExpectedLen > 0 &&
      this.frameCount < 3
    ) {
      console.log(
        `📐 [${this.did}] assembling ${this.currentAccumulatedLen}/${this.currentExpectedLen}B n=${this.videoFrags.size}`,
      );
    }

    const complete =
      this.currentExpectedLen > 0 &&
      this.currentAccumulatedLen >= this.currentExpectedLen;
    const lastFrag = data.length < 1024 && this.videoFrags.size > 1;
    if (complete || lastFrag) {
      this.flushCurrentFrame();
    }
  }

  private flushCurrentFrame(): void {
    if (this.videoFrags.size === 0) return;
    const entries = Array.from(this.videoFrags.entries());
    entries.sort(
      ([a], [b]) =>
        ((a - this.frameStartSeq) & 0xffff) -
        ((b - this.frameStartSeq) & 0xffff),
    );

    // Channel 1 multiplexes video fragments and audio AVIO on one PPCS
    // sequence. Holes in idx are skipped audio, not lost video — concat in
    // idx order and split on the declared AVIO length, keeping any tail
    // that already belongs to the next frame.
    const full = Buffer.concat(entries.map(([, buf]) => buf));
    this.videoFrags.clear();
    this.currentExpectedLen = 0;
    this.currentAccumulatedLen = 0;

    if (full.length < 32) return;

    const { frames, remainder } = splitAvioFrames(full);
    for (const frame of frames) this.processVideoFrame(frame);
    if (remainder.length) this.mediaStreamBuffer = remainder;
  }

  private processVideoFrame(full: Buffer): void {
    const codecId = full.readUInt16LE(0);
    this.frameCount++;

    // Log the negotiated video resolution once, so quality can be verified.
    if (!this._loggedResolution && full.length >= 24) {
      this._loggedResolution = true;
      const w16 = full.readUInt16LE(16),
        h16 = full.readUInt16LE(18);
      const w20 = full.readUInt16LE(20),
        h20 = full.readUInt16LE(22);
      const channel = parseInt(process.env.STREAM_QUALITY ?? "0", 10) || 0;
      console.log(
        `🖼️ [${this.did}] STREAM_QUALITY=${channel} | AVIO header(hex)=${full.subarray(0, 32).toString("hex")} | ` +
          `candidate res @16:${w16}x${h16} @20:${w20}x${h20}`,
      );
    }

    const isHevcFrame = codecId === 0x004f;
    if (this.rtspServer) this.rtspServer.isHevc = isHevcFrame;

    let rawH264: Buffer = full.subarray(32);
    if (this.decryptor && full.length > 48) {
      try {
        rawH264 = this.decryptor.decryptToAnnexB(full.subarray(32));
      } catch {
        try {
          rawH264 = this.decryptor.decrypt(full.subarray(32));
        } catch {
          rawH264 = full.subarray(48);
        }
      }
    } else if (full.length > 41) {
      const payload = full.subarray(32);
      const nalCount = payload[8];
      const tableEnd = 9 + nalCount * 8;
      if (nalCount > 0 && tableEnd < payload.length) {
        rawH264 = payload.subarray(tableEnd);
      }
    }

    // AVIO flags bit0 = I-frame (confirmed in live headers: 4e 00 01 00 ...).
    // Do not wait for Annex-B type 5: decrypted NALs often have no start codes
    // until we wrap them, so the NAL scan used to drop every frame.
    const avioKeyframe = (full.readUInt16LE(2) & 0x0001) === 1;
    const isKeyframe = avioKeyframe || isAnnexBKeyframe(rawH264, isHevcFrame);

    // Harvest SPS/PPS from every frame *before* the keyframe gate. They often
    // ride in non-IDR packets; dropping them made PLAY emit a naked type-5 IDR
    // and ffmpeg/VLC exit with "non-existing PPS 0 referenced".
    this.ingestParamSets(rawH264, isHevcFrame);
    if (this.frameCount <= 12 || this.frameCount % 30 === 0) {
      const types: number[] = [];
      walkAnnexBNals(rawH264, (nal) => {
        if (!nal.length) return;
        types.push(isHevcFrame ? (nal[0] >> 1) & 0x3f : nal[0] & 0x1f);
      });
      const w = full.length >= 22 ? full.readUInt16LE(16) : 0;
      const h = full.length >= 22 ? full.readUInt16LE(20) : 0;
      console.log(
        `🎞️ [${this.did}] frame#${this.frameCount} ${isKeyframe ? "I" : "P"} ${w}x${h} ${full.length}B flags=${full.readUInt16LE(2)} nals=${types.slice(0, 16).join(",") || "none"} sps=${!!this.rtspServer?.sps} pps=${!!this.rtspServer?.pps}`,
      );
    }

    this.lastVideoFrameAt = Date.now();

    const haveParams = this.rtspServer
      ? isHevcFrame
        ? !!(this.rtspServer.vps && this.rtspServer.sps && this.rtspServer.pps)
        : !!(this.rtspServer.sps && this.rtspServer.pps)
      : false;

    if (isKeyframe && !this.hasSeenKeyframe && haveParams) {
      this.hasSeenKeyframe = true;
      this.emit("stream_started");
      if (this.rtspServer) {
        this.emit(
          "rtsp_ready",
          `rtsp://0.0.0.0:${this.rtspServer.listenPort}/live/${this.did}`,
        );
      }
    } else if (isKeyframe && !haveParams && this.frameCount <= 12) {
      console.log(`⏳ [${this.did}] IDR without SPS/PPS yet (waiting to warm)`);
    }

    if (!this.hasSeenKeyframe) return;

    this.emit("raw_frame", full);

    if (this.rtspServer) {
      let outFrame = rawH264;
      const sc = Buffer.from([0, 0, 0, 1]);
      const hasStartCode =
        (rawH264.length >= 3 &&
          rawH264[0] === 0 &&
          rawH264[1] === 0 &&
          rawH264[2] === 1) ||
        (rawH264.length >= 4 &&
          rawH264[0] === 0 &&
          rawH264[1] === 0 &&
          rawH264[2] === 0 &&
          rawH264[3] === 1);

      if (!hasStartCode) {
        outFrame = Buffer.concat([sc, rawH264]);
      }
      if (isKeyframe) {
        this.rtspServer.lastKeyframe = this.prependParamSets(
          outFrame,
          isHevcFrame,
        );
      }
      this.rtspServer.broadcastFrame(outFrame);
    }
    this.emit("frame", { data: rawH264, isKeyframe, timestamp: Date.now() });
  }

  private ingestParamSets(annexB: Buffer, isHevc: boolean): void {
    if (!this.rtspServer) return;
    walkAnnexBNals(annexB, (nal) => {
      if (!nal.length) return;
      if (isHevc) {
        const t = (nal[0] >> 1) & 0x3f;
        if (t === 32) this.rtspServer!.vps = Buffer.from(nal);
        else if (t === 33) this.rtspServer!.sps = Buffer.from(nal);
        else if (t === 34) this.rtspServer!.pps = Buffer.from(nal);
      } else {
        const t = nal[0] & 0x1f;
        if (t === 7) this.rtspServer!.sps = Buffer.from(nal);
        else if (t === 8) this.rtspServer!.pps = Buffer.from(nal);
      }
    });
  }

  private prependParamSets(frame: Buffer, isHevc: boolean): Buffer {
    if (!this.rtspServer) return frame;
    const sc = Buffer.from([0, 0, 0, 1]);
    const haveSps = { v: false, s: false, p: false };
    walkAnnexBNals(frame, (nal) => {
      if (!nal.length) return;
      if (isHevc) {
        const t = (nal[0] >> 1) & 0x3f;
        if (t === 32) haveSps.v = true;
        if (t === 33) haveSps.s = true;
        if (t === 34) haveSps.p = true;
      } else {
        const t = nal[0] & 0x1f;
        if (t === 7) haveSps.s = true;
        if (t === 8) haveSps.p = true;
      }
    });
    const missing: Buffer[] = [];
    if (isHevc) {
      if (!haveSps.v && this.rtspServer.vps)
        missing.push(sc, this.rtspServer.vps);
      if (!haveSps.s && this.rtspServer.sps)
        missing.push(sc, this.rtspServer.sps);
      if (!haveSps.p && this.rtspServer.pps)
        missing.push(sc, this.rtspServer.pps);
    } else {
      if (!haveSps.s && this.rtspServer.sps)
        missing.push(sc, this.rtspServer.sps);
      if (!haveSps.p && this.rtspServer.pps)
        missing.push(sc, this.rtspServer.pps);
    }
    return missing.length ? Buffer.concat([...missing, frame]) : frame;
  }

  private processAudioFrame(frame: Buffer): void {
    let pcm: Buffer = frame.subarray(40);
    if (this.decryptor) {
      try {
        pcm = this.decryptor.decryptAudioFrame(frame) as Buffer;
      } catch {
        pcm = frame.subarray(40);
      }
    }
    if (!this._loggedAudio && pcm.length) {
      this._loggedAudio = true;
      const adts =
        pcm.length >= 2 && pcm[0] === 0xff && (pcm[1] & 0xf0) === 0xf0;
      console.log(
        `🔊 [${this.did}] first mic frame ${pcm.length}B adts=${adts} hex=${pcm.subarray(0, 12).toString("hex")}`,
      );
    }
    this.emit("audio_frame", pcm);
    if (this.rtspServer) {
      this.rtspServer.broadcastAudio(pcm);
    }
  }

  public isAudioEnabled(): boolean {
    return this.hasAudioStarted;
  }

  private hasAudioStarted: boolean = false;

  // ============= Two-Way Audio (Talkback) =============

  /**
   * Activate camera speaker path (vidicon_audio_play + MST_AUDIOP subscribe).
   * Must be called before startTalkback(). Sends LUMI_TYPE_AUDIO_START (0x1004)
   * with JSON payload to initialize audio playback pipeline.
   */
  public async startAudioPlayback(): Promise<void> {
    if (!this.isConnected) return;
    const payload = JSON.stringify({
      method: "vidicon_audio_play",
      name: "MST_AUDIOP",
      codec: "aac-lc",
      subscribe: "subscribe",
      samplerate: 16000,
      soundmode: "mono",
      bitmode: 16,
    });
    this.sendEncDrw(
      0,
      this.ch0Seq++,
      buildLumiFrame(
        LUMI_TYPE_AUDIO_START,
        Buffer.from(payload),
        this.cmdSeq++,
      ),
    );
    await new Promise<void>((resolve) => {
      const onAudioStarted = () => {
        this.off("audio_started", onAudioStarted);
        resolve();
      };
      this.on("audio_started", onAudioStarted);
      setTimeout(() => {
        this.off("audio_started", onAudioStarted);
        resolve();
      }, 3000);
    });
  }

  /** Begin talkback exactly as the official client does: one empty 0x100A on CH0. */
  public async startTalkback(): Promise<void> {
    if (!this.isConnected) return;
    // Do not confuse a successful login with a usable media session.
    if (!this.p2pSessionReady) {
      console.log(
        "⏳ [Talkback] Waiting for 0x1002/0x1003 media session before 0x100A...",
      );
      const ok = await this.waitForSessionReady(10000);
      if (!ok) {
        console.log(
          "❌ [Talkback] P2P media session not ready — aborting talkback start",
        );
        return;
      }
    }
    this.talkbackActive = true;
    this.hasAudioStarted = true;
    this.talkSeq = 0;
    this.talkFramesSent = 0;
    // Subscribe before 0x100A so a fast 0x100B cannot be missed.
    const accepted = new Promise<void>((resolve) => {
      const onAccepted = (state: string) => {
        if (state !== "accepted") return;
        this.off("talkback", onAccepted);
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.off("talkback", onAccepted);
        console.log(
          "⚠️ [Talkback] 0x100B not received within 3s, sending audio anyway",
        );
        resolve();
      }, 3000);
      this.on("talkback", onAccepted);
    });
    // The official client sends 0x100A (startTalk) then ADTS frames on channel
    // 2, without disconnecting its video session.  0x1004 is the camera-mic
    // subscription command, not a prerequisite for speaker talkback.
    this.sendEncDrw(
      0,
      this.ch0Seq++,
      buildLumiFrame(LUMI_TYPE_TALKBACK_START, Buffer.alloc(0), this.cmdSeq++),
    );
    this.emit("talkback", "started");
    await accepted;
  }

  /**
   * Open the speaker path the way Aqara Home does, including the 11-byte AAC
   * lead frame and the hardware-init pauses. Safe to call repeatedly.
   */
  public async ensureTalkbackReady(): Promise<boolean> {
    if (this.talkbackReady && this.talkbackActive && this.isConnected) {
      return true;
    }
    if (this.talkbackPrepare) return this.talkbackPrepare;
    this.talkbackPrepare = this.prepareTalkbackPath().finally(() => {
      this.talkbackPrepare = null;
    });
    return this.talkbackPrepare;
  }

  private async prepareTalkbackPath(): Promise<boolean> {
    if (!this.isConnected) return false;
    await this.startTalkback();
    if (!this.talkbackActive) return false;
    // Official capture: ~1.94s after 0x100A before the lead frame, then 620ms.
    await new Promise((r) => setTimeout(r, 1940));
    if (!this.talkbackActive || !this.isConnected) return false;
    this.sendAudioFrame(TALKBACK_LEAD_FRAME);
    await new Promise((r) => setTimeout(r, 620));
    this.talkbackReady = this.talkbackActive && this.isConnected;
    return this.talkbackReady;
  }

  /**
   * Wait for Lumi login to complete (sessionStarted = true).
   * Useful for talkback-only mode to ensure authentication before sending 0x100A.
   */
  public async waitForLogin(timeoutMs: number = 10000): Promise<boolean> {
    if (this.sessionStarted) return true;
    if (process.env.DEBUG)
      console.log(
        `⏳ [Login] Waiting for login, sessionStarted=${this.sessionStarted}`,
      );
    return new Promise<boolean>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.sessionStarted) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          if (process.env.DEBUG) console.log(`✅ [Login] Login complete`);
          resolve(true);
        }
      }, 100);
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        if (process.env.DEBUG)
          console.log(
            `❌ [Login] Login timeout, sessionStarted=${this.sessionStarted}`,
          );
        resolve(false);
      }, timeoutMs);
    });
  }

  /** Wait for the actual 0x1002 → 0x1003 media-session handshake. */
  public async waitForSessionReady(
    timeoutMs: number = 10000,
  ): Promise<boolean> {
    if (this.p2pSessionReady) return true;
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const onReady = () => finish(true);
      const finish = (ready: boolean) => {
        clearTimeout(timeout);
        this.off("p2p_session_ready", onReady);
        if (process.env.DEBUG) {
          console.log(
            ready
              ? "✅ [P2P] Media session ready"
              : "❌ [P2P] Media-session timeout",
          );
        }
        resolve(ready);
      };
      this.once("p2p_session_ready", onReady);
    });
  }

  /**
   * Re-fetch a fresh talk signature from the Aqara cloud for the existing app
   * public key (does NOT regenerate the X25519 keypair, so video keeps working).
   */
  private async refreshTalkSign(): Promise<void> {
    if (!this.appPub) return;
    try {
      const signBody = JSON.stringify({
        did: this.did,
        p2pAppPublicKey: this.appPub,
        devPwd: "",
      });
      const signResp = await axios.post(
        `${this.baseUrl}/app/v1.0/lumi/devex/camera/p2p/sign`,
        signBody,
        {
          headers: this.signHeaders(signBody),
          timeout: 15000,
        },
      );
      if (signResp.data?.code === 0 && signResp.data?.result?.sign) {
        this.appSign = signResp.data.result.sign;
        this.signTime = signResp.data.result.time;
      }
    } catch (e: any) {
      if (process.env.DEBUG)
        console.log(
          "[talkback] refreshTalkSign failed, reusing cached sign:",
          e?.message,
        );
    }
  }

  public stopTalkback(): void {
    if (!this.isConnected) return;
    this.talkbackActive = false;
    this.talkbackReady = false;
    this.clearTalkbackRetries();
    this.talkSeq = 0;
    this.talkFramesSent = 0;
    // stopTalkWithCompletion: emits one empty 0x100C on CH0.
    this.sendEncDrw(
      0,
      this.ch0Seq++,
      buildLumiFrame(LUMI_TYPE_TALKBACK_STOP, Buffer.alloc(0), this.cmdSeq++),
    );
    this.emit("talkback", "stopped");
  }

  private talkSeq: number = 0;
  private talkFramesSent?: number;

  private clearTalkbackRetries(): void {
    for (const timer of this.talkbackRetryTimers) clearTimeout(timer);
    this.talkbackRetryTimers.clear();
  }

  /**
   * The Aqara Home packet capture contains multiple identical channel-2 PPCS
   * datagrams (same sequence number) 10–15 ms apart.  This is native PPCS
   * reliability, not repeated AAC samples; the receiver de-duplicates by seq.
   * Our UDP implementation has no native retransmit queue, so reproduce the
   * first four deliveries inside the 64 ms AAC frame interval.
   */
  private sendTalkbackPpcsBody(sequence: number, body: Buffer): void {
    this.sendEncDrw(2, sequence, body);
    // Unit tests intentionally use a minimal socket stub. A real dgram socket
    // has send(); only then schedule the asynchronous retransmissions.
    if (typeof (this.socket as any)?.send !== "function") return;
    for (const delayMs of [12, 24, 36]) {
      const timer = setTimeout(() => {
        this.talkbackRetryTimers.delete(timer);
        if (this.isConnected && this.talkbackActive) {
          this.sendEncDrw(2, sequence, body);
        }
      }, delayMs);
      this.talkbackRetryTimers.add(timer);
    }
  }

  /**
   * Send one complete, plaintext ADTS AAC-LC frame on the application's logical
   * P2P channel 2. The frame includes its 7-byte ADTS header.
   */
  public sendAudioFrame(aac: Buffer): boolean {
    if (!this.isConnected || !this.talkbackActive || !this.socket) return false;
    if (!this.cameraIp || !this.cameraPort) return false;
    if (aac.length < 7 || aac[0] !== 0xff || (aac[1] & 0xf0) !== 0xf0)
      return false;

    // Ensure camera hardware decoder receives the AAC decoder warm-up frame
    // before the first actual audio data frame.
    if (this.talkFramesSent === 0 && !aac.equals(TALKBACK_LEAD_FRAME)) {
      this.sendTalkbackPpcsBody(
        this.talkSeq,
        buildTalkbackPpcsBody(TALKBACK_LEAD_FRAME),
      );
      this.talkSeq = (this.talkSeq + 1) & 0xffff;
      this.talkFramesSent = 1;
      if (process.env.DEBUG) {
        console.log(
          `🔊 [Talkback] sent lead frame ch=2 len=${TALKBACK_LEAD_FRAME.length}`,
        );
      }
    }

    // p2pSendFrame() prepends a 32-byte header (length at offset 28, ADTS at 32).
    // Without this prefix the speaker path accepts 0x100A but silently drops media.
    this.sendTalkbackPpcsBody(this.talkSeq, buildTalkbackPpcsBody(aac));
    this.talkSeq = (this.talkSeq + 1) & 0xffff;
    this.talkFramesSent = (this.talkFramesSent ?? 0) + 1;
    if (process.env.DEBUG) {
      console.log(
        `🔊 [Talkback] sent ADTS frame #${this.talkFramesSent} ch=2 seq=${this.talkSeq} len=${aac.length}`,
      );
    }
    return true;
  }

  // ============= PTZ (Pan / Tilt / Zoom) =============

  private ptzSeq: number = 0;

  /**
   * Pan / Tilt / Zoom control over the P2P channel (0x100A).
   * direction: 'left' | 'right' | 'up' | 'down' | 'stop' | 'zoom_in' | 'zoom_out'
   */
  public ptz(direction: string): void {
    if (!this.isConnected) return;
    const payload = JSON.stringify({ direction, cmd: "ptz", type: 1 });
    this.sendEncDrw(
      0,
      this.ch0Seq++,
      buildLumiFrame(LUMI_TYPE_PTZ, Buffer.from(payload), this.ptzSeq++),
    );
    this.emit("ptz", direction);
  }

  // ============= Offline Session Cache =============

  private cacheDir: string = "data";
  private keyPair: crypto.KeyPairKeyObjectResult | null = null;

  public setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  private cachePath(): string {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch {}
    const safe = this.did.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${this.cacheDir}/keys_${safe}.json`;
  }

  public saveSessionCache(): void {
    if (!this.p2pInfo || !this.keyPair) return;

    try {
      const privJwk = this.keyPair.privateKey.export({ format: "jwk" }) as any;
      const cache = {
        did: this.did,
        savedAt: Date.now(),
        p2pId: this.p2pInfo.p2pId,
        devP2pPublicKey: this.p2pInfo.devP2pPublicKey,
        initStringApp: this.p2pInfo.initStringApp,
        appPrivateKeyJwk: privJwk,
        sign: this.appSign,
        signTime: this.signTime,
      };
      fs.writeFileSync(this.cachePath(), JSON.stringify(cache, null, 2));
      this.emit("info", `Saved offline session cache -> ${this.cachePath()}`);
    } catch (err: any) {
      this.emit("warn", `Failed to save session cache: ${err.message}`);
    }
  }

  public loadSessionCache(): any | null {
    try {
      if (!fs.existsSync(this.cachePath())) return null;
      const raw = fs.readFileSync(this.cachePath(), "utf-8");
      const cache = JSON.parse(raw);
      if (cache.did !== this.did) return null;
      return cache;
    } catch {
      return null;
    }
  }

  /**
   * Max age of a cached offline session. The P2P `sign` is time-limited and, more
   * importantly, reusing a stale / shared session can collide with an already
   * CONNECTED user of the camera (official app, another bridge, …). One hour is
   * the safe ceiling — after that we must re-sign via the cloud.
   */
  public get sessionCacheTtlMs(): number {
    const sec = parseInt(process.env.SESSION_CACHE_TTL_SEC || "3600", 10);
    return Math.max(60, Math.min(3600, sec)) * 1000;
  }

  /**
   * Try to bootstrap the P2P session purely from a previously cached handshake,
   * skipping all Aqara cloud REST calls (works fully offline on the LAN).
   * Returns true if the cached session was applied. Rejects stale caches (>1h).
   */
  public applyCachedSession(): boolean {
    const cache = this.loadSessionCache();
    if (!cache) return false;
    const age = Date.now() - (cache.savedAt || 0);
    if (age > this.sessionCacheTtlMs) {
      this.emit(
        "info",
        `Cached session expired (${(age / 1000) | 0}s > ${(this.sessionCacheTtlMs / 1000) | 0}s); will re-sign via cloud`,
      );
      return false;
    }
    try {
      this.p2pInfo = {
        p2pId: cache.p2pId,
        devP2pPublicKey: cache.devP2pPublicKey,
        initStringApp: cache.initStringApp,
      } as P2PInfo;
      const initStringApp = cache.initStringApp || "";
      const keyPart = initStringApp.includes(":")
        ? initStringApp.split(":")[1]
        : initStringApp || "aqaraus19kn";
      this.ppcsKeyBuf = Buffer.from(keyPart, "ascii");
      this.punchBuf = punchPayload(
        this.p2pInfo.p2pId || "AQARAUS-207160-BRSYM",
      );
      this.appSign = cache.sign;
      this.signTime = cache.signTime;
      this.keyPair = crypto.createPrivateKey({
        key: cache.appPrivateKeyJwk,
        format: "jwk",
      }) as any;

      const devPubBuf = Buffer.from(this.p2pInfo.devP2pPublicKey, "hex");
      const devKeyObj = crypto.createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: devPubBuf.toString("base64url") },
        format: "jwk",
      });
      const sharedSecret = crypto.diffieHellman({
        privateKey: this.keyPair.privateKey,
        publicKey: devKeyObj,
      });
      const videoKeyHex = AqaraStreamDecryptor.deriveKey(
        this.did,
        sharedSecret,
      ).toString("hex");
      this.decryptor = new AqaraStreamDecryptor(videoKeyHex);
      this.emit("info", "Applied cached offline session (no cloud needed)");
      this.emit(
        "warn",
        "⚠️ Using cached P2P session — if the official app or another client is already connected to this camera, this stream may disrupt/kick that session.",
      );
      return true;
    } catch (err: any) {
      this.emit("warn", `Cached session invalid: ${err.message}`);
      return false;
    }
  }

  public stop(): void {
    if (this.talkbackActive && this.socket && this.cameraIp) {
      this.sendEncDrw(
        0,
        this.ch0Seq++,
        buildLumiFrame(LUMI_TYPE_TALKBACK_STOP, Buffer.alloc(0), this.cmdSeq++),
      );
    }
    this.talkbackActive = false;
    this.talkbackReady = false;
    this.isConnected = false;
    this.desiredStreamActive = false;
    this.resurrecting = false;
    this.p2pEstablishing = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.talkbackTimer) {
      clearInterval(this.talkbackTimer);
      this.talkbackTimer = null;
    }
    if (this.mediaKeepaliveTimer) {
      clearInterval(this.mediaKeepaliveTimer);
      this.mediaKeepaliveTimer = null;
    }
    this.clearTalkbackRetries();
    if (this.rtspServer) this.rtspServer.stop();
    if (this.decryptor) {
      this.decryptor.destroy();
      this.decryptor = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    this.resetVideoAssembly();
    this.sessionStarted = false;
    this.p2pSessionReady = false;
    this.isStreamStarted = false;
    this.liveStreamRequested = false;
  }
}
