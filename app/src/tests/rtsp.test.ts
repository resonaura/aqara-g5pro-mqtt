import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { RtspServer } from "../bridge.js";

// Minimal socket stand-in: collects writes, lets us push 'data' frames.
class MockSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  remoteAddress = "127.0.0.1";
  localAddress = "127.0.0.1";
  write(buf: Buffer): boolean {
    this.writes.push(Buffer.from(buf));
    return true;
  }
  end(): void {
    /* no-op */
  }
  destroy(): void {
    this.destroyed = true;
  }
  get all(): Buffer {
    return Buffer.concat(this.writes);
  }
}

// Parse all $<channel><len16><rtp> interleaved frames out of the buffer.
function parseInterleaved(buf: Buffer): { channel: number; payload: Buffer }[] {
  const out: { channel: number; payload: Buffer }[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] === 0x24) {
      const channel = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (i + 4 + len > buf.length) break;
      out.push({ channel, payload: buf.subarray(i + 4, i + 4 + len) });
      i += 4 + len;
    } else {
      i++;
    }
  }
  return out;
}

function rtpInfo(p: Buffer) {
  return {
    version: (p[0] >> 6) & 0x3,
    marker: (p[1] >> 7) & 0x1,
    payloadType: p[1] & 0x7f,
    seq: p.readUInt16BE(2),
    timestamp: p.readUInt32BE(4),
    ssrc: p.readUInt32BE(8),
    payload: p.subarray(12),
  };
}

function attach(srv: RtspServer): MockSocket {
  const s = new MockSocket();
  (srv as any).handleClient(s);
  return s;
}

function send(s: MockSocket, req: string) {
  s.writes = [];
  s.emit("data", Buffer.from(req + "\r\n\r\n"));
}

const SPS = Buffer.from("674d0028e900a00b7e5c0043000057a00000fa40003a980", "hex");
const PPS = Buffer.from("68ee3c80", "hex");

test("DESCRIBE is immediate even before SPS/PPS exist", () => {
  const srv = new RtspServer(0, "testdid");
  srv.isHevc = false;
  const s = attach(srv);
  send(s, "DESCRIBE rtsp://localhost/testdid RTSP/1.0\r\nCSeq: 1");
  const res = s.all.toString("utf8");
  assert.match(res, /RTSP\/1\.0 200 OK/);
  assert.match(res, /application\/sdp/);
});

test("DESCRIBE returns SDP with H264 video and AAC audio", () => {
  const srv = new RtspServer(0, "testdid");
  srv.isHevc = false;
  srv.sps = SPS;
  srv.pps = PPS;
  const s = attach(srv);
  send(s, "DESCRIBE rtsp://localhost/testdid RTSP/1.0\r\nCSeq: 1");
  const res = s.all.toString("utf8");
  assert.match(res, /RTSP\/1\.0 200 OK/);
  assert.match(res, /Content-Type: application\/sdp/);
  const sdp = res.split("\r\n\r\n")[1];
  assert.match(sdp, /a=rtpmap:96 H264\/90000/);
  assert.match(sdp, /a=rtpmap:97 MPEG4-GENERIC\/16000\/1/);
  assert.match(sdp, /a=control:track0/);
  assert.match(sdp, /a=control:track1/);
  assert.match(sdp, /sprop-parameter-sets=/);
  assert.ok(sdp.includes(SPS.toString("base64")));
  assert.ok(sdp.includes(PPS.toString("base64")));
});

test("DESCRIBE returns H265 rtpmap when isHevc is set", () => {
  const srv = new RtspServer(0, "d");
  srv.isHevc = true;
  srv.vps = Buffer.from([0x40, 0x01, 0x0c, 0x01]);
  srv.sps = Buffer.from([0x42, 0x01, 0x01, 0x01]);
  srv.pps = Buffer.from([0x44, 0x01, 0xc0, 0x73]);
  const s = attach(srv);
  send(s, "DESCRIBE rtsp://x/d RTSP/1.0\r\nCSeq: 1");
  const sdp = s.all.toString("utf8").split("\r\n\r\n")[1];
  assert.match(sdp, /a=rtpmap:96 H265\/90000/);
  assert.match(sdp, /sprop-vps=/);
  assert.match(sdp, /sprop-sps=/);
  assert.match(sdp, /sprop-pps=/);
});

