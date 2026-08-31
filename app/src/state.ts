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

const STATE_FILE = path.resolve(process.cwd(), "data", "app_state.json");
const LEGACY_P2P_STATE_FILE = path.resolve(process.cwd(), "data", "p2p_state.json");
const LOCK_DIR = path.resolve(process.cwd(), "data", "app_state.lock");

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
  const dir = path.dirname(LOCK_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return () => {
        try {
          fs.rmdirSync(LOCK_DIR);
        } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      // Check for stale lock (> 10s old) from a crashed process
      try {
        const stats = fs.statSync(LOCK_DIR);
        if (Date.now() - stats.mtimeMs > 10_000) {
          try {
            fs.rmdirSync(LOCK_DIR);
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
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8").trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        // Schema validation / migration
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
            }
          }
          return state;
        }
      }
    } else if (fs.existsSync(LEGACY_P2P_STATE_FILE)) {
      const raw = fs.readFileSync(LEGACY_P2P_STATE_FILE, "utf8").trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const state = createDefaultState();
        if (parsed && typeof parsed === "object") {
          for (const [key, val] of Object.entries(parsed)) {
            state.cameras[key] = typeof val === "boolean" ? { p2p_stream: val } : (val as any);
          }
          return state;
        }
      }
    }
  } catch (err: any) {
    console.warn(`⚠️ Failed to read app state file: ${err.message}`);
  }
  return createDefaultState();
}

/**
 * Synchronously update and save application state with atomic fsync + rename.
 */
function updateAppStateSync(updater: (draft: AppPersistentState) => void): AppPersistentState {
  const release = acquireLock();
  try {
    const state = loadAppState();
    updater(state);
    state.updatedAt = Date.now();

    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write via PID-tagged temp file + fsync + rename
    const tmpFile = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(state, null, 2);
    const fd = fs.openSync(tmpFile, "w");
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fs.renameSync(tmpFile, STATE_FILE);
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
