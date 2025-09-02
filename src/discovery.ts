import { EntityConfig, MQTTDevice } from "./types.js";
import { MqttClient } from "mqtt";

export function publishDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice,
  entity: EntityConfig
) {
  const objectId = entity.attr;
  const discoveryTopic = `homeassistant/${entity.domain}/${mqttDevice._simpleModel}/${objectId}/config`;
  console.log(discoveryTopic);
  const payload = {
    name: `${entity.name}`,
    unique_id: `${objectId}`,
    state_topic: `homeassistant/${entity.domain}/${mqttDevice._simpleModel}/${objectId}/state`,
    command_topic: entity.command
      ? `homeassistant/${entity.domain}/${mqttDevice._simpleModel}/${objectId}/set`
      : undefined,
    icon: entity.icon,
    device: {
      identifiers: mqttDevice.identifiers,
      manufacturer: mqttDevice.manufacturer,
      model: mqttDevice.model,
      name: mqttDevice.name,
    },
  };

  client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
}

export function publishLightDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  const payload = {
    name: "Spotlight",
    unique_id: "spotlight",
    schema: "json",
    command_topic: `homeassistant/light/${mqttDevice._simpleModel}/spotlight/set`,
    state_topic: `homeassistant/light/${mqttDevice._simpleModel}/spotlight/state`,
    brightness: true,
    icon: "mdi:lightbulb",
    device: {
      identifiers: mqttDevice.identifiers,
      manufacturer: mqttDevice.manufacturer,
      model: mqttDevice.model,
      name: mqttDevice.name,
    },
  };

  client.publish(
    `homeassistant/light/${mqttDevice._simpleModel}/spotlight/config`,
    JSON.stringify(payload),
    { retain: true }
  );
  console.log("💡 Published light discovery for Spotlight");
}

export function publishSdCardDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  const sensors = [
    { id: "sdcard_total", name: "SD Card Total", unit: "MB" },
    { id: "sdcard_free", name: "SD Card Free", unit: "MB" },
    { id: "sdcard_status", name: "SD Card Status" },
    { id: "sdcard_percent", name: "SD Card Used", unit: "%" },
  ];

  sensors.forEach((s) => {
    const payload = {
      name: s.name,
      unique_id: `${s.id}`,
      state_topic: `homeassistant/sensor/${mqttDevice._simpleModel}/${s.id}/state`,
      unit_of_measurement: s.unit,
      icon: "mdi:sd",
      device: {
        identifiers: mqttDevice.identifiers,
        manufacturer: mqttDevice.manufacturer,
        model: mqttDevice.model,
        name: mqttDevice.name,
      },
    };

    client.publish(
      `homeassistant/sensor/${mqttDevice._simpleModel}/${s.id}/config`,
      JSON.stringify(payload),
      { retain: true }
    );
    console.log(`💾 Published discovery for ${s.name}`);
  });
}
