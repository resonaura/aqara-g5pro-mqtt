import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("packaged setup help exits without credentials, prompting or writing state", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "aqara-setup-help-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../../dist/scripts/setup.js", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--help"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--auto/);
  assert.deepEqual(readdirSync(cwd), []);
});

test("setup authentication failures omit accounts, tokens, password hashes and request bodies", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "aqara-setup-redaction-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  const modules = join(cwd, "node_modules");
  mkdirSync(join(modules, "axios"), { recursive: true });
  writeFileSync(join(modules, "axios/package.json"), '{"type":"module","main":"index.js"}');
  writeFileSync(
    join(modules, "axios/index.js"),
    `export default {
      post: async () => { throw {
        isAxiosError: true, code: "ERR_BAD_RESPONSE", message: "PRIVATE_LOGIN_FIXTURE",
        config: { url: "PRIVATE_LOGIN_FIXTURE", headers: { Sign: "PRIVATE_LOGIN_FIXTURE" }, data: "PRIVATE_LOGIN_FIXTURE" },
        response: { status: 502, data: { token: "PRIVATE_LOGIN_FIXTURE" } }
      }; },
      isAxiosError: error => error.isAxiosError === true
    };`,
  );
  for (const name of ["uuid", "yargs", "inquirer"]) {
    const dependency = realpathSync(
      fileURLToPath(new URL(`../../node_modules/${name}`, import.meta.url)),
    );
    symlinkSync(dependency, join(modules, name), "junction");
  }
  copyFileSync(
    fileURLToPath(new URL("../../dist/scripts/setup.js", import.meta.url)),
    join(cwd, "setup.js"),
  );
  const password = "fixture-password-only";
  const result = spawnSync(
    process.execPath,
    [
      join(cwd, "setup.js"),
      "--auto",
      "--username",
      "fixture-account-only",
      "--password",
      password,
      "--area",
      "US",
      "--mqtt-url",
      "mqtt://fixture.invalid",
    ],
    { cwd, encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /ERR_BAD_RESPONSE/);
  assert.match(output, /502/);
  for (const secret of [
    "PRIVATE_LOGIN_FIXTURE",
    "fixture-account-only",
    password,
    createHash("md5").update(password).digest("hex"),
  ]) {
    assert.ok(!output.includes(secret), "Setup leaked private authentication material");
  }
  assert.ok(!readdirSync(cwd).includes(".env"));
});

test("setup paginates device discovery past the 30-device default limit with signed query params", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "aqara-setup-pagination-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  const modules = join(cwd, "node_modules");
  mkdirSync(join(modules, "axios"), { recursive: true });
  writeFileSync(join(modules, "axios/package.json"), '{"type":"module","main":"index.js"}');
  writeFileSync(
    join(modules, "axios/index.js"),
    `import crypto from "node:crypto";
    const devices = Array.from({ length: 35 }, (_, i) => ({
      did: "lumi.dev." + i,
      model: i === 33 ? "lumi.camera.acn005" : "lumi.sensor_ht.agl02",
      deviceName: "Dev " + i,
    }));
    export default {
      post: async () => ({
        status: 200,
        statusText: "OK",
        data: { code: 0, result: { token: "tok-123", userId: "uid-456" } },
      }),
      get: async (url, config) => {
        const parsed = new URL(url);
        const query = parsed.search.slice(1);
        const expectedSign = crypto
          .createHash("md5")
          .update(
            "Appid=444c476ef7135e53330f46e7&Nonce=" +
              config.headers.Nonce +
              "&Time=" +
              config.headers.Time +
              "&Token=tok-123&" +
              query +
              "&uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi",
          )
          .digest("hex");
        if (config.headers.Sign !== expectedSign) {
          return { data: { code: 106, message: "bad sign" } };
        }
        const startIndex = Number(parsed.searchParams.get("startIndex") || 0);
        const batch = devices.slice(startIndex, startIndex + 30);
        return {
          data: { code: 0, result: { count: devices.length, devices: batch } },
        };
      },
      isAxiosError: (error) => error?.isAxiosError === true,
    };`,
  );
  for (const name of ["uuid", "yargs", "inquirer"]) {
    const dependency = realpathSync(
      fileURLToPath(new URL(`../../node_modules/${name}`, import.meta.url)),
    );
    symlinkSync(dependency, join(modules, name), "junction");
  }
  copyFileSync(
    fileURLToPath(new URL("../../dist/scripts/setup.js", import.meta.url)),
    join(cwd, "setup.js"),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(cwd, "setup.js"),
      "--auto",
      "--username",
      "fixture-account",
      "--password",
      "fixture-password",
      "--area",
      "US",
      "--mqtt-url",
      "mqtt://fixture.invalid",
    ],
    { cwd, encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Total devices in account: 35/);
  assert.match(result.stdout, /Found 1 camera\(s\)/);
  assert.ok(readdirSync(cwd).includes(".env"));
});
