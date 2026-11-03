import type { MqttClient } from "mqtt";
import type { BridgeCamera, BridgeEntity, BridgeCommand } from "@haus/bridge/protocol";
import type { CameraBridgeProvider } from "@haus/bridge/provider";

interface Config {
  name: string;
  state_topic?: string;
  command_topic?: string;
  payload_on?: string;
  payload_off?: string;
  min?: number;
  max?: number;
  step?: number;
  brightness?: boolean;
  device_class?: string;
  unit_of_measurement?: string;
}
interface Definition {
  topic: string;
  domain: BridgeEntity["domain"];
  deviceId: string;
  id: string;
  config: Config;
  payload: string;
}

/** One state collector feeds both protocols; MQTT suppression never stops polling or native state. */
export class HausPublication {
  private readonly definitions = new Map<string, Definition>();
  private readonly states = new Map<string, { value: string; at: number }>();
  private readonly original: MqttClient["publish"];
  private readonly mqttPrefix = "homeassistant/";
  constructor(
    private readonly client: MqttClient,
    private readonly provider: CameraBridgeProvider,
    private readonly now = Date.now,
  ) {
    this.original = client.publish.bind(client);
    client.publish = ((topic, message, options?, callback?) => {
      this.capture(topic, message);
      if (topic.startsWith(this.mqttPrefix) && !client.connected) {
        const done = typeof options === "function" ? options : callback;
        if (done) queueMicrotask(() => done(undefined));
        return client;
      }
      if (
        !topic.startsWith(this.mqttPrefix) ||
        provider.shouldPublishMqtt() ||
        (topic.endsWith("/config") && message.length === 0)
      )
        return this.original(topic, message, options as any, callback);
      const done = typeof options === "function" ? options : callback;
      if (done) queueMicrotask(() => done(undefined));
      return client;
    }) as MqttClient["publish"];
    provider.on("mqtt-publication", (enabled: boolean) => this.restore(enabled));
    client.on("connect", () => this.restore(provider.shouldPublishMqtt()));
  }
  private capture(topic: string, message: Buffer | string) {
    const match =
      /^homeassistant\/(binary_sensor|sensor|switch|light|number|select|button)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/(config|state)$/.exec(
        topic,
      );
    if (!match) return;
    const value = message.toString();
    if (match[4] === "state") {
      this.states.set(topic, { value, at: this.now() });
      return;
    }
    if (!value) {
      this.definitions.delete(topic);
      return;
    }
    try {
      const config = JSON.parse(value) as Config;
      if (typeof config.name !== "string") return;
      this.definitions.set(topic, {
        topic,
        domain: match[1] as BridgeEntity["domain"],
        deviceId: match[2],
        id: match[3],
        config,
        payload: value,
      });
      if (this.client.connected && !this.provider.shouldPublishMqtt())
        this.original(topic, "", { retain: true });
    } catch {
      /* Only our validated discovery configs become native definitions. */
    }
  }
  private restore(enabled: boolean) {
    if (!this.client.connected) return;
    for (const definition of this.definitions.values()) {
      this.original(definition.topic, enabled ? definition.payload : "", { retain: true });
      const state = definition.config.state_topic && this.states.get(definition.config.state_topic);
      if (enabled && state)
        this.original(definition.config.state_topic!, state.value, { retain: true });
    }
  }
  entities(deviceId: string): BridgeEntity[] {
    return [...this.definitions.values()]
      .filter((definition) => definition.deviceId === deviceId)
      .flatMap((definition) => {
        const { config, domain, id } = definition;
        const observed = config.state_topic ? this.states.get(config.state_topic) : undefined;
        const value = observed?.value;
        const known =
          value !== undefined &&
          value.trim() !== "" &&
          !["unknown", "unavailable", "null", "undefined", "NaN", "Infinity", "-Infinity"].includes(
            value,
          );
        const entity: BridgeEntity = {
          id,
          name: config.name,
          domain,
          available: !!observed && known && this.now() - observed.at < 60000,
          state: null,
          updatedAt: observed?.at ?? 0,
          writable: !!config.command_topic,
        };
        if (config.device_class) entity.deviceClass = config.device_class;
        if (config.unit_of_measurement) entity.unit = config.unit_of_measurement;
        if (domain === "button") {
          entity.available = true;
          entity.state = null;
        } else if (domain === "light") {
          entity.role = "spotlight";
          entity.brightness = !!config.brightness;
          if (known)
            try {
              const parsed = JSON.parse(value);
              entity.state = {
                on: parsed.state === "ON",
                ...(Number.isFinite(parsed.brightness)
                  ? { brightness: Math.round((parsed.brightness / 255) * 100) }
                  : {}),
              };
            } catch {
              entity.available = false;
            }
        } else if (domain === "switch" || domain === "binary_sensor") {
          entity.state = known ? value === (config.payload_on ?? "ON") : null;
          if (domain === "binary_sensor" && config.device_class === "motion")
            entity.role = "motion";
        } else if (domain === "number") {
          entity.min = config.min ?? 0;
          entity.max = config.max ?? 100;
          entity.step = config.step ?? 1;
          entity.state = known && Number.isFinite(Number(value)) ? Number(value) : null;
        } else if (known) {
          entity.state =
            value !== "" && Number.isFinite(Number(value)) ? Number(value) : value.slice(0, 512);
        }
        return [entity];
      });
  }
  command(
    camera: Pick<BridgeCamera, "id">,
    entityId: string,
    command: BridgeCommand,
  ): { topic: string; payload: string } {
    const definition = [...this.definitions.values()].find(
      (definition) => definition.deviceId === camera.id && definition.id === entityId,
    );
    if (!definition?.config.command_topic) throw Error("bridge_entity_read_only");
    let payload: string;
    if (command.action === "press") payload = "PRESS";
    else if (definition.domain === "light") {
      const value = command.value as { on?: boolean; brightness?: number };
      payload = JSON.stringify({
        ...(value.on !== undefined ? { state: value.on ? "ON" : "OFF" } : {}),
        ...(value.brightness !== undefined
          ? { brightness: Math.round((value.brightness / 100) * 255) }
          : {}),
      });
    } else
      payload =
        typeof command.value === "boolean" ? (command.value ? "ON" : "OFF") : String(command.value);
    return { topic: definition.config.command_topic, payload };
  }
}
