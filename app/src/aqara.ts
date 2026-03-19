import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import {
  AqaraPullDevicesResponse,
  AqaraResponse,
  Device,
  MQTTDevice,
} from "./types.js";

const PHONE_ID = uuidv4().toUpperCase();

const api = axios.create({
  baseURL: process.env.AQUARA_URL,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "AqaraApp/1.0.0",
    "App-Version": "3.0.0",
    "Sys-Type": "1",
    Lang: "en",
    "Phone-Model": "NodeClient",
    PhoneId: PHONE_ID,
    Appid: process.env.APPID!,
    Token: process.env.TOKEN!,
  },
});

// Добавляем Time и Nonce на каждый запрос (требует Aqara API)
api.interceptors.request.use((config) => {
  config.headers["Time"] = Date.now().toString();
  config.headers["Nonce"] = uuidv4().replace(/-/g, "").substring(0, 16);
  return config;
});

export async function queryAttrs(
  attrs: string[],
  subjectId: string,
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

export async function getCameras(): Promise<Device[]> {
  const response = await getDevices();

  console.log("🔍 API Response:", {
    code: response.code,
    message: response.message,
    deviceCount: response.result?.devices?.length || 0,
  });

  if (!response.result || !response.result.devices) {
    console.log("⚠️ No devices found in API response");
    return [];
  }

  // Показываем все найденные устройства для отладки
  console.log("📱 All devices found:");
  response.result.devices.forEach((device) => {
    console.log(
      `  - ${device.deviceName} (${device.model}) - ${device.originalName}`,
    );
  });

  // Filter only Aqara cameras using model prefix like in setup script
  const cameras = response.result.devices.filter((device) =>
    device.model?.startsWith("lumi.camera"),
  );

  return cameras;
}

export async function checkDeviceCapabilities(
  subjectId: string,
): Promise<{ hasSpotlight: boolean }> {
  try {
    // Проверяем наличие spotlight через попытку получить атрибуты
    const res = await queryAttrs(
      ["white_light_enable", "white_light_level"],
      subjectId,
    );
    const hasSpotlight =
      res.result &&
      res.result.length > 0 &&
      res.result.some((r) => r.attr === "white_light_enable");
    return { hasSpotlight };
  } catch (error) {
    console.log(
      `⚠️ Could not check spotlight capabilities for ${subjectId}:`,
      error.message,
    );
    return { hasSpotlight: false };
  }
}

export function aqaraDeviceToMQTT(device: Device): MQTTDevice {
  return {
    identifiers: [device.did],
    manufacturer: "Aqara",
    model: device.originalName,
    name: device.deviceName,
    id: device.did.replaceAll(".", "_"),
  };
}

export async function writeAttr(
  attr: string,
  value: any,
  subjectId: string,
): Promise<void> {
  const res = await api.post("/app/v1.0/lumi/res/write", {
    subjectId,
    data: { [attr]: value },
  });
  return res.data;
}
