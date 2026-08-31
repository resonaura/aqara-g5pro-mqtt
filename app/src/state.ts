import * as fs from "node:fs";
import path from "node:path";

export interface CameraPersistentState {
  p2p_stream?: boolean;
  quality_channel?: number;
  motion_enabled?: boolean;
  spotlight_state?: "ON" | "OFF";
  spotlight_brightness?: number;
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

export function getLegacyP2pFilePath(): string {
  return path.join(getDataDir(), "p2p_state.json");
}

export function getLockDirPath(): string {
  return path.join(getDataDir(), "app_state.lock");
}

// In-process serialized Promise queue
let saveQueue = Promise.resolve();

function createDefaultState(): AppPersistentState {
  return {
    version: 1,
    updatedAt: Date.now(),
    cameras: {},
    global: {},
  };
}

/**
 * Acquire an inter-process directory lock with stale-lock recovery.
 */
function acquireLock(timeoutMs = 5000): () => void {
  const lockDir = getLockDirPath();
  const dir = path.dirname(lockDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      // Check for stale lock (> 10s old) from a crashed process
      try {
        const stats = fs.statSync(lockDir);
        if (Date.now() - stats.mtimeMs > 10_000) {
          try {
            fs.rmdirSync(lockDir);
            continue;
          } catch {}
        }
      } catch {}

      if (Date.now() >= deadline) {
        console.warn("⚠️ Timed out waiting for app_state file lock, proceeding with write");
        return () => {};
      }

      // Small synchronous spin-wait
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/**
 * Load complete application persistent state safely with automatic schema migration.
 */
export function loadAppState(): AppPersistentState {
  const stateFile = getStateFilePath();
  const legacyFile = getLegacyP2pFilePath();
  const fallbackLocalFile = path.resolve(process.cwd(), "data", "app_state.json");
  const fallbackLegacyLocal = path.resolve(process.cwd(), "data", "p2p_state.json");

  const candidateFiles = [stateFile, legacyFile, fallbackLocalFile, fallbackLegacyLocal];

  for (const file of candidateFiles) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8").trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            if (parsed.cameras && typeof parsed.cameras === "object") {
              return {
                version: parsed.version || 1,
                updatedAt: parsed.updatedAt || Date.now(),
                cameras: parsed.cameras,
                global: parsed.global || {},
              };
            }
            // Legacy flat { [did]: boolean } migration
            const state = createDefaultState();
            for (const [key, val] of Object.entries(parsed)) {
              if (typeof val === "boolean") {
                state.cameras[key] = { p2p_stream: val };
              } else if (val && typeof val === "object") {
                state.cameras[key] = val as CameraPersistentState;
              }
            }
            return state;
          }
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ Failed to read candidate state file ${file}: ${err.message}`);
    }
  }

  return createDefaultState();
}

/**
 * Synchronously update and save application state with atomic fsync + rename.
 */
function updateAppStateSync(updater: (draft: AppPersistentState) => void): AppPersistentState {
  const release = acquireLock();
  const stateFile = getStateFilePath();
  try {
    const state = loadAppState();
    updater(state);
    state.updatedAt = Date.now();

    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write via PID-tagged temp file + fsync + rename
    const tmpFile = `${stateFile}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(state, null, 2);
    const fd = fs.openSync(tmpFile, "w");
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tmpFile, stateFile);
    return state;
  } catch (err: any) {
    console.warn(`⚠️ Failed to persist app state: ${err.message}`);
    return loadAppState();
  } finally {
    release();
  }
}

/**
 * Update application state with an in-process serialized queue and cross-process lock.
 */
export function updateAppState(updater: (draft: AppPersistentState) => void): Promise<AppPersistentState> {
  let result: AppPersistentState = createDefaultState();
  saveQueue = saveQueue
    .then(async () => {
      result = updateAppStateSync(updater);
    })
    .catch((err) => {
      console.error("❌ Error in updateAppState queue:", err);
    });
  return saveQueue.then(() => result);
}

/**
 * Get state object for a specific camera.
 */
export function getCameraState(did: string): CameraPersistentState {
  const state = loadAppState();
  return state.cameras[did] || {};
}

/**
 * Set/update partial state for a specific camera.
 */
export async function setCameraState(did: string, partial: Partial<CameraPersistentState>): Promise<CameraPersistentState> {
  const state = await updateAppState((draft) => {
    draft.cameras[did] = {
      ...(draft.cameras[did] || {}),
      ...partial,
    };
  });
  return state.cameras[did];
}

/**
 * Get global state value.
 */
export function getGlobalState<T>(key: string, defaultValue: T): T {
  const state = loadAppState();
  return state.global[key] !== undefined ? state.global[key] : defaultValue;
}

/**
 * Set global state value.
 */
export async function setGlobalState<T>(key: string, value: T): Promise<void> {
  await updateAppState((draft) => {
    draft.global[key] = value;
  });
}

/**
 * Convenience helper: Load map of did -> boolean for P2P streams.
 */
export function loadP2pState(): Record<string, boolean> {
  const state = loadAppState();
  const res: Record<string, boolean> = {};
  for (const [did, cam] of Object.entries(state.cameras)) {
    if (typeof cam.p2p_stream === "boolean") {
      res[did] = cam.p2p_stream;
    }
  }
  return res;
}

/**
 * Convenience helper: Save P2P stream state for a camera.
 */
export async function saveP2pState(did: string, enabled: boolean): Promise<void> {
  await setCameraState(did, { p2p_stream: enabled });
}
