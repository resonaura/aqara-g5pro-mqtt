import { EntityConfig, MQTTDevice } from "./types.js";
import { MqttClient } from "mqtt";

function publishDiscoveryEntity(
  client: MqttClient,
  mqttDevice: MQTTDevice,
  entity: EntityConfig,
  overrides: Record<string, any> = {}
) {
  const objectId = entity.attr;
  const baseTopic = `homeassistant/${entity.domain}/${mqttDevice._simpleModel}/${objectId}`;

  const payload = {
    name: entity.name,
    unique_id: objectId,
    state_topic: `${baseTopic}/state`,
    command_topic: entity.command ? `${baseTopic}/set` : undefined,
    icon: entity.icon,
    device: {
      identifiers: mqttDevice.identifiers,
      manufacturer: mqttDevice.manufacturer,
      model: mqttDevice.model,
      name: mqttDevice.name,
    },
    ...overrides,
  };

  client.publish(`${baseTopic}/config`, JSON.stringify(payload), {
    retain: true,
  });
}

export function publishDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice,
  entity: EntityConfig
) {
  publishDiscoveryEntity(client, mqttDevice, entity);
}

export function publishLightDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  publishDiscoveryEntity(
    client,
    mqttDevice,
    {
      domain: "light",
      name: "Spotlight",
      attr: "spotlight",
      icon: "mdi:lightbulb",
      command: true,
    },
    {
      schema: "json",
      brightness: true,
    }
  );

  console.log("💡 Published discovery for Spotlight");
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

  sensors.forEach((s) =>
    publishDiscoveryEntity(
      client,
      mqttDevice,
      { domain: "sensor", name: s.name, attr: s.id, icon: "mdi:sd" },
      { unit_of_measurement: s.unit }
    )
  );

  console.log("💾 Published discovery for SD Card sensors");
}
