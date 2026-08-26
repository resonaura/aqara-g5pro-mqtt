/**
 * Aqara G5 Pro / E1 Camera Bridge
 * Complete P2P video bridge with built-in RTSP server and Home Assistant integration
 */
import * as crypto from 'crypto';
import * as dgram from 'dgram';
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
export const LUMI_TYPE_STREAM_START = 0x101C;
export const LUMI_TYPE_STREAM_START_RESP = 0x101D;
export const LUMI_TYPE_KEEPALIVE = 0x1024;
export const LUMI_TYPE_KEEPALIVE_RESP = 0x1025;

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
}

export class RtspServer extends EventEmitter {
  private server: net.Server | null = null;
  private port: number;
  private did: string;
  private clients: Set<RtspClient> = new Set();
  private rtpSeq: number = 0;
  private rtpSsrc: number = Math.floor(Math.random() * 0xFFFFFFFF);
  private audioRtpSeq: number = 0;
  private audioRtpSsrc: number = Math.floor(Math.random() * 0xFFFFFFFF);
  public isHevc: boolean = false;
  public vps: Buffer | null = null;
  public sps: Buffer | null = null;
  public pps: Buffer | null = null;

  constructor(port: number, did: string) {
    super();
    this.port = port;
    this.did = did;
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

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString('ascii');
      const lines = buffer.split('\r\n\r\n');
      if (lines.length > 1) {
        const request = lines.shift() || '';
        buffer = lines.join('\r\n\r\n');
        this.handleRtspRequest(client, request);
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
        client.socket.write(response);
        break;
      }

      case 'SETUP': {
        const isAudioTrack = (url || '').includes('track1');
        const defaultInterleaved = isAudioTrack ? '2-3' : '0-1';

        const transportLine = lines.find((l) => l.toLowerCase().startsWith('transport:')) || '';
        const transportVal = transportLine.split(':')[1]?.trim() || '';

        let transportHeader = `RTP/AVP/TCP;unicast;interleaved=${defaultInterleaved}`;
        if (transportVal.includes('interleaved=')) {
          const match = transportVal.match(/interleaved=([0-9]+-[0-9]+)/);
          transportHeader = `RTP/AVP/TCP;unicast;interleaved=${match ? match[1] : defaultInterleaved}`;
        } else if (transportVal.toLowerCase().includes('client_port=')) {
          const match = transportVal.match(/client_port=([0-9]+-[0-9]+)/);
          transportHeader = `RTP/AVP;unicast;client_port=${match ? match[1] : (isAudioTrack ? '5002-5003' : '5000-5001')};server_port=${isAudioTrack ? '6002-6003' : '6000-6001'}`;
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
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Session: ${client.session}\r\n` +
          `RTP-Info: url=${url}/track0;seq=${this.rtpSeq}\r\n\r\n`;
        client.socket.write(response);

        // Send cached parameter sets immediately
        if (this.sps && this.pps) {
          const now = Date.now();
          this.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), this.sps, Buffer.from([0, 0, 0, 1]), this.pps]), now);
        }
        // Request instant keyframe from camera
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
  public broadcastAudio(audioData: Buffer, timestampMs: number): void {
    if (this.clients.size === 0 || !audioData.length) return;

    const rtpTimestamp = Math.floor((timestampMs * 8) % 0xFFFFFFFF);
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
  public broadcastFrame(frameData: Buffer, timestampMs: number): void {
    if (this.clients.size === 0 || !frameData.length) return;

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

    const rtpTimestamp = Math.floor((timestampMs * 90) % 0xFFFFFFFF);
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

  private sendInterleavedRtp(channel: number, rtpPacket: Buffer): void {
    const tcpHeader = Buffer.alloc(4);
    tcpHeader[0] = 0x24; // '$'
    tcpHeader[1] = channel & 0xFF;
    tcpHeader.writeUInt16BE(rtpPacket.length, 2);

    const data = Buffer.concat([tcpHeader, rtpPacket]);
    for (const client of this.clients) {
      if (client.isPlaying && !client.socket.destroyed) {
        client.socket.write(data);
      }
    }
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
  private cmdSeq: number = 10;
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
    (this as any).keyPair = kp;
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

    return {
      appPub,
      sign: signResult.sign,
    };
  }

  /**
   * Connect to the camera over P2P/LAN and start RTSP broadcasting
   */
  public async start(): Promise<void> {
    return this.connect();
  }

  public async connect(): Promise<void> {
    await this.initCloudSession();
    this.socket = dgram.createSocket('udp4');

    // Start RTSP Server
    try {
      this.rtspServer = new RtspServer(this.rtspPort, this.did);
      this.rtspServer.on('need_keyframe', () => {
        if (this.isConnected) {
          this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(0x1018, Buffer.alloc(0), this.cmdSeq++));
        }
      });
      await this.rtspServer.start();
      this.emit('rtsp_ready', `rtsp://0.0.0.0:${this.rtspPort}/live/${this.did}`);
    } catch (err: any) {
      this.emit('warn', `RTSP server failed to start on port ${this.rtspPort}: ${err.message}`);
    }

    this.socket.on('message', (msg, rinfo) => {
      this.handleUdpPacket(msg, rinfo);
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
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

    this.discoveryTimer = setInterval(() => {
      if (this.isConnected) return;

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

  private sendAck(chan: number, idx: number): void {
    if (!this.socket || !this.cameraIp || !this.cameraPort) return;
    const ackPayload = Buffer.from([DRW_MARKER, chan, 0x00, 0x01, (idx >> 8) & 0xff, idx & 0xff]);
    const ackHdr = Buffer.from([PPCS_MAGIC, MSG_DRW_ACK, 0x00, 0x06]);
    const pkt = ppcsEncrypt(this.ppcsKeyBuf, Buffer.concat([ackHdr, ackPayload]));
    this.socket.send(pkt, this.cameraPort, this.cameraIp);
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

      // Immediately send ACK for each incoming packet
      this.sendAck(chan, idx);

      if (chan === 0) {
        this.handleChannel0Data(data);
      } else if (chan === 1) {
        this.handleVideoData(idx, data);
      } else {
        console.log(`[DRW OTHER CHAN] chan=${chan}, idx=${idx}, len=${data.length}, hex=${data.subarray(0, 20).toString('hex')}`);
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

    // 3. Keepalive timer
    this.keepaliveTimer = setInterval(() => {
      this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_KEEPALIVE, Buffer.alloc(0), this.cmdSeq++));
    }, 10000);
  }

  private async handleChannel0Data(data: Buffer): Promise<void> {
    if (data.length >= 16 && data.toString('ascii', 0, 4) === 'lumi') {
      const frameType = data.readUInt32LE(4);
      console.log('📨 [Chan 0] frameType: 0x' + frameType.toString(16), 'len:', data.length);
      if (frameType === LUMI_TYPE_LOGIN_RESP && !this.isStreamStarted) {
        this.isStreamStarted = true;
        console.log('📨 Camera Lumi Login Resp:', data.subarray(16).toString());
        // Step 3: Keepalive 0x1024
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_KEEPALIVE, Buffer.alloc(0), this.cmdSeq++));
        await new Promise(r => setTimeout(r, 150));

        // Step 4: Session trigger 0x1002
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(LUMI_TYPE_SESSION_START, Buffer.alloc(0), this.cmdSeq++));
        await new Promise(r => setTimeout(r, 150));

        // Step 4b: Set video stream quality 0x100E (videoStream: 0=2K, 1=1080p, 2=SD)
        const qualityBody = Buffer.alloc(16);
        qualityBody.writeUInt32LE(0, 0); // channel 0
        qualityBody.writeUInt32LE(1, 4); // videoStream: 1 (1080p)
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(0x100e, qualityBody, this.cmdSeq++));
        await new Promise(r => setTimeout(r, 150));

        // Step 5: Stream trigger 0x101C on Channel 3
        this.sendEncDrw(3, this.ch3Seq++, buildLumiFrame(LUMI_TYPE_STREAM_START, Buffer.alloc(0), this.cmdSeq++));
        await new Promise(r => setTimeout(r, 100));

        // Step 6: Stream keyframe / session init 0x1018 on Channel 0
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(0x1018, Buffer.alloc(0), this.cmdSeq++));
        await new Promise(r => setTimeout(r, 100));

        // Step 7: Stream start 0x101C on Channel 3
        this.sendEncDrw(3, this.ch3Seq++, buildLumiFrame(LUMI_TYPE_STREAM_START, Buffer.alloc(0), this.cmdSeq++));
        await new Promise(r => setTimeout(r, 100));

        // Step 8: Audio start 0x1004 on Channel 0
        this.sendEncDrw(0, this.ch0Seq++, buildLumiFrame(0x1004, Buffer.alloc(0), this.cmdSeq++));
      }
    }
  }

