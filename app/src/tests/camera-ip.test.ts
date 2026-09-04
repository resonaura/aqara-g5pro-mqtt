import test from "node:test";
import assert from "node:assert/strict";
import { resolveCameraIp } from "../camera-ip.js";

test("resolveCameraIp respects device.ip if already present", () => {
  const ip = resolveCameraIp({ did: "lumi1.123", ip: "192.168.1.10" }, "cam-1");
  assert.equal(ip, "192.168.1.10");
});

test("resolveCameraIp resolves from CAMERA_IP_<DID>", () => {
  process.env.CAMERA_IP_LUMI1_54EF447FA4F9 = "192.168.1.200";
  const ip = resolveCameraIp({ did: "lumi1.54ef447fa4f9" }, "doorbell-g4");
  assert.equal(ip, "192.168.1.200");
  delete process.env.CAMERA_IP_LUMI1_54EF447FA4F9;
});

test("resolveCameraIp resolves from CAMERA_IP_<SLUG>", () => {
  process.env.CAMERA_IP_DOORBELL_G4 = "192.168.1.201";
  const ip = resolveCameraIp({ did: "lumi1.54ef447fa4f9" }, "doorbell-g4");
  assert.equal(ip, "192.168.1.201");
  delete process.env.CAMERA_IP_DOORBELL_G4;
});

test("resolveCameraIp resolves from CAMERA_IPS comma mapping", () => {
  process.env.CAMERA_IPS = "doorbell-g4=192.168.1.50,lumi1.999=192.168.1.51";
  const ip1 = resolveCameraIp({ did: "lumi1.54ef447fa4f9" }, "doorbell-g4");
  const ip2 = resolveCameraIp({ did: "lumi1.999" }, "other-cam");
  assert.equal(ip1, "192.168.1.50");
  assert.equal(ip2, "192.168.1.51");
  delete process.env.CAMERA_IPS;
});

test("resolveCameraIp resolves single camera from CAMERA_IP", () => {
  process.env.CAMERA_IP = "192.168.1.99";
  const ip = resolveCameraIp({ did: "lumi1.single" }, "my-cam", 1);
  assert.equal(ip, "192.168.1.99");

  // Should NOT apply to multi-camera setup without matching
  const ipMulti = resolveCameraIp({ did: "lumi1.single" }, "my-cam", 2);
  assert.equal(ipMulti, undefined);
  delete process.env.CAMERA_IP;
});
