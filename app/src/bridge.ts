/**
 * Aqara G5 Pro / E1 Camera Bridge
 * Complete P2P video bridge with built-in RTSP server and Home Assistant integration
 */
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { EventEmitter } from 'events';
import axios from 'axios';
import { AqaraStreamDecryptor } from './decryptor.js';
import { isPortAllowed } from './ports.js';

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
}

// ============= Constants =============

export const PPCS_MAGIC = 0xF1;
export const MSG_PUNCH_PKT = 0x41;
export const MSG_P2P_RDY = 0x42;
export const MSG_P2P_RDY_ACK = 0x43;
export const MSG_DRW = 0xD0;
export const MSG_DRW_ACK = 0xD1;
export const MSG_ALIVE = 0xE0;
export const MSG_ALIVE_ACK = 0xE1;
export const PPPP_LAN_PORT = 32108;
export const DRW_MARKER = 0xD1;

export const LUMI_TYPE_LOGIN = 0x1000;
export const LUMI_TYPE_LOGIN_RESP = 0x1001;
export const LUMI_TYPE_SESSION_START = 0x1002;
export const LUMI_TYPE_SESSION_START_RESP = 0x1003;
export const LUMI_TYPE_KEYFRAME_REQ = 0x1018;
export const LUMI_TYPE_KEYFRAME_RESP = 0x1019;
export const LUMI_TYPE_STREAM_START = 0x101C;
export const LUMI_TYPE_STREAM_START_RESP = 0x101D;
export const LUMI_TYPE_KEEPALIVE = 0x1024;
export const LUMI_TYPE_KEEPALIVE_RESP = 0x1025;

// Audio (live mic + two-way talkback), see REPORT4 §4.3
export const LUMI_TYPE_AUDIO_START = 0x1004;
export const LUMI_TYPE_AUDIO_START_RESP = 0x1005;
export const LUMI_TYPE_AUDIO_SEND = 0x1006;        // talkback (app -> camera)
export const LUMI_TYPE_AUDIO_SEND_RESP = 0x1007;
export const LUMI_TYPE_AUDIO_STOP = 0x1008;
// Pan / Tilt / Zoom
export const LUMI_TYPE_PTZ = 0x100A;
// Audio AVIO codec id on media channel
export const AVIO_AUDIO = 0x0088;
export const AVIO_VIDEO_H264 = 0x004E;
export const AVIO_VIDEO_HEVC = 0x004F;

export const PPCS_TABLE = Buffer.from(
  '7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc1' +
  '1fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a3' +
  '88ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb1' +
  '0e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af42' +
  '37d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479' +
  'd24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7' +
  '336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c8' +
  '18e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17',
  'hex'
);

export const DEFAULT_CONFIG = {
  APP_ID: '444c476ef7135e53330f46e7',
  APP_KEY: 'uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi',
  BASE_URL: 'https://aiot-rpc-usa.aqara.com',
  PPPP_LAN_PORT: 32108,
  RTSP_PORT: 8554,
} as const;

export const TUTK_MASTER_SERVERS = [
  '54.71.80.151',
  '54.214.103.243',
  '3.23.78.166',
];

// ============= Crypto & Packet Helpers =============

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

export function getLocalIpv4(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
        return iface.address;
      }
    }
  }
  return '192.168.5.191';
}

export function slugifyStreamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(camera|hub|ip)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isAnnexBKeyframe(data: Buffer, isHevc: boolean): boolean {
  if (!data || data.length < 5) return false;
  const len = data.length;
  let i = 0;
  while (i < len - 4) {
    let prefixLen = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) prefixLen = 3;
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) prefixLen = 4;
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
  const seeds = [
    total & 0xff,
    (-total) & 0xff,
    s3 & 0xff,
    sx & 0xff,
  ];
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
  const seeds = [
    total & 0xff,
    (-total) & 0xff,
    s3 & 0xff,
    sx & 0xff,
  ];
  const out = Buffer.alloc(data.length);
  out[0] = PPCS_TABLE[seeds[0]] ^ data[0];
  let fb = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xff] ^ data[i];
    fb = data[i];
  }
  return out;
}

export function buildPPPP(msgType: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(payload.length, 0);
  return Buffer.concat([
    Buffer.from([PPCS_MAGIC, msgType]),
    lenBuf,
    payload,
  ]);
}

export function punchPayload(p2pId: string): Buffer {
  const [pre, num, suf] = p2pId.split('-');
  const b = Buffer.alloc(20);
  b.write(pre || '', 0, 'ascii');
  b[7] = 0; b[8] = 0;
  const n = parseInt(num || '0', 10);
  b[9] = (n >> 16) & 0xff;
  b[10] = (n >> 8) & 0xff;
  b[11] = n & 0xff;
  b.write(suf || '', 12, 'ascii');
  return b;
}

export function buildLumiFrame(type: number, payload: Buffer, seq: number = 1): Buffer {
  const f = Buffer.alloc(16);
  f.write('lumi', 0, 'ascii');
  f.writeUInt32LE(type, 4);
  f.writeUInt32LE(seq, 8);
  f.writeUInt32LE(payload.length, 12);
  return Buffer.concat([f, payload]);
}

// ============= RTSP Server Implementation =============

interface RtspClient {
  socket: net.Socket;
  session: string;
  isPlaying: boolean;
  receivedKeyframe: boolean;
  cseq: number;
  videoChannel?: number;
  audioChannel?: number;
}

export class RtspServer extends EventEmitter {
  private server: net.Server | null = null;
  private port: number;
  private did: string;
  private clients: Set<RtspClient> = new Set();
  private rtpSeq: number = 0;
  private rtpSsrc: number = Math.floor(Math.random() * 0xFFFFFFFF);
  private videoRtpTimestamp: number = 0;
  private audioRtpSeq: number = 0;
  private audioRtpSsrc: number = Math.floor(Math.random() * 0xFFFFFFFF);
  private audioRtpTimestamp: number = 0;
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
  public vps: Buffer | null = null;
  public sps: Buffer | null = null;
  public pps: Buffer | null = null;
  public lastKeyframe: Buffer | null = null;
  private gopCache: Buffer[] = [];
  // DESCRIBE requests that arrived before SPS/PPS were known are held here
  private pendingDescribes: Array<{ socket: net.Socket; cseq: number | string }> = [];

  /** Call after SPS/PPS are set to flush any pending DESCRIBE responses. */
  public flushPendingDescribes(): void {
    while (this.pendingDescribes.length > 0) {
      const { socket, cseq } = this.pendingDescribes.shift()!;
      this.sendDescribeResponse(socket, cseq);
    }
  }