test("SETUP uses interleaved 0-1 for video and 2-3 for audio by default", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 2");
  assert.match(s.all.toString("utf8"), /interleaved=0-1/);
  send(s, "SETUP rtsp://x/d/track1 RTSP/1.0\r\nCSeq: 3");
  assert.match(s.all.toString("utf8"), /interleaved=2-3/);
});

test("SETUP honors client-requested interleaved channels", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  send(
    s,
    "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=4-5",
  );
  assert.match(s.all.toString("utf8"), /interleaved=4-5/);
});

test("SETUP rejects same-host UDP with 461 so VLC retries TCP", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  send(
    s,
    "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP;unicast;client_port=5000-5001",
  );
  const res = s.all.toString("utf8");
  assert.match(res, /RTSP\/1\.0 461 Unsupported Transport/);
  assert.doesNotMatch(res, /client_port=5000-5001/);
});

test("SETUP accepts UDP unicast from a remote client", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  s.remoteAddress = "10.0.0.8";
  send(
    s,
    "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP;unicast;client_port=5000-5001",
  );
  const res = s.all.toString("utf8");
  assert.match(res, /RTSP\/1\.0 200 OK/);
  assert.match(res, /client_port=5000-5001/);
  assert.match(res, /destination=10\.0\.0\.8/);
  assert.doesNotMatch(res, /461/);
});

test("PLAY without a cached IDR does not emit silent-audio-only RTP", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  s.writes = [];
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  assert.match(s.all.toString("utf8"), /RTSP\/1\.0 200 OK/);
  assert.equal(
    parseInterleaved(s.all).length,
    0,
    "audio-only PLAY makes VLC start the clock and disconnect before video arrives",
  );
});

test("PLAY immediately replays the cached IDR so the client is not gray", () => {
  const srv = new RtspServer(0, "d");
  srv.sps = SPS;
  srv.pps = PPS;
  const idr = Buffer.from([0x65, 0x09, 0x08, 0x07, 0x06]);
  srv.lastKeyframe = Buffer.concat([
    Buffer.from([0, 0, 0, 1]),
    SPS,
    Buffer.from([0, 0, 0, 1]),
    PPS,
    Buffer.from([0, 0, 0, 1]),
    idr,
  ]);
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  s.writes = [];
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  srv.broadcastFrame(idr, 1000);
  const text = s.all.toString("latin1");
  assert.match(text, /RTP-Info:.*track0;seq=/);
  assert.match(text, /track1;seq=/);
  const frames = parseInterleaved(s.all).filter((f) => f.channel === 0);
  assert.ok(frames.length >= 1, "PLAY must emit the keyframe on first broadcast");
  const types = frames.map((f) => f.payload[12] & 0x1f);
  assert.ok(types.includes(5) || types.includes(7) || types.includes(28));
});

test("P-frames after PLAY GOP dump continue the same GOP", () => {
  const srv = new RtspServer(0, "d");
  srv.sps = SPS;
  srv.pps = PPS;
  const idr = Buffer.concat([
    Buffer.from([0, 0, 0, 1]),
    SPS,
    Buffer.from([0, 0, 0, 1]),
    PPS,
    Buffer.from([0, 0, 0, 1, 0x65, 0x01]),
  ]);
  srv.lastKeyframe = idr;
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  srv.broadcastFrame(idr, 1000);
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1, 0x61, 0xbb])]), 1200);
  const p = parseInterleaved(s.all).filter((f) => f.channel === 0);
  assert.equal(p.length, 1);
  assert.equal(p[0].payload[12], 0x61);
});

