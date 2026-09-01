import * as net from "net";
import * as dgram from "dgram";
import * as crypto from "crypto";
import * as os from "os";
import { EventEmitter } from "events";
import { isPortAllowed } from "./ports.js";

function getLocalIpv4(): string {
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

function stripV4Mapped(addr: string): string {
  if (addr.startsWith("::ffff:")) return addr.substring(7);
  return addr;
}

function localIPv4Set(): Set<string> {
  const set = new Set<string>(["127.0.0.1", "localhost"]);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4") set.add(net.address);
    }
  }
  return set;
}

function ntpTimestamp(): { sec: number; frac: number } {
  const unixMs = Date.now();
  const unixSec = Math.floor(unixMs / 1000);
  const ntpSec = (unixSec + 2208988800) >>> 0;
  const frac = Math.round(((unixMs % 1000) / 1000) * 0x100000000) >>> 0;
  return { sec: ntpSec, frac };
}

export interface RTSPClient {
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
  mediaPumped?: boolean;
  waitLiveIdr?: boolean;
}

export type RtspClient = RTSPClient;

export class RTSPServer extends EventEmitter {
  private server: net.Server | null = null;
  private rtpUdp: dgram.Socket | null = null;
  private rtpUdp6: dgram.Socket | null = null;
  private rtpUdpPort: number = 0;
  public port: number;
  public did: string;
  private clients: Set<RtspClient> = new Set();
  private rtpSeq: number = 1 + Math.floor(Math.random() * 0xfffe);
  private rtpSsrc: number = Math.floor(Math.random() * 0xffffffff);
  private videoRtpTimestamp: number = 1 + Math.floor(Math.random() * 0x0fffffff);
  private lastVideoRtpTimestamp: number = this.videoRtpTimestamp;
  private lastVideoSendAt: number = 0;
  private audioRtpSeq: number = 1 + Math.floor(Math.random() * 0xfffe);
  private audioRtpSsrc: number = Math.floor(Math.random() * 0xffffffff);
  private audioRtpTimestamp: number = 1 + Math.floor(Math.random() * 0x0fffffff);
  private lastAudioRtpTimestamp: number = this.audioRtpTimestamp;

  private videoQueue: Buffer[] = [];
  private videoPacer: NodeJS.Timeout | null = null;
  private audioQueue: Buffer[] = [];
  private audioPacer: NodeJS.Timeout | null = null;
  private audioPacerPrimed: boolean = false;
  private audioIngressCount = 0;
  private audioSentCount = 0;
  private audioPacerUnderruns = 0;
  private readonly AUDIO_PRIMER_FRAMES = 32;
  private readonly PACER_INTERVAL_MS = 1000 / 15;

