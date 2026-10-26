import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ensureNativeBinary } from "../build-guard.js";

// Run during image construction against the final runtime. Never load app state,
// connect to a camera or create a P2P session as part of this check.
const db = new Database(":memory:");
try {
  if (db.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new Error("Packaged SQLite integrity check failed");
  }
} finally {
  db.close();
}
execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5_000 });

await new Promise<void>((resolve, reject) => {
  const engine = spawn(ensureNativeBinary(), [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: engine.stdout });
  let ready = false;
  let pong = false;
  const timer = setTimeout(() => {
    engine.kill("SIGKILL");
    reject(new Error("Packaged native IPC check timed out"));
  }, 5_000);
  engine.stderr.resume();
  engine.stdin.on("error", () => {});
  engine.once("error", reject);
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.event === "ready" && !ready) {
        ready = true;
        engine.stdin.write('{"cmd":"ping"}\n');
      } else if (message.event === "pong" && ready) {
        pong = true;
        engine.stdin.end();
      }
    } catch {
      engine.kill("SIGKILL");
      reject(new Error("Packaged native IPC response was invalid"));
    }
  });
  engine.once("close", (code) => {
    clearTimeout(timer);
    lines.close();
    if (code === 0 && ready && pong) resolve();
    else reject(new Error("Packaged native engine did not complete ready/ping/exit"));
  });
});
console.log("Runtime verified: SQLite, FFmpeg and packaged native IPC");
