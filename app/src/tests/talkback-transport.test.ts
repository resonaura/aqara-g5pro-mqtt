import assert from "node:assert/strict";
import test from "node:test";
import { AqaraCameraBridge, buildTalkbackPPCSBody, TALKBACK_LEAD_FRAME } from "../bridge.js";

function createReadyBridge(): {
  bridge: AqaraCameraBridge;
  sent: Array<{ channel: number; sequence: number; payload: Buffer }>;
} {
  const bridge = new AqaraCameraBridge({
    did: "lumi.test",
    deviceName: "test",
    token: "test",
  });
  const internal = bridge as any;
  const sent: Array<{ channel: number; sequence: number; payload: Buffer }> = [];

  internal.isConnected = true;
  internal.talkbackActive = true;
  internal.socket = {};
  internal.cameraIp = "192.0.2.1";
  internal.cameraPort = 32108;
  internal.talkSeq = 0;
  internal.talkFramesSent = 0;
  internal.sendEncDrw = (channel: number, sequence: number, payload: Buffer) => {
    sent.push({ channel, sequence, payload: Buffer.from(payload) });
  };

  return { bridge, sent };
}

test("talkback PPCS body matches the 32-byte header with length at offset 28", () => {
  const adts = Buffer.from([0xff, 0xf9, 0x60, 0x40, 1, 2, 3]);
  const body = buildTalkbackPPCSBody(adts);

  assert.equal(body.length, 32 + adts.length);
  assert.deepEqual(body.subarray(0, 28), Buffer.alloc(28));
  assert.equal(body.readUInt32LE(28), adts.length);
  assert.deepEqual(body.subarray(32), adts);
});

test("talkback lead frame matches the official pcap channel-2 body", () => {
  const body = buildTalkbackPPCSBody(TALKBACK_LEAD_FRAME);
  // Decrypted APP->CAM seq=0 from /tmp/aqara_talk.pcap
  assert.equal(
    body.toString("hex"),
    "000000000000000000000000000000000000000000000000000000000b000000fff96040017ffc00d00007",
  );
  assert.equal(body.length, 43);
});

test("talkback wraps the decoder lead and AAC data in PPCS channel 2", () => {
  const { bridge, sent } = createReadyBridge();
  const aac = Buffer.from([0xff, 0xf9, 0x60, 0x40, 0x01, 0x7f, 0xfc, 1]);

  assert.equal(bridge.sendAudioFrame(aac), true);
  assert.deepEqual(
    sent.map(({ channel, sequence, payload }) => ({
      channel,
      sequence,
      payload,
    })),
    [
      {
        channel: 2,
        sequence: 0,
        payload: buildTalkbackPPCSBody(TALKBACK_LEAD_FRAME),
      },
      { channel: 2, sequence: 1, payload: buildTalkbackPPCSBody(aac) },
    ],
  );
});

test("an explicit lead frame is sent once, without an extra warm-up frame", () => {
  const { bridge, sent } = createReadyBridge();

  assert.equal(bridge.sendAudioFrame(TALKBACK_LEAD_FRAME), true);
  assert.deepEqual(sent, [
    {
      channel: 2,
      sequence: 0,
      payload: buildTalkbackPPCSBody(TALKBACK_LEAD_FRAME),
    },
  ]);
});
