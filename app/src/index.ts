import "./config.js";
import { createMqttClient } from "./mqtt.js";
import {
  publishDiscovery,
  publishLightDiscovery,
  publishSdCardDiscovery,
  publishRtspDiscovery,
  publishCameraDiscovery,
  publishP2pStreamSwitchDiscovery,
  publishP2pRtspDiscovery,
  publishPtzDiscovery,
  publishTalkbackDiscovery,
} from "./discovery.js";
import { AqaraCameraBridge, getLocalIpv4 } from "./bridge.js";
import { findFreePortRange, writeRtspPortMap, type RtspPortEntry } from "./ports.js";
import { assignUniqueSlugs } from "./slug.js";
import { ENTITIES } from "./entities.js";
import {
  aqaraDeviceToMQTT,
  getCameras,
  queryAttrs,
  writeAttr,
  checkDeviceCapabilities,
  login,
} from "./aqara.js";
import { generateEnvExample, normalizeValue } from "./utils.js";
import { Device, MQTTDevice } from "./types.js";
import {
  EVENT_ATTRS,
  processEventAttrs,
  publishMotionDiscovery,
} from "./motion.js";

if (process.env.NODE_ENV !== "production") {
  await generateEnvExample();
}

// Автологин по email/password, если TOKEN не задан или устарел
if (process.env.AQARA_USER && process.env.AQARA_PASS) {
  console.log("🔑 Logging in with Aqara credentials...");
  try {
    await login(process.env.AQARA_USER, process.env.AQARA_PASS);
    console.log("✅ Login successful");
  } catch (err: any) {
    console.warn("⚠️ Login failed:", err.message);
  }
}

// Получаем все камеры
let cameras = await getCameras();
if (cameras.length === 0 && process.env.AQARA_USER && process.env.AQARA_PASS) {
  console.log("🔄 Retrying login and camera discovery...");
  await login(process.env.AQARA_USER, process.env.AQARA_PASS);
  cameras = await getCameras();
}

console.log(`🎥 Found ${cameras.length} camera(s):`);
cameras.forEach(camera => console.log(`  - ${camera.deviceName} (${camera.did})`));

if (cameras.length === 0) {
  console.error("❌ No cameras found!");
  process.exit(1);
}

// Подготавливаем данные для всех камер
const cameraData: Array<{
  device: Device;
  mqttDevice: MQTTDevice;
  hasSpotlight: boolean;
  bridge?: AqaraCameraBridge;
}> = [];

const rtspBasePort = parseInt(process.env.RTSP_PORT || "8555", 10);

// PTZ-capable Aqara models (pan/tilt cameras). G5 Pro (agl004) is fixed.
function supportsPtz(model: string): boolean {
  const m = (model || "").toLowerCase();
  return m.includes("acn") || m.includes("e1") || m.includes("g3") || m.includes("ptz");
}

for (let i = 0; i < cameras.length; i++) {
  const camera = cameras[i];
  const mqttDevice = aqaraDeviceToMQTT(camera);
  const capabilities = await checkDeviceCapabilities(camera.did);

  cameraData.push({
    device: camera,
    mqttDevice,
    hasSpotlight: capabilities.hasSpotlight,
    bridge: undefined,
  });
  console.log(`📋 ${camera.deviceName}: spotlight=${capabilities.hasSpotlight ? "✅" : "❌"}`);
}

// Allocate a contiguous block of free RTSP ports (default 8555, walking up if
// the preferred port (or any port in the block) is already taken by e.g. go2rtc).
// Keeps camera ports sequential and avoids well-known / 3xxx / 5xxx ranges.
const rtspPorts = await findFreePortRange(cameraData.length || 1, rtspBasePort);
const slugMap = assignUniqueSlugs(
  cameraData.map((c) => ({ did: c.device.did, name: c.device.deviceName })),
);
const rtspPortEntries = new Map<string, RtspPortEntry>();
for (let i = 0; i < cameraData.length; i++) {
  const did = cameraData[i].device.did;
  rtspPortEntries.set(did, {
    port: rtspPorts[i],
    did,
    slug: slugMap[did],
  });
}
writeRtspPortMap(rtspBasePort, [...rtspPortEntries.values()]);
console.log(`🎚️  RTSP ports: ${rtspPorts.join(", ")} (base ${rtspBasePort})`);

