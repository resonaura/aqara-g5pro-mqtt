import * as crypto from "crypto";
import { EventEmitter } from "events";
import * as os from "os";
import { getP2PInfo, signP2PKey } from "./aqara.js";
import { AqaraStreamDecryptor } from "./decryptor.js";
import { NativeMediaEngine } from "./native-engine.js";

// Re-export legacy helpers for tests and backwards compatibility
export * from "./legacy-avio.js";
export * from "./legacy-rtsp.js";

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
  rtspPath?: string;
  videoKey?: string;
  deviceName?: string;
  model?: string;
  p2pQualityChannel?: number;
  transcodeVideo?: boolean;
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
export const LUMI_TYPE_QUALITY = 0x100e;
export const LUMI_TYPE_QUALITY_RESP = 0x100f;
export const LUMI_TYPE_KEEPALIVE = 0x1024;
export const LUMI_TYPE_KEEPALIVE_RESP = 0x1025;

export const LUMI_TYPE_AUDIO_START = 0x1004;
export const LUMI_TYPE_AUDIO_START_RESP = 0x1005;
export const LUMI_TYPE_AUDIO_SEND = 0x1006;
export const LUMI_TYPE_AUDIO_SEND_RESP = 0x1007;
export const LUMI_TYPE_AUDIO_STOP = 0x1008;
export const LUMI_TYPE_TALKBACK_START = 0x100a;
export const LUMI_TYPE_TALKBACK_START_RESP = 0x100b;
export const LUMI_TYPE_TALKBACK_STOP = 0x100c;

export const TALKBACK_LEAD_FRAME = Buffer.from([
  0xff, 0xf9, 0x60, 0x40, 0x01, 0x7f, 0xfc, 0x00, 0xd0, 0x00, 0x07,
]);

export function buildTalkbackPpcsBody(adts: Buffer): Buffer {
  const body = Buffer.alloc(32 + adts.length);
  body.writeUInt32LE(adts.length, 28);
  adts.copy(body, 32);
  return body;
}

export type VideoStreamOption = {
  title: string;
  channel: number;
  minWidth: number;
};

export function videoStreamLadder(model: string): VideoStreamOption[] {
  const m = (model || "").toLowerCase();
  if (m.includes("acn006")) {
    return [
      { title: "1296p", channel: 0, minWidth: 1200 },
      { title: "720p", channel: 1, minWidth: 700 },
      { title: "360p", channel: 2, minWidth: 0 },
    ];
  }
  if (m.includes("agl004") || m.includes("g5")) {
    return [
      { title: "1520p", channel: 3, minWidth: 1400 },
      { title: "1080p", channel: 0, minWidth: 1000 },
      { title: "360p", channel: 2, minWidth: 0 },
    ];
  }
  return [
    { title: "high", channel: 0, minWidth: 1200 },
    { title: "mid", channel: 1, minWidth: 700 },
    { title: "sd", channel: 2, minWidth: 0 },
  ];
}

export function pickMaxVideoStream(model: string, envOverride?: string): VideoStreamOption {
  const ladder = videoStreamLadder(model);
  if (envOverride === "0" || envOverride === "1" || envOverride === "2" || envOverride === "3") {
    const ch = parseInt(envOverride, 10);
    return ladder.find((s) => s.channel === ch) || ladder[0];
  }
  return ladder[0];
}

