import "dotenv/config";
import path from "path";
import {
  aqaraDeviceToMQTT,
  checkDeviceCapabilities,
  getCameras,
  login,
  queryAttrs,
  writeAttr,
} from "./aqara.js";
import { AqaraCameraBridge, getLocalIpv4 } from "./bridge.js";
import { resolveCameraIp } from "./camera-ip.js";
import "./config.js";
import { promises as fs } from "node:fs";
import { getCameraStreamQualities, pickMaxStreamQuality, jsonQualityChannel } from "./aqara.js";
import {
  publishCameraDiscovery,
  publishDiscovery,
  publishLightDiscovery,
  publishNativeRTSPDiscovery,
  publishP2PRTSPDiscovery,
  publishP2PStreamSwitchDiscovery,
  publishPTZDiscovery,
  publishRTSPDiscovery,
  publishSDCardDiscovery,
  publishSnapshotUrlDiscovery,
  publishTalkbackRTMPDiscovery,
} from "./discovery.js";
import { ENTITIES } from "./entities.js";
import { FrameHTTPServer } from "./http-server.js";
import { EVENT_ATTRS, processEventAttrs, publishMotionDiscovery } from "./motion.js";
import { createMQTTClient } from "./mqtt.js";
import {
  findFreePortRange,
  writeRTSPPortMap,
  readRTSPPortMap,
  isPortAllowed,
  type RTSPPortEntry,
} from "./ports.js";
import { RTMPIngestServer } from "./rtmp.js";
import { assignUniqueSlugs } from "./slug.js";
import { FrameSnapshotter } from "./snapshot.js";
import { OfflineCardManager } from "./offline-card.js";
import { FallbackStreamManager } from "./fallback-stream.js";
import { NativeMediaEngine } from "./native-engine.js";
import { Device, MQTTDevice } from "./types.js";
import { generateEnvExample, normalizeValue } from "./utils.js";
import { loadP2PState, saveP2PState, getDataDir, getCameraState, setCameraState } from "./state.js";
import { StreamRecovery } from "./stream-recovery.js";
import { closeDatabase } from "./db/data-source.js";
import { diagnostics, cameraDiagnosticId } from "./diagnostics.js";

const journal = diagnostics.start(path.join(getDataDir(), "diagnostics"));
journal.captureConsole();
const diagnosticVersion = await fs
  .readFile(new URL("../package.json", import.meta.url), "utf8")
  .then((value) => JSON.parse(value).version)
  .catch(() => "unknown");
diagnostics.record("app.start", {
  version: diagnosticVersion,
  pid: process.pid,
  node: process.version,
  arch: process.arch,
});
process.on("uncaughtExceptionMonitor", (error, origin) => {
  journal.crash(error, origin);
  // Previous journal batches are durable; the crash itself is saved synchronously.
});
process.on("uncaughtException", (error) => {
  // Exit nonzero for the add-on watchdog, but do not let Node print raw secrets
  // from an HTTP error/config object in its default exception formatter.
  console.error("[App] Fatal exception:", error);
  process.exit(1);
});

if (process.env.NODE_ENV !== "production") {
  await generateEnvExample();
}

// Auto-login using email/password if TOKEN is not set or expired
if (process.env.AQARA_USER && process.env.AQARA_PASS) {
  console.log("🔑 Logging in with Aqara credentials...");
  try {
    await login(process.env.AQARA_USER, process.env.AQARA_PASS);
    console.log("✅ Login successful");
  } catch (err: any) {
    console.warn("⚠️ Login failed:", err.message);
  }
}

// Discover all cameras
let cameras = await getCameras();
if (cameras.length === 0 && process.env.AQARA_USER && process.env.AQARA_PASS) {
  console.log("🔄 Retrying login and camera discovery...");
  await login(process.env.AQARA_USER, process.env.AQARA_PASS);
  cameras = await getCameras();
}

console.log(`🎥 Found ${cameras.length} camera(s):`);
cameras.forEach((camera) => console.log(`  - ${camera.deviceName} (${camera.did})`));

if (cameras.length === 0) {
  console.error("❌ No cameras found!");
  process.exit(1);
}

// Prepare camera metadata and device contexts
const cameraData: Array<{
  device: Device;
  mqttDevice: MQTTDevice;
  hasSpotlight: boolean;
  videoCodec: "h264" | "hevc";
  bridge?: AqaraCameraBridge;
  snapshotter?: FrameSnapshotter;
}> = [];

const rtspBasePort = parseInt(process.env.RTSP_PORT || "8555", 10);

