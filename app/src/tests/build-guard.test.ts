import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computeSourceHash, ensureNativeBinary, getNativeDir } from "../build-guard.js";

test("computeSourceHash calculates SHA-256 of C++ source files", () => {
  const nativeDir = getNativeDir();
  const hash = computeSourceHash(nativeDir);
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64);
});

test("ensureNativeBinary builds or verifies binary up-to-date", () => {
  const binPath = ensureNativeBinary();
  assert.equal(fs.existsSync(binPath), true);

  const hashFile = path.join(path.dirname(binPath), ".source_hash");
  assert.equal(fs.existsSync(hashFile), true);

  const hash = fs.readFileSync(hashFile, "utf8").trim();
  assert.equal(hash.length, 64);
});

function packagedFixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aqara-packaged-engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, "build");
  fs.mkdirSync(build);
  const binary = path.join(
    build,
    process.platform === "win32" ? "aqara-streamer.exe" : "aqara-streamer",
  );
  fs.writeFileSync(binary, "packaged fixture", { mode: 0o755 });
  fs.writeFileSync(path.join(build, ".source_hash"), "a".repeat(64));
  return { root, build, binary };
}

test("source-free release uses the packaged engine without starting CMake", (t) => {
  const { root, binary, build } = packagedFixture(t);
  assert.notEqual(computeSourceHash(root), "a".repeat(64));
  assert.equal(ensureNativeBinary(root), binary);
  assert.deepEqual(fs.readdirSync(build).sort(), [".source_hash", path.basename(binary)]);
});

test("source-free release fails clearly when its engine is missing", (t) => {
  const { root, binary } = packagedFixture(t);
  fs.unlinkSync(binary);
  assert.throws(() => ensureNativeBinary(root), /Packaged native engine is missing/);
});

test("source-free release rejects a missing or malformed build stamp", (t) => {
  const { root, build } = packagedFixture(t);
  fs.writeFileSync(path.join(build, ".source_hash"), "incomplete");
  assert.throws(() => ensureNativeBinary(root), /build stamp is invalid/);
  fs.unlinkSync(path.join(build, ".source_hash"));
  assert.throws(() => ensureNativeBinary(root), /Packaged native engine is missing/);
});

test(
  "source-free release rejects a non-executable engine",
  { skip: process.platform === "win32" },
  (t) => {
    const { root, binary } = packagedFixture(t);
    fs.chmodSync(binary, 0o644);
    assert.throws(() => ensureNativeBinary(root), /not executable/);
  },
);