export function getLocalIpv4(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

const PPCS_TABLE = Buffer.from([
  0x00, 0x51, 0xa2, 0xf3, 0x44, 0x15, 0xe6, 0xb7, 0x88, 0xd9, 0x2a, 0x7b, 0xcc, 0x9d, 0x6e, 0x3f,
  0x10, 0x41, 0xb2, 0xe3, 0x54, 0x05, 0xf6, 0xa7, 0x98, 0xc9, 0x3a, 0x6b, 0xdc, 0x8d, 0x7e, 0x2f,
  0x20, 0x71, 0x82, 0xd3, 0x64, 0x35, 0xc6, 0x97, 0xa8, 0xf9, 0x0a, 0x5b, 0xec, 0xbd, 0x4e, 0x1f,
  0x30, 0x61, 0x92, 0xc3, 0x74, 0x25, 0xd6, 0x87, 0xb8, 0xe9, 0x1a, 0x4b, 0xfc, 0xad, 0x5e, 0x0f,
  0x40, 0x11, 0xe2, 0xb3, 0x04, 0x55, 0xa6, 0xf7, 0xc8, 0x99, 0x6a, 0x3b, 0x8c, 0xdd, 0x2e, 0x7f,
  0x50, 0x01, 0xf2, 0xa3, 0x14, 0x45, 0xb6, 0xe7, 0xd8, 0x89, 0x7a, 0x2b, 0x9c, 0xcd, 0x3e, 0x6f,
  0x60, 0x31, 0xc2, 0x93, 0x24, 0x75, 0x86, 0xd7, 0xe8, 0xb9, 0x4a, 0x1b, 0xac, 0xfd, 0x0e, 0x5f,
  0x70, 0x21, 0xd2, 0x83, 0x34, 0x65, 0x96, 0xc7, 0xf8, 0xa9, 0x5a, 0x0b, 0xbc, 0xed, 0x1e, 0x4f,
  0x80, 0xd1, 0x22, 0x73, 0xc4, 0x95, 0x66, 0x37, 0x08, 0x59, 0xaa, 0xfb, 0x4c, 0x1d, 0xee, 0xbf,
  0x90, 0xc1, 0x32, 0x63, 0xd4, 0x85, 0x76, 0x27, 0x18, 0x49, 0xba, 0xeb, 0x5c, 0x0d, 0xfe, 0xaf,
  0xa0, 0xf1, 0x02, 0x53, 0xe4, 0xb5, 0x46, 0x17, 0x28, 0x79, 0x8a, 0xdb, 0x6c, 0x3d, 0xce, 0x9f,
  0xb0, 0xe1, 0x12, 0x43, 0xf4, 0xa5, 0x56, 0x07, 0x38, 0x69, 0x9a, 0xcb, 0x7c, 0x2d, 0xde, 0x8f,
  0xc0, 0x91, 0x62, 0x33, 0x84, 0xd5, 0x26, 0x77, 0x48, 0x19, 0xea, 0xbb, 0x0c, 0x5d, 0xae, 0xff,
  0xd0, 0x81, 0x72, 0x23, 0x94, 0xc5, 0x36, 0x67, 0x58, 0x09, 0xfa, 0xab, 0x1c, 0x4d, 0xbe, 0xef,
  0xe0, 0xb1, 0x42, 0x13, 0xa4, 0xf5, 0x06, 0x57, 0x68, 0x39, 0xca, 0x9b, 0x2c, 0x7d, 0x8e, 0xdf,
  0xf0, 0xa1, 0x52, 0x03, 0xb4, 0xe5, 0x16, 0x47, 0x78, 0x29, 0xda, 0x8b, 0x3c, 0x6d, 0x9e, 0xcf,
]);

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

export function buildPPPP(msgType: number, payload: Buffer = Buffer.alloc(0)): Buffer {
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

export function buildLumiFrame(type: number, payload: Buffer, seq: number = 1): Buffer {
  const f = Buffer.alloc(16);
  f.write("lumi", 0, "ascii");
  f.writeUInt32LE(type, 4);
  f.writeUInt32LE(seq, 8);
  f.writeUInt32LE(payload.length, 12);
  return Buffer.concat([f, payload]);
}

const DEFAULT_CONFIG = {
  BASE_URL: process.env.AQUARA_URL || "https://aiot-rpc-usa.aqara.com",
  APP_ID: process.env.APPID || "444c476ef7135e53330f46e7",
  APP_KEY: "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi",
  RTSP_PORT: 8555,
};

export class AqaraCameraBridge extends EventEmitter {
  public did: string;
  public token: string;
  public deviceName?: string;
  public model: string;
  public p2pQualityChannel: number = 0;
  public cameraIp: string | null = null;
  public cameraPort: number = 0;
  public baseUrl: string;
  public appId: string;
  public appKey: string;
  public rtspPort: number;
  public rtspPath?: string;
  public isConnected: boolean = false;
  public frameCount: number = 0;
  public droppedGapFrames: number = 0;

  private keyPair: any = null;
  private p2pInfo: P2PInfo | null = null;
  private appPub: string = "";
  private appSign: string = "";
  private signTime: string = "";
  private decryptor: AqaraStreamDecryptor | null = null;
  private talkbackActive = false;
  private p2pSessionReady = false;
  private talkSeq = 0;
  private talkFramesSent = 0;

  constructor(options: BridgeOptions) {
    super();
    this.did = options.did;
    this.token = options.token;
    this.model = options.model || "";
    this.p2pQualityChannel =
      typeof options.p2pQualityChannel === "number" ? options.p2pQualityChannel : 0;
    this.cameraIp = options.cameraIp || null;
    this.cameraPort = options.cameraPort || 0;
    this.baseUrl = options.baseUrl || DEFAULT_CONFIG.BASE_URL;
    this.appId = options.appId || DEFAULT_CONFIG.APP_ID;
    this.appKey = options.appKey || DEFAULT_CONFIG.APP_KEY;
    this.rtspPort = options.rtspPort || DEFAULT_CONFIG.RTSP_PORT;
    this.rtspPath = options.rtspPath;

    const videoKey =
      options.videoKey || "fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf";
    this.decryptor = new AqaraStreamDecryptor(videoKey);
  }

  public async start(): Promise<void> {
    return this.connect(false);
  }

  public async initCloudSession(): Promise<{ appPub: string; sign: string }> {
    this.p2pInfo = await getP2PInfo(this.did);

    this.keyPair = crypto.generateKeyPairSync("x25519");
    const pubJwk = this.keyPair.publicKey.export({ format: "jwk" }) as any;
    this.appPub = Buffer.from(pubJwk.x, "base64url").toString("hex");

    const signRes = await signP2PKey(this.did, this.appPub);
    this.appSign = signRes.sign;
    this.signTime = signRes.time;

    const devPubHex = signRes.p2pDevPublicKey || this.p2pInfo?.devP2pPublicKey;
    if (devPubHex) {
      const devPubDer = Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        Buffer.from(devPubHex, "hex"),
      ]);
      const devPubKey = crypto.createPublicKey({ key: devPubDer, format: "der", type: "spki" });
      const shared = crypto.diffieHellman({
        publicKey: devPubKey,
        privateKey: this.keyPair.privateKey,
      });
      const videoKeyHex = AqaraStreamDecryptor.deriveKey(this.did, shared).toString("hex");
      this.decryptor = new AqaraStreamDecryptor(videoKeyHex);
    }

    return { appPub: this.appPub, sign: this.appSign };
  }

  public async connect(_skipVideo?: boolean): Promise<void> {
    await this.initCloudSession();

    const engine = NativeMediaEngine.getInstance();
    engine.on("p2p_connected", (did: string, ip: string, port: number) => {
      if (did === this.did) {
        this.isConnected = true;
        this.cameraIp = ip;
        this.cameraPort = port;
        this.emit("connected", { ip, port });
      }
    });

    engine.on("session_started", (did: string, port: number) => {
      if (did === this.did) {
        this.isConnected = true;
        this.emit("connected", { port });
      }
    });

    engine.on("session_ready", (did: string) => {
      if (did === this.did) {
        this.p2pSessionReady = true;
        this.isConnected = true;
        this.emit("p2p_session_ready");
        this.emit("stream_started");
        this.emit("keyframe");
      }
    });

    engine.on("keyframe", (did: string) => {
      if (did === this.did) {
        this.emit("keyframe");
        this.emit("stream_started");
      }
    });

    engine.on("talkback_ready", (did: string) => {
      if (did === this.did) {
        this.emit("talkback", "accepted");
      }
    });

    const keyHex = this.decryptor?.getKeyHex() || "";
    engine.startP2p({
      did: this.did,
      p2p_id: this.p2pInfo?.p2pId,
      init_string: this.p2pInfo?.initStringApp,
      app_pub_hex: this.appPub,
      app_sign: this.appSign,
      sign_time: this.signTime,
      dev_pub_hex: this.p2pInfo?.devP2pPublicKey,
      video_key_hex: keyHex,
      audio_key_hex: keyHex,
      camera_ip: this.cameraIp || "",
      camera_port: this.cameraPort || 0,
      rtsp_port: this.rtspPort,
      rtsp_path: this.rtspPath || `live/${this.did}`,
      p2p_quality_channel: this.p2pQualityChannel,
    });
  }

  public async waitForSessionReady(timeoutMs = 10000): Promise<boolean> {
    if (this.p2pSessionReady) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.off("p2p_session_ready", onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("p2p_session_ready", onReady);
    });
  }

  public requestLiveKeyframe(): void {
    NativeMediaEngine.getInstance().requestKeyframe(this.did);
  }

  public ptz(direction: string): void {
    NativeMediaEngine.getInstance().ptz(this.did, direction);
  }

  public async startTalkback(): Promise<boolean> {
    if (!this.isConnected) return false;
    if (!this.p2pSessionReady) {
      console.log("⏳ [Talkback] Waiting for P2P session setup before 0x100A...");
      const ready = await this.waitForSessionReady(10000);
      if (!ready) {
        console.error("❌ [Talkback] P2P media session did not become ready");
        return false;
      }
    }
    this.talkbackActive = true;
    this.talkFramesSent = 0;
    this.talkSeq = 0;
    NativeMediaEngine.getInstance().startTalkback(this.did);
    return true;
  }

  public async ensureTalkbackReady(): Promise<boolean> {
    return this.startTalkback();
  }

  public sendEncDrw(channel: number, _seq: number, payload: Buffer): void {
    if (channel === 2) {
      NativeMediaEngine.getInstance().sendTalkback(this.did, payload);
    }
  }

  public sendTalkbackFrame(adts: Buffer): boolean {
    if (!this.talkbackActive) return false;
    if (this.talkFramesSent === 0 && !adts.equals(TALKBACK_LEAD_FRAME)) {
      const leadBody = buildTalkbackPpcsBody(TALKBACK_LEAD_FRAME);
      this.sendEncDrw(2, this.talkSeq++, leadBody);
    }
    const body = buildTalkbackPpcsBody(adts);
    this.sendEncDrw(2, this.talkSeq++, body);
    this.talkFramesSent++;
    return true;
  }

  public sendAudioFrame(adts: Buffer): boolean {
    return this.sendTalkbackFrame(adts);
  }

  public stopTalkback(): void {
    this.talkbackActive = false;
    NativeMediaEngine.getInstance().stopTalkback(this.did);
  }

  public stop(): void {
    this.isConnected = false;
    NativeMediaEngine.getInstance().stopP2p(this.did);
  }
}