// PTZ-capable Aqara models (pan/tilt cameras: G3, E1, etc.). G5 Pro (agl004) / G2H / G4 are fixed.
function supportsPtz(model: string): boolean {
  const m = (model || "").toLowerCase();
  return (
    m.includes("acn001") ||
    m.includes("acn006") ||
    m.includes("e1") ||
    m.includes("g3") ||
    m.includes("ptz") ||
    m.includes("pan") ||
    m.includes("tilt")
  );
}

for (let i = 0; i < cameras.length; i++) {
  const camera = cameras[i];
  const mqttDevice = aqaraDeviceToMQTT(camera);
  const capabilities = await checkDeviceCapabilities(camera.did);
  const saved = await getCameraState(camera.did);

  cameraData.push({
    device: camera,
    mqttDevice,
    hasSpotlight: capabilities.hasSpotlight,
    videoCodec: saved.video_codec === "hevc" ? "hevc" : "h264",
    bridge: undefined,
  });
  console.log(`📋 ${camera.deviceName}: spotlight=${capabilities.hasSpotlight ? "✅" : "❌"}`);
}

// Allocate a contiguous block of free RTSP ports (default 8555, walking up if
// the preferred port (or any port in the block) is already taken).
// Keeps camera ports sequential and avoids well-known / 3xxx / 5xxx ranges.
const savedPortMap = readRTSPPortMap();
const slugMap = assignUniqueSlugs(
  cameraData.map((c) => ({ did: c.device.did, name: c.device.deviceName })),
);
const rtspPorts: number[] = [];
const allSavedValid =
  savedPortMap &&
  cameraData.length > 0 &&
  cameraData.every((c) => {
    const entry = savedPortMap.cameras[c.device.did];
    return entry && isPortAllowed(entry.port);
  });

if (allSavedValid) {
  for (let i = 0; i < cameraData.length; i++) {
    rtspPorts.push(savedPortMap!.cameras[cameraData[i].device.did].port);
  }
} else {
  const allocated = await findFreePortRange(cameraData.length || 1, rtspBasePort);
  rtspPorts.push(...allocated);
}

const rtspPortEntries = new Map<string, RTSPPortEntry>();
for (let i = 0; i < cameraData.length; i++) {
  const did = cameraData[i].device.did;
  rtspPortEntries.set(did, {
    port: rtspPorts[i],
    did,
    slug: slugMap[did],
  });
}
writeRTSPPortMap(rtspBasePort, [...rtspPortEntries.values()]);
console.log(`🎚️  RTSP ports: ${rtspPorts.join(", ")} (base ${rtspBasePort})`);

const rtmpPort = parseInt(process.env.RTMP_PORT || "1935", 10);
const rtmpServer = new RTMPIngestServer(rtmpPort);
await rtmpServer.start();
console.log(`🎙️ Talkback RTMP ingest listening on port ${rtmpServer.listenPort}`);

// HTTP server for serving cached JPEG snapshots — only used while a P2P
// stream is active for a given camera. Bound to process.env.HTTP_PORT || 8580 (auto-allocated).

const framesDir = path.join(getDataDir(), "frames");
const httpServer = new FrameHTTPServer(framesDir);
await httpServer.start();

const client = createMQTTClient();
const bridgeStartPromises = new Map<string, Promise<AqaraCameraBridge>>();
const talkbackFeeds = new Map<string, { ready: boolean; queue: Buffer[] }>();
const recoveries = new Map<string, StreamRecovery>();
const lastCameraProgress = new Map<string, number>();

function cameraBySlug(name: string) {
  return cameraData.find((c) => slugMap[c.device.did] === name);
}