  private sendDescribeResponse(socket: net.Socket, cseq: number | string): void {
    let videoSdp = '';
    if (this.isHevc) {
      videoSdp =
        `m=video 0 RTP/AVP 96\r\n` +
        `a=rtpmap:96 H265/90000\r\n` +
        `a=control:track0\r\n`;
    } else {
      let fmtpLine = 'a=fmtp:96 packetization-mode=1';
      if (this.sps && this.pps) {
        fmtpLine += `;sprop-parameter-sets=${this.sps.toString('base64')},${this.pps.toString('base64')}`;
      }
      videoSdp =
        `m=video 0 RTP/AVP 96\r\n` +
        `a=rtpmap:96 H264/90000\r\n` +
        `${fmtpLine}\r\n` +
        `a=control:track0\r\n`;
    }

    const audioSdp =
      `m=audio 0 RTP/AVP 97\r\n` +
      `a=rtpmap:97 MPEG4-GENERIC/16000/1\r\n` +
      `a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;config=1408;sizelength=13;indexlength=3;indexdeltalength=3\r\n` +
      `a=control:track1\r\n`;

    const sdp =
      `v=0\r\n` +
      `o=- ${Date.now()} 1 IN IP4 127.0.0.1\r\n` +
      `s=Aqara Camera (${this.did})\r\n` +
      `c=IN IP4 127.0.0.1\r\n` +
      `t=0 0\r\n` +
      videoSdp +
      audioSdp;

    const response =
      `RTSP/1.0 200 OK\r\n` +
      `CSeq: ${cseq}\r\n` +
      `Content-Type: application/sdp\r\n` +
      `Content-Length: ${Buffer.byteLength(sdp)}\r\n\r\n` +
      sdp;
    try { socket.write(response); } catch {}
  }