  public isHevc: boolean = false;
  public audioMode: "aac" | "pcma" = "aac";
  public vps: Buffer | null = null;
  public sps: Buffer | null = null;
  public pps: Buffer | null = null;
  public lastKeyframe: Buffer | null = null;
  public lastAudio: Buffer | null = null;
  private rtcpTimer: NodeJS.Timeout | null = null;
  private videoPktCount = 0;
  private videoOctetCount = 0;
  private audioPktCount = 0;
  private audioOctetCount = 0;
  private pendingDescribes: Array<{ socket: net.Socket; cseq: number | string }> = [];

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
        ? `m=audio 0 RTP/AVP 8\r\n` + `a=rtpmap:8 PCMA/8000/1\r\n` + `a=control:track1\r\n`
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
  }

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
          this.rtpUdp.on("error", (e) => console.warn(`[RTSP] UDP4 error: ${e.message}`));
          this.rtpUdp6.on("error", () => {});
          let started = false;
          const finishStart = () => {
            if (started) return;
            started = true;
            try {
              this.rtpUdp6!.bind(0);
            } catch {}
            this.emit("listening", this.port);
            this.startAudioPacer();
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
          attempt++;
          do {
            this.port = this.port + 1;
          } while (!isPortAllowed(this.port));
          this.emit("warn", `RTSP port ${this.port - 1} in use, retrying on ${this.port}`);
          tryListen();
          return;
        }
        this.emit("error", err);
        reject(err);
      });

      tryListen();
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.rtpUdp) {
      this.rtpUdp.close();
      this.rtpUdp = null;
    }
    if (this.rtpUdp6) {
      this.rtpUdp6.close();
      this.rtpUdp6 = null;
    }
    this.stopAudioPacer();
    this.stopVideoPacer();
    this.stopRtcp();
    for (const c of this.clients) {
      c.socket.destroy();
    }
    this.clients.clear();
  }

  public stopVideoPacer(): void {
    if (this.videoPacer) {
      clearInterval(this.videoPacer);
      this.videoPacer = null;
    }
    this.videoQueue.length = 0;
  }

  public startVideoPacer(): void {
    if (this.videoPacer) return;
    this.videoPacer = setInterval(() => {
      if (this.videoQueue.length === 0) return;
      if (this.videoQueue.length > 45) {
        while (this.videoQueue.length > 1 && !this.frameIsKeyframe(this.videoQueue[0])) {
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

  private frameIsKeyframe(frameData: Buffer): boolean {
    if (!frameData || frameData.length < 5) return false;
    let i = 0;
    while (i < frameData.length - 4) {
      let prefixLen = 0;
      if (frameData[i] === 0 && frameData[i + 1] === 0 && frameData[i + 2] === 1) prefixLen = 3;
      else if (
        frameData[i] === 0 &&
        frameData[i + 1] === 0 &&
        frameData[i + 2] === 0 &&
        frameData[i + 3] === 1
      )
        prefixLen = 4;
      if (prefixLen > 0) {
        const nalType = this.isHevc
          ? (frameData[i + prefixLen] >> 1) & 0x3f
          : frameData[i + prefixLen] & 0x1f;
        if (this.isHevc) {
          if (
            nalType === 19 ||
            nalType === 20 ||
            nalType === 21 ||
            nalType === 32 ||
            nalType === 33 ||
            nalType === 34
          )
            return true;
        } else {
          if (nalType === 5 || nalType === 7 || nalType === 8) return true;
        }
        i += prefixLen + 1;
      } else {
        i++;
      }
    }
    return false;
  }

  private startAudioPacer(): void {
    if (this.audioPacer) return;
    this.audioPacer = setInterval(() => {
      if (!this.audioPacerPrimed) {
        if (this.audioQueue.length < this.AUDIO_PRIMER_FRAMES) return;
        this.audioPacerPrimed = true;
      }
      if (this.audioQueue.length === 0) {
        this.audioPacerUnderruns++;
        this.audioPacerPrimed = false;
        return;
      }
      if (this.audioQueue.length > 64) {
        this.audioQueue.splice(0, this.audioQueue.length - this.AUDIO_PRIMER_FRAMES);
      }
      const frame = this.audioQueue.shift();
      if (frame) {
        this.audioSentCount++;
        this.sendSingleAacFrame(frame);
      }
    }, 64);
  }

  private stopAudioPacer(): void {
    if (this.audioPacer) {
      clearInterval(this.audioPacer);
      this.audioPacer = null;
    }
    this.audioQueue.length = 0;
    this.audioPacerPrimed = false;
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
        if (buf[0] === 0x24) {
          if (buf.length < 4) break;
          const pktLen = buf.readUInt16BE(2);
          if (buf.length < 4 + pktLen) break;
          buf = buf.subarray(4 + pktLen);
          continue;
        }

        const idx = buf.indexOf(Buffer.from("\r\n\r\n"));
        if (idx === -1) {
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

  private pumpPlayMedia(client: RtspClient): void {
    if (!client.isPlaying || client.socket.destroyed || client.mediaPumped) return;
    client.mediaPumped = true;
    client.receivedKeyframe = false;
    if (this.lastKeyframe) {
      client.waitLiveIdr = false;
      this.videoQueue.length = 0;
      this.sendFrameNow(this.lastKeyframe, client);
      return;
    }
    client.waitLiveIdr = true;
    this.emit("need_keyframe");
  }

  public holdForNewIdr(): void {
    this.videoQueue.length = 0;
    this.lastKeyframe = null;
    for (const c of this.clients) {
      if (c.isPlaying) c.waitLiveIdr = true;
    }
  }

  public flushAudio(): void {
    this.audioQueue.length = 0;
    this.audioPacerPrimed = false;
    this.audioPacerUnderruns = 0;
    this.audioIngressCount = 0;
    this.audioSentCount = 0;
  }

  private handleRtspRequest(client: RtspClient, req: string): void {
    const lines = req.split("\r\n");
    const firstLine = lines[0] || "";
    const [method, url] = firstLine.split(" ");

    const cseqLine = lines.find((l) => l.toLowerCase().startsWith("cseq:"));
    const cseq = cseqLine ? parseInt(cseqLine.split(":")[1].trim(), 10) : client.cseq;

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
          `RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        if (client.isPlaying) this.pumpPlayMedia(client);
        break;
      }

      case "DESCRIBE": {
        this.sendDescribeResponse(client.socket, cseq, url);
        this.emit("need_keyframe");
        break;
      }

      case "SETUP": {
        const isAudioTrack = (url || "").includes("track1");
        const defaultInterleaved = isAudioTrack ? "2-3" : "0-1";

        const transportLine = lines.find((l) => l.toLowerCase().startsWith("transport:")) || "";
        const transportVal = transportLine.split(":")[1]?.trim() || "";

        let chosenChannel = isAudioTrack ? 2 : 0;
        let transportHeader = `RTP/AVP/TCP;unicast;interleaved=${defaultInterleaved}`;
        const interleavedMatch = transportVal.match(/interleaved=([0-9]+)-[0-9]+/);
        const clientPortMatch = transportVal.match(/client_port=([0-9]+)-([0-9]+)/);
        const wantsTcp = /RTP\/AVP\/TCP/i.test(transportVal) || !!interleavedMatch;

        if (wantsTcp && interleavedMatch) {
          chosenChannel = parseInt(interleavedMatch[1], 10);
          transportHeader = `RTP/AVP/TCP;unicast;interleaved=${interleavedMatch[1]}-${chosenChannel + 1}`;
          client.transport = "tcp";
        } else if (clientPortMatch && !wantsTcp) {
          const rtpPort = parseInt(clientPortMatch[1], 10);
          const rtcpPort = parseInt(clientPortMatch[2], 10);
          const remote = stripV4Mapped(client.socket.remoteAddress || "127.0.0.1");
          if (localIPv4Set().has(remote)) {
            client.socket.write(`RTSP/1.0 461 Unsupported Transport\r\n` + `CSeq: ${cseq}\r\n\r\n`);
            break;
          }
          client.udpAddr = remote;
          client.transport = "udp";
          if (isAudioTrack) client.audioRtpPort = rtpPort;
          else client.videoRtpPort = rtpPort;
          const srv = this.rtpUdpPort || 0;
          const src = stripV4Mapped(client.socket.localAddress || getLocalIpv4());
          transportHeader =
            `RTP/AVP;unicast;destination=${remote};source=${src}` +
            `;client_port=${rtpPort}-${rtcpPort}` +
            `;server_port=${srv}-${srv ? srv + 1 : 1}`;
        } else {
          client.transport = "tcp";
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
        client.socket.write(response);
        this.pumpPlayMedia(client);
        this.emit("need_keyframe");
        break;
      }

      case "PAUSE": {
        client.isPlaying = false;
        const response =
          `RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        break;
      }

      case "TEARDOWN": {
        client.isPlaying = false;
        const response =
          `RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Session: ${client.session}\r\n\r\n`;
        client.socket.write(response);
        client.socket.end();
        break;
      }
    }
  }

  public broadcastAudio(audioData: Buffer, timestampMs?: number, targetClient?: RtspClient): void {
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

    if (!isAdts) return;

    this.audioMode = "aac";
    let frameCount = 0;

    while (offset < audioData.length) {
      const remaining = audioData.subarray(offset);
      if (remaining.length >= 7 && remaining[0] === 0xff && (remaining[1] & 0xf0) === 0xf0) {
        const hasCrc = (remaining[1] & 0x01) === 0;
        const hdrLen = hasCrc ? 9 : 7;
        const adtsLen =
          ((remaining[3] & 0x03) << 11) | (remaining[4] << 3) | ((remaining[5] & 0xe0) >> 5);
        if (adtsLen <= hdrLen || adtsLen > remaining.length) {
          break;
        }
        const rawAac = remaining.subarray(hdrLen, adtsLen);
        if (targetClient || !this.audioPacer) {
          this.sendSingleAacFrame(rawAac, frameCount === 0 ? timestampMs : undefined, targetClient);
        } else {
          this.audioQueue.push(Buffer.from(rawAac));
          this.audioIngressCount++;
        }
        offset += adtsLen;
        frameCount++;
      } else {
        if (frameCount === 0) {
          if (targetClient || !this.audioPacer) {
            this.sendSingleAacFrame(audioData, timestampMs, targetClient);
          } else {
            this.audioQueue.push(Buffer.from(audioData));
            this.audioIngressCount++;
          }
        }
        break;
      }
    }
  }

  private sendSingleAacFrame(
    rawAac: Buffer,
    timestampMs?: number,
    targetClient?: RtspClient,
  ): void {
    if (!rawAac.length) return;

    if (typeof timestampMs === "number" && timestampMs > 0) {
      this.audioRtpTimestamp = Math.floor((timestampMs * 16) % 0xffffffff) >>> 0;
    }
    const rtpTimestamp = this.audioRtpTimestamp >>> 0;
    this.lastAudioRtpTimestamp = rtpTimestamp;
    this.audioRtpTimestamp = (this.audioRtpTimestamp + 1024) >>> 0;

    const auLen = rawAac.length;
    const auHdrBuf = Buffer.alloc(4);
    auHdrBuf.writeUInt16BE(16, 0);
    auHdrBuf.writeUInt16BE((auLen << 3) & 0xffff, 2);

    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 0x80 | 97;
    rtpHeader.writeUInt16BE(this.audioRtpSeq++ & 0xffff, 2);
    rtpHeader.writeUInt32BE(rtpTimestamp, 4);
    rtpHeader.writeUInt32BE(this.audioRtpSsrc, 8);

    this.sendInterleavedRtp(2, Buffer.concat([rtpHeader, auHdrBuf, rawAac]), targetClient);
  }

  public broadcastFrame(frameData: Buffer, _timestampMs?: number, targetClient?: RtspClient): void {
    if (!frameData.length) return;
    this.sendFrameNow(frameData, targetClient);
  }

  public sendFrameNow(frameData: Buffer, targetClient?: RtspClient): void {
    if (!frameData.length) return;

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
            (frameData[i + 2] === 1 || (frameData[i + 2] === 0 && frameData[i + 3] === 1))
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
      } else if (payload.length >= 3 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        payload = payload.subarray(3);
      }
      if (payload.length) nalUnits.push(payload);
    }

    let isKeyframe = false;
    for (const nal of nalUnits) {
      if (!nal || !nal.length) continue;
      if (this.isHevc) {
        const nalType = (nal[0] >> 1) & 0x3f;
        if (nalType === 32) this.vps = Buffer.from(nal);
        if (nalType === 33) this.sps = Buffer.from(nal);
        if (nalType === 34) this.pps = Buffer.from(nal);
        if (nalType === 19 || nalType === 20 || nalType === 21) isKeyframe = true;
      } else {
        const nalType = nal[0] & 0x1f;
        if (nalType === 7) this.sps = Buffer.from(nal);
        if (nalType === 8) this.pps = Buffer.from(nal);
        if (nalType === 5) isKeyframe = true;
      }
    }

    if (isKeyframe) {
      if (this.isHevc) {
        const missing: Buffer[] = [];
        if (this.vps) missing.push(this.vps);
        if (this.sps) missing.push(this.sps);
        if (this.pps) missing.push(this.pps);
        if (missing.length > 0) nalUnits.unshift(...missing);
      } else {
        const missing: Buffer[] = [];
        if (this.sps) missing.push(this.sps);
        if (this.pps) missing.push(this.pps);
        if (missing.length > 0) nalUnits.unshift(...missing);
      }
      if (!targetClient) {
        this.lastKeyframe = frameData;
      }
      if (targetClient) {
        targetClient.receivedKeyframe = true;
        targetClient.waitLiveIdr = false;
      } else {
        for (const c of this.clients) {
          if (c.isPlaying) {
            c.receivedKeyframe = true;
            c.waitLiveIdr = false;
          }
        }
      }
    }

    const hasParams = this.isHevc ? this.vps && this.sps && this.pps : this.sps && this.pps;
    if (hasParams && this.pendingDescribes.length > 0) {
      this.flushPendingDescribes();
    }

    const nowSendMs = Date.now();
    const elapsedMs = this.lastVideoSendAt > 0 ? nowSendMs - this.lastVideoSendAt : 40;
    const rtpIncrement = Math.min(18_000, Math.max(3_000, Math.round(elapsedMs * 90)));
    const rtpTimestamp = this.videoRtpTimestamp >>> 0;
    this.lastVideoRtpTimestamp = rtpTimestamp;
    this.videoRtpTimestamp = (this.videoRtpTimestamp + rtpIncrement) >>> 0;
    this.lastVideoSendAt = nowSendMs;
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

        this.sendInterleavedRtp(0, Buffer.concat([rtpHeader, nal]), targetClient, isKeyframe);
      } else if (this.isHevc) {
        const nalType = (nal[0] >> 1) & 0x3f;
        const payloadHdr1 = (nal[0] & 0x81) | (49 << 1);
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

          const fuPayloadHdr = Buffer.from([payloadHdr1, payloadHdr2, fuHeader]);
          const payloadChunk = nal.subarray(offset, offset + chunkLen);

          this.sendInterleavedRtp(
            0,
            Buffer.concat([rtpHeader, fuPayloadHdr, payloadChunk]),
            targetClient,
            isKeyframe,
          );
          offset += chunkLen;
        }
      } else {
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
            isKeyframe,
          );
          offset += chunkLen;
        }
      }
    }
  }

  private sendInterleavedRtp(
    defaultChannel: number,
    rtpPacket: Buffer,
    targetClient?: RtspClient,
    isKeyframe = false,
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
      if (client.waitLiveIdr) {
        if (isAudio) {
          /* mic keeps running while video waits for a live IDR */
        } else if (!isKeyframe) {
          return;
        } else {
          client.waitLiveIdr = false;
        }
      }
      if (client.transport === "udp") {
        const port = isAudio ? client.audioRtpPort : client.videoRtpPort;
        if (!port || !client.udpAddr) return;
        this.sendUdpRtp(rtpPacket, client.udpAddr, port);
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
      } catch {}
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
        this.lastVideoRtpTimestamp,
        this.videoPktCount,
        this.videoOctetCount,
      ),
    );
    this.sendRtcpPacket(
      client,
      true,
      this.buildRtcpSr(
        this.audioRtpSsrc,
        this.lastAudioRtpTimestamp,
        this.audioPktCount,
        this.audioOctetCount,
      ),
    );
  }

  private buildRtcpSr(ssrc: number, rtpTs: number, pktCount: number, octetCount: number): Buffer {
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

  private sendRtcpPacket(client: RtspClient, isAudio: boolean, packet: Buffer): void {
    if (client.transport === "udp") {
      const rtpPort = isAudio ? client.audioRtpPort : client.videoRtpPort;
      if (!rtpPort || !client.udpAddr) return;
      this.sendUdpRtp(packet, client.udpAddr, rtpPort + 1);
      return;
    }
    const chan = isAudio ? (client.audioChannel ?? 2) + 1 : (client.videoChannel ?? 0) + 1;
    const tcpHeader = Buffer.alloc(4);
    tcpHeader[0] = 0x24;
    tcpHeader[1] = chan & 0xff;
    tcpHeader.writeUInt16BE(packet.length, 2);
    try {
      client.socket.write(Buffer.concat([tcpHeader, packet]));
    } catch {}
  }

  private sendUdpRtp(packet: Buffer, addr: string, port: number): void {
    const v4mapped = stripV4Mapped(addr);
    const isV6 = v4mapped.includes(":");
    const sock = isV6 ? this.rtpUdp6 : this.rtpUdp;
    if (!sock) return;
    const dests = new Set<string>([v4mapped]);
    if (!isV6 && localIPv4Set().has(v4mapped)) dests.add("127.0.0.1");
    for (const dest of dests) {
      try {
        sock.send(packet, port, dest);
      } catch {}
    }
  }
}

export const RtspServer = RTSPServer;
