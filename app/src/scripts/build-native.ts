import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeSourceHash, getNativeDir } from "../build-guard.js";

const nativeDir = getNativeDir();
const buildDir = path.join(nativeDir, "build");
mkdirSync(buildDir, { recursive: true });
execFileSync("cmake", ["-B", buildDir, nativeDir], { stdio: "inherit" });
execFileSync("cmake", ["--build", buildDir, "-j4"], { stdio: "inherit" });
writeFileSync(path.join(buildDir, ".source_hash"), computeSourceHash(nativeDir), "utf8");

const compileCommands = path.join(buildDir, "compile_commands.json");
if (existsSync(compileCommands)) {
  try {
    copyFileSync(compileCommands, path.join(nativeDir, "compile_commands.json"));
  } catch {}
}

console.log(`✅ Native engine built and source hash updated: ${buildDir}`);
