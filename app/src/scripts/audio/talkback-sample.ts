import { execSync } from "child_process";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getCameras, getToken, login } from "../../aqara.js";
import { splitAdts } from "../../audio.js";
import { AqaraCameraBridge } from "../../bridge.js";

config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), "app/.env") });

process.env.DEBUG = process.env.DEBUG || "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ground truth from the official app: one empty 0x100A, then a full MPEG-2
// ADTS AAC-LC 16 kHz mono frame on P2P channel 2 every 64 ms, then 0x100C.
const TALK_SAMPLE_RATE = 16000;
// Aqara Home's captured AAC frames are predominantly 120–200 bytes per 64 ms
// AAC access unit.  At 16 kHz mono that corresponds to about 16 kb/s; 32 kb/s
// produces 250–400 byte frames which the camera accepts at the transport layer
// but does not hand to its speaker decoder.
const TALK_BITRATE = process.env.TALKBACK_BITRATE ?? "16k";

async function transcode(wavPath: string, sr: number): Promise<Buffer[]> {
  // Allow relative paths resolved against cwd AND the workspace root (the harness
  // is usually launched from app/, while the audio/ folder is at the repo root).
  const candidates = [
    wavPath,
    path.resolve(process.cwd(), wavPath),
    path.resolve(process.cwd(), "..", wavPath),
  ];
  const resolved = candidates.find((c) => fs.existsSync(c));
  if (!resolved) {
    console.error(
      `❌ Audio file not found: ${wavPath} (tried ${candidates.join(", ")})`,
    );
    process.exit(1);
  }
  const wav16 = "/tmp/aqara_talkback_16k.wav";
  const aacPath = "/tmp/aqara_talkback_sample.aac";
  // Loudness-normalize to 16 kHz mono PCM first, then encode with macOS
  // AudioToolbox (same encoder as Aqara Home). ffmpeg's native AAC injects a
  // "Lavc..." FIL ident as the first access unit; the camera decoder drops it.
  try {
    execSync(
      `ffmpeg -y -nostats -err_detect ignore_err -fflags +genpts -i "${resolved}" ` +
        `-af loudnorm=I=-16:TP=-1.5:LRA=11 -ar ${sr} -ac 1 ` +
        `-c:a pcm_s16le "${wav16}"`,
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e: any) {
    console.error(
      `❌ ffmpeg resample failed on ${resolved}:\n${e.stderr?.toString() || e.message}`,
    );
    process.exit(1);
  }
  const bitrateBps = String(parseInt(TALK_BITRATE, 10) * 1000 || 16000);
  let encoded = false;
  try {
    execSync(
      `afconvert -f adts -d aacl@${sr} -c 1 -b ${bitrateBps} -s 0 "${wav16}" "${aacPath}"`,
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    encoded = true;
    console.log(
      "🎛️ Encoded with afconvert (AudioToolbox AAC-LC, matches Aqara Home)",
    );
  } catch {
    /* fall through to ffmpeg */
  }
  if (!encoded) {
    try {
      execSync(
        `ffmpeg -y -nostats -i "${wav16}" -c:a aac -profile:a aac_low -b:a ${TALK_BITRATE} ` +
          `-aac_coder twoloop -flags +bitexact -fflags +bitexact -f adts "${aacPath}"`,
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      console.log("🎛️ Encoded with ffmpeg AAC-LC (afconvert unavailable)");
    } catch (e: any) {
      console.error(
        `❌ AAC encode failed:\n${e.stderr?.toString() || e.message}`,
      );
      process.exit(1);
    }
  }
  let frames = splitAdts(fs.readFileSync(aacPath)).filter(
    (f) => !f.includes(Buffer.from("Lavc")),
  );
  // Official Aqara Home access units are ~120–220 B (a few up to ~245).
  const typical = frames.filter((f) => f.length <= 280);
  if (typical.length > 0) frames = typical;
  // AudioToolbox/ffmpeg may emit MPEG-4 ADTS (byte1=0xf1). The camera, like
  // the app, uses MPEG-2 ADTS (byte1=0xf9).
  const patched = frames.map((f) => {
    const c = Buffer.from(f);
    c[1] |= 0x08;
    return c;
  });
  const sizes = patched.map((f) => f.length);
  console.log(
    `📦 AAC frames: ${patched.length}  sizes ${Math.min(...sizes)}–${Math.max(...sizes)} B  (official ~120–220)`,
  );
  return patched;
}

async function main() {
  console.log("🎙️ Aqara Talkback Sample (official-app wire format)\n");

  if (process.env.AQARA_USER && process.env.AQARA_PASS) {
    await login(process.env.AQARA_USER, process.env.AQARA_PASS);
  }
  const token = getToken();
  const cameras = await getCameras();
  const targetFilter = (
    process.argv.slice(2).find((a) => !a.toLowerCase().endsWith(".wav")) ||
    process.env.TARGET_CAM ||
    "guinea"
  ).toLowerCase();
  const cam =
    cameras.find(
      (c) =>
        c.deviceName.toLowerCase().includes(targetFilter) ||
        c.did.toLowerCase().includes(targetFilter),
    ) || cameras[0];
  if (!cam) {
    console.error("❌ No suitable camera found.");
    process.exit(1);
  }
  console.log(`🎯 Targeting Camera: ${cam.deviceName} (${cam.did})\n`);

  const bridge = new AqaraCameraBridge({
    did: cam.did,
    deviceName: cam.deviceName,
    token: token,
    cameraIp: cam.ip,
    cameraPort: 32108,
    rtspPort: 8592,
  });

  // Register before start(): discovery can complete quickly on a LAN and an
  // after-the-fact listener occasionally missed the only `connected` event.
  const connected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("P2P connection timed out after 35 seconds"));
    }, 35_000);
    const onConnected = () => {
      cleanup();
      console.log("✅ P2P connected and authenticated transport is ready!");
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      bridge.off("connected", onConnected);
      bridge.off("error", onError);
    };
    bridge.once("connected", onConnected);
    bridge.once("error", onError);
  });

  // Aqara Home opens talkback through the normal 0x1002/0x1003 media session.
  // Keep that session active even though this script does not consume RTSP.
  await bridge.start();
  await connected;

  // Accept one or more .wav files as argv[2..]; default to plop.wav. This lets us
  // compare speech vs non-speech (melody/baby) to detect any speech-only gate
  // (VAD) on the camera's talk/speaker path.
  const wavArgs = process.argv
    .slice(2)
    .filter((a) => a.toLowerCase().endsWith(".wav"));
  const wavList = wavArgs.length
    ? wavArgs
    : [path.resolve(process.cwd(), "..", "audio", "plop.wav")];
  console.log(
    `🎵 Clip(s): ${wavList.map((w) => path.basename(w)).join(", ")}\n`,
  );

  for (const wav of wavList) {
    console.log(
      `\n▶ Playing ${path.basename(wav)}: 0x100A → ADTS/ch2 → 0x100C (video stays active)`,
    );
    const frames = await transcode(wav, TALK_SAMPLE_RATE);

    console.log("🎙️ Starting talkback on existing P2P session (0x100A)...");
    await bridge.startTalkback();
    // Ground truth from official app Frida log:
    // 1) Emit 0x100A on CH0.
    // 2) Wait 1.94s for camera speaker hardware init.
    // 3) Send 11-byte lead frame (TALKBACK_LEAD_FRAME) on CH2.
    // 4) Wait 620ms.
    // 5) Send audio frames spaced on exact 64ms wall-clock boundaries.
    await sleep(1940);
    console.log("🔊 Sending lead frame...");
    if (
      !bridge.sendAudioFrame(
        Buffer.from([
          0xff, 0xf9, 0x60, 0x40, 0x01, 0x7f, 0xfc, 0x00, 0xd0, 0x00, 0x07,
        ]),
      )
    ) {
      throw new Error("Camera rejected the talkback lead frame");
    }
    await sleep(620);

    const frameMs = (1024 / TALK_SAMPLE_RATE) * 1000;
    const startTime = performance.now();
    for (let i = 0; i < frames.length; i++) {
      if (!bridge.sendAudioFrame(frames[i])) {
        throw new Error(`Camera connection ended at audio frame ${i}`);
      }
      const nextTarget = startTime + (i + 1) * frameMs;
      const delay = nextTarget - performance.now();
      if (delay > 0) {
        await sleep(delay);
      }
    }
    await sleep(300);
    bridge.stopTalkback();
    await sleep(600);
    console.log(
      `✅ Finished ${path.basename(wav)} (${frames.length} AAC frames)`,
    );
  }

  bridge.stop();
  process.exit(0);
}

main().catch(console.error);
