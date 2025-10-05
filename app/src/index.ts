import "./config.js";
import { createMqttClient } from "./mqtt.js";
import {
  publishDiscovery,
  publishLightDiscovery,
  publishSdCardDiscovery,
} from "./discovery.js";
import { ENTITIES } from "./entities.js";
import {
  aqaraDeviceToMQTT,
  getCameras,
  queryAttrs,
  writeAttr,
  checkDeviceCapabilities,
} from "./aqara.js";
import { generateEnvExample, normalizeValue } from "./utils.js";
import { Device, MQTTDevice } from "./types.js";

if (process.env.NODE_ENV !== "production") {
  await generateEnvExample();
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
  });

  // Подписываемся на команды для всех камер
  cameraData.forEach(({ mqttDevice }) => {
    client.subscribe(`homeassistant/+/${mqttDevice.id}/+/set`);
  });
});

// === COMMAND HANDLERS ===
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
    await handlers[domain]?.(attr, value, subjectId);
    await pollSingle(attr, subjectId, cameraInfo.mqttDevice);
  } catch (err) {
    console.error("❌ Command failed:", err);
  }
});

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
    client.publish(
      `homeassistant/light/${mqttDevice.id}/spotlight/state`,
      JSON.stringify({ state, brightness }),
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
