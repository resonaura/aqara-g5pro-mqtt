/**
 * Aqara G5 Pro / E1 Camera Bridge
 * Complete P2P video bridge with built-in RTSP server and Home Assistant integration
 */
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as net from 'net';
import { EventEmitter } from 'events';
import axios from 'axios';

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
  videoKey?: string; // Hex key for AES-128-CBC video frame decryption
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
export const CHAN_CMD = 0;
export const CHAN_VIDEO = 4;

export const LUMI_TYPE_LOGIN = 0x1000;
export const LUMI_TYPE_COMMAND = 0x1020;
export const LUMI_TYPE_KEEPALIVE = 0x1024;

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

// ============= Crypto & Packet Helpers =============

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
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

export function encodeP2PID(p2pId: string): Buffer {
  const parts = p2pId.split('-');
  const prefix = parts[0] || '';
  const num = parseInt(parts[1] || '0', 10);
  const suffix = parts[2] || '';
  const numBuf = Buffer.alloc(4);
  numBuf.writeUInt32BE(num, 0);
  return Buffer.concat([
    Buffer.from(prefix.padEnd(8, '\0'), 'ascii'),
    numBuf,
    Buffer.from(suffix.padEnd(8, '\0'), 'ascii'),
  ]);
}

export function buildLumiFrame(type: number, payload: Buffer, seq: number = 1): Buffer {
  const headerBuf = Buffer.alloc(12);
  headerBuf.writeUInt32BE(type, 0);
  headerBuf.writeUInt32BE(seq, 4);
  headerBuf.writeUInt32BE(payload.length, 8);
  return Buffer.concat([
    Buffer.from('lumi'),
    headerBuf,
    payload,
  ]);
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
    const [method, url, proto] = firstLine.split(' ');

    const cseqLine = lines.find((l) => l.toLowerCase().startsWith('cseq:'));
    const cseq = cseqLine ? parseInt(cseqLine.split(':')[1].trim(), 10) : client.cseq;

    switch (method) {
      case 'OPTIONS': {
        const response =
          `RTSP/1.0 200 OK\r\n` +
          `CSeq: ${cseq}\r\n` +
          `Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case 'DESCRIBE': {
        const sdp =
          `v=0\r\n` +
          `o=- ${Date.now()} 1 IN IP4 127.0.0.1\r\n` +
          `s=Aqara Camera (${this.did})\r\n` +
          `c=IN IP4 127.0.0.1\r\n` +
          `t=0 0\r\n` +
          `m=video 0 RTP/AVP 96\r\n` +
          `a=rtpmap:96 H264/90000\r\n` +
          `a=fmtp:96 packetization-mode=1\r\n` +
          `a=control:track0\r\n`;

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
        const transportLine = lines.find((l) => l.toLowerCase().startsWith('transport:')) || '';
        const transportVal = transportLine.split(':')[1]?.trim() || '';

        let transportHeader = 'RTP/AVP/TCP;unicast;interleaved=0-1';
        if (transportVal.includes('interleaved=')) {
          const match = transportVal.match(/interleaved=([0-9]+-[0-9]+)/);
          transportHeader = `RTP/AVP/TCP;unicast;interleaved=${match ? match[1] : '0-1'}`;
        } else if (transportVal.toLowerCase().includes('client_port=')) {
          const match = transportVal.match(/client_port=([0-9]+-[0-9]+)/);
          transportHeader = `RTP/AVP;unicast;client_port=${match ? match[1] : '5000-5001'};server_port=6000-6001`;
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
   * Broadcast H.264 video frame as RFC 6184 compliant RTP packets to active RTSP clients
   */
  public broadcastFrame(frameData: Buffer, timestampMs: number): void {
    if (this.clients.size === 0 || !frameData.length) return;

    // Split frame into NAL units (Annex B format)
    const nalUnits: Buffer[] = [];
    let start = 0;
    const len = frameData.length;

    while (start < len) {
      // Find start code (0x000001 or 0x00000001)
      let prefixLen = 0;
      if (start + 3 <= len && frameData[start] === 0 && frameData[start + 1] === 0 && frameData[start + 2] === 1) {
        prefixLen = 3;
      } else if (start + 4 <= len && frameData[start] === 0 && frameData[start + 1] === 0 && frameData[start + 2] === 0 && frameData[start + 3] === 1) {
        prefixLen = 4;
      }

      if (prefixLen > 0) {
        const nalStart = start + prefixLen;
        // Find next start code
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

    // If no start codes found, treat the whole buffer as a single NAL unit
    if (nalUnits.length === 0) {
      nalUnits.push(frameData);
    }

    const rtpTimestamp = Math.floor((timestampMs * 90) % 0xFFFFFFFF);
    const MAX_PAYLOAD_SIZE = 1380;

    for (let n = 0; n < nalUnits.length; n++) {
      const nal = nalUnits[n];
      if (!nal || !nal.length) continue;
      const isLastNal = n === nalUnits.length - 1;

      if (nal.length <= MAX_PAYLOAD_SIZE) {
        // Single NAL unit packet
        const rtpHeader = Buffer.alloc(12);
        rtpHeader[0] = 0x80;
        rtpHeader[1] = (isLastNal ? 0x80 : 0x00) | 96; // Marker bit on last NAL
        rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xFFFF, 2);
        rtpHeader.writeUInt32BE(rtpTimestamp >>> 0, 4);
        rtpHeader.writeUInt32BE(this.rtpSsrc >>> 0, 8);

        const rtpPacket = Buffer.concat([rtpHeader, nal]);
        this.sendInterleavedTcp(0, rtpPacket);
      } else {
        // FU-A Fragmentation
        const nalHeader = nal[0];
        const nalPayload = nal.subarray(1);
        const nalType = nalHeader & 0x1f;
        const nri = nalHeader & 0x60;
        const fuIndicator = nri | 28; // FU-A type 28

        let offset = 0;
        const totalPayloadLen = nalPayload.length;

        while (offset < totalPayloadLen) {
          const isStart = offset === 0;
          const isEnd = offset + MAX_PAYLOAD_SIZE >= totalPayloadLen;
          const chunkSize = Math.min(MAX_PAYLOAD_SIZE, totalPayloadLen - offset);

          let fuHeader = nalType;
          if (isStart) fuHeader |= 0x80; // S bit
          if (isEnd) fuHeader |= 0x40;   // E bit

          const rtpHeader = Buffer.alloc(12);
          rtpHeader[0] = 0x80;
          rtpHeader[1] = (isEnd && isLastNal ? 0x80 : 0x00) | 96;
          rtpHeader.writeUInt16BE(this.rtpSeq++ & 0xFFFF, 2);
          rtpHeader.writeUInt32BE(rtpTimestamp >>> 0, 4);
          rtpHeader.writeUInt32BE(this.rtpSsrc >>> 0, 8);

          const fuPayload = Buffer.concat([
            Buffer.from([fuIndicator, fuHeader]),
            nalPayload.subarray(offset, offset + chunkSize),
          ]);

          const rtpPacket = Buffer.concat([rtpHeader, fuPayload]);
          this.sendInterleavedTcp(0, rtpPacket);
          offset += chunkSize;
        }
      }
    }
  }

  private sendInterleavedTcp(channel: number, rtpPacket: Buffer): void {
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
  private cameraPort: number = PPPP_LAN_PORT;
  private baseUrl: string;
  private appId: string;
  private appKey: string;
  private rtspPort: number;
  private videoKey: Buffer | null = null;

  private socket: dgram.Socket | null = null;
  private rtspServer: RtspServer | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private seq: number = 1;
  private isConnected: boolean = false;

  private p2pInfo: P2PInfo | null = null;
  private ppcsKeyBuf: Buffer = Buffer.alloc(0);
  private sharedSecret: Buffer | null = null;
  private appPub: string = '';
  private appSign: string = '';
  private signTime: string = '';

  constructor(options: BridgeOptions) {
    super();
    this.did = options.did;
    this.token = options.token;
    this.cameraIp = options.cameraIp || null;
    this.cameraPort = options.cameraPort || PPPP_LAN_PORT;
    this.baseUrl = options.baseUrl || DEFAULT_CONFIG.BASE_URL;
    this.appId = options.appId || DEFAULT_CONFIG.APP_ID;
    this.appKey = options.appKey || DEFAULT_CONFIG.APP_KEY;
    this.rtspPort = options.rtspPort || DEFAULT_CONFIG.RTSP_PORT;

    if (options.videoKey) {
      this.videoKey = Buffer.from(options.videoKey, 'hex');
    }
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
    appPriv: string;
    sign: string;
    devPub: string;
  }> {
    // 1. Get p2p/info
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
    const keyPart = initStringApp.includes(':') ? initStringApp.split(':')[1] : initStringApp;
    this.ppcsKeyBuf = Buffer.from(keyPart, 'ascii');

    // 2. Generate ephemeral X25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const appPub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64').toString('hex');
    const appPriv = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64').toString('hex');

    // 3. Request cloud signature for app public key
    const signBody = JSON.stringify({
      did: this.did,
      p2pAppPublicKey: appPub,
      devPwd: '',
    });

    if (this.token) {
      try {
        console.log('📡 Querying cloud for native RTSP credentials & endpoints...');
        const attrResp = await axios.post(
          `${this.baseUrl || DEFAULT_CONFIG.BASE_URL}/app/v1.0/lumi/res/query`,
          { data: [{ options: ['rtsp_url', 'rtsp_enable'], subjectId: this.did }] },
          { headers: { 'Content-Type': 'application/json', token: this.token } }
        );
        const attrs = attrResp.data?.result || [];
        const urlAttr = attrs.find((a: any) => a.attr === 'rtsp_url');
        if (urlAttr?.value) {
          const parsed = JSON.parse(urlAttr.value);
          const nativeUrl = parsed['1520p'] || parsed['1080p'] || parsed['720p'] || parsed['360p'] || Object.values(parsed)[0];
          if (nativeUrl) {
            console.log(`🎥 Native RTSP Stream URL discovered: ${nativeUrl}`);
            this.emit('native_rtsp', nativeUrl);
          }
        }
      } catch (err: any) {
        console.log('⚠️ Could not query native RTSP attributes:', err.message);
      }
    }

    const signResp = await axios.post(`${this.baseUrl}/app/v1.0/lumi/devex/camera/p2p/sign`, signBody, {
      headers: this.signHeaders(signBody),
      timeout: 15000,
    });

    if (signResp.data?.code !== 0) {
      throw new Error(`Failed to get P2P sign: ${JSON.stringify(signResp.data)}`);
    }

    const signResult = signResp.data.result;
    const devPub = signResult?.p2pDevPublicKey || this.p2pInfo?.devP2pPublicKey;

    // 4. Subscribe to camera video activation
    try {
      const subBody = JSON.stringify({
        data: [{ attrs: ['set_video', 'work_mode'], subjectId: this.did }],
      });
      await axios.post(`${this.baseUrl}/app/v1.0/lumi/res/subscribe`, subBody, {
        headers: this.signHeaders(subBody),
        timeout: 15000,
      });
    } catch {
      // Non-critical
    }

    // 5. Compute X25519 shared secret
    if (devPub && devPub.length === 64) {
      try {
        const devPubJwk = {
          kty: 'OKP',
          crv: 'X25519',
          x: Buffer.from(devPub, 'hex').toString('base64url'),
        };
        const pub = crypto.createPublicKey({ key: devPubJwk, format: 'jwk' });
        this.sharedSecret = crypto.diffieHellman({ privateKey, publicKey: pub });
        if (!this.videoKey && this.sharedSecret) {
          this.videoKey = this.sharedSecret;
        }
      } catch (err: any) {
        this.emit('warn', `Could not compute X25519 shared secret: ${err.message}`);
      }
    }

    this.appPub = appPub;
    this.appSign = signResult.sign;
    this.signTime = signResult.time;

    return {
      appPub,
      appPriv,
      sign: signResult.sign,
      devPub,
    };
  }

  /**
   * Connect to the camera over UDP (LAN / PPPP tunnel) and start RTSP server
   */
  public async connect(): Promise<void> {
    await this.initCloudSession();
    this.socket = dgram.createSocket('udp4');

    // Start RTSP Server
    try {
      this.rtspServer = new RtspServer(this.rtspPort, this.did);
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

    // Send discovery / punch packets periodically until connected
    const p2pIdBuf = encodeP2PID(this.p2pInfo?.p2pId || 'AAAA-000000-AAAAA');
    const punchPkt = buildPPPP(MSG_PUNCH_PKT, p2pIdBuf);
    const searchPkt = Buffer.from([PPCS_MAGIC, 0x30, 0x00, 0x00]);

    const sendPunch = () => {
      if (this.isConnected) return;
      if (this.cameraIp) {
        this.socket?.send(punchPkt, this.cameraPort, this.cameraIp);
        this.socket?.send(searchPkt, PPPP_LAN_PORT, this.cameraIp);
      }
      this.socket?.send(punchPkt, PPPP_LAN_PORT, '255.255.255.255');
      this.socket?.send(searchPkt, PPPP_LAN_PORT, '255.255.255.255');
    };

    sendPunch();
    const punchInterval = setInterval(sendPunch, 1000);

    this.on('connected', () => {
      clearInterval(punchInterval);
    });

    // Start keepalive timer
    this.keepaliveTimer = setInterval(() => {
      this.sendKeepalive();
    }, 25000);
  }

  private handleUdpPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < 4 || msg[0] !== PPCS_MAGIC) return;

    const msgType = msg[1];
    const len = msg.readUInt16BE(2);
    const payload = msg.subarray(4, 4 + len);

    console.log(`📥 UDP [0x${msgType.toString(16)}] len=${len} from ${rinfo.address}:${rinfo.port}`);

    switch (msgType) {
      case MSG_PUNCH_PKT: {
        this.cameraIp = rinfo.address;
        this.cameraPort = rinfo.port;
        const p2pIdBuf = payload.length === 20 ? payload : encodeP2PID(this.p2pInfo?.p2pId || 'AAAA-000000-AAAAA');
        const punchPkt = buildPPPP(MSG_PUNCH_PKT, p2pIdBuf);
        this.socket?.send(punchPkt, this.cameraPort, this.cameraIp);

        const rdyPkt = buildPPPP(MSG_P2P_RDY);
        this.socket?.send(rdyPkt, this.cameraPort, this.cameraIp);
        console.log(`🤝 Exchanging PUNCH & RDY with ${this.cameraIp}:${this.cameraPort}`);
        break;
      }

      case MSG_P2P_RDY: {
        this.cameraIp = rinfo.address;
        this.cameraPort = rinfo.port;
        const ack = buildPPPP(MSG_P2P_RDY_ACK);
        this.socket?.send(ack, this.cameraPort, this.cameraIp);
        console.log(`🎉 P2P RDY confirmed with ${this.cameraIp}:${this.cameraPort}, sending Lumi Login...`);
        this.sendLumiLogin();
        break;
      }

      case MSG_P2P_RDY_ACK: {
        this.cameraIp = rinfo.address;
        this.cameraPort = rinfo.port;
        console.log(`🎉 P2P RDY_ACK received from ${this.cameraIp}:${this.cameraPort}, sending Lumi Login...`);
        this.sendLumiLogin();
        break;
      }

      case MSG_ALIVE: {
        const ack = buildPPPP(MSG_ALIVE_ACK);
        this.socket?.send(ack, rinfo.port, rinfo.address);
        console.log(`💓 ALIVE packet acknowledged with ${rinfo.address}:${rinfo.port}`);
        break;
      }

      case MSG_DRW: {
        // Decrypt PPCS payload
        const decrypted = ppcsDecrypt(this.ppcsKeyBuf, payload);
        if (decrypted.length >= 4 && decrypted[0] === DRW_MARKER) {
          const channel = decrypted[1];
          const index = decrypted.readUInt16BE(2);

          // Send DRW ACK immediately
          const ackPayload = Buffer.from([channel, (index >> 8) & 0xff, index & 0xff, 0x00]);
          const ackPkt = buildPPPP(MSG_DRW_ACK, ackPayload);
          this.socket?.send(ackPkt, rinfo.port, rinfo.address);

          const lumiPayload = decrypted.subarray(4);
          this.handleLumiFrame(channel, lumiPayload);
        }
        break;
      }
    }
  }

  private sendLumiLogin(): void {
    if (!this.socket || !this.cameraIp) return;

    const loginPayload = JSON.stringify({
      app_pub: this.appPub,
      app_sign: this.appSign,
      device_id: this.did,
      did: this.did,
      p2pAppPublicKey: this.appPub,
      sign: this.appSign,
      time: this.signTime ? parseInt(this.signTime, 10) : Date.now(),
    });

    // 1. Send Lumi-format login on channel 0
    const lumiFrame = buildLumiFrame(LUMI_TYPE_LOGIN, Buffer.from(loginPayload), this.seq++);
    const drwHeader1 = Buffer.from([CHAN_CMD, (this.seq >> 8) & 0xff, this.seq & 0xff, 0x00]);
    const packetData1 = Buffer.concat([drwHeader1, lumiFrame]);
    const encrypted1 = ppcsEncrypt(this.ppcsKeyBuf, packetData1);
    this.socket.send(buildPPPP(MSG_DRW, encrypted1), this.cameraPort, this.cameraIp);

    // 2. Also send AVIO-format auth request (0x1000)
    const avioAuthHdr = Buffer.alloc(4);
    avioAuthHdr.writeUInt16LE(0x1000, 0);
    avioAuthHdr.writeUInt16LE(loginPayload.length, 2);
    const avioPkt = Buffer.concat([avioAuthHdr, Buffer.from(loginPayload)]);
    const drwHeader2 = Buffer.from([CHAN_CMD, (this.seq >> 8) & 0xff, this.seq & 0xff, 0x00]);
    const packetData2 = Buffer.concat([drwHeader2, avioPkt]);
    const encrypted2 = ppcsEncrypt(this.ppcsKeyBuf, packetData2);
    this.socket.send(buildPPPP(MSG_DRW, encrypted2), this.cameraPort, this.cameraIp, () => {
      this.isConnected = true;
      this.emit('connected', { ip: this.cameraIp, port: this.cameraPort });

      // Send start stream commands over channel 0
      setTimeout(() => {
        this.sendStartStreamCommand();
      }, 300);
    });
  }

  private sendStartStreamCommand(): void {
    if (!this.socket || !this.cameraIp) return;

    const startCmd = JSON.stringify({
      cmd: 'start_stream',
      channel: 4,
      quality: 'high',
      stream: 'live',
      time: Date.now(),
    });

    // 1. Lumi format start command
    const lumiFrame = buildLumiFrame(LUMI_TYPE_COMMAND, Buffer.from(startCmd), this.seq++);
    const drwHeader1 = Buffer.from([CHAN_CMD, (this.seq >> 8) & 0xff, this.seq & 0xff, 0x00]);
    const encrypted1 = ppcsEncrypt(this.ppcsKeyBuf, Buffer.concat([drwHeader1, lumiFrame]));
    this.socket.send(buildPPPP(MSG_DRW, encrypted1), this.cameraPort, this.cameraIp);

    // 2. AVIO struct start stream request (0x1020)
    const startAvioHdr = Buffer.alloc(4);
    startAvioHdr.writeUInt16LE(0x1020, 0);
    startAvioHdr.writeUInt16LE(8, 2);
    const streamPayload = Buffer.alloc(8); // channel 0, stream 0
    const avioPacket = Buffer.concat([startAvioHdr, streamPayload]);
    const drwHeader2 = Buffer.from([CHAN_CMD, (this.seq >> 8) & 0xff, this.seq & 0xff, 0x00]);
    const encrypted2 = ppcsEncrypt(this.ppcsKeyBuf, Buffer.concat([drwHeader2, avioPacket]));
    this.socket.send(buildPPPP(MSG_DRW, encrypted2), this.cameraPort, this.cameraIp);
  }

  private sendKeepalive(): void {
    if (!this.isConnected || !this.socket || !this.cameraIp) return;

    const lumiFrame = buildLumiFrame(LUMI_TYPE_KEEPALIVE, Buffer.alloc(0), this.seq++);
    const drwHeader = Buffer.from([DRW_MARKER, CHAN_CMD, 0x00, 0x01]);
    const packetData = Buffer.concat([drwHeader, lumiFrame]);
    const encrypted = ppcsEncrypt(this.ppcsKeyBuf, packetData);
    const ppppPacket = buildPPPP(MSG_DRW, encrypted);

    this.socket.send(ppppPacket, this.cameraPort, this.cameraIp);
  }

  private handleLumiFrame(channel: number, data: Buffer): void {
    if (data.subarray(0, 4).toString('ascii') !== 'lumi') return;

    const frameType = data.readUInt32BE(4);
    const seq = data.readUInt32BE(8);
    const len = data.readUInt32BE(12);
    const payload = data.subarray(16, 16 + len);

    if (channel === CHAN_VIDEO) {
      this.handleVideoPayload(payload);
    } else {
      this.emit('command', { frameType, seq, payload });
    }
  }

  private handleVideoPayload(payload: Buffer): void {
    if (payload.length < 24) return;

    const header: P2PFrameHeader = {
      frmNo: payload.readUInt32LE(0),
      codecId: payload.readUInt32LE(4),
      flags: payload.readUInt32LE(8),
      camIndex: payload.readUInt32LE(12),
      iFrameIndex: payload.readUInt32LE(16),
      timestamp: Number(payload.readBigUInt64LE ? payload.readBigUInt64LE(16) : payload.readUInt32LE(16)),
    };

    const encryptedVideo = payload.subarray(24);
    let decryptedData = encryptedVideo;

    if (this.videoKey && encryptedVideo.length >= 16) {
      try {
        const iv = encryptedVideo.subarray(0, 16);
        const ciphertext = encryptedVideo.subarray(16);
        const decipher = crypto.createDecipheriv('aes-128-cbc', this.videoKey.subarray(0, 16), iv);
        decipher.setAutoPadding(false);
        decryptedData = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (err: any) {
        // If AES fails, fallback to raw
      }
    }

    const frame: VideoFrame = {
      header,
      data: decryptedData,
      timestamp: header.timestamp || Date.now(),
    };

    this.emit('frame', frame);

    // Broadcast frame to RTSP clients
    if (this.rtspServer && decryptedData.length > 0) {
      this.rtspServer.broadcastFrame(decryptedData, frame.timestamp);
    }
  }

  /**
   * Stop the bridge, release UDP sockets and stop RTSP server
   */
  public disconnect(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.rtspServer) {
      this.rtspServer.stop();
      this.rtspServer = null;
    }
    this.isConnected = false;
    this.emit('disconnected');
  }
}