import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
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
