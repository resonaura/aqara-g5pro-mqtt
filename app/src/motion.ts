import { MqttClient } from "mqtt";
import { MQTTDevice } from "./types.js";

// Событийные атрибуты детекции: смена timeStamp любого из них = движение
export const EVENT_ATTRS = [
  "detect_human_event",
  "detect_pets_event",
  "detect_face_event",
  "detect_vehicle_event",
  "package_detect_event",
  "human_detect_event",
  "pet_detect_event",
  "vehicle_detect_event",
  "person_detect_event",
];

const RESET_SECONDS = Number(process.env.MOTION_RESET ?? 30);

type CameraKey = string;
// last seen timeStamp/value по каждому атрибуту
const lastSeen = new Map<string, { ts: number; value: string }>();
// активное движение + таймер сброса
const motionOn = new Map<CameraKey, boolean>();
const offTimers = new Map<CameraKey, NodeJS.Timeout>();

export function publishMotionDiscovery(client: MqttClient, mqttDevice: MQTTDevice): void {
  const base = `homeassistant/binary_sensor/${mqttDevice.id}/motion`;
  client.publish(
    `${base}/config`,
    JSON.stringify({
      name: "Motion",
      unique_id: "motion",
      state_topic: `${base}/state`,
      device_class: "motion",
      payload_on: "ON",
      payload_off: "OFF",
      device: {
        identifiers: mqttDevice.identifiers,
        manufacturer: mqttDevice.manufacturer,
        model: mqttDevice.model,
        name: mqttDevice.name,
      },
    }),
    { retain: true },
  );
}

export function processEventAttrs(
  client: MqttClient,
  mqttDevice: MQTTDevice,
  rows: Array<{ attr: string; value: any; timeStamp?: number }>,
): void {
  let detected = false;
  let changedAttr = "";

  for (const row of rows) {
    if (!EVENT_ATTRS.includes(row.attr)) continue;
    const key = `${mqttDevice.id}:${row.attr}`;
    const ts = Number(row.timeStamp ?? 0);
    const value = String(row.value);
    const prev = lastSeen.get(key);

    if (prev && (ts > prev.ts || (ts === prev.ts && value !== prev.value))) {
      detected = true;
      changedAttr = row.attr;
    }
    lastSeen.set(key, { ts, value });
  }

  if (!detected) return;

  const wasOn = motionOn.get(mqttDevice.id) ?? false;
  console.log(`🚶 ${mqttDevice.name} Motion=ON (${changedAttr})`);

  if (!wasOn) {
    motionOn.set(mqttDevice.id, true);
    client.publish(`homeassistant/binary_sensor/${mqttDevice.id}/motion/state`, "ON", {
      retain: true,
    });
  }

  // перезапускаем таймер сброса
  const old = offTimers.get(mqttDevice.id);
  if (old) clearTimeout(old);
  offTimers.set(
    mqttDevice.id,
    setTimeout(() => {
      motionOn.set(mqttDevice.id, false);
      client.publish(`homeassistant/binary_sensor/${mqttDevice.id}/motion/state`, "OFF", {
        retain: true,
      });
      console.log(`🌙 ${mqttDevice.name} Motion=OFF`);
    }, RESET_SECONDS * 1000),
  );
}
