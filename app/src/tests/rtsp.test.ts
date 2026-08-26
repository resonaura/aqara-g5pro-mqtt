import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RtspServer } from '../bridge.js';

// Minimal socket stand-in: collects writes, lets us push 'data' frames.
class MockSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  write(buf: Buffer): boolean { this.writes.push(Buffer.from(buf)); return true; }
  end(): void { /* no-op */ }
  destroy(): void { this.destroyed = true; }
  get all(): Buffer { return Buffer.concat(this.writes); }
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
  s.emit('data', Buffer.from(req + '\r\n\r\n'));
}

const SPS = Buffer.from('674d0028e900a00b7e5c0043000057a00000fa40003a980', 'hex');
const PPS = Buffer.from('68ee3c80', 'hex');

test('DESCRIBE returns SDP with H264 video and PCMA audio', () => {
  const srv = new RtspServer(0, 'testdid');
  srv.isHevc = false;
  srv.sps = SPS;
  srv.pps = PPS;
  const s = attach(srv);
  send(s, 'DESCRIBE rtsp://localhost/testdid RTSP/1.0\r\nCSeq: 1');
  const res = s.all.toString('utf8');
  assert.match(res, /RTSP\/1\.0 200 OK/);
  assert.match(res, /Content-Type: application\/sdp/);
  const sdp = res.split('\r\n\r\n')[1];
  assert.match(sdp, /a=rtpmap:96 H264\/90000/);
  assert.match(sdp, /a=rtpmap:8 PCMA\/8000\/1/);
  assert.match(sdp, /a=control:track0/);
  assert.match(sdp, /a=control:track1/);
  assert.match(sdp, /sprop-parameter-sets=/);
  assert.ok(sdp.includes(SPS.toString('base64')));
  assert.ok(sdp.includes(PPS.toString('base64')));
});

test('DESCRIBE returns H265 rtpmap when isHevc is set', () => {
  const srv = new RtspServer(0, 'd');
  srv.isHevc = true;
  const s = attach(srv);
  send(s, 'DESCRIBE rtsp://x/d RTSP/1.0\r\nCSeq: 1');
  const sdp = s.all.toString('utf8').split('\r\n\r\n')[1];
  assert.match(sdp, /a=rtpmap:96 H265\/90000/);
});

test('SETUP uses interleaved 0-1 for video and 2-3 for audio by default', () => {
  const srv = new RtspServer(0, 'd');
  const s = attach(srv);
  send(s, 'SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 2');
  assert.match(s.all.toString('utf8'), /interleaved=0-1/);
  send(s, 'SETUP rtsp://x/d/track1 RTSP/1.0\r\nCSeq: 3');
  assert.match(s.all.toString('utf8'), /interleaved=2-3/);
});

test('SETUP honors client-requested interleaved channels', () => {
  const srv = new RtspServer(0, 'd');
  const s = attach(srv);
  send(s, 'SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=4-5');
  assert.match(s.all.toString('utf8'), /interleaved=4-5/);
});

test('PLAY enables sending; a small NAL produces one RTP packet (M bit set)', () => {
  const srv = new RtspServer(0, 'd');
  srv.sps = SPS; srv.pps = PPS;
  const s = attach(srv);
  send(s, 'SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1');
  send(s, 'PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2');
  const smallNal = Buffer.from([0x67, 0x01, 0x02, 0x03]); // type 7 (SPS-size)
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), smallNal]), 1000);
  const frames = parseInterleaved(s.all).filter((f) => f.channel === 0);
  // PLAY already pushed sps+pps (2 packets); our broadcast adds 1 small NAL
  const last = rtpInfo(frames[frames.length - 1].payload);
  assert.equal(last.marker, 1);
  assert.equal(last.payloadType, 96);
  assert.ok(last.payload.equals(smallNal));
});

test('H264 large IDR is packetized into FU-A and reassembles exactly', () => {
  const srv = new RtspServer(0, 'd');
  const s = attach(srv);
  send(s, 'SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1');
  send(s, 'PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2');

  const idrBody = Buffer.alloc(2000);
  for (let i = 0; i < idrBody.length; i++) idrBody[i] = (i * 7) & 0xff;
  const idr = Buffer.concat([Buffer.from([0x65]), idrBody]); // NAL type 5, len 2001
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), idr]), 2000);

  const fu = parseInterleaved(s.all)
    .filter((f) => f.channel === 0 && (f.payload[12] & 0x1f) === 28);
  assert.equal(fu.length, 2); // ceil(2000/1380) = 2
  assert.equal((fu[0].payload[13] & 0x80) !== 0, true); // start bit
  assert.equal((fu[1].payload[13] & 0x40) !== 0, true); // end bit

  // Reassemble: header = (fuIndicator & 0x60) | (fuHeader & 0x1F), then chunks
  const header = (fu[0].payload[12] & 0x60) | (fu[0].payload[13] & 0x1f);
  const chunks: Buffer[] = [Buffer.from([header])];
  for (const f of fu) chunks.push(f.payload.subarray(14));
  assert.ok(Buffer.concat(chunks).equals(idr));
});

test('HEVC large NAL is packetized into FU and reassembles exactly', () => {
  const srv = new RtspServer(0, 'd');
  srv.isHevc = true;
  const s = attach(srv);
  send(s, 'SETUP rtsp://x/d/track0 RTSP/1.0\r\nCSeq: 1');
  send(s, 'PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2');

  const body = Buffer.alloc(2000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 13) & 0xff;
  const nal = Buffer.concat([Buffer.from([0x82, 0x01]), body]); // type 1, 2-byte hdr
  s.writes = [];
  srv.broadcastFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]), 3000);

  const fu = parseInterleaved(s.all)
    .filter((f) => f.channel === 0 && ((f.payload[12] >> 1) & 0x3f) === 49);
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

test('broadcastAudio emits a single PCMA RTP packet on channel 2', () => {
  const srv = new RtspServer(0, 'd');
  const s = attach(srv);
  send(s, 'SETUP rtsp://x/d/track1 RTSP/1.0\r\nCSeq: 1');
  send(s, 'PLAY rtsp://x/d RTSP/1.0\r\nCSeq: 2');

  const pcm = Buffer.alloc(160, 0xab);
  s.writes = [];
  srv.broadcastAudio(pcm, 1000);
  const frames = parseInterleaved(s.all).filter((f) => f.channel === 2);
  assert.equal(frames.length, 1);
  const info = rtpInfo(frames[0].payload);
  assert.equal(info.payloadType, 8);
  assert.equal(info.timestamp, 1000 * 8);
  assert.ok(info.payload.equals(pcm));
});

test('broadcastFrame ignores clients that are not playing', () => {
  const srv = new RtspServer(0, 'd');
  const s = attach(srv);
  // No SETUP/PLAY -> client.isPlaying stays false
  s.writes = [];
  srv.broadcastFrame(Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]), 0);
  assert.equal(parseInterleaved(s.all).length, 0);
});
