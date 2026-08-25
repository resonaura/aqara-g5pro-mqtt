import "./config.js";
import { createMqttClient } from "./mqtt.js";
import {
  publishDiscovery,
  publishLightDiscovery,
  publishSdCardDiscovery,
  publishRtspDiscovery,
} from "./discovery.js";
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

// Автологин по email/password, если TOKEN не задан
if (!process.env.TOKEN && process.env.AQARA_USER && process.env.AQARA_PASS) {
  console.log("🔑 No TOKEN provided, logging in with credentials...");
  await login(process.env.AQARA_USER, process.env.AQARA_PASS);
  console.log("✅ Login successful");
}

// Получаем все камеры
const cameras = await getCameras();
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
}> = [];

for (const camera of cameras) {
  const mqttDevice = aqaraDeviceToMQTT(camera);
  const capabilities = await checkDeviceCapabilities(camera.did);
  cameraData.push({
    device: camera,
    mqttDevice,
    hasSpotlight: capabilities.hasSpotlight,
  });
  console.log(`📋 ${camera.deviceName}: spotlight=${capabilities.hasSpotlight ? "✅" : "❌"}`);
}

const client = createMqttClient();
const interval = Number(process.env.POLL_INTERVAL || 1) * 1000;

// === DISCOVERY ===
client.on("connect", () => {
  console.log("🚀 MQTT connected, publishing discovery...");

  // Публикуем discovery для всех камер
  cameraData.forEach(({ mqttDevice, hasSpotlight }) => {
    ENTITIES.forEach((e) => publishDiscovery(client, mqttDevice, e));
    publishLightDiscovery(client, mqttDevice, hasSpotlight);
    publishSdCardDiscovery(client, mqttDevice);
    publishMotionDiscovery(client, mqttDevice);
    publishRtspDiscovery(client, mqttDevice);
  });

  // Подписываемся на команды для всех камер
  cameraData.forEach(({ mqttDevice }) => {
    client.subscribe(`homeassistant/+/${mqttDevice.id}/+/set`);
  });
});

// === COMMAND HANDLERS ===
// === OPTIMISTIC STATE ===
// Публикуем ожидаемое состояние сразу, не дожидаясь облачного опроса.
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
        // текущее состояние берём из последнего опубликованного
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

  try {
    await optimistic(domain, deviceId, attr, value, cameraInfo);
    await handlers[domain]?.(attr, value, subjectId);
    // подтверждение реальным состоянием через короткую задержку,
    // чтобы камера успела применить команду
    setTimeout(() => {
      pollSingle(attr, subjectId, cameraInfo.mqttDevice).catch(() => {});
    }, 2000);
  } catch (err) {
    console.error("❌ Command failed:", err);
  }
});

// === RTSP STREAM URLS (редко меняются, но читаем каждый цикл вместе с остальными) ===
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
    console.log(`📹 ${cameraInfo.device.deviceName} RTSP=${urls[best]}`);
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

  // Опрашиваем все камеры
  for (const cameraInfo of cameraData) {
    try {
      const res = await queryAttrs(attrs, cameraInfo.device.did);
      for (const r of res.result || []) {
        await publishAttr(r.attr, r.value, cameraInfo);
      }
      // событийные атрибуты детекции → generic motion sensor
      const events = await queryAttrs(EVENT_ATTRS, cameraInfo.device.did);
      if (events.code === 0) {
        processEventAttrs(client, cameraInfo.mqttDevice, events.result || []);
      }
      await publishRtspState(cameraInfo.device.did, cameraInfo);
    } catch (error) {
      console.error(`❌ Polling failed for ${cameraInfo.device.deviceName}:`, error.message);
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
