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
  getDevice,
  queryAttrs,
  writeAttr,
} from "./aqara.js";
import { generateEnvExample, normalizeValue } from "./utils.js";

if (process.env.NODE_ENV !== "production") {
  await generateEnvExample();
}

const subjectId = process.env.SUBJECT_ID!;
const deviceInfo = await getDevice(subjectId);
const mqttDevice = aqaraDeviceToMQTT(deviceInfo);

const client = createMqttClient();
const interval = Number(process.env.POLL_INTERVAL || 1) * 1000;

// === DISCOVERY ===
client.on("connect", () => {
  console.log("🚀 MQTT connected, publishing discovery...");

  ENTITIES.forEach((e) => publishDiscovery(client, mqttDevice, e));
  publishLightDiscovery(client, mqttDevice);
  publishSdCardDiscovery(client, mqttDevice);

  client.subscribe(`homeassistant/+/${mqttDevice._simpleModel}/+/set`);
});

// === COMMAND HANDLERS ===
const handlers: Record<string, (attr: string, value: string) => Promise<void>> =
  {
    switch: async (attr, value) =>
      writeAttr(attr, value === "ON" ? 1 : 0, subjectId),
    number: async (attr, value) =>
      writeAttr(attr, parseInt(value, 10), subjectId),
    light: async (attr, value) => {
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
  const [_, domain, __, attr] = topic.split("/");
  const value = msg.toString();

  console.log(`⬅️ HA → ${domain}.${attr}=${value}`);
  try {
    await handlers[domain]?.(attr, value);
    await pollSingle(attr);
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
  const res = await queryAttrs(attrs, subjectId);

  for (const r of res.result || []) {
    await publishAttr(r.attr, r.value);
  }
}

async function pollSingle(attr: string) {
  const res = await queryAttrs([attr], subjectId);
  const result = res.result?.[0];
  if (result) await publishAttr(result.attr, result.value, true);
}

// === ATTRIBUTE PUBLISHER ===
async function publishAttr(attr: string, rawValue: any, refreshed = false) {
  if (["white_light_enable", "white_light_level"].includes(attr)) {
    const [power, level] = await Promise.all([
      queryAttrs(["white_light_enable"], subjectId),
      queryAttrs(["white_light_level"], subjectId),
    ]);
    const state = power.result?.[0]?.value === "1" ? "ON" : "OFF";
    const brightness = Math.round(
      (Number(level.result?.[0]?.value || 0) / 100) * 255
    );
    client.publish(
      `homeassistant/light/${mqttDevice._simpleModel}/spotlight/state`,
      JSON.stringify({ state, brightness }),
      { retain: true }
    );
    console.log(`${refreshed ? "🔄" : "💡"} Spotlight=${state}, ${brightness}`);
    return;
  }

  if (attr === "sdcard_status") {
    try {
      const parsed = JSON.parse(rawValue);
      const usedPercent = Math.round(
        ((parsed.totalsize - parsed.freesize) / parsed.totalsize) * 100
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice._simpleModel}/sdcard_total/state`,
        String(parsed.totalsize),
        { retain: true }
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice._simpleModel}/sdcard_free/state`,
        String(parsed.freesize),
        { retain: true }
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice._simpleModel}/sdcard_status/state`,
        String(parsed.sdstatus),
        { retain: true }
      );
      client.publish(
        `homeassistant/sensor/${mqttDevice._simpleModel}/sdcard_percent/state`,
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

  const topic = `homeassistant/${entity.domain}/${mqttDevice._simpleModel}/${attr}/state`;
  const value = normalizeValue(entity.domain, attr, rawValue);
  client.publish(topic, String(value), { retain: true });
  console.log(`📊 ${attr}=${value}`);
}

// === START ===
setInterval(poll, interval);
poll();
