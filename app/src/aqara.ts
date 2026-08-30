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

export function getToken(): string {
  return TOKEN;
}

export function getUserId(): string {
  return USER_ID;
}

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
  baseURL: process.env.AQUARA_URL || "https://aiot-rpc-usa.aqara.com",
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
      {
        key: crypto.createPublicKey(pub),
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
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

  if (!response.result || !response.result.devices) {
    console.log("⚠️ No devices found in API response");
    return [];
  }

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

/** One live-quality option from cloud (Aqara Home's 1520p / 1080p / Low list). */
export type CameraStreamQuality = {
  title: string;
  height: number;
  /** P2P 0x100E `channel` — same index as `/chN` in the cloud map, not an RTSP URL. */
  channel: number;
};

const HEIGHT_RE = /(\d{3,4})\s*p/i;

/**
 * Parse the cloud `rtsp_url` JSON as a quality catalogue.
 * We never connect to those URLs — only the names and `/chN` index are used
 * for P2P `changeStreamResolution`. App UI for G5 Pro is 1520p / 1080p / Low;
 * 360p in this map is Low Resolution. Highest height wins.
 */
export function parseCloudStreamQualities(raw: unknown): CameraStreamQuality[] {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return [];
  }
  const out: CameraStreamQuality[] = [];
  for (const [title, url] of Object.entries(obj)) {
    const hm = title.match(HEIGHT_RE);
    const height = hm ? parseInt(hm[1], 10) : /low/i.test(title) ? 360 : 0;
    const ch = String(url ?? "").match(/\/ch(\d+)/i);
    const channel = ch ? parseInt(ch[1], 10) : 0;
    out.push({ title, height, channel });
  }
  return out.sort((a, b) => b.height - a.height);
}

export function pickMaxStreamQuality(
  list: CameraStreamQuality[],
): CameraStreamQuality | null {
  return list[0] ?? null;
}

/** Map a named quality to StartVideoCmdContent.videoStream (0=1520p, 1=1080p, 2=Low). */
export function videoStreamIndex(q: CameraStreamQuality | null): number {
  if (!q) return 0;
  if (q.height >= 1400) return 0;
  if (q.height >= 1000) return 1;
  return 2;
}

/**
 * JSON 0x100E `{"channel":N}` from Aqara Home changeLiveStreamResolution.
 * Official E1 dump: start 640x360 (no 0x100E), user High → `{"channel":0}`
 * → 2304x1296 I-frame, stream does not stop. 0=max, 1=mid, 2=low.
 * Cloud `/chN` is NOT this field.
 */
export function jsonQualityChannel(
  q: CameraStreamQuality | null,
  model = "",
): number {
  const m = (model || "").toLowerCase();
  const isG5 = m.includes("agl004") || m.includes("g5");
  if (q) {
    if (isG5) {
      // G5 Pro uses non-standard channel ordering (Frida-confirmed):
      // channel 3=1520p (max), channel 0=1080p (mid), channel 2=fluent (low)
      if (q.height >= 1400) return 3;
      if (q.height >= 1000) return 0;
      return 2;
    }
    // E1 / generic: channel 0=max, 1=mid, 2=low
    if (q.height >= 1200) return 0;
    if (q.height >= 700) return 1;
    return 2;
  }
  // No cloud quality list: default to max quality per model
  if (isG5) return 3; // G5 Pro max = channel 3 (1520p)
  return 0; // E1 and others: channel 0 = max
}

/** Cloud catalogue for one camera. Empty if the model has no `rtsp_url` attr (E1). */
export async function getCameraStreamQualities(
  did: string,
): Promise<CameraStreamQuality[]> {
  const res = await queryAttrs(["rtsp_url"], did);
  const raw = res.result?.find((a) => a.attr === "rtsp_url")?.value;
  if (!raw) return [];
  return parseCloudStreamQualities(raw);
}
