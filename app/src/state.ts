import * as fs from "node:fs";
import path from "node:path";
import { initDatabase } from "./db/data-source.js";
import { CameraStateEntity, GlobalSettingEntity, RTSPPortEntity } from "./db/entities/index.js";

export interface CameraPersistentState {
  p2p_stream?: boolean;
  quality_channel?: number;
  motion_enabled?: boolean;
  spotlight_state?: "ON" | "OFF";
  spotlight_brightness?: number;
  slug?: string;
  deviceName?: string;
  model?: string;
  rtsp_port?: number;
  [key: string]: any;
}

export interface AppPersistentState {
  version: number;
  updatedAt: number;
  cameras: Record<string, CameraPersistentState>;
  global: Record<string, any>;
}

// Dynamic data directory resolver: Home Assistant Add-on persistent /data volume or local ./data
export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }
  try {
    if (fs.existsSync("/data")) {
      fs.accessSync("/data", fs.constants.W_OK);
      return "/data";
    }
  } catch {}
  return path.resolve(process.cwd(), "data");
}

export function getStateFilePath(): string {
  return path.join(getDataDir(), "app_state.json");
}

export function getLegacyP2PFilePath(): string {
  return path.join(getDataDir(), "p2p_state.json");
}

export const getLegacyP2pFilePath = getLegacyP2PFilePath;

let migrationChecked = false;

/**
 * Automatically migrate legacy JSON state files (if present) to SQLite tables on startup.
 */
