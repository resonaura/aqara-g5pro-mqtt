import mqtt from "mqtt";

export function createMqttClient() {
  const client = mqtt.connect(process.env.MQTT_URL!, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
  });

  client.on("connect", () => console.log("✅ MQTT connected"));

  return client;
}
