import "reflect-metadata";
import { DataSource } from "typeorm";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { CameraStateEntity, GlobalSettingEntity, RTSPPortEntity } from "./entities/index.js";
import { getDataDir } from "../state.js";

let dataSource: DataSource | null = null;
let isInitialized = false;

export function getDataSource(): DataSource {
  if (!dataSource) {
    const dbPath = process.env.SQLITE_PATH || path.join(getDataDir(), "storage.sqlite");
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    dataSource = new DataSource({
      type: "better-sqlite3",
      database: dbPath,
      synchronize: true,
      logging: process.env.DEBUG_SQL === "true",
      entities: [CameraStateEntity, GlobalSettingEntity, RTSPPortEntity],
    });
  }
  return dataSource;
}

export async function initDatabase(): Promise<DataSource> {
  const ds = getDataSource();
  if (isInitialized && ds.isInitialized) {
    return ds;
  }

  if (!ds.isInitialized) {
    await ds.initialize();
  }

  isInitialized = true;
  return ds;
}

export async function closeDatabase(): Promise<void> {
  if (dataSource && dataSource.isInitialized) {
    await dataSource.destroy();
    isInitialized = false;
    dataSource = null;
  }
}
