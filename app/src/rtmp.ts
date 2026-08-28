/**
 * Minimal RTMP ingest server for talkback.
 * Accepts `rtmp://host:port/talk/<slug>` AAC publishes (ffmpeg/OBS/HA)
 * and emits MPEG-2 ADTS frames ready for P2P sendAudioFrame().
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as net from "net";
import {
  forceMpeg2Adts,
  isTalkbackNativeAac,
  parseAudioSpecificConfig,
  splitAdts,
  wrapRawAacToAdts,
  type AacConfig,
} from "./audio.js";

const HANDSHAKE = 1536;
const MSG_SET_CHUNK = 1;
const MSG_ACK_SIZE = 5;
const MSG_PEER_BW = 6;
const MSG_USER_CONTROL = 4;
const MSG_AUDIO = 8;
const MSG_COMMAND = 20;

export interface RtmpPublishEvent {
  name: string;
  app: string;
}

export interface RtmpAudioEvent {
  name: string;
  adts: Buffer;
}

export class RtmpIngestServer extends EventEmitter {
  private server: net.Server | null = null;
  private port: number;
  private connections = new Set<RtmpConnection>();

  constructor(port: number = 1935) {
    super();
    this.port = port;
  }

  public get listenPort(): number {
    return this.port;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.accept(socket));
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.port += 1;
          this.server!.listen(this.port);
          return;
        }
        reject(err);
      });
      this.server.listen(this.port, () => {
        this.emit("listening", this.port);
        resolve();
      });
    });
  }

  public stop(): void {
    for (const c of this.connections) c.close();
    this.connections.clear();
    this.server?.close();
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    const conn = new RtmpConnection(socket);
    this.connections.add(conn);
    conn.on("publish", (ev: RtmpPublishEvent) => this.emit("publish", ev));
    conn.on("audio", (ev: RtmpAudioEvent) => this.emit("audio", ev));
    conn.on("unpublish", (ev: RtmpPublishEvent) => this.emit("unpublish", ev));
    socket.on("close", () => this.connections.delete(conn));
    socket.on("error", () => this.connections.delete(conn));
  }
}

class RtmpConnection extends EventEmitter {
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private stage: "c0c1" | "c2" | "chunk" = "c0c1";
  private s1 = Buffer.alloc(HANDSHAKE);
  private chunkSize = 128;
  private chunks = new Map<
    number,
    {
      timestamp: number;
      len: number;
      type: number;
      streamId: number;
      payload: Buffer;
    }
  >();
  private transId = 1;
  private streamName = "";
  private app = "talk";
  private aacCfg: AacConfig | null = null;
  private transcode: ChildProcessWithoutNullStreams | null = null;
  private transcodeTail = Buffer.alloc(0);
  private published = false;

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    socket.on("data", (d) => this.onData(d));
    socket.on("close", () => this.teardown());
    socket.on("error", () => this.teardown());
  }

  public close(): void {
    try {
      this.socket.destroy();
    } catch {}
    this.teardown();
  }

  private teardown(): void {
    if (this.published && this.streamName) {
      this.published = false;
      this.emit("unpublish", { name: this.streamName, app: this.app });
    }
    this.stopTranscode();
  }

  private onData(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    if (this.stage === "c0c1") {
      if (this.buf.length < 1 + HANDSHAKE) return;
      const c1 = this.buf.subarray(1, 1 + HANDSHAKE);
      this.buf = this.buf.subarray(1 + HANDSHAKE);
      this.s1.writeUInt32BE((Date.now() / 1000) >>> 0, 0);
      const s0s1s2 = Buffer.concat([Buffer.from([3]), this.s1, c1]);
      this.socket.write(s0s1s2);
      this.stage = "c2";
    }
    if (this.stage === "c2") {
      if (this.buf.length < HANDSHAKE) return;
      this.buf = this.buf.subarray(HANDSHAKE);
      this.stage = "chunk";
    }
    if (this.stage === "chunk") {
      while (this.consumeChunk()) {
        /* drain */
      }
    }
  }

  private consumeChunk(): boolean {
    if (this.buf.length < 1) return false;
    const first = this.buf[0];
    const fmt = first >> 6;
    let csId = first & 0x3f;
    let hdrLen = 1;
    if (csId === 0) {
      if (this.buf.length < 2) return false;
      csId = this.buf[1] + 64;
      hdrLen = 2;
    } else if (csId === 1) {
      if (this.buf.length < 3) return false;
      csId = this.buf.readUInt16BE(1) + 64;
      hdrLen = 3;
    }

    const prev = this.chunks.get(csId);
    let ts = prev?.timestamp ?? 0;
    let msgLen = prev?.len ?? 0;
    let msgType = prev?.type ?? 0;
    let streamId = prev?.streamId ?? 0;
    let extra = 0;

    if (fmt === 0) {
      if (this.buf.length < hdrLen + 11) return false;
      const h = this.buf.subarray(hdrLen, hdrLen + 11);
      ts = (h[0] << 16) | (h[1] << 8) | h[2];
      msgLen = (h[3] << 16) | (h[4] << 8) | h[5];
      msgType = h[6];
      streamId = h.readUInt32LE(7);
      extra = 11;
    } else if (fmt === 1) {
      if (this.buf.length < hdrLen + 7) return false;
      const h = this.buf.subarray(hdrLen, hdrLen + 7);
      ts = (h[0] << 16) | (h[1] << 8) | h[2];
      msgLen = (h[3] << 16) | (h[4] << 8) | h[5];
      msgType = h[6];
      extra = 7;
    } else if (fmt === 2) {
      if (this.buf.length < hdrLen + 3) return false;
      const h = this.buf.subarray(hdrLen, hdrLen + 3);
      ts = (h[0] << 16) | (h[1] << 8) | h[2];
      extra = 3;
    } else {
      extra = 0;
    }

    let timestamp = ts;
    if (ts === 0xffffff) {
      if (this.buf.length < hdrLen + extra + 4) return false;
      timestamp = this.buf.readUInt32BE(hdrLen + extra);
      extra += 4;
    }

    const have = prev?.payload.length ?? 0;
    const remaining = msgLen - have;
    const take = Math.min(this.chunkSize, remaining);
    if (this.buf.length < hdrLen + extra + take) return false;

    const piece = this.buf.subarray(hdrLen + extra, hdrLen + extra + take);
    this.buf = this.buf.subarray(hdrLen + extra + take);
    const payload = Buffer.concat([prev?.payload ?? Buffer.alloc(0), piece]);
    this.chunks.set(csId, {
      timestamp,
      len: msgLen,
      type: msgType,
      streamId,
      payload,
    });

    if (payload.length >= msgLen) {
      this.chunks.set(csId, {
        timestamp,
        len: msgLen,
        type: msgType,
        streamId,
        payload: Buffer.alloc(0),
      });
      this.onMessage(msgType, payload.subarray(0, msgLen), streamId);
    }
    return true;
  }

  private onMessage(type: number, payload: Buffer, streamId: number): void {
    if (type === MSG_SET_CHUNK && payload.length >= 4) {
      this.chunkSize = payload.readUInt32BE(0) || this.chunkSize;
      return;
    }
    if (type === MSG_COMMAND) {
      const args = decodeAmf0List(payload);
      const cmd = String(args[0] || "");
      const tx = Number(args[1] || 0);
      if (cmd === "connect") {
        const obj = (args[2] || {}) as Record<string, unknown>;
        this.app = String(obj.app || "talk").replace(/\/$/, "");
        this.sendWindowAck(5000000);
        this.sendPeerBandwidth(5000000);
        this.sendUserControl(0, 0);
        this.sendChunkSize(4096);
        this.sendCommand(
          "_result",
          tx,
          { fmsVer: "FMS/3,0,1,123", capabilities: 31 },
          {
            level: "status",
            code: "NetConnection.Connect.Success",
            description: "ok",
          },
        );
      } else if (cmd === "createStream") {
        this.sendCommand("_result", tx, null, 1);
      } else if (cmd === "publish") {
        this.streamName = String(args[3] || args[4] || "stream");
        this.sendUserControl(0, 1);
        this.sendOnStatus(
          streamId,
          "NetStream.Publish.Start",
          `Publishing ${this.streamName}`,
        );
        this.published = true;
        this.emit("publish", { name: this.streamName, app: this.app });
      } else if (
        cmd === "FCUnpublish" ||
        cmd === "deleteStream" ||
        cmd === "closeStream"
      ) {
        this.teardown();
      }
      return;
    }
    if (type === MSG_AUDIO) this.onAudio(payload);
  }

  private onAudio(payload: Buffer): void {
    if (payload.length < 2) return;
    const format = (payload[0] >> 4) & 0x0f;
    if (format !== 10) return; // AAC only
    const packetType = payload[1];
    const body = payload.subarray(2);
    if (packetType === 0) {
      this.aacCfg = parseAudioSpecificConfig(body);
      if (this.aacCfg && !isTalkbackNativeAac(this.aacCfg)) {
        this.startTranscode();
      }
      return;
    }
    if (packetType !== 1 || body.length === 0) return;

    if (this.transcode?.stdin.writable) {
      const adts = wrapRawAacToAdts(body, this.aacCfg || {});
      this.transcode.stdin.write(adts);
      return;
    }

    const adts = forceMpeg2Adts(
      wrapRawAacToAdts(
        body,
        this.aacCfg || { objectType: 2, sampleRate: 16000, channels: 1 },
      ),
    );
    if (!this.streamName) return;
    this.emit("audio", { name: this.streamName, adts });
  }

  private startTranscode(): void {
    if (this.transcode) return;
    try {
      this.transcode = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "aac",
          "-i",
          "pipe:0",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-c:a",
          "aac",
          "-profile:a",
          "aac_low",
          "-b:a",
          "16k",
          "-f",
          "adts",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      this.transcode = null;
      return;
    }
    this.transcode.stdout.on("data", (chunk: Buffer) => {
      this.transcodeTail = Buffer.concat([this.transcodeTail, chunk]);
      const frames = splitAdts(this.transcodeTail);
      if (!frames.length) return;
      let consumed = 0;
      for (const f of frames) consumed += f.length;
      this.transcodeTail = this.transcodeTail.subarray(consumed);
      for (const f of frames) {
        this.emit("audio", { name: this.streamName, adts: forceMpeg2Adts(f) });
      }
    });
    this.transcode.on("exit", () => {
      this.transcode = null;
    });
  }

  private stopTranscode(): void {
    if (!this.transcode) return;
    try {
      this.transcode.stdin.end();
      this.transcode.kill("SIGKILL");
    } catch {}
    this.transcode = null;
  }

  private sendChunkSize(size: number): void {
    this.chunkSize = size;
    const p = Buffer.alloc(4);
    p.writeUInt32BE(size, 0);
    this.sendMessage(2, MSG_SET_CHUNK, 0, p);
  }

  private sendWindowAck(size: number): void {
    const p = Buffer.alloc(4);
    p.writeUInt32BE(size, 0);
    this.sendMessage(2, MSG_ACK_SIZE, 0, p);
  }

  private sendPeerBandwidth(size: number): void {
    const p = Buffer.alloc(5);
    p.writeUInt32BE(size, 0);
    p[4] = 2;
    this.sendMessage(2, MSG_PEER_BW, 0, p);
  }

  private sendUserControl(event: number, value: number): void {
    const p = Buffer.alloc(6);
    p.writeUInt16BE(event, 0);
    p.writeUInt32BE(value, 2);
    this.sendMessage(2, MSG_USER_CONTROL, 0, p);
  }

  private sendCommand(cmd: string, tx: number, ...rest: unknown[]): void {
    const payload = encodeAmf0List([cmd, tx, ...rest]);
    this.sendMessage(3, MSG_COMMAND, 0, payload);
  }

  private sendOnStatus(
    streamId: number,
    code: string,
    description: string,
  ): void {
    const payload = encodeAmf0List([
      "onStatus",
      0,
      null,
      { level: "status", code, description },
    ]);
    this.sendMessage(4, MSG_COMMAND, streamId, payload);
  }

  private sendMessage(
    csId: number,
    type: number,
    streamId: number,
    payload: Buffer,
  ): void {
    const hdr = Buffer.alloc(12);
    hdr[0] = csId & 0x3f; // fmt 0
    hdr[3] = 0;
    hdr[4] = (payload.length >> 16) & 0xff;
    hdr[5] = (payload.length >> 8) & 0xff;
    hdr[6] = payload.length & 0xff;
    hdr[7] = type;
    hdr.writeUInt32LE(streamId, 8);
    const chunks: Buffer[] = [hdr];
    let off = 0;
    const size = this.chunkSize;
    while (off < payload.length) {
      if (off > 0) chunks.push(Buffer.from([0xc0 | (csId & 0x3f)]));
      const n = Math.min(size, payload.length - off);
      chunks.push(payload.subarray(off, off + n));
      off += n;
    }
    try {
      this.socket.write(Buffer.concat(chunks));
    } catch {}
    this.transId++;
  }
}