  constructor(port: number, did: string) {
    super();
    this.port = port;
    this.did = did;
    this.isHevc = did.includes('agl004') || did.includes('g5');
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
          this.emit('listening', this.port);
          this.startVideoPacer();
          resolve();
        });
      };

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 64) {
          // Preferred port is taken — step to the next allowed port and retry,
          // so the server still comes up on a free sequential port.
          attempt++;
          do {
            this.port = this.port + 1;
          } while (!isPortAllowed(this.port));
          this.emit('warn', `RTSP port ${this.port - 1} in use, retrying on ${this.port}`);
          tryListen();
          return;
        }
        this.emit('error', err);
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
      // Adaptive drain: if queue builds up during a UDP burst, drain up to 2 frames per tick
      const count = this.videoQueue.length > 2 ? 2 : 1;
      for (let i = 0; i < count && this.videoQueue.length > 0; i++) {
        const frame = this.videoQueue.shift()!;
        this.sendFrameNow(frame);
      }
    }, 20);
  }

  /** Stop and clean up the video pacer. */
  public stopVideoPacer(): void {
    if (this.videoPacer) { clearInterval(this.videoPacer); this.videoPacer = null; }
    this.videoQueue.length = 0;
  }


  private handleClient(socket: net.Socket): void {
    const client: RtspClient = {
      socket,
      session: crypto.randomBytes(4).toString('hex'),
      isPlaying: false,
      receivedKeyframe: false,
      cseq: 1,
    };
    this.clients.add(client);

    let buf = Buffer.alloc(0);

    socket.on('data', (data) => {
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
        const idx = buf.indexOf(Buffer.from('\r\n\r\n'));
        if (idx === -1) {
          // If buffer starts with unknown non-ascii data, discard leading byte
          if (buf[0] < 0x20 || buf[0] > 0x7E) {
            buf = buf.subarray(1);
            continue;
          }
          break;
        }

        const reqStr = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        if (reqStr.trim().length > 0) {
          this.handleRtspRequest(client, reqStr);
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(client);
    });

    socket.on('error', () => {
      this.clients.delete(client);
    });
  }

  private handleRtspRequest(client: RtspClient, req: string): void {
    const lines = req.split('\r\n');
    const firstLine = lines[0] || '';
    const [method, url] = firstLine.split(' ');
    if (process.env.DEBUG) console.log(`[RTSP REQ] ${method} ${url || ''}`);

    const cseqLine = lines.find((l) => l.toLowerCase().startsWith('cseq:'));
    const cseq = cseqLine ? parseInt(cseqLine.split(':')[1].trim(), 10) : client.cseq;

    switch (method) {
      case 'OPTIONS': {
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case 'GET_PARAMETER':
      case 'SET_PARAMETER': {
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case 'DESCRIBE': {
        const h264NeedsWait = !this.isHevc && !(this.sps && this.pps);
        if (h264NeedsWait) {
          const entry = { socket: client.socket, cseq };
          this.pendingDescribes.push(entry);
          this.emit('need_keyframe');
          setTimeout(() => {
            const idx = this.pendingDescribes.indexOf(entry);
            if (idx !== -1) {
              this.pendingDescribes.splice(idx, 1);
              this.sendDescribeResponse(client.socket, cseq);
            }
          }, 600);
        } else {
          this.sendDescribeResponse(client.socket, cseq);
        }
        break;
      }

      case 'SETUP': {
        const isAudioTrack = (url || '').includes('track1');
        const defaultInterleaved = isAudioTrack ? '2-3' : '0-1';

        const transportLine = lines.find((l) => l.toLowerCase().startsWith('transport:')) || '';
        const transportVal = transportLine.split(':')[1]?.trim() || '';

        let chosenChannel = isAudioTrack ? 2 : 0;
        let transportHeader = `RTP/AVP/TCP;unicast;interleaved=${defaultInterleaved}`;
        if (transportVal.includes('interleaved=')) {
          const match = transportVal.match(/interleaved=([0-9]+)-[0-9]+/);
          if (match) {
            chosenChannel = parseInt(match[1], 10);
            transportHeader = `RTP/AVP/TCP;unicast;interleaved=${match[1]}-${chosenChannel + 1}`;
          }
        } else if (transportVal.toLowerCase().includes('client_port=')) {
          const match = transportVal.match(/client_port=([0-9]+-[0-9]+)/);
          transportHeader = `RTP/AVP;unicast;client_port=${match ? match[1] : (isAudioTrack ? '5002-5003' : '5000-5001')};server_port=${isAudioTrack ? '6002-6003' : '6000-6001'}`;
        }

        if (isAudioTrack) {
          client.audioChannel = chosenChannel;
        } else {
          client.videoChannel = chosenChannel;
        }

        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Transport: ${transportHeader}\r\n` +
          `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case 'PLAY': {
        client.isPlaying = true;
        client.receivedKeyframe = false; // Strictly wait for fresh IDR so client never sees missing reference frames / gray screen
        // NOTE: We send the PLAY OK without RTP-Info seq/rtptime because the actual
        // values are only known when the first IDR arrives. Omitting them is valid
        // per RFC 2326 §12.33 and prevents players from seeing a false reorder gap
        // between the advertised seq and the real first packet seq.
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n` +
          `Range: npt=now-\r\n\r\n`;
        client.socket.write(response);

        // Immediately trigger keyframe generation from camera so fresh IDR arrives in <150ms
        this.emit('need_keyframe');
        break;
      }

      case 'PAUSE': {
        client.isPlaying = false;
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case 'TEARDOWN': {
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
  public broadcastAudio(audioData: Buffer, timestampMs?: number): void {
    if (this.clients.size === 0 || !audioData.length) return;

    // Scan for all ADTS frames in the audio buffer (handles single or multi-frame packets)
    let offset = 0;
    let frameCount = 0;

    while (offset < audioData.length) {
      const remaining = audioData.subarray(offset);
      if (remaining.length >= 7 && remaining[0] === 0xFF && (remaining[1] & 0xF0) === 0xF0) {
        const hasCrc = (remaining[1] & 0x01) === 0;
        const hdrLen = hasCrc ? 9 : 7;
        const adtsLen = ((remaining[3] & 0x03) << 11) | (remaining[4] << 3) | ((remaining[5] & 0xE0) >> 5);
        if (adtsLen <= hdrLen || adtsLen > remaining.length) {
          break;
        }
        const rawAac = remaining.subarray(hdrLen, adtsLen);
        this.sendSingleAacFrame(rawAac, frameCount === 0 ? timestampMs : undefined);
        offset += adtsLen;
        frameCount++;
      } else {
        // If not ADTS formatted (e.g. raw AAC frame passed directly)
        if (frameCount === 0) {
          this.sendSingleAacFrame(audioData, timestampMs);
        }
        break;
      }
    }
  }

  private sendSingleAacFrame(rawAac: Buffer, timestampMs?: number): void {
    if (!rawAac.length) return;

    // AAC LC: always 1024 samples per frame, clock at 16000 Hz.
    // Increment by 1024 per frame with drift compensation against wall clock.
    if (typeof timestampMs === 'number' && timestampMs > 0) {
      this.audioRtpTimestamp = Math.floor((timestampMs * 16) % 0xFFFFFFFF) >>> 0;
    } else if (this.audioRtpTimestamp === 0) {
      if (!this.baseWallClock) this.baseWallClock = Date.now();
      const elapsed = Date.now() - this.baseWallClock;
      this.audioRtpTimestamp = Math.floor(elapsed * 16) >>> 0;
    } else {
      const nextExpected = (this.audioRtpTimestamp + 1024) >>> 0;
      if (this.baseWallClock) {
        const wallClockRtp = Math.floor((Date.now() - this.baseWallClock) * 16) >>> 0;
        const drift = Math.abs(wallClockRtp - nextExpected);
        // If drift exceeds 200ms (3200 ticks at 16kHz), resync to wall clock
        if (drift > 3200) {
          this.audioRtpTimestamp = wallClockRtp;
        } else {
          this.audioRtpTimestamp = nextExpected;
        }
      } else {
        this.audioRtpTimestamp = nextExpected;
      }
    }

    const rtpTimestamp = this.audioRtpTimestamp;

    // RFC 3640 AAC-hbr packet format:
    // [0..1] AU-headers-length = 16 bits (number of bits in the AU-header section)
    // [2..3] AU-header = (auSize << 3) | index (index=0 for single AU)
    // [4..]  Raw AAC frame data
    const auLen = rawAac.length;
    const auHdrBuf = Buffer.alloc(4);
    auHdrBuf.writeUInt16BE(16, 0);              // AU-headers-length: 16 bits
    auHdrBuf.writeUInt16BE((auLen << 3) & 0xFFFF, 2); // AU-header: size+index

    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 0x80 | 97; // Marker bit set, payload type 97
    rtpHeader.writeUInt16BE(this.audioRtpSeq++ & 0xFFFF, 2);
    rtpHeader.writeUInt32BE(rtpTimestamp, 4);
    rtpHeader.writeUInt32BE(this.audioRtpSsrc, 8);

    this.sendInterleavedRtp(2, Buffer.concat([rtpHeader, auHdrBuf, rawAac]));
  }


  /**
   * Enqueue a video frame for smooth, paced delivery to RTSP clients.
   *
   * Frames arrive from the camera in UDP bursts.  Without pacing, a burst of
   * 5 P-frames at once causes VLC's clock to jump (all arrive within ~1 ms),
   * then freeze for the inter-burst gap.  We place frames in a small queue and
   * drain them at a steady 33 ms interval via the pacing timer.
   *
   * Keyframes bypass the depth-drop limit so they always get through.
   * Excess P-frames are dropped from the *front* (oldest) to keep latency low.
   */
  public broadcastFrame(frameData: Buffer, _timestampMs?: number, targetClient?: RtspClient): void {
    if (!frameData.length) return;
    // Direct send for single-client targeted frames or if pacer is not active
    if (targetClient || !this.videoPacer) {
      this.sendFrameNow(frameData, targetClient);
      return;
    }
    // If queue exceeds 60 frames (~2s backlog), flush the whole broken GOP and request IDR
    if (this.videoQueue.length > 60) {
      this.videoQueue.length = 0;
      for (const c of this.clients) {
        c.receivedKeyframe = false;
      }
      this.emit('need_keyframe');
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
      if (frameData[i] === 0 && frameData[i+1] === 0 && frameData[i+2] === 1) prefixLen = 3;
      else if (frameData[i] === 0 && frameData[i+1] === 0 && frameData[i+2] === 0 && frameData[i+3] === 1) prefixLen = 4;
      if (prefixLen === 0) { i++; continue; }
      const nalByte = frameData[i + prefixLen];
      if (this.isHevc) {
        const t = (nalByte >> 1) & 0x3F;
        if (t === 19 || t === 20 || t === 21 || t === 32 || t === 33 || t === 34) return true;
      } else {
        const t = nalByte & 0x1F;
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
      if (start + 3 <= len && frameData[start] === 0 && frameData[start + 1] === 0 && frameData[start + 2] === 1) {
        prefixLen = 3;
      } else if (start + 4 <= len && frameData[start] === 0 && frameData[start + 1] === 0 && frameData[start + 2] === 0 && frameData[start + 3] === 1) {
        prefixLen = 4;
      }

      if (prefixLen > 0) {
        const nalStart = start + prefixLen;
        let nextStart = len;
        for (let i = nalStart; i < len - 3; i++) {
          if (frameData[i] === 0 && frameData[i + 1] === 0 && (frameData[i + 2] === 1 || (frameData[i + 2] === 0 && frameData[i + 3] === 1))) {
            nextStart = i;
            break;
          }
        }
        if (nextStart > nalStart) {
          const rawNal = frameData.subarray(nalStart, nextStart);
          if (rawNal.length > 0) {
            if (this.isHevc) {
              const nalType = (rawNal[0] >> 1) & 0x3F;
              if (nalType <= 40) nalUnits.push(rawNal);
            } else {
              const nalType = rawNal[0] & 0x1F;
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
      if (this.isHevc) {
        const nalType = (frameData[0] >> 1) & 0x3F;
        if (nalType <= 40) nalUnits.push(frameData);
      } else {
        const nalType = frameData[0] & 0x1F;
        if (nalType >= 1 && nalType <= 19) nalUnits.push(frameData);
      }
    }

    let isKeyframe = false;
    let hasSps = false;
    let hasPps = false;
    let hasVps = false;
    for (const nal of nalUnits) {
      if (!nal || !nal.length) continue;
      if (this.isHevc) {
        const nalType = (nal[0] >> 1) & 0x3F;
        if (nalType === 32) { this.vps = Buffer.from(nal); hasVps = true; }
        if (nalType === 33) { this.sps = Buffer.from(nal); hasSps = true; }
        if (nalType === 34) { this.pps = Buffer.from(nal); hasPps = true; }
        if (nalType === 19 || nalType === 20 || nalType === 21) isKeyframe = true;
      } else {
        const nalType = nal[0] & 0x1F;
        if (nalType === 7) { this.sps = Buffer.from(nal); hasSps = true; }
        if (nalType === 8) { this.pps = Buffer.from(nal); hasPps = true; }
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
      for (const c of this.clients) {
        c.receivedKeyframe = true;
      }
    } else if (this.gopCache.length > 0 && this.gopCache.length < 30) {
      this.gopCache.push(frameData);
    }

    // Once we have codec parameters, flush any DESCRIBE responses that were
    // held pending the first keyframe.
    const hasParams = this.isHevc ? (this.vps && this.sps && this.pps) : (this.sps && this.pps);
    if (hasParams && this.pendingDescribes.length > 0) {
      this.flushPendingDescribes();
    }

    let rtpTimestamp: number;
    if (!this.baseWallClock) this.baseWallClock = Date.now();
    const elapsed = Date.now() - this.baseWallClock;
    rtpTimestamp = Math.floor((elapsed * 90) % 0xFFFFFFFF) >>> 0;
    // Enforce strictly monotonic timestamps with a 1ms (+90 ticks) guard
    // so downstream players (VLC, FFmpeg) maintain clean jitter-free playback
    // without runaway clock drift relative to audio.
    const minNext = (this.videoRtpTimestamp + 90) >>> 0;
    if (rtpTimestamp < minNext) {
      rtpTimestamp = minNext;
    }
    this.videoRtpTimestamp = rtpTimestamp;
    const MAX_PAYLOAD_SIZE = 1380;

    for (let n = 0; n < nalUnits.length; n++) {
      const nal = nalUnits[n];
      if (!nal || !nal.length) continue;
      const isLastNal = n === nalUnits.length - 1;

      if (nal.length <= MAX_PAYLOAD_SIZE) {
        const rtpHeader = Buffer.alloc(12);
        rtpHeader[0] = 0x80;
        rtpHeader[1] = (isLastNal ? 0x80 : 0x00) | 96;
        rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xFFFF, 2);
        rtpHeader.writeUInt32BE(rtpTimestamp, 4);
        rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

        this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, nal]), targetClient);
      } else if (this.isHevc) {
        // RFC 7798 H.265 Fragmentation Unit (FU)
        const nalType = (nal[0] >> 1) & 0x3F;
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
          rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xFFFF, 2);
          rtpHeader.writeUInt32BE(rtpTimestamp, 4);
          rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

          let fuHeader = nalType;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const fuPayloadHdr = Buffer.from([payloadHdr1, payloadHdr2, fuHeader]);
          const payloadChunk = nal.subarray(offset, offset + chunkLen);

          this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, fuPayloadHdr, payloadChunk]), targetClient);
          offset += chunkLen;
        }
      } else {
        // RFC 6184 H.264 FU-A Fragmentation
        const nalHeader = nal[0];
        const nalType = nalHeader & 0x1F;
        const nalNri = nalHeader & 0x60;
        let offset = 1;

        while (offset < nal.length) {
          const chunkLen = Math.min(MAX_PAYLOAD_SIZE, nal.length - offset);
          const isStart = offset === 1;
          const isEnd = offset + chunkLen >= nal.length;

          const rtpHeader = Buffer.alloc(12);
          rtpHeader[0] = 0x80;
          rtpHeader[1] = (isLastNal && isEnd ? 0x80 : 0x00) | 96;
          rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xFFFF, 2);
          rtpHeader.writeUInt32BE(rtpTimestamp, 4);
          rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

          const fuIndicator = nalNri | 28;
          let fuHeader = nalType;
          if (isStart) fuHeader |= 0x80;
          if (isEnd) fuHeader |= 0x40;

          const fuHeaderBuf = Buffer.from([fuIndicator, fuHeader]);
          const payloadChunk = nal.subarray(offset, offset + chunkLen);

          this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, fuHeaderBuf, payloadChunk]), targetClient);
          offset += chunkLen;
        }
      }
    }
  }

  private _rtpCount = 0;
  private sendInterleavedRtp(defaultChannel: number, rtpPacket: Buffer, targetClient?: RtspClient): void {
    const isAudio = defaultChannel >= 2;
    const len = rtpPacket.length;

    if (targetClient) {
      if (targetClient.isPlaying && !targetClient.socket.destroyed) {
        const chan = isAudio ? (targetClient.audioChannel ?? defaultChannel) : (targetClient.videoChannel ?? defaultChannel);
        const tcpHeader = Buffer.alloc(4);
        tcpHeader[0] = 0x24; // '$'
        tcpHeader[1] = chan & 0xFF;
        tcpHeader.writeUInt16BE(len, 2);
        try {
          targetClient.socket.write(Buffer.concat([tcpHeader, rtpPacket]));
        } catch { /* ignore */ }
      }
      return;
    }

    for (const client of this.clients) {
      if (client.isPlaying && !client.socket.destroyed) {
        // Drop packets for clients that have not received their initial keyframe yet
        if (!client.receivedKeyframe) {
          continue;
        }
        const chan = isAudio ? (client.audioChannel ?? defaultChannel) : (client.videoChannel ?? defaultChannel);
        const tcpHeader = Buffer.alloc(4);
        tcpHeader[0] = 0x24; // '$'
        tcpHeader[1] = chan & 0xFF;
        tcpHeader.writeUInt16BE(len, 2);
        try {
          client.socket.write(Buffer.concat([tcpHeader, rtpPacket]));
        } catch { /* ignore */ }
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
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
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
  private cmdSeq: number = 10;

  // --- Self-healing P2P state ---
  private desiredStreamActive: boolean = false; // user wants the stream up (HA p2p_stream ON)
  private resurrecting: boolean = false;        // a reconnect attempt is in flight
  private p2pEstablishing: boolean = false;     // connect()/discovery in progress (don't double-run)
  private reconnectAttempts: number = 0;
  private lastVideoFrameAt: number = 0;         // for stall detection
  private lastResurrectAt: number = 0;          // for backoff
  private stallTimeoutMs: number = Math.max(3, parseInt(process.env.STREAM_STALL_TIMEOUT_SEC || '8', 10)) * 1000;
  private reconnectBackoffMs: number = Math.max(2, parseInt(process.env.RECONNECT_BACKOFF_SEC || '4', 10)) * 1000;
  private ch0Seq: number = 0;
  private ch3Seq: number = 0;
  private isConnected: boolean = false;
  private isStreamStarted: boolean = false;

  private p2pInfo: P2PInfo | null = null;
  private ppcsKeyBuf: Buffer = Buffer.alloc(0);
  private punchBuf: Buffer = Buffer.alloc(0);
  private appPub: string = '';
  private appSign: string = '';
  private signTime: string = '';
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
    this.cameraIp = options.cameraIp || null;
    this.cameraPort = options.cameraPort || 0;
    this.baseUrl = options.baseUrl || DEFAULT_CONFIG.BASE_URL;
    this.appId = options.appId || DEFAULT_CONFIG.APP_ID;
    this.appKey = options.appKey || DEFAULT_CONFIG.APP_KEY;
    this.rtspPort = options.rtspPort || DEFAULT_CONFIG.RTSP_PORT;
    const videoKey = options.videoKey || 'fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf';
    this.decryptor = new AqaraStreamDecryptor(videoKey);
  }

  private signHeaders(body: string = ''): Record<string, string> {
    const time = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex').toUpperCase();
    let pre = `Appid=${this.appId}&Nonce=${nonce}&Time=${time}`;
    if (this.token) pre += `&Token=${this.token}`;
    if (body) pre += `&${body}`;
    pre += `&${this.appKey}`;

    return {
      lang: 'en',
      'app-version': '6.1.6',
      'sys-type': '1',
      'sys-version': '14',
      'phone-model': 'Pixel 7',
      appid: this.appId,
      nonce,
      time,
      sign: md5(pre),
      ...(this.token ? { token: this.token } : {}),
      'content-type': 'application/json',
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
    if (process.env.USE_SESSION_CACHE === 'true' && this.applyCachedSession() && this.keyPair) {
      const appPub = Buffer.from((this.keyPair.publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('hex');
      return { appPub, sign: this.appSign };
    }

    const infoUrl = `${this.baseUrl}/app/v1.0/lumi/devex/camera/p2p/info?did=${encodeURIComponent(this.did)}`;
    const infoResp = await axios.get(infoUrl, {
      headers: this.signHeaders(`did=${this.did}`),
      timeout: 15000,
    });

    if (infoResp.data?.code !== 0) {
      throw new Error(`Failed to get P2P info: ${JSON.stringify(infoResp.data)}`);
    }

    this.p2pInfo = infoResp.data.result;
    const initStringApp = this.p2pInfo?.initStringApp || '';
    const keyPart = initStringApp.includes(':') ? initStringApp.split(':')[1] : initStringApp || 'aqaraus19kn';
    this.ppcsKeyBuf = Buffer.from(keyPart, 'ascii');
    this.punchBuf = punchPayload(this.p2pInfo?.p2pId || 'AQARAUS-207160-BRSYM');

    // Generate ephemeral X25519 keypair
    const kp = crypto.generateKeyPairSync('x25519');
    this.keyPair = kp;
    const appPub = Buffer.from((kp.publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('hex');

    const signBody = JSON.stringify({
      did: this.did,
      p2pAppPublicKey: appPub,
      devPwd: '',
    });

    const signResp = await axios.post(`${this.baseUrl}/app/v1.0/lumi/devex/camera/p2p/sign`, signBody, {
      headers: this.signHeaders(signBody),
      timeout: 15000,
    });

    if (signResp.data?.code !== 0) {
      throw new Error(`Failed to get P2P sign: ${JSON.stringify(signResp.data)}`);
    }

    const signResult = signResp.data.result;
    this.appPub = appPub;
    this.appSign = signResult.sign;
    this.signTime = signResult.time;

    // Derive session X25519 Shared Secret key for video decryption
    if (this.p2pInfo?.devP2pPublicKey) {
      try {
        const devPubBuf = Buffer.from(this.p2pInfo.devP2pPublicKey, 'hex');
        const devKeyObj = crypto.createPublicKey({
          key: {
            kty: 'OKP',
            crv: 'X25519',
            x: devPubBuf.toString('base64url'),
          },
          format: 'jwk',
        });
        const sharedSecret = crypto.diffieHellman({
          privateKey: kp.privateKey,
          publicKey: devKeyObj,
        });
        const sharedKeyHex = sharedSecret.toString('hex');
        const videoKeyHex = AqaraStreamDecryptor.deriveKey(this.did, sharedSecret).toString('hex');
        this.decryptor = new AqaraStreamDecryptor(videoKeyHex);
        this.emit('info', `Computed X25519 shared: ${sharedKeyHex}, video key (sha256(did|shared)): ${videoKeyHex}`);
      } catch (err: any) {
        this.emit('warn', `Failed to derive X25519 shared secret: ${err.message}`);
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
  public async start(): Promise<void> {
    this.desiredStreamActive = true;
    this.startWatchdog();
    try {
      await this.connect();
    } catch (err: any) {
      this.p2pEstablishing = false; // let the watchdog retry
      throw err;
    }
  }

  public async connect(): Promise<void> {
    this.p2pEstablishing = true;
    await this.initCloudSession();
    this.socket = dgram.createSocket('udp4');

    // Start RTSP Server — but only once. On resurrection we MUST keep the
    // existing server (and its connected RTSP clients) alive; only the P2P
    // feed underneath is torn down and rebuilt.
    if (!this.rtspServer) {
      try {
        this.rtspServer = new RtspServer(this.rtspPort, this.did);
        if (this.did.includes('agl004') || this.did.includes('g5')) {
          this.rtspServer.isHevc = true;
        }
        this.rtspServer.on('need_keyframe', () => {
          if (this.isConnected) {
            this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_KEYFRAME_REQ, Buffer.alloc(0), this.cmdSeq++));
            this.sendEncDrw(3, this.ch3Seq++, buildLumiFrame(LUMI_TYPE_KEYFRAME_REQ, Buffer.alloc(0), this.cmdSeq++));
          }
        });
        await this.rtspServer.start();
        this.emit('rtsp_ready', `rtsp://0.0.0.0:${this.rtspServer.listenPort}/live/${this.did}`);
      } catch (err: any) {
        this.emit('warn', `RTSP server failed to start on port ${this.rtspPort}: ${err.message}`);
      }
    }

    this.socket.on('message', (msg, rinfo) => {
      this.handleUdpPacket(msg, rinfo);
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
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
        } catch { /* ignore if OS restricts */ }
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
    const ipParts = localIp.split('.').map(Number);
    req20[24] = ipParts[3];
    req20[25] = ipParts[2];
    req20[26] = ipParts[1];
    req20[27] = ipParts[0];

    const queryPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(0x20, req20));
    const helloPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(0x00));
    const punchPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_PUNCH_PKT, this.punchBuf));

    // Stop discovery after a bounded time. Hammering the camera forever would
    // both waste resources and can disrupt an already-connected user/session.
    const timeoutSec = parseInt(process.env.P2P_DISCOVERY_TIMEOUT_SEC || '30', 10);
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
          this.emit('warn', `P2P discovery timed out after ${timeoutSec}s — will retry (stream still desired)`);
        } else {
          this.emit('error', new Error(`P2P discovery timed out after ${timeoutSec}s (camera not reachable / busy by another session)`));
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
      this.socket?.send(Buffer.from([PPCS_MAGIC, 0x30, 0x00, 0x00]), PPPP_LAN_PORT, '255.255.255.255');
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
    if (!this.desiredStreamActive || this.resurrecting || this.p2pEstablishing) return;
    const now = Date.now();
    const stalled = this.isConnected && (now - this.lastVideoFrameAt > this.stallTimeoutMs);
    const dead = !this.isConnected;
    if (dead || stalled) {
      this.resurrect();
    }
  }

  private async resurrect(): Promise<void> {
    if (this.resurrecting) return;
    if (Date.now() - this.lastResurrectAt < this.reconnectBackoffMs) return;
    this.resurrecting = true;
    this.lastResurrectAt = Date.now();
    this.reconnectAttempts++;
    this.emit('warn', `🔌 [${this.did}] Feed lost (attempt #${this.reconnectAttempts}) — resurrecting with fresh session (RTSP server alive)`);

    // Tear down only the P2P plumbing; keep RTSP server + connected clients alive
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.ackTimer) { clearInterval(this.ackTimer); this.ackTimer = null; }
    if (this.talkbackTimer) { clearInterval(this.talkbackTimer); this.talkbackTimer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    this.isConnected = false;
    this.isStreamStarted = false;
    this.hasAudioStarted = false;
    this.sessionStarted = false;
    this.liveStreamRequested = false;
    this.pendingAcks.clear();
    this.ch0Seq = 0;
    this.ch3Seq = 0;
    this.mediaStreamBuffer = Buffer.alloc(0);
    this.lastAudioTs = -1;
    this.lastAudioNonce = null;
    this.emit('disconnected');

    try {
      await this.connect();
    } catch (err: any) {
      this.p2pEstablishing = false; // connect threw before discovery — allow retry
      this.emit('warn', `Resurrection attempt #${this.reconnectAttempts} failed: ${err.message}`);
    } finally {
      this.resurrecting = false;
    }
  }

  private sendEncDrw(chan: number, idx: number, data: Buffer): void {
    if (!this.socket || !this.cameraIp || !this.cameraPort) return;
    const inner = Buffer.concat([Buffer.from([DRW_MARKER, chan, (idx >> 8) & 0xff, idx & 0xff]), data]);
    const h = Buffer.alloc(4);
    h[0] = PPCS_MAGIC;
    h[1] = MSG_DRW;
    h.writeUInt16BE(inner.length, 2);
    const pkt = ppcsEncrypt(this.ppcsKeyBuf, Buffer.concat([h, inner]));
    this.socket.send(pkt, this.cameraPort, this.cameraIp);
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

      const pkt = ppcsEncrypt(this.ppcsKeyBuf, Buffer.concat([ackHdr, ackPayload]));
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
      const punchPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_PUNCH_PKT, this.punchBuf));
      this.socket?.send(punchPkt, port, ip);
      return;
    }

    if (msgType === MSG_PUNCH_PKT) {
      this.cameraIp = rinfo.address;
      this.cameraPort = rinfo.port;
      const punchPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_PUNCH_PKT, this.punchBuf));
      this.socket?.send(punchPkt, this.cameraPort, this.cameraIp);
      const rdyPkt = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_P2P_RDY, this.punchBuf));
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
        if (this.discoveryTimer) clearInterval(this.discoveryTimer);
        this.emit('connected', { ip: this.cameraIp, port: this.cameraPort });
        this.startSessionFlow();
      }
    } else if (msgType === MSG_ALIVE) {
      const ack = ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE_ACK));
      this.socket?.send(ack, rinfo.port, rinfo.address);
    } else if ((msgType === MSG_DRW || msgType === 0xD8) && payload.length >= 4 && payload[0] === DRW_MARKER) {
      const chan = payload[1];
      const idx = payload.readUInt16BE(2);
      const data = payload.subarray(4);

      // Batch send ACK for incoming packet
      this.queueAck(chan, idx);

      if (chan === 0) {
        this.handleChannel0Data(data);
      } else if (chan === 1 || (chan === 4 && (this.did.includes('agl004') || this.did.includes('g5')))) {
        this.handleVideoData(idx, data);
      } else {
        // Channel 3 sync / keepalives or non-active sub-stream
      }
    }
  }

  private startSessionFlow(): void {
    if (!this.socket || !this.cameraIp || !this.cameraPort) return;

    // 1. Send E0 keepalive
    this.socket.send(ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE)), this.cameraPort, this.cameraIp);

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
      this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_LOGIN, Buffer.from(loginJson), this.cmdSeq++));
      loginAttempts++;
      if (loginAttempts < 10 && !this.isStreamStarted) {
        setTimeout(sendLogin, 1000);
      }
    };
    setTimeout(sendLogin, 200);

    // 3. Fast 10ms ACK batch timer
    if (this.ackTimer) clearInterval(this.ackTimer);
    this.ackTimer = setInterval(() => {
      for (const ch of Array.from(this.pendingAcks.keys())) {
        this.flushAcks(ch);
      }
    }, 10);

    // 4. PPCS Keepalive timer (every 2.5s send MSG_ALIVE to maintain UDP NAT hole)
    this.keepaliveTimer = setInterval(() => {
      if (this.socket && this.cameraIp && this.cameraPort) {
        this.socket.send(ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE)), this.cameraPort, this.cameraIp);
      }
    }, 2500);
  }

  private async handleChannel0Data(data: Buffer): Promise<void> {
    if (data.length >= 16 && data.toString('ascii', 0, 4) === 'lumi') {
      const frameType = data.readUInt32LE(4);
      if (process.env.DEBUG) console.log('📨 [Chan 0] frameType: 0x' + frameType.toString(16), 'len:', data.length);
      if (frameType === LUMI_TYPE_LOGIN_RESP) {
        if (!this.sessionStarted) {
          this.sessionStarted = true;
          this.isStreamStarted = true;
          if (process.env.DEBUG) console.log(`📨 [${this.did}] Camera Lumi Login Resp:`, data.subarray(16).toString());

          // Step 1: Session start 0x1002 on Channel 0
          this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_SESSION_START, Buffer.alloc(0), this.cmdSeq++));
        }
      } else if (frameType === LUMI_TYPE_SESSION_START_RESP) {
        if (!this.liveStreamRequested) {
          this.liveStreamRequested = true;
          this.isStreamStarted = true;
          // Step 2: Stream start 0x101C on Channel 3
          this.sendEncDrw(3, this.ch3Seq++, buildLumiFrame(LUMI_TYPE_STREAM_START, Buffer.alloc(0), this.cmdSeq++));

          // Step 3: Stream keyframe 0x1018 on Channel 0
          this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_KEYFRAME_REQ, Buffer.alloc(0), this.cmdSeq++));
        }
      } else if (frameType === LUMI_TYPE_AUDIO_START_RESP) {
        this.hasAudioStarted = true;
        if (process.env.DEBUG) console.log('🔊 [Audio] Start response received');
        this.emit('audio_started');
      } else if (frameType === LUMI_TYPE_AUDIO_SEND_RESP) {
        if (process.env.DEBUG) console.log('🔊 [Talkback] Camera accepted speaker channel');
        this.emit('talkback', 'accepted');
      }
    }
  }

  private frameStartSeq: number = 0;
  private videoFrags: Map<number, Buffer> = new Map();
  private currentExpectedLen: number = 0;
  private currentAccumulatedLen: number = 0;
  private sessionStarted: boolean = false;
  private liveStreamRequested: boolean = false;
  private talkbackActive: boolean = false;
  private talkbackTimer: NodeJS.Timeout | null = null;
  private mediaStreamBuffer: Buffer = Buffer.alloc(0);
  private _firstVideoPkt: boolean = true;
  private _vidPktCount = 0;

  private lastAudioTs: number = -1;
  private lastAudioNonce: Buffer | null = null;

  private async handleVideoData(idx: number, data: Buffer): Promise<void> {
    this._vidPktCount++;
    this.emit('packet_data_ch1', idx, data);

    if (this._firstVideoPkt) {
      this._firstVideoPkt = false;
      if (process.env.DEBUG) {
        console.log(`🎞️ [${this.did}] First media packet: idx=${idx} len=${data.length} hex=${data.subarray(0, 16).toString('hex')}`);
      }
    }

    // 1. Audio AVIO frames (0x0088)
    if (data.length >= 40 && data.readUInt16LE(0) === AVIO_AUDIO) {
      const payLen = data.readUInt32LE(28);
      const frameLen = 40 + payLen;
      if (payLen > 0 && payLen <= 4096 && frameLen <= data.length) {
        const nonce = data.subarray(32, 40);

        // Filter duplicate audio packets (PPCS UDP retries/retransmissions)
        if (this.lastAudioNonce && nonce.equals(this.lastAudioNonce)) {
          return;
        }
        this.lastAudioNonce = Buffer.from(nonce);

        this.processAudioFrame(data.subarray(0, frameLen));
        return;
      }
    }

    // 2. Video AVIO frames (0x004E / 0x004F)
    const isAvioHead = data.length >= 41 &&
      (data.readUInt16LE(0) === 0x004E || data.readUInt16LE(0) === 0x004F) &&
      data.readUInt32LE(28) > 0 && data.readUInt32LE(28) <= 2000000 &&
      data[40] <= 16; // nalCount is 1..16

    if (isAvioHead) {
      if (this.currentExpectedLen > 0 && this.currentAccumulatedLen >= this.currentExpectedLen) {
        this.flushCurrentFrame();
      } else if (this.videoFrags.size > 0) {
        // Previous frame was incomplete (lost UDP fragments) — discard it cleanly to avoid corruption
        this.videoFrags.clear();
        this.currentExpectedLen = 0;
        this.currentAccumulatedLen = 0;
      }

      this.frameStartSeq = idx;
      this.currentExpectedLen = 32 + data.readUInt32LE(28);
      this.currentAccumulatedLen = 0;
    }

    if (this.currentExpectedLen === 0) return;

    const diff = (idx - this.frameStartSeq) & 0xFFFF;
    const maxPkts = Math.ceil(this.currentExpectedLen / 800) + 16;
    if (diff >= 32768 || diff > maxPkts) {
      return;
    }

    if (!this.videoFrags.has(idx)) {
      this.videoFrags.set(idx, data);
      this.currentAccumulatedLen += data.length;
    }

    if (this.currentExpectedLen > 0 && this.currentAccumulatedLen >= this.currentExpectedLen) {
      this.flushCurrentFrame();
    }
  }

  private flushCurrentFrame(): void {
    if (this.videoFrags.size === 0) return;
    const entries = Array.from(this.videoFrags.entries());
    entries.sort(([a], [b]) => ((a - this.frameStartSeq) & 0xFFFF) - ((b - this.frameStartSeq) & 0xFFFF));

    const full = Buffer.concat(entries.map(([, buf]) => buf));
    const expected = this.currentExpectedLen;
    this.videoFrags.clear();
    this.currentExpectedLen = 0;
    this.currentAccumulatedLen = 0;

    if (full.length < 32) return;
    if (expected > 0 && full.length < expected) return;

    const codecId = full.readUInt16LE(0);
    if (codecId !== 0x004E && codecId !== 0x004F) return;

    this.processVideoFrame(full);
  }

  private processVideoFrame(full: Buffer): void {
    const codecId = full.readUInt16LE(0);
    this.frameCount++;

    // Update isHevc from the actual codec so the SDP is accurate.
    if (this.rtspServer) {
      const isHevcFrame = codecId === 0x004F;
      if (this.rtspServer.isHevc !== isHevcFrame && !this.rtspServer.hasPlayingClients()) {
        this.rtspServer.isHevc = isHevcFrame;
      }
    }

    let rawH264: Buffer = full.subarray(32);
    if (this.decryptor && full.length > 48) {
      try {
        const payload = full.subarray(32);
        rawH264 = this.decryptor.decrypt(payload);
      } catch {
        rawH264 = full.subarray(48);
      }
    } else if (full.length > 41) {
      const payload = full.subarray(32);
      const nalCount = payload[8];
      const tableEnd = 9 + nalCount * 8;
      if (nalCount > 0 && tableEnd < payload.length) {
        rawH264 = payload.subarray(tableEnd);
      }
    }

    const isHevcFrame = codecId === 0x004F || (this.rtspServer?.isHevc ?? false);
    const isKeyframe = isAnnexBKeyframe(rawH264, isHevcFrame);

    if (isKeyframe) {
      this.hasSeenKeyframe = true;
    }

    if (!this.hasSeenKeyframe) return;

    this.emit('raw_frame', full);
    this.lastVideoFrameAt = Date.now();

    if (this.rtspServer) {
      let outFrame = rawH264;
      const sc = Buffer.from([0, 0, 0, 1]);
      const hasStartCode = (rawH264.length >= 3 && rawH264[0] === 0 && rawH264[1] === 0 && rawH264[2] === 1) ||
                           (rawH264.length >= 4 && rawH264[0] === 0 && rawH264[1] === 0 && rawH264[2] === 0 && rawH264[3] === 1);

      if (!hasStartCode) {
        outFrame = Buffer.concat([sc, rawH264]);
      }
      if (isKeyframe) {
        this.rtspServer.lastKeyframe = outFrame;
      }
      this.rtspServer.broadcastFrame(outFrame);
    }
    this.emit('frame', { data: rawH264, isKeyframe, timestamp: Date.now() });
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
    this.emit('audio_frame', pcm);
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
   * Begin talkback: ask the camera to open its speaker channel (0x1006).
   * After this, call sendAudioFrame() with G.711 A-law PCM to speak.
   */
  public startTalkback(): void {
    if (!this.isConnected) return;
    this.talkbackActive = true;
    this.hasAudioStarted = true;
    this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_AUDIO_SEND, Buffer.alloc(0), this.cmdSeq++));
    this.emit('talkback', 'started');
  }

  public stopTalkback(): void {
    if (!this.isConnected) return;
    this.talkbackActive = false;
    this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_AUDIO_STOP, Buffer.alloc(0), this.cmdSeq++));
    this.emit('talkback', 'stopped');
  }

  private talkSeq: number = 0;

  /**
   * Send a single G.711 A-law frame (typically 160 bytes / 20ms) to the camera speaker.
   * Encrypted with ChaCha20(key=shareKey, nonce=8B, ctr=0) exactly like incoming audio.
   */
  public sendAudioFrame(g711: Buffer): boolean {
    if (!this.isConnected || !this.talkbackActive || !this.socket || !this.decryptor) return false;
    if (!this.cameraIp || !this.cameraPort) return false;
    const frame = this.decryptor.encryptAudioFrame(g711, this.talkSeq);
    this.sendEncDrw(1, this.talkSeq, frame);
    this.talkSeq = (this.talkSeq + 1) & 0xFFFF;
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
    const payload = JSON.stringify({ direction, cmd: 'ptz', type: 1 });
    this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_PTZ, Buffer.from(payload), this.ptzSeq++));
    this.emit('ptz', direction);
  }

  // ============= Offline Session Cache =============

  private cacheDir: string = 'data';
  private keyPair: crypto.KeyPairKeyObjectResult | null = null;

  public setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  private cachePath(): string {

    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch {}
    const safe = this.did.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${this.cacheDir}/keys_${safe}.json`;
  }

  public saveSessionCache(): void {
    if (!this.p2pInfo || !this.keyPair) return;

    try {
      const privJwk = this.keyPair.privateKey.export({ format: 'jwk' }) as any;
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
      this.emit('info', `Saved offline session cache -> ${this.cachePath()}`);
    } catch (err: any) {
      this.emit('warn', `Failed to save session cache: ${err.message}`);
    }
  }

  public loadSessionCache(): any | null {

    try {
      if (!fs.existsSync(this.cachePath())) return null;
      const raw = fs.readFileSync(this.cachePath(), 'utf-8');
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
    const sec = parseInt(process.env.SESSION_CACHE_TTL_SEC || '3600', 10);
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
      this.emit('info', `Cached session expired (${(age / 1000) | 0}s > ${(this.sessionCacheTtlMs / 1000) | 0}s); will re-sign via cloud`);
      return false;
    }
    try {
      this.p2pInfo = {
        p2pId: cache.p2pId,
        devP2pPublicKey: cache.devP2pPublicKey,
        initStringApp: cache.initStringApp,
      } as P2PInfo;
      const initStringApp = cache.initStringApp || '';
      const keyPart = initStringApp.includes(':') ? initStringApp.split(':')[1] : (initStringApp || 'aqaraus19kn');
      this.ppcsKeyBuf = Buffer.from(keyPart, 'ascii');
      this.punchBuf = punchPayload(this.p2pInfo.p2pId || 'AQARAUS-207160-BRSYM');
      this.appSign = cache.sign;
      this.signTime = cache.signTime;
      this.keyPair = crypto.createPrivateKey({ key: cache.appPrivateKeyJwk, format: 'jwk' }) as any;

      const devPubBuf = Buffer.from(this.p2pInfo.devP2pPublicKey, 'hex');
      const devKeyObj = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: devPubBuf.toString('base64url') },
        format: 'jwk',
      });
      const sharedSecret = crypto.diffieHellman({
        privateKey: this.keyPair.privateKey,
        publicKey: devKeyObj,
      });
      const videoKeyHex = AqaraStreamDecryptor.deriveKey(this.did, sharedSecret).toString('hex');
      this.decryptor = new AqaraStreamDecryptor(videoKeyHex);
      this.emit('info', 'Applied cached offline session (no cloud needed)');
      this.emit('warn', '⚠️ Using cached P2P session — if the official app or another client is already connected to this camera, this stream may disrupt/kick that session.');
      return true;
    } catch (err: any) {
      this.emit('warn', `Cached session invalid: ${err.message}`);
      return false;
    }
  }

  public stop(): void {
    this.isConnected = false;
    this.desiredStreamActive = false;
    this.resurrecting = false;
    this.p2pEstablishing = false;
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.ackTimer) { clearInterval(this.ackTimer); this.ackTimer = null; }
    if (this.talkbackTimer) { clearInterval(this.talkbackTimer); this.talkbackTimer = null; }
    if (this.rtspServer) this.rtspServer.stop();
    if (this.decryptor) {
      this.decryptor.destroy();
      this.decryptor = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    this.mediaStreamBuffer = Buffer.alloc(0);
    this.sessionStarted = false;
    this.liveStreamRequested = false;
  }
}
