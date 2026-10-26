import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("Supervisor SIGTERM reaches the Node cleanup handler through the actual add-on launcher", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aqara-stop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "saved.env"), "TOKEN=fixture\nCONFIG_HASH=fixture\n");
  await fs.writeFile(
    path.join(root, "dist/index.js"),
    `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync('stopped','clean');process.exit(0)});console.log('fixture ready');setInterval(()=>{},1000);`,
  );
  // Only replace the two external HA paths. The production launch/control flow
  // stays intact; service discovery and configuration have isolated fixtures.
  const source = (await fs.readFile(new URL("../../addon.sh", import.meta.url), "utf8"))
    .replace("CONFIG_PATH=/data/options.json", "CONFIG_PATH=/fixture-options.json")
    .replace(
      'ENV_FILE="/usr/src/app/.env"',
      `ENV_FILE=${JSON.stringify(path.join(root, "saved.env"))}`,
    );
  await fs.writeFile(path.join(root, "launcher.sh"), source);
  const wrapper = `
    bashio::services.available() { return 1; }
    jq() { case "$1" in .area) echo US;; .poll_interval) echo 1;; .log_level) echo info;; esac; }
    sha256sum() { cat >/dev/null; echo 'fixture -'; }
    source ./launcher.sh
  `;
  const child = spawn("bash", ["-c", wrapper], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
  });
  t.after(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* The owned process group already exited. */
    }
  });
  const exited = once(child, "exit");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Isolated add-on startup timed out")), 5000);
    let output = "";
    child.on("error", reject);
    child.stdout.on("data", (value) => {
      output += value;
      if (output.includes("fixture ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.kill("SIGTERM");
  await exited;
  assert.equal(await fs.readFile(path.join(root, "stopped"), "utf8"), "clean");
});
