import axios from "axios";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  AqaraPullDevicesResponse,
  AqaraResponse,
  Device,
  MQTTDevice,
} from "./types.js";

const PHONE_ID = uuidv4().toUpperCase();

// Публичные ключи подписи приложения Aqara Home (Android)
const APP_ID = process.env.APPID || "444c476ef7135e53330f46e7";
const APP_KEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi";

let TOKEN: string = process.env.TOKEN || "";
let USER_ID: string = "";

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

function aqaraSign(opts: {
  nonce: string;
  time: string;
  token?: string;
  body?: string;
}): string {
  let pre = `Appid=${APP_ID}&Nonce=${opts.nonce}&Time=${opts.time}`;
  if (opts.token) pre += `&Token=${opts.token}`;
  if (opts.body) pre += `&${opts.body}`;
  pre += `&${APP_KEY}`;
  return md5(pre);
}

export const api = axios.create({
  baseURL: process.env.AQUARA_URL,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    lang: "en",
    "app-version": "6.1.6",
    "sys-type": "1",
    "sys-version": "14",
    "phone-model": "Pixel 7",
    phoneid: PHONE_ID,
    appid: APP_ID,
  },
});

api.interceptors.request.use((config) => {
  const time = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex").toUpperCase();
  let body = "";
  if (config.method === "get" && config.params) {
    body = Object.entries(config.params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
  } else if (
    config.data &&
    typeof config.data === "string" &&
    config.data.length > 0
  ) {
    body = config.data;
  } else if (config.data && typeof config.data === "object") {
    // axios сериализует объект позже — для подписи нужна точная строка запроса
    body = JSON.stringify(config.data);
    config.data = body;
  }
  config.headers["Time"] = time;
  config.headers["Nonce"] = nonce;
  config.headers["Sign"] = aqaraSign({ nonce, time, token: TOKEN, body });
  if (TOKEN) config.headers["Token"] = TOKEN;
  if (USER_ID) config.headers["Userid"] = USER_ID;
  return config;
});

export async function login(email: string, password: string): Promise<void> {
  const pub = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCG46slB57013JJs4Vvj5cVyMpR
9b+B2F+YJU6qhBEYbiEmIdWpFPpOuBikDs2FcPS19MiWq1IrmxJtkICGurqImRUt
4lP688IWlEmqHfSxSRf2+aH0cH8VWZ2OaZn5DWSIHIPBF2kxM71q8stmoYiV0oZs
rZzBHsMuBwA4LQdxBwIDAQAB
-----END PUBLIC KEY-----`;
  const md5pw = crypto.createHash("md5").update(password).digest("hex");
  const encrypted = crypto
    .publicEncrypt(
      { key: crypto.createPublicKey(pub), padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(md5pw),
    )
    .toString("base64");
  const body = JSON.stringify({
    account: email,
    encryptType: 2,
    password: encrypted,
  });
  // Логин выполняется без Token в подписи
  const time = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex").toUpperCase();
  const res = await api.post("/app/v1.0/lumi/user/login", body, {
    headers: {
      Time: time,
      Nonce: nonce,
      Sign: aqaraSign({ nonce, time, body }),
    },
  });
  if (res.data?.code !== 0) {
    throw new Error(
      `Aqara login failed: code=${res.data?.code} ${res.data?.message}`,
    );
  }
  TOKEN = res.data.result.token;
  USER_ID = res.data.result.userId;
}


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
