import axios from "axios";
import {
  AqaraPullDevicesResponse,
  AqaraResponse,
  Device,
  MQTTDevice,
} from "./types.js";

const api = axios.create({
  baseURL: process.env.AQUARA_URL,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Sys-Type": "1",
    Appid: process.env.APPID!,
    Token: process.env.TOKEN!,
  },
});

export async function queryAttrs(
  attrs: string[],
  subjectId: string
): Promise<AqaraResponse> {
  const res = await api.post("/app/v1.0/lumi/res/query", {
    data: [{ options: attrs, subjectId }],
  });
  return res.data;
}

export async function getDevices(): Promise<AqaraPullDevicesResponse> {
  const res = await api.get("/app/v1.0/lumi/app/position/device/query");
  return res.data;
}

export async function getDevice(id: string): Promise<Device> {
  const response = await getDevices();
  return response.result.devices.find((device) => device.did === id);
}

export function aqaraDeviceToMQTT(device: Device): MQTTDevice {
  return {
    identifiers: [device.did],
    manufacturer: "Aqara",
    model: device.originalName,
    name: device.deviceName,
    _simpleModel: device.model.replaceAll('.', '_')
  };
}

export async function writeAttr(
  attr: string,
  value: any,
  subjectId: string
): Promise<void> {
  const res = await api.post("/app/v1.0/lumi/res/write", {
    subjectId,
    data: { [attr]: value },
  });
  return res.data;
}