test("PLAY enables sending; a non-keyframe NAL produces one RTP packet (M bit set)", () => {
  const srv = new RtspServer(0, "d");
  srv.sps = SPS;
  srv.pps = PPS;
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  // Deliver a keyframe first so the client clears the receivedKeyframe gate.
  const idr = Buffer.from([0x65, 0x09, 0x08, 0x07, 0x06]);
  srv.broadcastFrame(
    Buffer.concat([
      Buffer.from([0, 0, 0, 1]),
      SPS,
      Buffer.from([0, 0, 0, 1]),
      PPS,
      Buffer.from([0, 0, 0, 1]),
      idr,
    ]),
    900,
  );
  s.writes = [];
  const smallNal = Buffer.from([0x61, 0x01, 0x02, 0x03]); // type 1 (non-IDR)
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), smallNal]), 1000);
  const frames = parseInterleaved(s.all).filter((f) => f.channel === 0);
  assert.equal(frames.length, 1);
  const last = rtpInfo(frames[0].payload);
  assert.equal(last.marker, 1);
  assert.equal(last.payloadType, 96);
  assert.ok(last.payload.equals(smallNal));
});

test("H264 large IDR is packetized into FU-A and reassembles exactly", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");

  const idrBody = Buffer.alloc(2000);
  for (let i = 0; i < idrBody.length; i++) idrBody[i] = (i * 7) & 0xff;
  const idr = Buffer.concat([Buffer.from([0x65]), idrBody]); // NAL type 5, len 2001
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), idr]), 2000);

  const fu = parseInterleaved(s.all).filter(
    (f) => f.channel === 0 && (f.payload[12] & 0x1f) === 28,
  );
  assert.equal(fu.length, 2); // ceil(2000/1380) = 2
  assert.equal((fu[0].payload[13] & 0x80) !== 0, true); // start bit
  assert.equal((fu[1].payload[13] & 0x40) !== 0, true); // end bit

  // Reassemble: header = (fuIndicator & 0x60) | (fuHeader & 0x1F), then chunks
  const header = (fu[0].payload[12] & 0x60) | (fu[0].payload[13] & 0x1f);
  const chunks: Buffer[] = [Buffer.from([header])];
  for (const f of fu) chunks.push(f.payload.subarray(14));
  assert.ok(Buffer.concat(chunks).equals(idr));
});

test("HEVC large NAL is packetized into FU and reassembles exactly", () => {
  const srv = new RtspServer(0, "d");
  srv.isHevc = true;
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");

  const body = Buffer.alloc(2000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 13) & 0xff;
  const nal = Buffer.concat([Buffer.from([0x26, 0x01]), body]); // type 19 (IDR), 2-byte hdr
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]), 3000);

  const fu = parseInterleaved(s.all).filter(
    (f) => f.channel === 0 && ((f.payload[12] >> 1) & 0x3f) === 49,
  );
  assert.equal(fu.length, 2);
  assert.equal((fu[0].payload[14] & 0x80) !== 0, true); // start
  assert.equal((fu[1].payload[14] & 0x40) !== 0, true); // end

  // HEVC FU reassembly: header[0] = (payloadHdr1 & 0x81) | (fuType << 1), header[1] = payloadHdr2
  const fuType = fu[0].payload[14] & 0x3f;
  const hdr = Buffer.from([(fu[0].payload[12] & 0x81) | (fuType << 1), fu[0].payload[13]]);
  const chunks: Buffer[] = [hdr];
  for (const f of fu) chunks.push(f.payload.subarray(15));
  assert.ok(Buffer.concat(chunks).equals(nal));
});

