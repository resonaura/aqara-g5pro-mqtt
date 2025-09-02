import * as dotenv from "dotenv";
import "./config.js";
import { createMqttClient } from "./mqtt.js";
import { publishDiscovery } from "./discovery.js";
import { ENTITIES } from "./entities.js";
import { queryAttrs, writeAttr } from "./aqara.js";
import { generateEnvExample } from "./utils.js";

dotenv.config();

if (process.env.NODE_ENV !== "production") {
  await generateEnvExample(); // вот он, генератор
}

const client = createMqttClient();
const subjectId = process.env.SUBJECT_ID!;
const interval = parseInt(process.env.POLL_INTERVAL || "5", 10) * 1000;

// ========== MQTT CONNECT ==========
client.on("connect", () => {
  console.log("🚀 Connected to MQTT broker, publishing discovery configs...");

  ENTITIES.forEach((e) => publishDiscovery(client, subjectId, e));
  publishLightDiscovery(); // полноценный светильник
  publishSdCardDiscovery(); // отдельные сенсоры SD карты

  client.subscribe("homeassistant/+/aqara_g5_pro/+/set", (err) => {
    if (err) {
      console.error("❌ Failed to subscribe:", err);
    } else {
      console.log("📡 Subscribed to HA command topics");
    }
  });
});

// ========== HANDLE COMMANDS ==========
client.on("message", async (topic, msg) => {
  const value = msg.toString();
  const parts = topic.split("/");
  const domain = parts[1];
  const attr = parts[3];

  console.log(
    `⬅️  HA → Command: domain=${domain}, attr=${attr}, value=${value}`
  );

  try {
    if (domain === "switch") {
      const aqaraValue = value === "ON" ? 1 : 0;
      await writeAttr(attr, aqaraValue, subjectId);
      console.log(`➡️ Aqara set ${attr}=${aqaraValue}`);
      await pollSingle(attr);
    }

    if (domain === "number") {
      const aqaraValue = parseInt(value, 10);
      await writeAttr(attr, aqaraValue, subjectId);
      console.log(`➡️ Aqara set ${attr}=${aqaraValue}`);
      await pollSingle(attr);
    }

    if (domain === "light" && attr === "spotlight") {
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
      console.log(`➡️ Aqara set Spotlight=${value}`);
      await pollSingle("white_light_enable");
    }

    console.log("🔄 Status refreshed for", attr);
  } catch (err) {
    console.error(`❌ Command failed:`, err);
  }
});

// ========== POLLING LOOP ==========
async function poll() {
  try {
    const attrs = ENTITIES.map((e) => e.attr).concat([
      "white_light_enable",
      "white_light_level",
    ]);

    const res = await queryAttrs(attrs, subjectId);
    const results = res.result || [];

    console.log(`📡 Aqara → Received ${results.length} attributes`);

    // Spotlight
    const state = results.find(
      (r: any) => r.attr === "white_light_enable"
    )?.value;
    const level = parseInt(
      results.find((r: any) => r.attr === "white_light_level")?.value || "0",
      10
    );
    publishLightState(state, level);

    // Остальные сенсоры
    results.forEach((r: any) => {
      if (["white_light_enable", "white_light_level"].includes(r.attr)) return;
      if (r.attr === "sdcard_status") {
        publishSdCard(r.value);
        return;
      }

      const entity = ENTITIES.find((e) => e.attr === r.attr);
      if (!entity) return;

      const topic = `homeassistant/${entity.domain}/aqara_g5_pro/${r.attr}/state`;
      const value = normalizeValue(entity.domain, r.attr, r.value);

      client.publish(topic, String(value), { retain: true });
      console.log(`📊 Aqara → Publish ${r.attr}=${value}`);
    });
  } catch (err) {
    console.error("❌ Polling error:", err);
  }
}

// ========== POLL SINGLE ==========
async function pollSingle(attr: string) {
  try {
    const res = await queryAttrs([attr], subjectId);
    const result = res.result?.[0];
    if (!result) return;

    if (["white_light_enable", "white_light_level"].includes(attr)) {
      const state = (
        await queryAttrs(["white_light_enable", "white_light_level"], subjectId)
      ).result;
      const power = state.find(
        (r: any) => r.attr === "white_light_enable"
      )?.value;
      const level = parseInt(
        state.find((r: any) => r.attr === "white_light_level")?.value || "0",
        10
      );
      publishLightState(power, level, true);
      return;
    }

    if (result.attr === "sdcard_status") {
      publishSdCard(result.value);
      return;
    }

    const entity = ENTITIES.find((e) => e.attr === result.attr);
    if (!entity) {
      console.warn(`⚠️ pollSingle: no entity found for ${result.attr}`);
      return;
    }

    const topic = `homeassistant/${entity.domain}/aqara_g5_pro/${result.attr}/state`;
    const value = normalizeValue(entity.domain, result.attr, result.value);

    client.publish(topic, String(value), { retain: true });
    console.log(`📊 Refreshed ${result.attr}=${value}`);
  } catch (err) {
    console.error(`❌ pollSingle(${attr}) failed:`, err);
  }
}

