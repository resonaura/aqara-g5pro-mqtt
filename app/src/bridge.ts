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
  public isHevc: boolean = false;
  public vps: Buffer | null = null;
  public sps: Buffer | null = null;
  public pps: Buffer | null = null;
  public lastKeyframe: Buffer | null = null;
  // DESCRIBE requests that arrived before SPS/PPS were known are held here
  private pendingDescribes: Array<{ socket: net.Socket; cseq: string }> = [];

  /** Call after SPS/PPS are set to flush any pending DESCRIBE responses. */
  public flushPendingDescribes(): void {
    while (this.pendingDescribes.length > 0) {
      const { socket, cseq } = this.pendingDescribes.shift()!;
      this.sendDescribeResponse(socket, cseq);
    }
  }

  private sendDescribeResponse(socket: net.Socket, cseq: string): void {
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
      `m=audio 0 RTP/AVP 8\r\n` +
      `a=rtpmap:8 PCMA/8000/1\r\n` +
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

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleClient(socket);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.port, () => {
        this.emit('listening', this.port);
        resolve();
      });
    });
  }

  private handleClient(socket: net.Socket): void {
    const client: RtspClient = {
      socket,
      session: crypto.randomBytes(4).toString('hex'),
      isPlaying: false,
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
        // For H.264, hold the DESCRIBE until SPS/PPS are known so FFmpeg
        // receives sprop-parameter-sets in the SDP and can decode immediately.
        // For HEVC, send immediately (no sprop in SDP needed).
        const h264NeedsWait = !this.isHevc && !(this.sps && this.pps);
        if (h264NeedsWait) {
          this.pendingDescribes.push({ socket: client.socket, cseq });
          // NOTE: do NOT emit need_keyframe here — the P2P layer may not be ready yet.
          // The PLAY handler emits it at the correct time.
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
        const cleanUrl = (url || '').replace(/\/+$/, '');
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n` +
          `Range: npt=0.000-\r\n` +
          `RTP-Info: url=${cleanUrl}/track0;seq=${this.rtpSeq}\r\n\r\n`;
        client.socket.write(response);

        // Immediately send cached keyframe to newly playing client
        if (this.lastKeyframe) {
          this.broadcastFrame(this.lastKeyframe, Date.now());
        }

        // Request live IDR from camera
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
   * Broadcast audio frame (PCMA/G.711) as RFC 3551 compliant RTP packets
   */
  public broadcastAudio(audioData: Buffer, timestampMs?: number): void {
    if (this.clients.size === 0 || !audioData.length) return;

    let rtpTimestamp: number;
    if (typeof timestampMs === 'number' && timestampMs > 0) {
      rtpTimestamp = Math.floor((timestampMs * 8) % 0xFFFFFFFF) >>> 0;
    } else {
      this.audioRtpTimestamp = (this.audioRtpTimestamp + (audioData.length || 160)) >>> 0;
      rtpTimestamp = this.audioRtpTimestamp;
    }

    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 8; // PCMA payload type 8
    rtpHeader.writeUInt16BE(this.audioRtpSeq++ & 0xFFFF, 2);
    rtpHeader.writeUInt32BE(rtpTimestamp, 4);
    rtpHeader.writeUInt32BE(this.audioRtpSsrc, 8);

    this.sendInterleavedRtp(2, Buffer.concat([rtpHeader, audioData]));
  }

  /**
   * Broadcast video frame as RFC 6184 (H.264) or RFC 7798 (H.265) compliant RTP packets
   */
  public broadcastFrame(frameData: Buffer, timestampMs?: number): void {
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
          nalUnits.push(frameData.subarray(nalStart, nextStart));
        }
        start = nextStart;
      } else {
        start++;
      }
    }

    if (nalUnits.length === 0) {
      nalUnits.push(frameData);
    }

    for (const nal of nalUnits) {
      if (!nal || !nal.length) continue;
      if (this.isHevc) {
        const nalType = (nal[0] >> 1) & 0x3F;
        if (nalType === 32) this.vps = Buffer.from(nal);
        if (nalType === 33) this.sps = Buffer.from(nal);
        if (nalType === 34) this.pps = Buffer.from(nal);
      } else {
        const nalType = nal[0] & 0x1F;
        if (nalType === 7) this.sps = Buffer.from(nal);
        if (nalType === 8) this.pps = Buffer.from(nal);
      }
    }

    // Once we have codec parameters, flush any DESCRIBE responses that were
    // held pending the first keyframe.
    const hasParams = this.isHevc ? (this.vps && this.sps && this.pps) : (this.sps && this.pps);
    if (hasParams && this.pendingDescribes.length > 0) {
      this.flushPendingDescribes();
    }


    if (this.clients.size === 0) return;
    let rtpTimestamp: number;
    if (typeof timestampMs === 'number' && timestampMs > 0) {
      rtpTimestamp = Math.floor((timestampMs * 90) % 0xFFFFFFFF) >>> 0;
    } else {
      this.videoRtpTimestamp = (this.videoRtpTimestamp + 4500) >>> 0;
      rtpTimestamp = this.videoRtpTimestamp;
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
        rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xFFFF, 2);
        rtpHeader.writeUInt32BE(rtpTimestamp, 4);
        rtpHeader.writeUInt32BE(this.rtpSsrc, 8);

        this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, nal]));
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

          this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, fuPayloadHdr, payloadChunk]));
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

          this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, fuHeaderBuf, payloadChunk]));
          offset += chunkLen;
        }
      }
    }
  }

  private _rtpCount = 0;
  private sendInterleavedRtp(defaultChannel: number, rtpPacket: Buffer): void {
    const isAudio = defaultChannel >= 2;
    for (const client of this.clients) {
      if (client.isPlaying && !client.socket.destroyed) {
        const chan = isAudio ? (client.audioChannel ?? defaultChannel) : (client.videoChannel ?? defaultChannel);
        const tcpHeader = Buffer.alloc(4);
        tcpHeader[0] = 0x24; // '$'
        tcpHeader[1] = chan & 0xFF;
        tcpHeader.writeUInt16BE(rtpPacket.length, 2);
        client.socket.write(Buffer.concat([tcpHeader, rtpPacket]));
        if (process.env.DEBUG && (this._rtpCount++ < 20 || this._rtpCount % 50 === 0)) {
          console.log(`[RTP OUT #${this._rtpCount}] chan=${chan}, len=${rtpPacket.length}, isAudio=${isAudio}`);
        }
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
  private stallTimeoutMs: number = Math.max(5, parseInt(process.env.STREAM_STALL_TIMEOUT_SEC || '15', 10)) * 1000;
  private reconnectBackoffMs: number = Math.max(5, parseInt(process.env.RECONNECT_BACKOFF_SEC || '15', 10)) * 1000;
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
    // Offline-first: reuse a previously cached handshake (no cloud round-trip).
    if (this.applyCachedSession() && this.keyPair) {
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
        this.rtspServer.on('need_keyframe', () => {
          if (this.isConnected) {
            this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_KEYFRAME_REQ, Buffer.alloc(0), this.cmdSeq++));
          }
        });
        await this.rtspServer.start();
        this.emit('rtsp_ready', `rtsp://0.0.0.0:${this.rtspPort}/live/${this.did}`);
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
   * `stallTimeoutMs`), resurrect it — without ever tearing down the RTSP server,
   * so connected RTSP clients just see a brief gap, never a dead stream.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkLiveness(), 5000);
  }

  private checkLiveness(): void {
    if (!this.desiredStreamActive || this.resurrecting || this.p2pEstablishing) return;
    const stalled = this.isConnected && (Date.now() - this.lastVideoFrameAt > this.stallTimeoutMs);
    const dead = !this.isConnected;
    if (dead || stalled) {
      this.resurrect();
    }
  }

  private async resurrect(): Promise<void> {
    if (this.resurrecting || this.p2pEstablishing) return;
    if (Date.now() - this.lastResurrectAt < this.reconnectBackoffMs) return;
    this.resurrecting = true;
    this.lastResurrectAt = Date.now();
    this.reconnectAttempts++;
    this.emit('warn', `🔌 P2P feed lost (attempt #${this.reconnectAttempts}) — resurrecting gracefully (RTSP server kept alive)`);

    // Tear down only the P2P plumbing; keep RTSP server + decryptor intact.
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    this.isConnected = false;
    this.isStreamStarted = false;
    this.hasAudioStarted = false;

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

    if (list.length >= 16) {
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
    let pkt: Buffer = Buffer.from(msg);
    if (pkt[0] !== PPCS_MAGIC) {
      pkt = Buffer.from(ppcsDecrypt(this.ppcsKeyBuf, pkt));
    }
    if (pkt[0] !== PPCS_MAGIC) return;

    const msgType = pkt[1];
    const len = pkt.readUInt16BE(2);
    const payload = pkt.subarray(4, 4 + len);

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
    } else if (msgType === MSG_P2P_RDY) {
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

    // 2. Send Lumi Login (0x1000)
    setTimeout(() => {
      const loginJson = JSON.stringify({
        app_public_key: this.appPub,
        app_sign: this.appSign,
        device_id: this.did,
        timestamp: String(this.signTime || Date.now()),
      });
      this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_LOGIN, Buffer.from(loginJson), this.cmdSeq++));
    }, 200);

    // 3. Start recurring 25ms ACK batch timer
    if (this.ackTimer) clearInterval(this.ackTimer);
    this.ackTimer = setInterval(() => {
      for (const ch of Array.from(this.pendingAcks.keys())) {
        this.flushAcks(ch);
      }
    }, 25);

    // 4. PPCS Keepalive timer (every 5s send MSG_ALIVE to maintain UDP NAT hole)
    this.keepaliveTimer = setInterval(() => {
      if (this.socket && this.cameraIp && this.cameraPort) {
        this.socket.send(ppcsEncrypt(this.ppcsKeyBuf, buildPPPP(MSG_ALIVE)), this.cameraPort, this.cameraIp);
      }
    }, 5000);
  }

  private async handleChannel0Data(data: Buffer): Promise<void> {
    if (data.length >= 16 && data.toString('ascii', 0, 4) === 'lumi') {
      const frameType = data.readUInt32LE(4);
      if (process.env.DEBUG) console.log('📨 [Chan 0] frameType: 0x' + frameType.toString(16), 'len:', data.length);
      if (frameType === LUMI_TYPE_LOGIN_RESP && !this.isStreamStarted) {
        this.isStreamStarted = true;
        if (process.env.DEBUG) console.log(`📨 [${this.did}] Camera Lumi Login Resp:`, data.subarray(16).toString());

        // Step 1: Session start 0x1002 on Channel 0
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_SESSION_START, Buffer.alloc(0), this.cmdSeq++));
      } else if (frameType === LUMI_TYPE_SESSION_START_RESP) {
        // Step 2: Stream start 0x101C on Channel 3
        this.sendEncDrw(3, this.ch3Seq++, buildLumiFrame(LUMI_TYPE_STREAM_START, Buffer.alloc(0), this.cmdSeq++));

        // Step 3: Stream keyframe 0x1018 on Channel 0
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_KEYFRAME_REQ, Buffer.alloc(0), this.cmdSeq++));
      } else if (frameType === LUMI_TYPE_AUDIO_START_RESP) {
        this.hasAudioStarted = true;
        if (process.env.DEBUG) console.log('🔊 [Audio] Start response received; live mic streaming active');
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

  // Audio reassembly state (separate from video to avoid corruption)
  private audioStartSeq: number = 0;
  private audioFrags: Map<number, Buffer> = new Map();
  private audioExpectedLen: number = 0;
  private audioAccumulatedLen: number = 0;
  private talkbackActive: boolean = false;
  private talkbackTimer: NodeJS.Timeout | null = null;

  private _vidPktCount = 0;
  private async handleVideoData(idx: number, data: Buffer): Promise<void> {
    this._vidPktCount++;
    if (process.env.DEBUG && (this._vidPktCount <= 5 || this._vidPktCount % 20 === 0)) {
      console.log(`📦 [Chan 1] Pkt #${this._vidPktCount}: idx=${idx} len=${data.length} codec=0x${data.subarray(0, 2).toString('hex')}`);
    }
    this.emit('packet_data_ch1', idx, data);

    if (this._firstVideoPkt) {
      this._firstVideoPkt = false;
      if (process.env.DEBUG) console.log(`🎞️ [${this.did}] First video packet: idx=${idx} len=${data.length} hex=${data.subarray(0, 16).toString('hex')}`);
    }

    // Audio AVIO frames (0x0088) are interleaved on the same media channel.
    if (data.length >= 2 && data.readUInt16LE(0) === AVIO_AUDIO) {
      await this.handleAudioData(idx, data);
      return;
    }

    const isAvioHead = data.length >= 32 &&
      (data.readUInt16LE(0) === 0x004E || data.readUInt16LE(0) === 0x004F) &&
      (data.readUInt32LE(28) > 0 && data.readUInt32LE(28) <= 2000000);

    if (isAvioHead && this.videoFrags.size > 0) {
      await this.flushCurrentFrame();
    }

    if (isAvioHead) {
      this.frameStartSeq = idx;
      this.currentExpectedLen = 32 + data.readUInt32LE(28);
      this.currentAccumulatedLen = 0;
      this.videoFrags.clear();
    }

    // Only accumulate if we have an active frame (don't accumulate orphan continuations)
    if (this.currentExpectedLen === 0) return;

    this.videoFrags.set(idx, data);
    this.currentAccumulatedLen += data.length;

    if (this.currentExpectedLen > 0 && this.currentAccumulatedLen >= this.currentExpectedLen) {
      await this.flushCurrentFrame();
    }
  }

  private async flushCurrentFrame(): Promise<void> {
    if (this.videoFrags.size === 0) return;
    const entries = Array.from(this.videoFrags.entries());
    entries.sort(([a], [b]) => ((a - this.frameStartSeq) & 0xFFFF) - ((b - this.frameStartSeq) & 0xFFFF));
    const full = Buffer.concat(entries.map(([, buf]) => buf));
    const expected = this.currentExpectedLen;
    this.videoFrags.clear();
    this.currentExpectedLen = 0;
    this.currentAccumulatedLen = 0;

    if (full.length < 32) {
      if (process.env.DEBUG) console.log(`🔴 [flush] SKIP: too short ${full.length}`);
      return;
    }
    if (expected > 0 && full.length < expected) {
      if (process.env.DEBUG) console.warn(`⚠️ Incomplete frame dropped: got ${full.length} / expected ${expected}`);
      return;
    }
    const codecId = full.readUInt16LE(0);
    if (codecId !== 0x004E && codecId !== 0x004F) {
      if (process.env.DEBUG) console.log(`🔴 [flush] SKIP: bad codecId 0x${codecId.toString(16)} len=${full.length}`);
      return;
    }


    this.frameCount++;

    // Update isHevc from the actual codec so the SDP is accurate.
    // Only safe when no RTSP client is yet playing (pre-negotiation).
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

    const isKeyframe = (full.length >= 4 && (full.readUInt16LE(2) === 1 || full.readUInt32LE(4) === 1)) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x67])) ||
                       rawH264.includes(Buffer.from([0, 0, 1, 0x67])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x65])) ||
                       rawH264.includes(Buffer.from([0, 0, 1, 0x65])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x40])) ||
                       rawH264.includes(Buffer.from([0, 0, 1, 0x40])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x42])) ||
                       rawH264.includes(Buffer.from([0, 0, 1, 0x42])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x26])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x28])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x2a]));

    if (isKeyframe) {
      this.hasSeenKeyframe = true;
    }

    if (!this.hasSeenKeyframe) return;

    this.emit('raw_frame', full);

    this.lastVideoFrameAt = Date.now();

    if (this.rtspServer) {
      const hasPlaying = this.rtspServer.hasPlayingClients();
      if (process.env.DEBUG && (hasPlaying || this.frameCount % 100 === 0)) {
        console.log(`🎬 [frame] count=${this.frameCount} keyframe=${isKeyframe} rawLen=${rawH264.length} hasPlaying=${hasPlaying} hasSeenKF=${this.hasSeenKeyframe}`);
      }
      let outFrame = rawH264;
      // For keyframes, prepend SPS+PPS in-band so the decoder can initialize
      // without relying solely on out-of-band sprop-parameter-sets.
      if (isKeyframe && !this.rtspServer.isHevc) {
        const sps = this.rtspServer.sps;
        const pps = this.rtspServer.pps;
        const sc = Buffer.from([0, 0, 0, 1]);
        const parts: Buffer[] = [];
        if (sps) { parts.push(sc); parts.push(sps); }
        if (pps) { parts.push(sc); parts.push(pps); }
        parts.push(rawH264);
        // Only prepend if rawH264 doesn't already START with SPS (0x67)
        const alreadyHasSps = rawH264.length >= 5 && rawH264[0] === 0 && rawH264[1] === 0 &&
          rawH264[2] === 0 && rawH264[3] === 1 && (rawH264[4] & 0x1F) === 7;
        if (!alreadyHasSps && (sps || pps)) {
          outFrame = Buffer.concat(parts);
        }
      } else if (isKeyframe && this.rtspServer.isHevc) {
        const vps = this.rtspServer.vps;
        const sps = this.rtspServer.sps;
        const pps = this.rtspServer.pps;
        const sc = Buffer.from([0, 0, 0, 1]);
        const parts: Buffer[] = [];
        if (vps) { parts.push(sc); parts.push(vps); }
        if (sps) { parts.push(sc); parts.push(sps); }
        if (pps) { parts.push(sc); parts.push(pps); }
        parts.push(rawH264);
        // Only prepend if rawH264 doesn't already START with VPS (NAL type 32)
        const alreadyHasVps = rawH264.length >= 5 && rawH264[0] === 0 && rawH264[1] === 0 &&
          rawH264[2] === 0 && rawH264[3] === 1 && ((rawH264[4] >> 1) & 0x3F) === 32;
        if (!alreadyHasVps && (vps || sps || pps)) {
          outFrame = Buffer.concat(parts);
        }
      }
      if (isKeyframe) {
        this.rtspServer.lastKeyframe = outFrame;
      }
      this.rtspServer.broadcastFrame(outFrame, Date.now());
    }
    this.emit('frame', { data: rawH264, isKeyframe, timestamp: Date.now() });
  }

  public stop(): void {
    this.isConnected = false;
    // User turned the stream off: stop trying to keep it alive.
    this.desiredStreamActive = false;
    this.resurrecting = false;
    this.p2pEstablishing = false;
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.talkbackTimer) clearInterval(this.talkbackTimer);
    if (this.rtspServer) this.rtspServer.stop();
    if (this.decryptor) {
      this.decryptor.destroy();
      this.decryptor = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  // ============= Live Audio Reception =============

  private async handleAudioData(idx: number, data: Buffer): Promise<void> {
    // The media datagram usually contains exactly one complete audio AVIO frame
    // (header 32B + 8B nonce + payload), zero-padded to the UDP MTU. Audio frames
    // are tiny (<200B) so they never span datagrams in practice — process the
    // exact declared length and ignore the padding.
    if (data.length >= 32 && data.readUInt16LE(0) === AVIO_AUDIO) {
      const payLen = data.readUInt32LE(28);
      const frameLen = 40 + payLen; // header(32) + nonce(8) + payload
      if (payLen > 0 && payLen <= 4096 && frameLen <= data.length) {
        this.decryptAndBroadcastAudio(data.subarray(0, frameLen));
        return;
      }
      // Head present but frame extends beyond this datagram -> fragmented path.
      if (payLen > 0 && payLen <= 4096) {
        if (this.audioFrags.size > 0) await this.flushAudioFrame();
        this.audioStartSeq = idx;
        this.audioExpectedLen = frameLen;
        this.audioAccumulatedLen = 0;
        this.audioFrags.clear();
        this.audioFrags.set(idx, data);
        this.audioAccumulatedLen += data.length;
        if (this.audioAccumulatedLen >= this.audioExpectedLen) await this.flushAudioFrame();
        return;
      }
    }
    // Continuation fragment (no head at start) — accumulate for reassembly.
    this.audioFrags.set(idx, data);
    this.audioAccumulatedLen += data.length;
    if (this.audioExpectedLen > 0 && this.audioAccumulatedLen >= this.audioExpectedLen) {
      await this.flushAudioFrame();
    }
  }

  private decryptAndBroadcastAudio(frame: Buffer): void {
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
      this.rtspServer.broadcastAudio(pcm, Date.now());
    }
  }

  private async flushAudioFrame(): Promise<void> {
    if (this.audioFrags.size === 0) return;
    const entries = Array.from(this.audioFrags.entries());
    entries.sort(([a], [b]) => ((a - this.audioStartSeq) & 0xFFFF) - ((b - this.audioStartSeq) & 0xFFFF));
    let full = Buffer.concat(entries.map(([, buf]) => buf));
    this.audioFrags.clear();
    // Keep only the declared frame length; drop trailing fragments / padding.
    if (this.audioExpectedLen > 0 && full.length > this.audioExpectedLen) {
      full = full.subarray(0, this.audioExpectedLen);
    }
    this.audioExpectedLen = 0;
    this.audioAccumulatedLen = 0;

    if (full.length < 40) return;
    if (full.readUInt16LE(0) !== AVIO_AUDIO) return;
    this.decryptAndBroadcastAudio(full);
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
}