function encodeAmf0List(values: unknown[]): Buffer {
  return Buffer.concat(values.map(encodeAmf0));
}

function encodeAmf0(value: unknown): Buffer {
  if (value === null) return Buffer.from([0x05]);
  if (typeof value === "number") {
    const b = Buffer.alloc(9);
    b[0] = 0x00;
    b.writeDoubleBE(value, 1);
    return b;
  }
  if (typeof value === "boolean") {
    return Buffer.from([0x01, value ? 1 : 0]);
  }
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf8");
    const b = Buffer.alloc(3 + s.length);
    b[0] = 0x02;
    b.writeUInt16BE(s.length, 1);
    s.copy(b, 3);
    return b;
  }
  if (typeof value === "object") {
    const parts: Buffer[] = [Buffer.from([0x03])];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = Buffer.from(k, "utf8");
      const kb = Buffer.alloc(2 + key.length);
      kb.writeUInt16BE(key.length, 0);
      key.copy(kb, 2);
      parts.push(kb, encodeAmf0(v));
    }
    parts.push(Buffer.from([0x00, 0x00, 0x09]));
    return Buffer.concat(parts);
  }
  return Buffer.from([0x05]);
}

function decodeAmf0List(buf: Buffer): unknown[] {
  const out: unknown[] = [];
  let off = 0;
  while (off < buf.length) {
    const r = decodeAmf0(buf, off);
    if (!r) break;
    out.push(r.value);
    off = r.off;
  }
  return out;
}

