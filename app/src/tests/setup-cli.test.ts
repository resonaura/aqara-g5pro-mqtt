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