test("broadcastAudio emits a single AAC RTP packet on channel 2", () => {
  const srv = new RtspServer(0, "d");
  srv.sps = SPS;
  srv.pps = PPS;
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track1 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  // Deliver a keyframe first so the client clears the receivedKeyframe gate.
  const idr = Buffer.from([0x65, 0x09, 0x08, 0x07, 0x06]);
  srv.broadcastFrame(
    Buffer.concat([
      Buffer.from([0, 0, 0, 1]),
      SPS,
      Buffer.from([0, 0, 0, 1]),
      PPS,
      Buffer.from([0, 0, 0, 1]),
      idr,
    ]),
    900,
  );

  const rawAac = Buffer.alloc(160, 0xab);
  const frameLen = 7 + rawAac.length;
  const adts = Buffer.alloc(frameLen);
  adts[0] = 0xff;
  adts[1] = 0xf9;
  adts[2] = 0x60;
  adts[3] = 0x40 | ((frameLen >> 11) & 3);
  adts[4] = (frameLen >> 3) & 0xff;
  adts[5] = ((frameLen & 7) << 5) | 0x1f;
  adts[6] = 0xfc;
  rawAac.copy(adts, 7);
  s.writes = [];
  srv.broadcastAudio(adts, 1000);
  const frames = parseInterleaved(s.all).filter((f) => f.channel === 2);
  assert.equal(frames.length, 1);
  const info = rtpInfo(frames[0].payload);
  assert.equal(info.payloadType, 97);
  assert.equal(info.timestamp, 1000 * 16);
  assert.ok(info.payload.subarray(4).equals(rawAac));
});

test("video RTP timestamps only move forward", () => {
  const srv = new RtspServer(0, "d");
  srv.sps = SPS;
  srv.pps = PPS;
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  const idr = Buffer.concat([
    Buffer.from([0, 0, 0, 1]),
    SPS,
    Buffer.from([0, 0, 0, 1]),
    PPS,
    Buffer.from([0, 0, 0, 1, 0x65, 0x01]),
  ]);
  srv.broadcastFrame(idr, 100);
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1, 0x61, 0x02])]), 140);
  const t1 = rtpInfo(parseInterleaved(s.all).filter((f) => f.channel === 0)[0].payload).timestamp;
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1, 0x61, 0x03])]), 180);
  const t2 = rtpInfo(parseInterleaved(s.all).filter((f) => f.channel === 0)[0].payload).timestamp;
  // Wall-clock increment: frames sent synchronously → elapsed ≈ 0 ms →
  // clamped to minimum 3000 ticks (33 ms). Assert monotonically increasing
  // within the [3000, 18000] clamp rather than an exact constant.
  assert.ok((t2 - t1) >>> 0 >= 3000, `expected t2>t1 with increment>=3000, got ${(t2 - t1) >>> 0}`);
  assert.ok((t2 - t1) >>> 0 <= 18000, `expected increment<=18000, got ${(t2 - t1) >>> 0}`);
});

test("idle pacer does not replay the last IDR", async () => {
  const srv = new RtspServer(0, "d");
  srv.sps = SPS;
  srv.pps = PPS;
  const idr = Buffer.concat([
    Buffer.from([0, 0, 0, 1]),
    SPS,
    Buffer.from([0, 0, 0, 1]),
    PPS,
    Buffer.from([0, 0, 0, 1, 0x65, 0x01]),
  ]);
  srv.lastKeyframe = idr;
  const s = attach(srv);
  send(s, "SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1");
  send(s, "PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2");
  srv.broadcastFrame(idr, 100);
  (srv as any).startVideoPacer();
  await new Promise((r) => setTimeout(r, 50));
  const n1 = parseInterleaved(s.all).filter((f) => f.channel === 0).length;
  assert.ok(n1 >= 1, "broadcastFrame should have sent the IDR");
  await new Promise((r) => setTimeout(r, 280));
  const n2 = parseInterleaved(s.all).filter((f) => f.channel === 0).length;
  srv.stopVideoPacer();
  assert.equal(n2, n1, "replaying the cached IDR makes VLC jump backward");
});

test("broadcastFrame ignores clients that are not playing", () => {
  const srv = new RtspServer(0, "d");
  const s = attach(srv);
  // No SETUP/PLAY -> client.isPlaying stays false
  s.writes = [];
  srv.broadcastFrame(Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]), 0);
  assert.equal(parseInterleaved(s.all).length, 0);
});
