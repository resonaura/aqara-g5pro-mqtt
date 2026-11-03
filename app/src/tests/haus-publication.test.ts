import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MqttClient } from "mqtt";
import { CameraBridgeProvider } from "@haus/bridge/provider";
import { entityKeys, validateInventory } from "@haus/bridge/protocol";
import { HausPublication } from "../haus-publication.js";
import { processEventAttrs, publishMotionDiscovery } from "../motion.js";
import type { MQTTDevice } from "../types.js";

test("native state collection survives disabled MQTT and withdraws/restores only owned discoveries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aqara-native-publication-"));
  const provider = await new CameraBridgeProvider({
    directory,
    provider: "aqara",
    name: "Aqara",
  }).initialize();
  const wire: { topic: string; message: string }[] = [];
  const client = Object.assign(new EventEmitter(), {
    connected: true,
    publish(topic: string, message: Buffer | string) {
      wire.push({ topic, message: message.toString() });
      return this;
    },
  }) as unknown as MqttClient;
  let now = 1000;
  const publication = new HausPublication(client, provider, () => now);
  const topic = "homeassistant/light/camera_one/spotlight";
  try {
    client.publish(
      topic + "/config",
      JSON.stringify({
        name: "Spotlight",
        brightness: true,
        state_topic: topic + "/state",
        command_topic: topic + "/set",
      }),
      { retain: true },
    );
    client.publish(topic + "/state", JSON.stringify({ state: "ON", brightness: 128 }), {
      retain: true,
    });
    const cameraTopic = "homeassistant/camera/camera_one/camera/config";
    const cameraConfig = JSON.stringify({
      unique_id: "camera_one_camera",
      device: { identifiers: ["physical-one"] },
    });
    client.publish(cameraTopic, cameraConfig, { retain: true });
    const build = () => ({
      version: 2 as const,
      bridgeId: provider.id,
      provider: "aqara" as const,
      cameras: [
        {
          id: "camera_one",
          name: "One",
          manufacturer: "Aqara",
          model: "G5 Pro",
          available: true,
          identifiers: ["physical-one"],
          stream: { url: "rtsp://192.168.1.5:8554/one", transport: "p2p" as const },
          snapshotPath: "/api/cameras/one/snapshot/last-live",
          entities: publication.entities("camera_one"),
        },
      ],
    });
    const value = build(),
      revision = provider.updateInventory(value),
      { code } = provider.openPairing(),
      enrolled = await provider.enroll(code, randomUUID());
    assert.deepEqual(value.cameras[0].entities[0].state, { on: true, brightness: 50 });
    await provider.confirmNativeReady(enrolled.clientId, { revision, entities: entityKeys(value) });
    assert.equal(wire.at(-1)?.topic, topic + "/config");
    assert.equal(wire.at(-1)?.message, "");
    assert.ok(wire.some((value) => value.topic === cameraTopic && value.message === ""));
    assert.equal(
      publication.entities("camera_one").length,
      1,
      "The camera discovery is not an extra control",
    );
    const count = wire.length;
    now = 2000;
    client.publish(topic + "/state", JSON.stringify({ state: "OFF", brightness: 0 }), {
      retain: true,
    });
    assert.equal(wire.length, count, "MQTT state is not sent while native owns it");
    assert.deepEqual(publication.entities("camera_one")[0].state, { on: false, brightness: 0 });
    assert.equal(publication.entities("camera_one")[0].updatedAt, 2000);
    assert.deepEqual(
      publication.command({ id: "camera_one" }, "spotlight", {
        action: "set",
        value: { brightness: 40, on: true },
      }),
      { topic: topic + "/set", payload: JSON.stringify({ state: "ON", brightness: 102 }) },
    );
    provider.setDisableMqttWithHaus(false);
    assert.ok(wire.some((value) => value.topic === cameraTopic && value.message === cameraConfig));
    assert.ok(
      wire.some(
        (value) => value.topic === topic + "/config" && value.message.includes("Spotlight"),
      ),
    );
    assert.equal(wire.at(-1)?.message, JSON.stringify({ state: "OFF", brightness: 0 }));
    client.publish("unrelated/topic", "preserved");
    assert.equal(wire.at(-1)?.message, "preserved");
    const sd = "homeassistant/sensor/camera_one/sdcard_percent";
    const number = "homeassistant/number/camera_one/volume";
    for (const [base, name, writable] of [
      [sd, "SD Card Used", false],
      [number, "Volume", true],
    ] as const) {
      client.publish(
        base + "/config",
        JSON.stringify({
          name,
          state_topic: base + "/state",
          ...(writable ? { command_topic: base + "/set" } : {}),
        }),
      );
      client.publish(base + "/state", "");
    }
    const unavailable = publication
      .entities("camera_one")
      .filter((entity) => entity.id !== "spotlight");
    assert.ok(unavailable.every((entity) => entity.state === null && !entity.available));
    assert.doesNotThrow(
      () => provider.updateInventory(build()),
      "An empty SD reading must not freeze the whole bridge inventory",
    );
    client.publish(sd + "/state", "37");
    const recovered = publication
      .entities("camera_one")
      .find((entity) => entity.id === "sdcard_percent")!;
    assert.equal(recovered.state, 37);
    assert.equal(recovered.available, true);
    assert.doesNotThrow(() => validateInventory(build()));
    const device = {
      id: "camera_one",
      name: "One",
      identifiers: ["physical-one"],
      manufacturer: "Aqara",
      model: "G5 Pro",
    } as MQTTDevice;
    publishMotionDiscovery(client, device);
    processEventAttrs(client, device, []);
    now += 61000;
    processEventAttrs(client, device, []);
    const motion = publication.entities("camera_one").find((entity) => entity.role === "motion");
    assert.equal(motion?.state, false);
    assert.equal(
      motion?.available,
      true,
      "Successful quiet-scene polls keep the native motion sensor available",
    );
    provider.setDisableMqttWithHaus(true);
    assert.equal(provider.shouldPublishMqtt(), false);
    await provider.releaseNative(enrolled.clientId);
    assert.equal(provider.shouldPublishMqtt(), true);
    assert.equal(provider.authenticate(`Bearer ${enrolled.token}`), enrolled.clientId);
    assert.ok(wire.some((value) => value.topic === cameraTopic && value.message === cameraConfig));
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