const client = createMqttClient();
const interval = Number(process.env.POLL_INTERVAL || 1) * 1000;

// === DISCOVERY ===
client.on("connect", () => {
  console.log("🚀 MQTT connected, publishing discovery...");

  // Публикуем discovery для всех камер
  cameraData.forEach(({ mqttDevice, hasSpotlight, device }, idx) => {
    ENTITIES.forEach((e) => publishDiscovery(client, mqttDevice, e));
    publishLightDiscovery(client, mqttDevice, hasSpotlight);
    publishSdCardDiscovery(client, mqttDevice);
    publishMotionDiscovery(client, mqttDevice);
    publishRtspDiscovery(client, mqttDevice);
    publishP2pStreamSwitchDiscovery(client, mqttDevice);
    publishP2pRtspDiscovery(client, mqttDevice);

    if (supportsPtz(device.model)) {
      publishPtzDiscovery(client, mqttDevice);
    }
    publishTalkbackDiscovery(client, mqttDevice);

    // Initial state: P2P Stream OFF by default
    client.publish(`homeassistant/switch/${mqttDevice.id}/p2p_stream/state`, "OFF", { retain: true });
    client.publish(`homeassistant/sensor/${mqttDevice.id}/p2p_rtsp_stream/state`, "OFF", { retain: true });

    const rtspStreamUrl = `rtsp://${process.env.BRIDGE_HOST || getLocalIpv4()}:${rtspPorts[idx]}/live/${slugMap[device.did]}`;
    publishCameraDiscovery(client, mqttDevice, rtspStreamUrl);
  });

  // Подписываемся на команды для всех камер
  cameraData.forEach(({ mqttDevice }) => {
    client.subscribe(`homeassistant/+/${mqttDevice.id}/+/set`);
  });
});

// === OPTIMISTIC STATE ===
const stateTopic = (domain: string, deviceId: string, attr: string) =>
  `homeassistant/${domain}/${deviceId}/${attr}/state`;

async function optimistic(domain: string, deviceId: string, attr: string, value: string, cameraInfo: typeof cameraData[0]) {
  switch (domain) {
    case "switch":
      client.publish(stateTopic("switch", deviceId, attr), value, { retain: true });
      console.log(`⚡ ${cameraInfo.device.deviceName} ${attr}=${value} (optimistic)`);
      break;
    case "number":
      client.publish(stateTopic("number", deviceId, attr), String(parseInt(value, 10)), { retain: true });
      console.log(`⚡ ${cameraInfo.device.deviceName} ${attr}=${parseInt(value, 10)} (optimistic)`);
      break;
    case "light":
      if (attr !== "spotlight") return;
      {
        const payload = JSON.parse(value);
        const cur = lastLightState.get(deviceId) ?? { state: "OFF", brightness: 255 };
        const next = {
          state: payload.state ?? cur.state,
          brightness:
            payload.brightness !== undefined
              ? Math.round((payload.brightness / 255) * 100) * 2.55 | 0
              : cur.brightness,
        };
        lastLightState.set(deviceId, next);
        client.publish(
          stateTopic("light", deviceId, "spotlight"),
          JSON.stringify(next),
          { retain: true }
        );
        console.log(`⚡ ${cameraInfo.device.deviceName} spotlight=${next.state}, ${next.brightness} (optimistic)`);
      }
      break;
  }
}

const lastLightState = new Map<string, { state: string; brightness: number }>();

