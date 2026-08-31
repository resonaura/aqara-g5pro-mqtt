import fs from "fs";
import * as net from "net";
import path from "path";

/**
 * RTSP port allocation helpers.
 *
 * Ports must be four-digit, sequential across cameras ("walk one after
 * another"), and must avoid:
 *   - well-known ports (< 1024)
 *   - the 3000-3999 and 5000-5999 ranges (explicitly excluded by design)
 * If the preferred base (or any port in the chosen block) is already taken,
 * we scan forward for the next free *contiguous* run of ports so the cameras
 * always end up on a tidy sequential block.
 */

export const RTSP_PORT_MIN = 1024;
export const RTSP_PORT_MAX = 9999;
const FORBIDDEN_RANGES: [number, number][] = [
  [3000, 3999],
  [5000, 5999],
];

export function isPortAllowed(port: number): boolean {
  if (!Number.isInteger(port)) return false;
  if (port < RTSP_PORT_MIN || port > RTSP_PORT_MAX) return false;
  for (const [a, b] of FORBIDDEN_RANGES) {
    if (port >= a && port <= b) return false;
  }
  return true;
}

/** Probe whether a TCP port is free on localhost (nothing listening). */
export function probePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (free: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(free);
    };
    const sock = net.connect(port, "127.0.0.1");
    sock.setTimeout(500);
    // Something accepted the connection → port is occupied.
    sock.once("connect", () => finish(false));
    // Connection refused → nothing listening → free.
    sock.once("error", () => finish(true));
    sock.once("timeout", () => finish(true));
  });
}

/**
 * Find a contiguous block of `count` free, allowed ports starting near `base`.
 * Returns the concrete list of ports, or throws if no such block exists in the
 * allowed range.
 */
export async function findFreePortRange(count: number, base = 8555): Promise<number[]> {
  if (count <= 0) return [];

  // Normalize base into the allowed range.
  let start = Math.max(base, RTSP_PORT_MIN);
  while (!isPortAllowed(start)) start++;

  const maxStart = RTSP_PORT_MAX - count + 1;
  let guard = 0;
  while (start <= maxStart && guard++ < 20000) {
    if (!isPortAllowed(start) || !isPortAllowed(start + count - 1)) {
      start++;
      continue;
    }
    const candidates: number[] = [];
    for (let i = 0; i < count; i++) candidates.push(start + i);
    const free = await Promise.all(candidates.map((p) => probePortFree(p)));
    if (free.every((f) => f)) return candidates;
    // Jump past the first occupied port in the window and retry.
    const firstBad = free.findIndex((f) => !f);
    start = start + (firstBad === -1 ? 1 : firstBad) + 1;
  }
  throw new Error(
    `Could not find a free contiguous RTSP port block of size ${count} starting near ${base}`,
  );
}

/** Find a single free allowed TCP port starting near `base`. */
export async function findFreePort(base = 8580): Promise<number> {
  const [port] = await findFreePortRange(1, base);
  return port;
}

// ---- rtsp_ports.json: records the actual ports chosen per camera. ----

export interface RtspPortEntry {
  port: number;
  did: string;
  slug: string;
}

export interface RtspPortMap {
  base: number;
  updatedAt: number;
  cameras: Record<string, RtspPortEntry>;
}

function rtspPortMapPath(): string {
  return path.join(process.cwd(), "data", "rtsp_ports.json");
}

export function writeRtspPortMap(base: number, entries: RtspPortEntry[]): void {
  try {
    const dir = path.dirname(rtspPortMapPath());
    fs.mkdirSync(dir, { recursive: true });
    const map: RtspPortMap = {
      base,
      updatedAt: Date.now(),
      cameras: {},
    };
    for (const e of entries) map.cameras[e.did] = e;
    fs.writeFileSync(rtspPortMapPath(), JSON.stringify(map, null, 2));
  } catch {
    // Non-fatal: the port map is only a convenience for local tooling.
  }
}

export function readRtspPortMap(): RtspPortMap | null {
  try {
    const p = rtspPortMapPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as RtspPortMap;
  } catch {
    return null;
  }
}
