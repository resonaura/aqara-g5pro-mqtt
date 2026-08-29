import { execFile } from "child_process";
import { config } from "dotenv";
import * as path from "path";
import { promisify } from "util";
import {
  getCameras,
  getCameraStreamQualities,
  getToken,
  jsonQualityChannel,
  login,
  pickMaxStreamQuality,
} from "../../aqara.js";
import { AqaraCameraBridge } from "../../bridge.js";

config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), "app/.env") });

process.env.DEBUG = process.env.DEBUG || "1";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = parseInt(process.env.PROBE_WAIT_MS || "8000", 10);
const FFMPEG_MS = 5000;

async function ffmpegProbe(url: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-rtsp_transport",
        "tcp",
        "-timeout",
        "4000000",
        "-i",
        url,
        "-frames:v",
        "2",
        "-f",
        "null",
        "-",
      ],
      { timeout: FFMPEG_MS, maxBuffer: 2_000_000 },
    );
    return stderr.toString();
  } catch (e: any) {
    return (e.stderr?.toString() || e.message || String(e)).slice(0, 2500);
  }
}

async function probeOne(
  cam: {
    did: string;
    deviceName: string;
    model: string;
    ip?: string;
  },
  token: string,
  port: number,
): Promise<void> {
  let ch1 = 0,
    frames = 0,
    idrs = 0,
    audio = 0;
  let p2pCh = 1;
  try {
    const q = await getCameraStreamQualities(cam.did);
    const best = pickMaxStreamQuality(q);
    if (best) p2pCh = jsonQualityChannel(best, cam.model);
    else p2pCh = jsonQualityChannel(null, cam.model);
    console.log(
      `📺 ${cam.deviceName} qualities=${q.map((x) => x.title).join(",") || "none"} jsonChannel=${p2pCh}`,
    );
  } catch (e: any) {
    console.log(`📺 ${cam.deviceName} quality fetch failed: ${e.message}`);
  }

  const bridge = new AqaraCameraBridge({
    did: cam.did,
    token,
    cameraIp: cam.ip,
    cameraPort: 32108,
    rtspPort: port,
    model: cam.model,
    p2pQualityChannel: p2pCh,
  });
  bridge.on("packet_data_ch1", () => {
    ch1++;
  });
  bridge.on("frame", (f: { isKeyframe?: boolean }) => {
    frames++;
    if (f?.isKeyframe) idrs++;
  });
  bridge.on("audio_frame", () => {
    audio++;
  });
  const ready = new Promise<void>((resolve) => {
    bridge.once("rtsp_ready", () => resolve());
  });

  await bridge.start();
  const t0 = Date.now();
  await Promise.race([ready, sleep(WAIT_MS)]);
  await sleep(3000);
  const url = `rtsp://127.0.0.1:${port}/live`;
  console.log(
    `📊 ${cam.deviceName} wait=${Date.now() - t0}ms ch1=${ch1} frames=${frames} I=${idrs} audio=${audio} framesSeen=${bridge.frameCount}`,
  );

  if (frames === 0) {
    console.log(`❌ ${cam.deviceName} no P2P frames — skip ffmpeg`);
    bridge.stop();
    return;
  }

  console.log(`🎬 ffmpeg ${url}`);
  const ff = await ffmpegProbe(url);
  const lines = ff
    .split("\n")
    .filter((l) =>
      /Stream|Video:|Audio:|error|Invalid|non-existing|frame=|Duration|rtsp/i.test(
        l,
      ),
    )
    .slice(0, 18);
  console.log(lines.join("\n") || ff.slice(-800));
  bridge.stop();
}

async function main() {
  if (process.env.AQARA_USER && process.env.AQARA_PASS) {
    await login(process.env.AQARA_USER, process.env.AQARA_PASS);
  }
  const cams = await getCameras();
  const token = getToken();
  const want = process.argv.slice(2);
  const list = want.length
    ? cams.filter((c) =>
        want.some((w) =>
          (c.deviceName + c.did + c.model)
            .toLowerCase()
            .includes(w.toLowerCase()),
        ),
      )
    : cams;
  if (!list.length) {
    console.error("no cameras");
    process.exit(1);
  }
  const base = parseInt(process.env.PROBE_PORT || "8654", 10);
  for (let i = 0; i < list.length; i++) {
    console.log(`\n—— ${list[i].deviceName} ——`);
    await probeOne(list[i], token, base + i);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
