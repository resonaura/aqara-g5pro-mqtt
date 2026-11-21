import { queryAttrs, writeAttr } from "./aqara.js";
import { cameraDiagnosticId, diagnostics } from "./diagnostics.js";

export type PTZDirection = "up" | "down" | "left" | "right" | "stop";

export interface CloudPTZPosition {
  x: number;
  y: number;
}

export interface CloudPTZResult {
  moved: boolean;
  reason?: string;
  position?: CloudPTZPosition;
}

export interface CloudPTZDeps {
  queryAttrs: typeof queryAttrs;
  writeAttr: typeof writeAttr;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CloudPTZOptions {
  panStep?: number;
  tiltStep?: number;
  cacheTtlMs?: number;
  minIntervalMs?: number;
}

// Verified against Camera E1 (lumi.camera.acn006 & acn007, firmware 4.5.20_0020,
// identical MD5 a22216a432d80e2b0b5b89872be1e088): rootfs/bin/ppcs only handles
// 0x1000..0x1024 and rejects 0x102A with code=-1. Motor control lives in
// rootfs/bin/ai (resource 14.88.85 / "ptz_position") with x in [-175, +175]
// (+ left, - right) and y in [-15, +52] (+ up, - down), enforcing a 200ms
// cooldown in motor_cruise_dir when x_dir/y_dir > 0.
export const E1_PTZ_PAN_MIN = -175;
export const E1_PTZ_PAN_MAX = 175;
export const E1_PTZ_TILT_MIN = -15;
export const E1_PTZ_TILT_MAX = 52;
export const E1_PTZ_PAN_STEP = 20;
export const E1_PTZ_TILT_STEP = 10;
export const E1_PTZ_CACHE_TTL_MS = 5_000;
export const E1_PTZ_MIN_INTERVAL_MS = 250;

const VALID_DIRECTIONS = new Set<string>(["up", "down", "left", "right", "stop"]);

export function isValidPtzDirection(direction: string): direction is PTZDirection {
  return VALID_DIRECTIONS.has(direction);
}

export function usesCloudPtzPosition(model: string): boolean {
  const m = (model || "").toLowerCase();
  return m.includes("acn006") || m.includes("acn007");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function parseCloudPtzPosition(raw: unknown): CloudPTZPosition | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const x = Number((obj as Record<string, unknown>).x);
  const y = Number((obj as Record<string, unknown>).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: clamp(x, E1_PTZ_PAN_MIN, E1_PTZ_PAN_MAX),
    y: clamp(y, E1_PTZ_TILT_MIN, E1_PTZ_TILT_MAX),
  };
}

export function stepCloudPtzPosition(
  current: CloudPTZPosition,
  direction: Exclude<PTZDirection, "stop">,
  panStep = E1_PTZ_PAN_STEP,
  tiltStep = E1_PTZ_TILT_STEP,
): CloudPTZPosition {
  switch (direction) {
    case "left":
      return { x: clamp(current.x + panStep, E1_PTZ_PAN_MIN, E1_PTZ_PAN_MAX), y: current.y };
    case "right":
      return { x: clamp(current.x - panStep, E1_PTZ_PAN_MIN, E1_PTZ_PAN_MAX), y: current.y };
    case "up":
      return { x: current.x, y: clamp(current.y + tiltStep, E1_PTZ_TILT_MIN, E1_PTZ_TILT_MAX) };
    case "down":
      return { x: current.x, y: clamp(current.y - tiltStep, E1_PTZ_TILT_MIN, E1_PTZ_TILT_MAX) };
  }
}

export function formatCloudPtzPayload(position: CloudPTZPosition): string {
  // Using x_dir=2, y_dir=2 matches E1's built-in cloud presets and routes through
  // motor_cruise_dir (200ms cooldown) instead of motor_cruise (5s cooldown).
  return JSON.stringify({
    x: clamp(position.x, E1_PTZ_PAN_MIN, E1_PTZ_PAN_MAX),
    y: clamp(position.y, E1_PTZ_TILT_MIN, E1_PTZ_TILT_MAX),
    x_dir: 2,
    y_dir: 2,
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CloudPTZController {
  private readonly deps: Required<CloudPTZDeps>;
  private readonly panStep: number;
  private readonly tiltStep: number;
  private readonly cacheTtlMs: number;
  private readonly minIntervalMs: number;
  private readonly cache = new Map<string, { pos: CloudPTZPosition; updatedAt: number }>();
  private readonly lastWriteAt = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(deps?: Partial<CloudPTZDeps>, options?: CloudPTZOptions) {
    this.deps = {
      queryAttrs: deps?.queryAttrs ?? queryAttrs,
      writeAttr: deps?.writeAttr ?? writeAttr,
      now: deps?.now ?? Date.now,
      sleep: deps?.sleep ?? defaultSleep,
    };
    this.panStep = options?.panStep ?? E1_PTZ_PAN_STEP;
    this.tiltStep = options?.tiltStep ?? E1_PTZ_TILT_STEP;
    this.cacheTtlMs = options?.cacheTtlMs ?? E1_PTZ_CACHE_TTL_MS;
    this.minIntervalMs = options?.minIntervalMs ?? E1_PTZ_MIN_INTERVAL_MS;
  }

  public move(did: string, direction: string): Promise<CloudPTZResult> {
    if (!isValidPtzDirection(direction)) {
      diagnostics.record(
        "cloud.ptz_rejected",
        { camera: cameraDiagnosticId(did), direction, reason: "invalid_direction" },
        "warn",
      );
      return Promise.resolve({ moved: false, reason: "invalid_direction" });
    }

    const previous = this.queues.get(did) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.execute(did, direction));
    this.queues.set(did, run);
    return run;
  }

  private async readCurrentPosition(did: string): Promise<CloudPTZPosition | null> {
    const res = await this.deps.queryAttrs(["ptz_position"], did);
    const entry = res?.result?.find((item) => item.attr === "ptz_position");
    return parseCloudPtzPosition(entry?.value);
  }

  private async execute(did: string, direction: PTZDirection): Promise<CloudPTZResult> {
    if (direction === "stop") {
      // Cloud ptz_position commands are bounded single-step moves (not continuous motion).
      // Clear cached target so the next directional command re-syncs from the camera.
      this.cache.delete(did);
      diagnostics.record("cloud.ptz_sent", {
        camera: cameraDiagnosticId(did),
        direction,
        transport: "cloud_ptz_position",
      });
      return { moved: false, reason: "bounded_step_noop" };
    }

    const now = this.deps.now();
    const cached = this.cache.get(did);
    let usedCache = false;
    let current: CloudPTZPosition | null = null;

    if (cached && now - cached.updatedAt < this.cacheTtlMs) {
      current = cached.pos;
      usedCache = true;
    } else {
      current = await this.readCurrentPosition(did);
    }

    if (!current) {
      diagnostics.record(
        "cloud.ptz_rejected",
        { camera: cameraDiagnosticId(did), direction, reason: "position_unavailable" },
        "warn",
      );
      return { moved: false, reason: "position_unavailable" };
    }

    let target = stepCloudPtzPosition(current, direction, this.panStep, this.tiltStep);
    if (target.x === current.x && target.y === current.y && usedCache) {
      // Re-check live hardware position in case the camera was moved externally.
      this.cache.delete(did);
      const fresh = await this.readCurrentPosition(did);
      if (!fresh) {
        return { moved: false, reason: "position_unavailable" };
      }
      current = fresh;
      target = stepCloudPtzPosition(current, direction, this.panStep, this.tiltStep);
    }

    if (target.x === current.x && target.y === current.y) {
      this.cache.set(did, { pos: current, updatedAt: this.deps.now() });
      return { moved: false, reason: "at_limit", position: current };
    }

    const prevWrite = this.lastWriteAt.get(did);
    if (prevWrite !== undefined) {
      const waitMs = this.minIntervalMs - (this.deps.now() - prevWrite);
      if (waitMs > 0) {
        await this.deps.sleep(waitMs);
      }
    }

    try {
      await this.deps.writeAttr("ptz_position", formatCloudPtzPayload(target), did);
    } catch (err) {
      this.cache.delete(did);
      diagnostics.record(
        "cloud.ptz_rejected",
        { camera: cameraDiagnosticId(did), direction, reason: "cloud_write_failed" },
        "warn",
      );
      throw err;
    }

    const completedAt = this.deps.now();
    this.lastWriteAt.set(did, completedAt);
    this.cache.set(did, { pos: target, updatedAt: completedAt });
    diagnostics.record("cloud.ptz_sent", {
      camera: cameraDiagnosticId(did),
      direction,
      transport: "cloud_ptz_position",
    });

    return { moved: true, position: target };
  }
}
