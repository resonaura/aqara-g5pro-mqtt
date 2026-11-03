import mqtt from "mqtt";

export function createMQTTClient() {
  const client = mqtt.connect(process.env.MQTT_URL!, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    queueQoSZero: false,
    reconnectPeriod: 3000,
  });

  client.on("connect", () => console.log("✅ MQTT connected"));
  let warnedAt = 0;
  client.on("error", () => {
    if (Date.now() - warnedAt > 30000) {
      warnedAt = Date.now();
      console.warn("[MQTT] Broker unavailable; camera streaming and native Haus remain available.");
    }
  });

  return client;
}

export const createMqttClient = createMQTTClient;