async function checkAndMigrateLegacyJson(): Promise<void> {
  if (migrationChecked) return;
  migrationChecked = true;

  const ds = await initDatabase();
  const camRepo = ds.getRepository(CameraStateEntity);
  const globRepo = ds.getRepository(GlobalSettingEntity);
  const portRepo = ds.getRepository(RTSPPortEntity);

  // 1. Check legacy app_state.json
  const appStatePath = getStateFilePath();
  if (fs.existsSync(appStatePath)) {
    try {
      const raw = fs.readFileSync(appStatePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppPersistentState>;
      if (parsed.cameras) {
        for (const [did, cState] of Object.entries(parsed.cameras)) {
          const existing = await camRepo.findOneBy({ did });
          if (!existing) {
            const entity = new CameraStateEntity();
            entity.did = did;
            entity.slug = cState.slug;
            entity.deviceName = cState.deviceName;
            entity.model = cState.model;
            entity.p2p_stream = cState.p2p_stream ?? false;
            entity.quality_channel = cState.quality_channel;
            entity.motion_enabled = cState.motion_enabled ?? true;
            entity.spotlight_state = cState.spotlight_state;
            entity.spotlight_brightness = cState.spotlight_brightness;
            entity.rtsp_port = cState.rtsp_port;
            await camRepo.save(entity);
          }
        }
      }
      if (parsed.global) {
        for (const [k, v] of Object.entries(parsed.global)) {
          await globRepo.save({
            key: k,
            value: typeof v === "string" ? v : JSON.stringify(v),
          });
        }
      }
      // Remove migrated file
      fs.unlinkSync(appStatePath);
      console.log(`[Database] Successfully migrated legacy app_state.json to SQLite`);
    } catch (err: any) {
      console.warn(`[Database] Error during app_state.json migration: ${err?.message}`);
    }
  }

  // 2. Check legacy p2p_state.json
  const p2pStatePath = getLegacyP2PFilePath();
  if (fs.existsSync(p2pStatePath)) {
    try {
      const raw = fs.readFileSync(p2pStatePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.cameras) {
        for (const [did, val] of Object.entries(parsed.cameras)) {
          const streamFlag = typeof val === "boolean" ? val : ((val as any)?.p2p_stream ?? false);
          let entity = await camRepo.findOneBy({ did });
          if (!entity) {
            entity = new CameraStateEntity();
            entity.did = did;
            entity.p2p_stream = streamFlag;
          } else {
            entity.p2p_stream = streamFlag;
          }
          await camRepo.save(entity);
        }
      }
      fs.unlinkSync(p2pStatePath);
      console.log(`[Database] Successfully migrated legacy p2p_state.json to SQLite`);
    } catch (err: any) {
      console.warn(`[Database] Error during p2p_state.json migration: ${err?.message}`);
    }
  }

  // 3. Check legacy rtsp_ports.json
  const rtspPortsPath = path.join(getDataDir(), "rtsp_ports.json");
  if (fs.existsSync(rtspPortsPath)) {
    try {
      const raw = fs.readFileSync(rtspPortsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.cameras) {
        for (const [did, entry] of Object.entries(parsed.cameras as Record<string, any>)) {
          if (entry?.port) {
            await portRepo.save({
              did,
              slug: entry.slug || did,
              port: entry.port,
            });
          }
        }
      }
      fs.unlinkSync(rtspPortsPath);
      console.log(`[Database] Successfully migrated legacy rtsp_ports.json to SQLite`);
    } catch (err: any) {
      console.warn(`[Database] Error during rtsp_ports.json migration: ${err?.message}`);
    }
  }
}

function entityToCameraState(entity: CameraStateEntity): CameraPersistentState {
  const result: CameraPersistentState = {
    p2p_stream: entity.p2p_stream,
    motion_enabled: entity.motion_enabled,
    ...entity.extra,
  };
  if (entity.slug !== undefined && entity.slug !== null) result.slug = entity.slug;
  if (entity.deviceName !== undefined && entity.deviceName !== null)
    result.deviceName = entity.deviceName;
  if (entity.model !== undefined && entity.model !== null) result.model = entity.model;
  if (entity.quality_channel !== undefined && entity.quality_channel !== null)
    result.quality_channel = entity.quality_channel;
  if (entity.spotlight_state !== undefined && entity.spotlight_state !== null)
    result.spotlight_state = entity.spotlight_state as any;
  if (entity.spotlight_brightness !== undefined && entity.spotlight_brightness !== null)
    result.spotlight_brightness = entity.spotlight_brightness;
  if (entity.rtsp_port !== undefined && entity.rtsp_port !== null)
    result.rtsp_port = entity.rtsp_port;
  return result;
}

/**
 * Load the complete application state from SQLite.
 */
export async function loadAppState(): Promise<AppPersistentState> {
  await checkAndMigrateLegacyJson();
  const ds = await initDatabase();
  const camRepo = ds.getRepository(CameraStateEntity);
  const globRepo = ds.getRepository(GlobalSettingEntity);

  const [camEntities, globEntities] = await Promise.all([camRepo.find(), globRepo.find()]);

  const cameras: Record<string, CameraPersistentState> = {};
  for (const c of camEntities) {
    cameras[c.did] = entityToCameraState(c);
  }

  const global: Record<string, any> = {};
  for (const g of globEntities) {
    try {
      global[g.key] = JSON.parse(g.value);
    } catch {
      global[g.key] = g.value;
    }
  }

  return {
    version: 1,
    updatedAt: Date.now(),
    cameras,
    global,
  };
}

/**
 * Update the application state atomically using a mutator function.
 */
export async function updateAppState(
  updater: (draft: AppPersistentState) => void | Promise<void>,
): Promise<AppPersistentState> {
  await checkAndMigrateLegacyJson();
  const current = await loadAppState();
  await updater(current);

  const ds = await initDatabase();
  const camRepo = ds.getRepository(CameraStateEntity);
  const globRepo = ds.getRepository(GlobalSettingEntity);

  // Save cameras
  for (const [did, cState] of Object.entries(current.cameras)) {
    let entity = await camRepo.findOneBy({ did });
    if (!entity) {
      entity = new CameraStateEntity();
      entity.did = did;
    }
    if (cState.slug !== undefined) entity.slug = cState.slug;
    if (cState.deviceName !== undefined) entity.deviceName = cState.deviceName;
    if (cState.model !== undefined) entity.model = cState.model;
    if (cState.p2p_stream !== undefined) entity.p2p_stream = cState.p2p_stream;
    if (cState.quality_channel !== undefined) entity.quality_channel = cState.quality_channel;
    if (cState.motion_enabled !== undefined) entity.motion_enabled = cState.motion_enabled;
    if (cState.spotlight_state !== undefined) entity.spotlight_state = cState.spotlight_state;
    if (cState.spotlight_brightness !== undefined)
      entity.spotlight_brightness = cState.spotlight_brightness;
    if (cState.rtsp_port !== undefined) entity.rtsp_port = cState.rtsp_port;

    const knownKeys = new Set([
      "slug",
      "deviceName",
      "model",
      "p2p_stream",
      "quality_channel",
      "motion_enabled",
      "spotlight_state",
      "spotlight_brightness",
      "rtsp_port",
    ]);
    const extra: Record<string, any> = {};
    for (const [k, v] of Object.entries(cState)) {
      if (!knownKeys.has(k)) extra[k] = v;
    }
    if (Object.keys(extra).length > 0) {
      entity.extra = extra;
    }
    await camRepo.save(entity);
  }

  // Save global settings
  for (const [k, v] of Object.entries(current.global)) {
    await globRepo.save({
      key: k,
      value: typeof v === "string" ? v : JSON.stringify(v),
    });
  }

  return current;
}

/**
 * Get state for a specific camera.
 */
export async function getCameraState(did: string): Promise<CameraPersistentState> {
  await checkAndMigrateLegacyJson();
  const ds = await initDatabase();
  const camRepo = ds.getRepository(CameraStateEntity);
  const entity = await camRepo.findOneBy({ did });
  if (!entity) return {};
  return entityToCameraState(entity);
}

/**
 * Set/update partial state for a specific camera.
 */
export async function setCameraState(
  did: string,
  partial: Partial<CameraPersistentState>,
): Promise<CameraPersistentState> {
  await checkAndMigrateLegacyJson();
  const ds = await initDatabase();
  const camRepo = ds.getRepository(CameraStateEntity);

  let entity = await camRepo.findOneBy({ did });
  if (!entity) {
    entity = new CameraStateEntity();
    entity.did = did;
  }

  if (partial.slug !== undefined) entity.slug = partial.slug;
  if (partial.deviceName !== undefined) entity.deviceName = partial.deviceName;
  if (partial.model !== undefined) entity.model = partial.model;
  if (partial.p2p_stream !== undefined) entity.p2p_stream = partial.p2p_stream;
  if (partial.quality_channel !== undefined) entity.quality_channel = partial.quality_channel;
  if (partial.motion_enabled !== undefined) entity.motion_enabled = partial.motion_enabled;
  if (partial.spotlight_state !== undefined) entity.spotlight_state = partial.spotlight_state;
  if (partial.spotlight_brightness !== undefined)
    entity.spotlight_brightness = partial.spotlight_brightness;
  if (partial.rtsp_port !== undefined) entity.rtsp_port = partial.rtsp_port;

  const knownKeys = new Set([
    "slug",
    "deviceName",
    "model",
    "p2p_stream",
    "quality_channel",
    "motion_enabled",
    "spotlight_state",
    "spotlight_brightness",
    "rtsp_port",
  ]);
  const extra: Record<string, any> = entity.extra || {};
  for (const [k, v] of Object.entries(partial)) {
    if (!knownKeys.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) {
    entity.extra = extra;
  }

  const saved = await camRepo.save(entity);
  return entityToCameraState(saved);
}

/**
 * Get global state value.
 */
export async function getGlobalState<T = any>(key: string, fallback: T): Promise<T> {
  await checkAndMigrateLegacyJson();
  const ds = await initDatabase();
  const globRepo = ds.getRepository(GlobalSettingEntity);
  const entity = await globRepo.findOneBy({ key });
  if (!entity) return fallback;
  try {
    return JSON.parse(entity.value) as T;
  } catch {
    return entity.value as unknown as T;
  }
}

/**
 * Set global state value.
 */
export async function setGlobalState<T = any>(key: string, value: T): Promise<void> {
  await checkAndMigrateLegacyJson();
  const ds = await initDatabase();
  const globRepo = ds.getRepository(GlobalSettingEntity);
  await globRepo.save({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  });
}

/**
 * Backwards compatibility helper for loading P2P state.
 */
export async function loadP2PState(): Promise<Record<string, boolean>> {
  const appState = await loadAppState();
  const cameras: Record<string, boolean> = {};
  for (const [did, cam] of Object.entries(appState.cameras)) {
    cameras[did] = !!cam.p2p_stream;
  }
  return cameras;
}

export const loadP2pState = loadP2PState;

/**
 * Backwards compatibility helper for saving P2P state.
 */
export async function saveP2PState(
  didOrMap:
    string | { cameras?: Record<string, { p2p_stream?: boolean }> } | Record<string, boolean>,
  enabled?: boolean,
): Promise<void> {
  if (typeof didOrMap === "string") {
    await setCameraState(didOrMap, { p2p_stream: !!enabled });
  } else if (typeof didOrMap === "object" && didOrMap !== null) {
    if ("cameras" in didOrMap && didOrMap.cameras) {
      for (const [did, cam] of Object.entries(didOrMap.cameras)) {
        await setCameraState(did, { p2p_stream: !!cam?.p2p_stream });
      }
    } else {
      for (const [did, flag] of Object.entries(didOrMap)) {
        await setCameraState(did, {
          p2p_stream: typeof flag === "boolean" ? flag : !!(flag as any)?.p2p_stream,
        });
      }
    }
  }
}

export const saveP2pState = saveP2PState;
