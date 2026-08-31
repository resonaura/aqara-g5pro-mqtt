import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getNativeDir(): string {
  const candidates = [
    path.resolve(__dirname, "../native"),
    path.resolve(__dirname, "../../native"),
    path.resolve(process.cwd(), "app/native"),
    path.resolve(process.cwd(), "native"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, "CMakeLists.txt"))) {
      return c;
    }
  }
  return candidates[0];
}

export function computeSourceHash(nativeDir: string): string {
  const hash = crypto.createHash("sha256");

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Sort entries for deterministic hashing
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "build") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.name.endsWith(".cpp") ||
        entry.name.endsWith(".hpp") ||
        entry.name.endsWith(".h") ||
        entry.name.endsWith(".c") ||
        entry.name === "CMakeLists.txt"
      ) {
        hash.update(entry.name);
        hash.update(fs.readFileSync(fullPath));
      }
    }
  }

  walk(nativeDir);
  return hash.digest("hex");
}

export function ensureNativeBinary(): string {
  const nativeDir = getNativeDir();
  const buildDir = path.join(nativeDir, "build");
  const binName = process.platform === "win32" ? "aqara-streamer.exe" : "aqara-streamer";
  const binPath = path.join(buildDir, binName);
  const hashFile = path.join(buildDir, ".source_hash");

  if (!fs.existsSync(nativeDir)) {
    return binPath;
  }

  const currentHash = computeSourceHash(nativeDir);
  let storedHash = "";

  if (fs.existsSync(hashFile)) {
    try {
      storedHash = fs.readFileSync(hashFile, "utf8").trim();
    } catch {}
  }

  const binaryExists = fs.existsSync(binPath);
  const needsRebuild = !binaryExists || storedHash !== currentHash;

  if (needsRebuild) {
    const reason = !binaryExists
      ? "Binary missing"
      : `Source code modified (${storedHash.substring(0, 8)} -> ${currentHash.substring(0, 8)})`;
    console.log(`🔨 [NativeEngine] ${reason}. Building C++ native engine (aqara-streamer)...`);

    const startTime = Date.now();
    try {
      if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
      }

      // Configure & Build with all available CPU cores
      execSync(`cmake -B "${buildDir}" "${nativeDir}"`, {
        stdio: process.env.DEBUG ? "inherit" : "pipe",
      });
      execSync(`cmake --build "${buildDir}" -j`, {
        stdio: process.env.DEBUG ? "inherit" : "pipe",
      });

      fs.writeFileSync(hashFile, currentHash, "utf8");
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ [NativeEngine] Build completed successfully in ${elapsed}s -> ${binPath}`);
    } catch (err: any) {
      console.error(`❌ [NativeEngine] Build failed:\n`, err.stderr?.toString() || err.message);
      throw err;
    }
  }

  return binPath;
}