function restartCameraStream(cameraInfo: (typeof cameraData)[number], reason: string): void {
  const did = cameraInfo.device.did;
  let recovery = recoveries.get(did);
  if (!recovery) {
    recovery = new StreamRecovery({
      isEnabled: async () => (await loadP2PState())[did] !== false,
      recover: async (signal, attempt, message) => {
        diagnostics.record(
          "camera.recovery",
          {
            camera: cameraDiagnosticId(did),
            name: cameraInfo.device.deviceName,
            attempt,
            reason: message,
          },
          "warn",
        );
        const slug = slugMap[did];
        const rtspPort = rtspPorts[cameraData.indexOf(cameraInfo)];
        const rtpPort = 10000 + (rtspPort - rtspBasePort) * 4;
        console.warn(`[Recovery:${cameraInfo.device.deviceName}] ${message} (attempt ${attempt})`);
        OfflineCardManager.getInstance().setRecovering(
          {
            slug,
            deviceName: cameraInfo.device.deviceName,
            deviceId: cameraInfo.mqttDevice.id,
            reason: `Reconnecting camera (attempt ${attempt})`,
            onFrameUpdate: (image) =>
              client.publish(
                `homeassistant/camera/${cameraInfo.mqttDevice.id}/camera/image`,
                image,
              ),
          },
          lastCameraProgress.get(did),
        );
        cameraInfo.snapshotter?.stop();
        cameraInfo.snapshotter = undefined;
        FallbackStreamManager.getInstance().startFallback({
          slug,
          deviceName: cameraInfo.device.deviceName,
          rtpPort,
          audioRtpPort: rtpPort + 2,
          isHevc: cameraInfo.videoCodec === "hevc",
        });
        if (cameraInfo.bridge) await cameraInfo.bridge.reconnect(signal);
        else await ensureCameraBridge(cameraInfo, signal);
      },
      onError: (error, attempt) =>
        console.warn(
          `[Recovery:${cameraInfo.device.deviceName}] Attempt ${attempt} failed; retry retained: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
    });
    recoveries.set(did, recovery);
  }
  recovery.request(reason);
}

async function ensureCameraBridge(
  cameraInfo: (typeof cameraData)[number],
  signal?: AbortSignal,
): Promise<AqaraCameraBridge> {
  if (cameraInfo.bridge) return cameraInfo.bridge;
  const existing = bridgeStartPromises.get(cameraInfo.device.did);
  if (existing) return existing;

  const startPromise = (async () => {
    const idx = cameraData.indexOf(cameraInfo);
    const rtspPort = rtspPorts[idx];
    const rtpPort = 10000 + (rtspPort - rtspBasePort) * 4;
    const audioRtpPort = rtpPort + 2;
    const deviceId = cameraInfo.mqttDevice.id;
    const host = process.env.BRIDGE_HOST || getLocalIpv4();
    const slug = slugMap[cameraInfo.device.did];
    const streamUrl = `rtsp://${host}:${rtspPort}/live/${slug}`;
    const rtmpTalkUrl = `rtmp://${host}:${rtmpServer.listenPort}/talk/${slug}`;
    const snapshotUrl = `http://${host}:${httpServer.listenPort}/api/cameras/${slug}/snapshot`;

    const resolvedIp = resolveCameraIp(cameraInfo.device, slug);
    if (resolvedIp) {
      cameraInfo.device.ip = resolvedIp;
      console.log(
        `🌐 [${cameraInfo.device.deviceName}] Direct camera LAN IP configured: ${resolvedIp}`,
      );
    }

    const bridge = new AqaraCameraBridge({
      did: cameraInfo.device.did,
      token: process.env.TOKEN || "",
      cameraIp: cameraInfo.device.ip,
      cameraPort: 32108,
      rtspPort,
      rtspPath: `live/${slug}`,
      udpVideoPort: rtpPort,
      udpAudioPort: audioRtpPort,
      model: cameraInfo.device.model,
      videoCodec: cameraInfo.videoCodec,
      p2pQualityChannel: jsonQualityChannel(null, cameraInfo.device.model),
      videoKey: process.env.VIDEO_KEY,
      deviceName: cameraInfo.device.deviceName,
    });
    cameraInfo.bridge = bridge;

    const updateStreamEntities = () => {
      client.publish(`homeassistant/switch/${deviceId}/p2p_stream/state`, "ON", { retain: true });
      client.publish(`homeassistant/sensor/${deviceId}/p2p_rtsp_stream/state`, streamUrl, {
        retain: true,
      });
      client.publish(`homeassistant/sensor/${deviceId}/talkback_rtmp/state`, rtmpTalkUrl, {
        retain: true,
      });
      client.publish(`homeassistant/sensor/${deviceId}/snapshot_url/state`, snapshotUrl, {
        retain: true,
      });
    };

    const startSnapshotter = () => {
      if (!cameraInfo.snapshotter) {
        const localRtspUrl = `rtsp://127.0.0.1:${rtspPort}/live/${slug}`;
        const snap = new FrameSnapshotter({
          slug,
          did: cameraInfo.device.did,
          rtspUrl: localRtspUrl,
          dataDir: getDataDir(),
          getSnapshot: (did, timeoutMs) =>
            NativeMediaEngine.getInstance().getSnapshot(did, timeoutMs),
        });
        snap.on("frame", async ({ slug: frameSlug, path: framePath }) => {
          if (cameraInfo.snapshotter !== snap) return;
          lastCameraProgress.set(cameraInfo.device.did, Date.now());
          recoveries.get(cameraInfo.device.did)?.healthy();
          OfflineCardManager.getInstance().setOnline(frameSlug);
          const frameUrl = `http://${host}:${httpServer.listenPort}/api/cameras/${frameSlug}/snapshot`;
          client.publish(`homeassistant/sensor/${deviceId}/snapshot_url/state`, frameUrl, {
            retain: true,
          });
          try {
            const imgBuf = await fs.readFile(framePath);
            client.publish(`homeassistant/camera/${deviceId}/camera/image`, imgBuf);
          } catch {}
        });
        snap.on("unhealthy", ({ consecutiveFailures, durationMs }) => {
          void restartCameraStream(
            cameraInfo,
            `Snapshot capture failed ${consecutiveFailures} consecutive times (${Math.round(durationMs / 1000)}s without a valid frame)`,
          );
        });
        snap.start();
        cameraInfo.snapshotter = snap;
      }
    };

    bridge.on("unhealthy", () => {
      void restartCameraStream(cameraInfo, "Native P2P engine reported video stream stall");
    });

    bridge.on("rtsp_listening", (url) => {
      console.log(`📡 [RTSP Server] ${cameraInfo.device.deviceName} listening on ${url}`);
    });

    bridge.on("rtsp_ready", (url) => {
      console.log(`📹 [P2P RTSP] ${cameraInfo.device.deviceName} stream ready at ${url}`);
      updateStreamEntities();
    });

    bridge.on("keyframe", (codec: "h264" | "hevc") => {
      lastCameraProgress.set(cameraInfo.device.did, Date.now());
      cameraInfo.videoCodec = codec;
      void setCameraState(cameraInfo.device.did, { video_codec: codec }).catch(() => {});
      recoveries.get(cameraInfo.device.did)?.healthy();
      FallbackStreamManager.getInstance().stopFallback(slug);
      OfflineCardManager.getInstance().setOnline(slug);
      updateStreamEntities();
      startSnapshotter();
    });

    bridge.on("connected", ({ ip, port }) => {
      console.log(`🔌 [P2P Tunnel] ${cameraInfo.device.deviceName} connected to ${ip}:${port}`);
      if (ip && ip !== "0.0.0.0" && !ip.startsWith("127.")) {
        cameraInfo.device.ip = ip;
      }
    });
    bridge.on("info", (m: string) => console.log(`ℹ️ [${cameraInfo.device.deviceName}] ${m}`));
    bridge.on("warn", (m: string) => console.warn(`⚠️ [${cameraInfo.device.deviceName}] ${m}`));
    bridge.on("error", (e: any) =>
      console.error(`❌ [${cameraInfo.device.deviceName}] ${e?.message || e}`),
    );

    const isHevc = cameraInfo.videoCodec === "hevc";
    FallbackStreamManager.getInstance().startFallback({
      slug,
      deviceName: cameraInfo.device.deviceName,
      rtpPort,
      audioRtpPort,
      isHevc,
    });
    bridge.prepareOutput();
    updateStreamEntities();
    await bridge.start(signal);
    return bridge;
  })();

  bridgeStartPromises.set(cameraInfo.device.did, startPromise);
  try {
    return await startPromise;
  } finally {
    if (bridgeStartPromises.get(cameraInfo.device.did) === startPromise) {
      bridgeStartPromises.delete(cameraInfo.device.did);
    }
  }
}

// Auto-restore saved P2P streams immediately on app boot
void (async () => {
  const initialSavedP2pState = await loadP2PState();
  console.log(
    `💾 Loaded persistent state for ${Object.keys(initialSavedP2pState).length} camera(s) from SQLite (${getDataDir()})`,
  );
  cameraData.forEach((cam) => {
    if (initialSavedP2pState[cam.device.did]) {
      console.log(
        `🔄 [P2P Stream] Auto-restoring saved P2P stream (ON) for ${cam.device.deviceName}...`,
      );
      restartCameraStream(cam, "Restoring saved camera stream");
    }
  });
})();

rtmpServer.on("publish", async ({ name }: { name: string }) => {
  const cam = cameraBySlug(name);
  if (!cam) {
    console.warn(`⚠️ [Talkback RTMP] unknown stream "${name}"`);
    return;
  }
  const feed = { ready: false, queue: [] as Buffer[] };
  talkbackFeeds.set(name, feed);
  console.log(`🎙️ [Talkback RTMP] publisher connected for ${cam.device.deviceName}`);
  try {
    const bridge = await ensureCameraBridge(cam);
    const ok = await bridge.ensureTalkbackReady();
    if (!ok || talkbackFeeds.get(name) !== feed) return;
    feed.ready = true;
    for (const frame of feed.queue.splice(0)) bridge.sendAudioFrame(frame);
  } catch (err: any) {
    talkbackFeeds.delete(name);
    console.warn(
      `⚠️ [Talkback RTMP] startup failed for ${cam.device.deviceName}: ${err?.message || err}`,
    );
  }
});

rtmpServer.on("audio", ({ name, adts }: { name: string; adts: Buffer }) => {
  const cam = cameraBySlug(name);
  const feed = talkbackFeeds.get(name);
  if (!cam?.bridge || !feed) return;
  if (!feed.ready) {
    // Preserve the first couple of seconds while P2P/0x100A is being prepared,
    // but keep the queue bounded for a publisher that starts too early.
    feed.queue.push(Buffer.from(adts));
    if (feed.queue.length > 48) feed.queue.shift();
    return;
  }
  cam.bridge.sendAudioFrame(adts);
});

rtmpServer.on("unpublish", ({ name }: { name: string }) => {
  const cam = cameraBySlug(name);
  talkbackFeeds.delete(name);
  if (!cam?.bridge) return;
  console.log(`🎙️ [Talkback RTMP] publisher left ${cam.device.deviceName}`);
  cam.bridge.stopTalkback();
});

const interval = Number(process.env.POLL_INTERVAL || 1) * 1000;

// === DISCOVERY ===
client.on("connect", async () => {
  console.log("🚀 MQTT connected, publishing discovery...");

  const savedP2pState = await loadP2PState();

  // Publish discovery for all cameras
  cameraData.forEach(async ({ mqttDevice, hasSpotlight, device }, idx) => {
    const slug = slugMap[device.did];
    const bridgeHost = process.env.BRIDGE_HOST || getLocalIpv4();
    const httpPort = httpServer.listenPort;
    const p2pRtspUrl = `rtsp://${bridgeHost}:${rtspPorts[idx]}/live/${slug}`;
    const rtmpTalkUrl = `rtmp://${bridgeHost}:${rtmpServer.listenPort}/talk/${slug}`;
    const snapshotUrl = `http://${bridgeHost}:${httpPort}/api/cameras/${slug}/snapshot`;

    ENTITIES.forEach((e) => publishDiscovery(client, mqttDevice, e));
    publishLightDiscovery(client, mqttDevice, hasSpotlight);
    publishSDCardDiscovery(client, mqttDevice);
    publishMotionDiscovery(client, mqttDevice);
    publishRTSPDiscovery(client, mqttDevice);
    publishP2PStreamSwitchDiscovery(client, mqttDevice);
    publishP2PRTSPDiscovery(client, mqttDevice);
    publishNativeRTSPDiscovery(client, mqttDevice);
    publishSnapshotUrlDiscovery(client, mqttDevice);

    if (supportsPtz(device.model)) {
      publishPTZDiscovery(client, mqttDevice);
    }
    publishTalkbackRTMPDiscovery(client, mqttDevice);
    // Remove the old retained manual switch; RTMP now owns talkback lifecycle.
    client.publish(`homeassistant/switch/${mqttDevice.id}/talkback/config`, "", { retain: true });

    // Initial state from persisted disk state or active bridge
    const isP2pOn = savedP2pState[device.did] || !!cameraData[idx].bridge;
    client.publish(
      `homeassistant/switch/${mqttDevice.id}/p2p_stream/state`,
      isP2pOn ? "ON" : "OFF",
      { retain: true },
    );
    client.publish(
      `homeassistant/sensor/${mqttDevice.id}/p2p_rtsp_stream/state`,
      isP2pOn ? p2pRtspUrl : "null",
      { retain: true },
    );
    client.publish(
      `homeassistant/sensor/${mqttDevice.id}/snapshot_url/state`,
      isP2pOn ? snapshotUrl : "null",
      { retain: true },
    );
    client.publish(
      `homeassistant/sensor/${mqttDevice.id}/talkback_rtmp/state`,
      isP2pOn ? rtmpTalkUrl : "null",
      { retain: true },
    );

    // Query Native camera RTSP URL if available
    try {
      const qualities = await getCameraStreamQualities(device.did);
      const best = pickMaxStreamQuality(qualities);
      const nativeRtspUrl = best
        ? `rtsp://${device.ip || getLocalIpv4()}:554/live/ch${best.channel}`
        : "null";
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/native_rtsp_stream/state`,
        nativeRtspUrl,
        {
          retain: true,
        },
      );
    } catch {
      client.publish(`homeassistant/sensor/${mqttDevice.id}/native_rtsp_stream/state`, "null", {
        retain: true,
      });
    }

    publishCameraDiscovery(client, mqttDevice, p2pRtspUrl);
  });

  // Subscribe to control topics for all cameras
  cameraData.forEach(({ mqttDevice }) => {
    client.subscribe(`homeassistant/+/${mqttDevice.id}/+/set`);
  });
});

// === OPTIMISTIC STATE ===
const stateTopic = (domain: string, deviceId: string, attr: string) =>
  `homeassistant/${domain}/${deviceId}/${attr}/state`;

async function optimistic(
  domain: string,
  deviceId: string,
  attr: string,
  value: string,
  _cameraInfo: (typeof cameraData)[0],
) {
  switch (domain) {
    case "switch":
      client.publish(stateTopic("switch", deviceId, attr), value, {
        retain: true,
      });
      break;
    case "number":
      client.publish(stateTopic("number", deviceId, attr), String(parseInt(value, 10)), {
        retain: true,
      });
      break;
    case "light":
      if (attr !== "spotlight") return;
      {
        const payload = JSON.parse(value);
        const cur = lastLightState.get(deviceId) ?? {
          state: "OFF",
          brightness: 255,
        };
        const next = {
          state: payload.state ?? cur.state,
          brightness:
            payload.brightness !== undefined
              ? (Math.round((payload.brightness / 255) * 100) * 2.55) | 0
              : cur.brightness,
        };
        lastLightState.set(deviceId, next);
        client.publish(stateTopic("light", deviceId, "spotlight"), JSON.stringify(next), {
          retain: true,
        });
      }
      break;
  }
}

const lastLightState = new Map<string, { state: string; brightness: number }>();

const handlers: Record<string, (attr: string, value: string, subjectId: string) => Promise<void>> =
  {
    switch: async (attr, value, subjectId) => writeAttr(attr, value === "ON" ? 1 : 0, subjectId),
    number: async (attr, value, subjectId) => writeAttr(attr, parseInt(value, 10), subjectId),
    light: async (attr, value, subjectId) => {
      if (attr !== "spotlight") return;
      const payload = JSON.parse(value);
      if (payload.state !== undefined) {
        await writeAttr("white_light_enable", payload.state === "ON" ? 1 : 0, subjectId);
      }
      if (payload.brightness !== undefined) {
        const percent = Math.round((payload.brightness / 255) * 100);
        await writeAttr("white_light_level", percent, subjectId);
      }
    },
  };

client.on("message", async (topic, msg) => {
  const [_, domain, deviceId, attr] = topic.split("/");
  const value = msg.toString();

  // Find camera by device ID
  const cameraInfo = cameraData.find(({ mqttDevice }) => mqttDevice.id === deviceId);
  if (!cameraInfo) {
    console.error(`❌ Unknown device ID: ${deviceId}`);
    return;
  }

  const subjectId = cameraInfo.device.did;
  // Log significant control events; filter high-frequency poll noise
  if (
    attr === "p2p_stream" ||
    attr === "talkback" ||
    (domain === "button" && attr.startsWith("ptz_"))
  ) {
    console.log(`⬅️ HA → ${cameraInfo.device.deviceName}.${attr}=${value}`);
  }

  // === SPECIAL HANDLER FOR P2P STREAM SWITCH ===
  if (attr === "p2p_stream") {
    const p2pSwitchTopic = `homeassistant/switch/${deviceId}/p2p_stream/state`;
    const p2pRtspTopic = `homeassistant/sensor/${deviceId}/p2p_rtsp_stream/state`;
    const snapshotUrlTopic = `homeassistant/sensor/${deviceId}/snapshot_url/state`;
    const talkbackRtmpTopic = `homeassistant/sensor/${deviceId}/talkback_rtmp/state`;
    if (value === "ON") {
      console.log(`🔌 [P2P Stream] Enabling P2P Stream for ${cameraInfo.device.deviceName}...`);
      await saveP2PState(cameraInfo.device.did, true);
      client.publish(p2pSwitchTopic, "ON", { retain: true });
      restartCameraStream(cameraInfo, "Stream enabled by user");
    } else {
      console.log(`🛑 [P2P Stream] Disabling P2P Stream for ${cameraInfo.device.deviceName}...`);
      await saveP2PState(cameraInfo.device.did, false);
      recoveries.get(cameraInfo.device.did)?.stop();
      recoveries.delete(cameraInfo.device.did);
      bridgeStartPromises.delete(cameraInfo.device.did);
      const slug = slugMap[cameraInfo.device.did];
      FallbackStreamManager.getInstance().stopFallback(slug);
      OfflineCardManager.getInstance().setOffline({
        slug,
        deviceName: cameraInfo.device.deviceName,
        deviceId,
        reason: "P2P stream is switched OFF",
        onFrameUpdate: (imgBuf) => {
          client.publish(`homeassistant/camera/${deviceId}/camera/image`, imgBuf);
        },
      });
      if (cameraInfo.bridge) {
        cameraInfo.bridge.stop();
        cameraInfo.bridge = undefined;
      }
      if (cameraInfo.snapshotter) {
        cameraInfo.snapshotter.stop();
        cameraInfo.snapshotter = undefined;
      }
      client.publish(p2pSwitchTopic, "OFF", { retain: true });
      client.publish(p2pRtspTopic, "null", { retain: true });
      client.publish(snapshotUrlTopic, "null", { retain: true });
      client.publish(talkbackRtmpTopic, "null", { retain: true });
    }
    return;
  }

  // === PTZ BUTTONS ===
  if (domain === "button" && attr.startsWith("ptz_")) {
    const dir = attr.replace(/^ptz_/, "");
    console.log(`🕹️ [PTZ] ${cameraInfo.device.deviceName} → ${dir}`);
    if (!cameraInfo.bridge) {
      console.warn(
        `⚠️ [PTZ] P2P stream not active for ${cameraInfo.device.deviceName}; start it first`,
      );
    } else {
      cameraInfo.bridge.ptz(dir);
    }
    return;
  }

  try {
    await optimistic(domain, deviceId, attr, value, cameraInfo);
    await handlers[domain]?.(attr, value, subjectId);
    setTimeout(() => {
      pollSingle(attr, subjectId, cameraInfo.mqttDevice).catch(() => {});
    }, 2000);
  } catch (err) {
    console.error("❌ Command failed:", err);
  }
});

// === RTSP STREAM URLS (Official / cloud RTSP URL) ===
const QUALITY_ORDER = ["1520p", "1080p", "720p", "360p"];

const lastPublishedValues = new Map<string, string>();

async function publishRTSPState(subjectId: string, cameraInfo: (typeof cameraData)[0]) {
  const res = await queryAttrs(["rtsp_url"], subjectId);
  const raw = res.result?.[0]?.value;
  if (!raw) return;
  try {
    const urls = JSON.parse(raw);
    const best = QUALITY_ORDER.find((q) => urls[q]);
    if (!best) return;
    client.publish(
      `homeassistant/sensor/${cameraInfo.mqttDevice.id}/rtsp_stream/state`,
      urls[best],
      { retain: true },
    );
    const rtspKey = `${cameraInfo.device.did}:official_rtsp`;
    const prevRtsp = lastPublishedValues.get(rtspKey);
    if (prevRtsp !== urls[best]) {
      lastPublishedValues.set(rtspKey, urls[best]);
      console.log(`📹 ${cameraInfo.device.deviceName} Official RTSP=${urls[best]}`);
    }
  } catch {
    console.error("❌ Failed to parse rtsp_url:", raw);
  }
}

// === POLLING ===
const pollingCameras = new Set<string>();
function poll(): void {
  const attrs = ENTITIES.map((e) => e.attr).concat(["white_light_enable", "white_light_level"]);
  for (const cameraInfo of cameraData) {
    const did = cameraInfo.device.did;
    if (pollingCameras.has(did)) continue;
    pollingCameras.add(did);
    // One bounded poll per camera; an offline camera cannot pile up polls or block its peers.
    void (async () => {
      try {
        const res = await queryAttrs(attrs, did);
        for (const r of res.result || []) await publishAttr(r.attr, r.value, cameraInfo);
        const events = await queryAttrs(EVENT_ATTRS, did);
        if (events.code === 0)
          processEventAttrs(client, cameraInfo.mqttDevice, events.result || []);
        await publishRTSPState(did, cameraInfo);
      } catch (error) {
        console.warn(
          `[Poll:${cameraInfo.device.deviceName}] ${error instanceof Error ? error.message : "Request failed"}`,
        );
      } finally {
        pollingCameras.delete(did);
      }
    })();
  }
}

async function pollSingle(attr: string, subjectId: string, _mqttDevice: MQTTDevice) {
  const res = await queryAttrs([attr], subjectId);
  const result = res.result?.[0];
  if (result) {
    const cameraInfo = cameraData.find((c) => c.device.did === subjectId);
    if (cameraInfo) {
      await publishAttr(result.attr, result.value, cameraInfo, true);
    }
  }
}

// === ATTRIBUTE PUBLISHER ===
async function publishAttr(
  attr: string,
  rawValue: any,
  cameraInfo: (typeof cameraData)[0],
  refreshed = false,
) {
  const { mqttDevice, device } = cameraInfo;
  const isDebug = process.env.LOG_LEVEL === "debug";

  if (["white_light_enable", "white_light_level"].includes(attr)) {
    const [power, level] = await Promise.all([
      queryAttrs(["white_light_enable"], device.did),
      queryAttrs(["white_light_level"], device.did),
    ]);
    const state = power.result?.[0]?.value === "1" ? "ON" : "OFF";
    const brightness = Math.round((Number(level.result?.[0]?.value || 0) / 100) * 255);
    const lightState = { state, brightness };
    lastLightState.set(mqttDevice.id, lightState);
    client.publish(
      `homeassistant/light/${mqttDevice.id}/spotlight/state`,
      JSON.stringify(lightState),
      { retain: true },
    );
    const spotKey = `${device.did}:spotlight`;
    const spotStr = `${state}, ${brightness}`;
    const prevSpot = lastPublishedValues.get(spotKey);
    if (prevSpot !== spotStr || refreshed) {
      lastPublishedValues.set(spotKey, spotStr);
      console.log(
        `${refreshed ? "🔄" : "💡"} ${device.deviceName} Spotlight=${state}, ${brightness}`,
      );
    }
    return;
  }

  if (attr === "sdcard_status") {
    try {
      const parsed = JSON.parse(rawValue);
      const usedPercent = Math.round(
        ((parsed.totalsize - parsed.freesize) / parsed.totalsize) * 100,
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_total/state`,
        String(parsed.totalsize),
        { retain: true },
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_free/state`,
        String(parsed.freesize),
        { retain: true },
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_status/state`,
        String(parsed.sdstatus),
        { retain: true },
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_percent/state`,
        String(usedPercent),
        { retain: true },
      );
    } catch {
      console.error("❌ Failed to parse sdcard_status:", rawValue);
    }
    return;
  }

  const entity = ENTITIES.find((e) => e.attr === attr);
  if (!entity) return;

  const topic = `homeassistant/${entity.domain}/${mqttDevice.id}/${attr}/state`;
  const value = normalizeValue(entity.domain, attr, rawValue);
  client.publish(topic, String(value), { retain: true });

  const stateKey = `${device.did}:${attr}`;
  const strVal = String(value);
  const prevVal = lastPublishedValues.get(stateKey);

  if (prevVal === undefined) {
    lastPublishedValues.set(stateKey, strVal);
    if (isDebug) {
      console.log(`📊 ${device.deviceName} ${attr}=${strVal}`);
    }
  } else if (prevVal !== strVal || refreshed) {
    lastPublishedValues.set(stateKey, strVal);
    console.log(`📊 ${device.deviceName} ${attr}: ${prevVal} ➔ ${strVal}`);
  }
}

// === GRACEFUL SHUTDOWN ===
async function shutdown(signal: string) {
  diagnostics.record("app.shutdown", { signal });
  console.log(`\n🛑 [App] Received ${signal}, performing graceful shutdown...`);
  try {
    for (const recovery of recoveries.values()) recovery.stop();
    for (const c of cameraData) {
      c.snapshotter?.stop();
      c.bridge?.stop();
    }
    FallbackStreamManager.getInstance().stopAll();
    OfflineCardManager.getInstance().stopAll();
    httpServer.stop();
    rtmpServer.stop();
    NativeMediaEngine.getInstance().stop();
    client.end();
    await closeDatabase();
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
  }
  await diagnostics.flush();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const diagnosticTimer = setInterval(() => {
  const memory = process.memoryUsage();
  diagnostics.record("app.health", {
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapBytes: memory.heapUsed,
    workerReady: NativeMediaEngine.getInstance().ready,
    cameras: cameraData.map(({ device }) => ({
      camera: cameraDiagnosticId(device.did),
      name: device.deviceName,
      snapshotAgeMs: lastCameraProgress.has(device.did)
        ? Date.now() - lastCameraProgress.get(device.did)!
        : null,
    })),
  });
}, 30_000);
diagnosticTimer.unref();

// === START ===
setInterval(poll, interval);
poll();
