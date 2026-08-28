import { config } from "dotenv";
import { getCameras, getToken, login, queryAttrs } from "../../aqara.js";
import { AqaraCameraBridge, getLocalIpv4 } from "../../bridge.js";
import {
  findFreePortRange,
  writeRtspPortMap,
  type RtspPortEntry,
} from "../../ports.js";
import { assignUniqueSlugs } from "../../slug.js";

config();

async function main() {
  console.log("====================================================");
  console.log(
    "🎥 Aqara Cameras — High-Performance Pure TypeScript RTSP Server",
  );
  console.log("====================================================\n");

  if (process.env.AQARA_USER && process.env.AQARA_PASS) {
    console.log("🔑 Authenticating with Aqara Cloud...");
    await login(process.env.AQARA_USER, process.env.AQARA_PASS);
    console.log("✅ Authentication successful\n");
  }

  const token = getToken();
  const cameras = await getCameras();
  if (cameras.length === 0) {
    console.error("❌ No cameras found in Aqara account.");
    process.exit(1);
  }

  console.log(`📡 Found ${cameras.length} camera(s):\n`);

  const localIp = process.env.BRIDGE_HOST || getLocalIpv4();

  // Allocate a contiguous block of free RTSP ports (default 8555, walking up if
  // the preferred port — or any in the block — is already taken).
  // No shared "common proxy" port is used; each camera gets its own sequential
  // port and is a fully standalone RTSP stream served directly by the bridge.
  const rtspPortBase = parseInt(process.env.RTSP_PORT || "8555", 10);
  const rtspPorts = await findFreePortRange(cameras.length, rtspPortBase);
  const slugMap = assignUniqueSlugs(
    cameras.map((c) => ({ did: c.did, name: c.deviceName })),
  );
  let camIdx = 0;
  const rtspPortEntries: RtspPortEntry[] = [];
  const activeBridges: Array<{
    bridge: AqaraCameraBridge;
    slug: string;
    did: string;
    port: number;
  }> = [];

  interface CamState {
    deviceName: string;
    model: string;
    rtspUrl: string;
    rtspPort: number;
    streamSlug: string;
    connected: boolean;
    hasSeenKeyframe: boolean;
  }

  const camStates = new Map<string, CamState>();

  for (const cam of cameras) {
    console.log(`----------------------------------------------------`);
    console.log(`📷 Camera: ${cam.deviceName} (${cam.model}) [${cam.did}]`);

    // Check if camera has official ONVIF/RTSP
    try {
      const res = await queryAttrs(["stream_address"], cam.did);
      const val = res?.result?.[0]?.value;
      if (val && typeof val === "string" && val.startsWith("rtsp://")) {
        console.log(`   ✅ Official Native RTSP Stream:`);
        console.log(`      🔗 ${val}\n`);
        continue;
      }
    } catch {
      // No stream_address attribute
    }

    const streamSlug = slugMap[cam.did];
    const rtspPort = rtspPorts[camIdx++];
    const rtspUrl = `rtsp://${localIp}:${rtspPort}/live/${streamSlug}`;
    console.log(`   🔌 Starting RTSP Engine on port ${rtspPort}...`);

    const state: CamState = {
      deviceName: cam.deviceName,
      model: cam.model,
      rtspUrl,
      rtspPort,
      streamSlug,
      connected: false,
      hasSeenKeyframe: false,
    };
    camStates.set(cam.did, state);
    rtspPortEntries.push({ port: rtspPort, did: cam.did, slug: streamSlug });

    const bridge = new AqaraCameraBridge({
      did: cam.did,
      token: token,
      cameraIp: cam.ip,
      cameraPort: 32108,
      baseUrl: process.env.AQARA_BASE_URL || "https://open-usa.aqara.com",
      appId: process.env.AQARA_APP_ID || "",
      appKey: process.env.AQARA_APP_KEY || "",
      rtspPort: rtspPort,
    });

    bridge.on("connected", () => {
      state.connected = true;
    });

    bridge.on("stream_started", () => {
      state.connected = true;
      state.hasSeenKeyframe = true;
    });

    bridge.on("disconnected", () => {
      state.connected = false;
    });

    bridge.on("rtsp_ready", (url: string) => {
      const actualPort = Number(url.match(/:(\d+)\//)?.[1] || rtspPort);
      if (actualPort !== rtspPort) {
        state.rtspPort = actualPort;
        state.rtspUrl = `rtsp://${localIp}:${actualPort}/live/${streamSlug}`;
        const e = rtspPortEntries.find((x) => x.did === cam.did);
        if (e) e.port = actualPort;
        writeRtspPortMap(rtspPortBase, rtspPortEntries);
      }
      console.log(`   ✅ RTSP Stream Ready:`);
      console.log(`      🔗 ${state.rtspUrl}\n`);
    });

    try {
      await bridge.start();
      activeBridges.push({
        bridge,
        slug: streamSlug,
        did: cam.did,
        port: rtspPort,
      });
    } catch (err: any) {
      console.error(
        `   ❌ Failed to start bridge for ${cam.deviceName}:`,
        err.message,
      );
    }
  }

  writeRtspPortMap(rtspPortBase, rtspPortEntries);
  console.log(
    `\n🎚️  RTSP ports: ${rtspPorts.join(", ")} (base ${rtspPortBase})`,
  );

  // Live status telemetry ticker
  setInterval(() => {
    for (const [did, s] of camStates.entries()) {
      const icon = s.connected ? "🟢 LIVE" : "⚪ CONNECTING";
      const keyIcon = s.hasSeenKeyframe ? "🔑" : "⏳";
      const namePad = s.deviceName.padEnd(20, " ");

      console.log(
        ` [${icon}] ${namePad} | Status: ${keyIcon} | 🔗 ${s.rtspUrl}`,
      );
    }
  }, 3000);

  const cleanup = () => {
    console.log("\n🛑 Stopping all RTSP bridges...");
    for (const item of activeBridges) {
      item.bridge.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