const handlers: Record<string, (attr: string, value: string, subjectId: string) => Promise<void>> =
  {
    switch: async (attr, value, subjectId) =>
      writeAttr(attr, value === "ON" ? 1 : 0, subjectId),
    number: async (attr, value, subjectId) =>
      writeAttr(attr, parseInt(value, 10), subjectId),
    light: async (attr, value, subjectId) => {
      if (attr !== "spotlight") return;
      const payload = JSON.parse(value);
      if (payload.state !== undefined) {
        await writeAttr(
          "white_light_enable",
          payload.state === "ON" ? 1 : 0,
          subjectId
        );
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

  // Находим камеру по ID
  const cameraInfo = cameraData.find(({ mqttDevice }) => mqttDevice.id === deviceId);
  if (!cameraInfo) {
    console.error(`❌ Unknown device ID: ${deviceId}`);
    return;
  }

  const subjectId = cameraInfo.device.did;
  console.log(`⬅️ HA → ${cameraInfo.device.deviceName}.${attr}=${value}`);

  // === SPECIAL HANDLER FOR P2P STREAM SWITCH ===
  if (attr === "p2p_stream") {
    const p2pSwitchTopic = `homeassistant/switch/${deviceId}/p2p_stream/state`;
    const p2pRtspTopic = `homeassistant/sensor/${deviceId}/p2p_rtsp_stream/state`;
    const idx = cameraData.indexOf(cameraInfo);
    const rtspPort = rtspPorts[idx];

    if (value === "ON") {
      console.log(`🔌 [P2P Stream] Enabling P2P Stream for ${cameraInfo.device.deviceName}...`);
      client.publish(p2pSwitchTopic, "ON", { retain: true });

      if (!cameraInfo.bridge) {
        const bridge = new AqaraCameraBridge({
          did: cameraInfo.device.did,
          token: process.env.TOKEN || "",
          rtspPort,
          videoKey: process.env.VIDEO_KEY,
        });

        bridge.on("rtsp_ready", (url) => {
          console.log(`📹 [P2P RTSP] ${cameraInfo.device.deviceName} stream ready at ${url}`);
          const actualPort = Number(url.match(/:(\d+)\//)?.[1] || rtspPort);
          // Keep the port map accurate if the server had to shift off the preferred port.
          const entry = rtspPortEntries.get(cameraInfo.device.did);
          if (entry && entry.port !== actualPort) {
            entry.port = actualPort;
            writeRtspPortMap(rtspBasePort, [...rtspPortEntries.values()]);
          }
          const streamUrl = `rtsp://${process.env.BRIDGE_HOST || getLocalIpv4()}:${actualPort}/live/${slugMap[cameraInfo.device.did]}`;
          client.publish(p2pRtspTopic, streamUrl, { retain: true });
        });

        bridge.on("connected", ({ ip, port }) => {
          console.log(`🔌 [P2P Tunnel] ${cameraInfo.device.deviceName} connected to ${ip}:${port}`);
        });

        bridge.on("info", (m: string) => {
          console.log(`ℹ️ [${cameraInfo.device.deviceName}] ${m}`);
        });
        bridge.on("warn", (m: string) => {
          console.warn(`⚠️ [${cameraInfo.device.deviceName}] ${m}`);
        });
        bridge.on("error", (e: any) => {
          console.error(`❌ [${cameraInfo.device.deviceName}] ${e?.message || e}`);
        });

        bridge.start().catch((err) => {
          console.warn(`⚠️ [P2P Bridge] Could not start P2P stream for ${cameraInfo.device.deviceName}: ${err.message}`);
          client.publish(p2pSwitchTopic, "OFF", { retain: true });
          client.publish(p2pRtspTopic, "OFF", { retain: true });
          cameraInfo.bridge = undefined;
        });

        cameraInfo.bridge = bridge;
      }
    } else {
      console.log(`🛑 [P2P Stream] Disabling P2P Stream for ${cameraInfo.device.deviceName}...`);
      if (cameraInfo.bridge) {
        cameraInfo.bridge.stop();
        cameraInfo.bridge = undefined;
      }
      client.publish(p2pSwitchTopic, "OFF", { retain: true });
      client.publish(p2pRtspTopic, "OFF", { retain: true });
    }
    return;
  }

  // === TWO-WAY AUDIO (TALKBACK) SWITCH ===
  if (attr === "talkback") {
    const talkbackStateTopic = `homeassistant/switch/${deviceId}/talkback/state`;
    if (value === "ON") {
      console.log(`🎙️ [Talkback] Enabling speaker channel for ${cameraInfo.device.deviceName}...`);
      client.publish(talkbackStateTopic, "ON", { retain: true });
      cameraInfo.bridge?.startTalkback();
    } else {
      console.log(`🎙️ [Talkback] Disabling speaker channel for ${cameraInfo.device.deviceName}...`);
      client.publish(talkbackStateTopic, "OFF", { retain: true });
      cameraInfo.bridge?.stopTalkback();
    }
    return;
  }

  // === PTZ BUTTONS ===
  if (domain === "button" && attr.startsWith("ptz_")) {
    const dir = attr.replace(/^ptz_/, "");
    console.log(`🕹️ [PTZ] ${cameraInfo.device.deviceName} → ${dir}`);
    if (!cameraInfo.bridge) {
      console.warn(`⚠️ [PTZ] P2P stream not active for ${cameraInfo.device.deviceName}; start it first`);
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

// === RTSP STREAM URLS (Официальный / облачный RTSP URL) ===
const QUALITY_ORDER = ["1520p", "1080p", "720p", "360p"];

async function publishRtspState(subjectId: string, cameraInfo: typeof cameraData[0]) {
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
      { retain: true }
    );
    console.log(`📹 ${cameraInfo.device.deviceName} Official RTSP=${urls[best]}`);
  } catch {
    console.error("❌ Failed to parse rtsp_url:", raw);
  }
}

// === POLLING ===
async function poll() {
  const attrs = ENTITIES.map((e) => e.attr).concat([
    "white_light_enable",
    "white_light_level",
  ]);

  for (const cameraInfo of cameraData) {
    try {
      const res = await queryAttrs(attrs, cameraInfo.device.did);
      for (const r of res.result || []) {
        await publishAttr(r.attr, r.value, cameraInfo);
      }
      const events = await queryAttrs(EVENT_ATTRS, cameraInfo.device.did);
      if (events.code === 0) {
        processEventAttrs(client, cameraInfo.mqttDevice, events.result || []);
      }
      await publishRtspState(cameraInfo.device.did, cameraInfo);
    } catch (error: any) {
      console.error(`❌ Polling failed for ${cameraInfo.device.deviceName}:`, error?.message || error);
    }
  }
}

async function pollSingle(attr: string, subjectId: string, mqttDevice: MQTTDevice) {
  const res = await queryAttrs([attr], subjectId);
  const result = res.result?.[0];
  if (result) {
    const cameraInfo = cameraData.find(c => c.device.did === subjectId);
    if (cameraInfo) {
      await publishAttr(result.attr, result.value, cameraInfo, true);
    }
  }
}

// === ATTRIBUTE PUBLISHER ===
async function publishAttr(attr: string, rawValue: any, cameraInfo: typeof cameraData[0], refreshed = false) {
  const { mqttDevice, device } = cameraInfo;
  
  if (["white_light_enable", "white_light_level"].includes(attr)) {
    const [power, level] = await Promise.all([
      queryAttrs(["white_light_enable"], device.did),
      queryAttrs(["white_light_level"], device.did),
    ]);
    const state = power.result?.[0]?.value === "1" ? "ON" : "OFF";
    const brightness = Math.round(
      (Number(level.result?.[0]?.value || 0) / 100) * 255
    );
    const lightState = { state, brightness };
    lastLightState.set(mqttDevice.id, lightState);
    client.publish(
      `homeassistant/light/${mqttDevice.id}/spotlight/state`,
      JSON.stringify(lightState),
      { retain: true }
    );
    console.log(`${refreshed ? "🔄" : "💡"} ${device.deviceName} Spotlight=${state}, ${brightness}`);
    return;
  }

  if (attr === "sdcard_status") {
    try {
      const parsed = JSON.parse(rawValue);
      const usedPercent = Math.round(
        ((parsed.totalsize - parsed.freesize) / parsed.totalsize) * 100
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_total/state`,
        String(parsed.totalsize),
        { retain: true }
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_free/state`,
        String(parsed.freesize),
        { retain: true }
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_status/state`,
        String(parsed.sdstatus),
        { retain: true }
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice.id}/sdcard_percent/state`,
        String(usedPercent),
        { retain: true }
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
  console.log(`📊 ${device.deviceName} ${attr}=${value}`);
}

// === START ===
setInterval(poll, interval);
poll();
