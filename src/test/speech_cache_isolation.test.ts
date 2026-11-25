import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copySpeechCacheToTemp } from "./speech_cache_copy.js";

test("speech cache isolation helper copies a dir to temp and removes cleanly", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cache-src-"));
  fs.writeFileSync(path.join(src, "ledger.sqlite"), "fake-ledger-bytes");
  fs.mkdirSync(path.join(src, "blobs"));
  fs.writeFileSync(path.join(src, "blobs", "a.bin"), "fake-blob-bytes");
  const copy = copySpeechCacheToTemp(src);
  try {
    assert.notEqual(copy, src);
    assert.equal(fs.readFileSync(path.join(copy, "ledger.sqlite"), "utf8"), "fake-ledger-bytes");
    assert.equal(fs.readFileSync(path.join(copy, "blobs", "a.bin"), "utf8"), "fake-blob-bytes");
    // Mutating the copy leaves the shared source untouched.
    fs.writeFileSync(path.join(copy, "ledger.sqlite"), "mutated");
    assert.equal(fs.readFileSync(path.join(src, "ledger.sqlite"), "utf8"), "fake-ledger-bytes");
  } finally {
    rmRetrySync(copy);
  }
  assert.ok(!fs.existsSync(copy));
  rmRetrySync(src);
});