  private frameStartSeq: number = 0;
  private videoFrags: Map<number, Buffer> = new Map();
  private currentExpectedLen: number = 0;
  private currentAccumulatedLen: number = 0;

  private async handleVideoData(idx: number, data: Buffer): Promise<void> {
    this.emit('packet_data_ch1', idx, data);
    const isAvioHead = data.length >= 32 &&
      (data.readUInt16LE(0) === 0x004E || data.readUInt16LE(0) === 0x004F) &&
      (data.readUInt32LE(16) >= 320 && data.readUInt32LE(16) <= 4096) &&
      (data.readUInt32LE(20) >= 240 && data.readUInt32LE(20) <= 4096) &&
      (data.readUInt32LE(24) <= 60) &&
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
    this.videoFrags.clear();
    this.currentExpectedLen = 0;
    this.currentAccumulatedLen = 0;

    if (full.length < 32) return;
    const codecId = full.readUInt16LE(0);
    if (codecId !== 0x004E && codecId !== 0x004F) return;

    if (this.rtspServer) {
      this.rtspServer.isHevc = (codecId === 0x004F);
    }

    this.frameCount++;
    let rawH264: Buffer = full.subarray(32);
    if (this.decryptor && full.length > 48) {
      try {
        const payload = full.subarray(32);
        rawH264 = this.decryptor.decrypt(payload);
      } catch {
        rawH264 = full.subarray(48);
      }
    }

    const isKeyframe = (full.length >= 8 && full.readUInt32LE(4) === 1) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x67])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x40])) ||
                       rawH264.includes(Buffer.from([0, 0, 0, 1, 0x42]));

    if (isKeyframe) {
      this.hasSeenKeyframe = true;
    }

    if (!this.hasSeenKeyframe) return;

    this.emit('raw_frame', full);

    if (this.rtspServer) {
      this.rtspServer.broadcastFrame(rawH264, Date.now());
    }
    this.emit('frame', { data: rawH264, isKeyframe, timestamp: Date.now() });
  }

  public stop(): void {
    this.isConnected = false;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
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
}
