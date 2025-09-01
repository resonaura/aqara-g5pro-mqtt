import { EntityConfig } from "./types.js";
import { MqttClient } from "mqtt";

export function publishDiscovery(
  client: MqttClient,
  deviceId: string,
  entity: EntityConfig
) {
  const objectId = entity.attr;
  const discoveryTopic = `homeassistant/${entity.domain}/aqara_g5_pro/${objectId}/config`;

  const payload = {
    name: `Aqara G5 Pro ${entity.name}`,
    unique_id: `aqara_g5_pro_${objectId}`,
    state_topic: `homeassistant/${entity.domain}/aqara_g5_pro/${objectId}/state`,
    command_topic: entity.command
      ? `homeassistant/${entity.domain}/aqara_g5_pro/${objectId}/set`
      : undefined,
    device: {
      identifiers: [deviceId],
      manufacturer: "Aqara",
      model: "Camera Hub G5 Pro",
      name: "Aqara G5 Pro",
    },
  };

  client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
}