function decodeAmf0(
  buf: Buffer,
  off: number,
): { value: unknown; off: number } | null {
  if (off >= buf.length) return null;
  const t = buf[off++];
  if (t === 0x00) {
    if (off + 8 > buf.length) return null;
    return { value: buf.readDoubleBE(off), off: off + 8 };
  }
  if (t === 0x01) {
    if (off >= buf.length) return null;
    return { value: buf[off] !== 0, off: off + 1 };
  }
  if (t === 0x02) {
    if (off + 2 > buf.length) return null;
    const n = buf.readUInt16BE(off);
    off += 2;
    if (off + n > buf.length) return null;
    return { value: buf.subarray(off, off + n).toString("utf8"), off: off + n };
  }
  if (t === 0x03 || t === 0x08) {
    if (t === 0x08) off += 4;
    const obj: Record<string, unknown> = {};
    while (off + 2 <= buf.length) {
      const n = buf.readUInt16BE(off);
      off += 2;
      if (n === 0 && buf[off] === 0x09) {
        off += 1;
        break;
      }
      if (off + n > buf.length) break;
      const key = buf.subarray(off, off + n).toString("utf8");
      off += n;
      const r = decodeAmf0(buf, off);
      if (!r) break;
      obj[key] = r.value;
      off = r.off;
    }
    return { value: obj, off };
  }
  if (t === 0x05 || t === 0x06) return { value: null, off };
  if (t === 0x0a) {
    if (off + 4 > buf.length) return null;
    const n = buf.readUInt32BE(off);
    off += 4;
    const arr: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const r = decodeAmf0(buf, off);
      if (!r) break;
      arr.push(r.value);
      off = r.off;
    }
    return { value: arr, off };
  }
  return { value: null, off: buf.length };
}
