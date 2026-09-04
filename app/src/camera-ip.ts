import type { Device } from "./types.js";

export function resolveCameraIp(
  device: Pick<Device, "did" | "ip">,
  slug: string,
  totalCameras = 1,
): string | undefined {
  if (device.ip) return device.ip;

  const didKey = `CAMERA_IP_${device.did.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
  if (process.env[didKey]) return process.env[didKey];

  const slugKey = `CAMERA_IP_${slug.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
  if (process.env[slugKey]) return process.env[slugKey];

  if (process.env.CAMERA_IPS) {
    const pairs = process.env.CAMERA_IPS.split(",");
    for (const pair of pairs) {
      const [k, v] = pair.split("=").map((s) => s?.trim());
      if (k && v && (k === device.did || k.toLowerCase() === slug.toLowerCase())) {
        return v;
      }
    }
  }

  if (process.env.CAMERA_IP && totalCameras === 1) {
    return process.env.CAMERA_IP;
  }

  return undefined;
}
