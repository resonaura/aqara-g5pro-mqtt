import { EntityConfig, MQTTDevice } from "./types.js";
import { MqttClient } from "mqtt";

function publishDiscoveryEntity(
  client: MqttClient,
  mqttDevice: MQTTDevice,
  entity: EntityConfig,
  overrides: Record<string, any> = {}
) {
  const objectId = entity.attr;
  const baseTopic = `homeassistant/${entity.domain}/${mqttDevice.id}/${objectId}`;

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
  mqttDevice: MQTTDevice,
  hasSpotlight: boolean = true
) {
  if (!hasSpotlight) {
    console.log(`⚠️ Skipping spotlight discovery for ${mqttDevice.name} - not supported`);
    return;
  }

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

  console.log(`💡 Published discovery for Spotlight on ${mqttDevice.name}`);
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

export function publishRtspDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  publishDiscoveryEntity(
    client,
    mqttDevice,
    { domain: "sensor", name: "RTSP Stream", attr: "rtsp_stream", icon: "mdi:video-input" },
    {
      icon: "mdi:video",
    }
  );
  console.log(`📹 Published discovery for RTSP Stream on ${mqttDevice.name}`);
}

export function publishP2pStreamSwitchDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  publishDiscoveryEntity(
    client,
    mqttDevice,
    {
      domain: "switch",
      name: "P2P Stream",
      attr: "p2p_stream",
      icon: "mdi:video-wireless",
      command: true,
    }
  );
  console.log(`🔀 Published discovery for P2P Stream Switch on ${mqttDevice.name}`);
}

export function publishP2pRtspDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  publishDiscoveryEntity(
    client,
    mqttDevice,
    {
      domain: "sensor",
      name: "P2P RTSP Stream",
      attr: "p2p_rtsp_stream",
      icon: "mdi:video-wireless-outline",
    }
  );
  console.log(`📹 Published discovery for P2P RTSP Stream on ${mqttDevice.name}`);
}

export function publishCameraDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice,
  rtspUrl?: string
) {
  const baseTopic = `homeassistant/camera/${mqttDevice.id}/camera`;
  const payload = {
    name: `${mqttDevice.name} Camera`,
    unique_id: `${mqttDevice.id}_camera`,
    topic: `${baseTopic}/image`,
    ...(rtspUrl ? { stream_source: rtspUrl } : {}),
    icon: "mdi:camera",
    device: {
      identifiers: mqttDevice.identifiers,
      manufacturer: mqttDevice.manufacturer,
      model: mqttDevice.model,
      name: mqttDevice.name,
    },
  };
  client.publish(`${baseTopic}/config`, JSON.stringify(payload), { retain: true });
  console.log(`🎥 Published discovery for Camera entity on ${mqttDevice.name}`);
}

export function publishPtzDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  const directions: Array<{ attr: string; name: string; icon: string; dir: string }> = [
    { attr: "ptz_left", name: "PTZ Left", icon: "mdi:arrow-left", dir: "left" },
    { attr: "ptz_right", name: "PTZ Right", icon: "mdi:arrow-right", dir: "right" },
    { attr: "ptz_up", name: "PTZ Up", icon: "mdi:arrow-up", dir: "up" },
    { attr: "ptz_down", name: "PTZ Down", icon: "mdi:arrow-down", dir: "down" },
    { attr: "ptz_stop", name: "PTZ Stop", icon: "mdi:stop", dir: "stop" },
  ];

  directions.forEach((d) => {
    const base = `homeassistant/button/${mqttDevice.id}/${d.attr}`;
    client.publish(
      `${base}/config`,
      JSON.stringify({
        name: d.name,
        unique_id: d.attr,
        command_topic: `${base}/set`,
        icon: d.icon,
        device: {
          identifiers: mqttDevice.identifiers,
          manufacturer: mqttDevice.manufacturer,
          model: mqttDevice.model,
          name: mqttDevice.name,
        },
      }),
      { retain: true }
    );
  });
  console.log(`🕹️ Published PTZ button discovery on ${mqttDevice.name}`);
}

export function publishTalkbackDiscovery(
  client: MqttClient,
  mqttDevice: MQTTDevice
) {
  const base = `homeassistant/switch/${mqttDevice.id}/talkback`;
  client.publish(
    `${base}/config`,
    JSON.stringify({
      name: "Two-Way Audio (Talkback)",
      unique_id: "talkback",
      state_topic: `${base}/state`,
      command_topic: `${base}/set`,
      icon: "mdi:microphone-message",
      device: {
        identifiers: mqttDevice.identifiers,
        manufacturer: mqttDevice.manufacturer,
        model: mqttDevice.model,
        name: mqttDevice.name,
      },
    }),
    { retain: true }
  );
  console.log(`🎙️ Published Talkback switch discovery on ${mqttDevice.name}`);
}