// ========== HELPERS ==========

// Светильник (Spotlight)
function publishLightState(state: string, level: number, refreshed = false) {
  const lightPayload = {
    state: state === "1" ? "ON" : "OFF",
    brightness: Math.round((level / 100) * 255),
  };

  client.publish(
    "homeassistant/light/aqara_g5_pro/spotlight/state",
    JSON.stringify(lightPayload),
    { retain: true }
  );

  const prefix = refreshed
    ? "💡 Spotlight refreshed →"
    : "💡 Spotlight state →";
  console.log(`${prefix} ${JSON.stringify(lightPayload)}`);
}

// SD Card
function publishSdCard(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    const used = parsed.totalsize - parsed.freesize;
    const usedPercent = Math.round((used / parsed.totalsize) * 100);

    client.publish(
      "homeassistant/sensor/aqara_g5_pro/sdcard_total/state",
      String(parsed.totalsize),
      { retain: true }
    );
    client.publish(
      "homeassistant/sensor/aqara_g5_pro/sdcard_free/state",
      String(parsed.freesize),
      { retain: true }
    );
    client.publish(
      "homeassistant/sensor/aqara_g5_pro/sdcard_status/state",
      String(parsed.sdstatus),
      { retain: true }
    );
    client.publish(
      "homeassistant/sensor/aqara_g5_pro/sdcard_percent/state",
      String(usedPercent),
      { retain: true }
    );

    console.log(
      `💾 SD Card → total=${parsed.totalsize}MB free=${parsed.freesize}MB (${usedPercent}%) status=${parsed.sdstatus}`
    );
  } catch (e) {
    console.error("❌ Failed to parse sdcard_status:", raw);
  }
}

// Value normalization
function normalizeValue(domain: string, attr: string, value: any): any {
  if (domain === "switch" || domain === "binary_sensor") {
    return value === "1" ? "ON" : "OFF";
  }

  if (attr === "device_battery_power") {
    if (!value || value === "null" || value === "-1") return "unavailable";
  }

  if (attr === "work_mode") {
    const mapping: Record<string, string> = {
      "0": "Day",
      "1": "Night",
      "2": "Auto",
    };
    return mapping[value] ?? value;
  }

  if (domain === "number") {
    return Number(value);
  }

  return value;
}

// ========== DISCOVERY HELPERS ==========
function publishLightDiscovery() {
  const payload = {
    name: "Aqara G5 Pro Spotlight",
    unique_id: "aqara_g5_pro_spotlight",
    schema: "json",
    command_topic: "homeassistant/light/aqara_g5_pro/spotlight/set",
    state_topic: "homeassistant/light/aqara_g5_pro/spotlight/state",
    brightness: true,
    icon: "mdi:lightbulb",
    device: {
      identifiers: [subjectId],
      manufacturer: "Aqara",
      model: "Camera Hub G5 Pro",
      name: "Aqara G5 Pro",
    },
  };

  client.publish(
    "homeassistant/light/aqara_g5_pro/spotlight/config",
    JSON.stringify(payload),
    { retain: true }
  );
  console.log("💡 Published light discovery for Spotlight");
}

function publishSdCardDiscovery() {
  const sensors = [
    { id: "sdcard_total", name: "SD Card Total", unit: "MB" },
    { id: "sdcard_free", name: "SD Card Free", unit: "MB" },
    { id: "sdcard_status", name: "SD Card Status" },
    { id: "sdcard_percent", name: "SD Card Used", unit: "%" },
  ];

  sensors.forEach((s) => {
    const payload = {
      name: s.name,
      unique_id: `aqara_g5_pro_${s.id}`,
      state_topic: `homeassistant/sensor/aqara_g5_pro/${s.id}/state`,
      unit_of_measurement: s.unit,
      icon: "mdi:sd",
      device: {
        identifiers: [subjectId],
        manufacturer: "Aqara",
        model: "Camera Hub G5 Pro",
        name: "Aqara G5 Pro",
      },
    };

    client.publish(
      `homeassistant/sensor/aqara_g5_pro/${s.id}/config`,
      JSON.stringify(payload),
      { retain: true }
    );
    console.log(`💾 Published discovery for ${s.name}`);
  });
}

// ========== START ==========
setInterval(poll, interval);
poll();
