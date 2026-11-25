/**
 * Product temp-folder cleanup (`src/test/fs_retry.test.ts`).
 *
 * `fs.rmSync` `maxRetries` does not retry a locked-file `EPERM` on Windows
 * (fails in ~1 ms against a file held open by another process), so product
 * cleanup lines use `rmRetrySync` from `../core/fs_retry.js` instead.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "../core/fs_retry.js";
import { rmRetrySync as rmTestRetrySync } from "./fs_cleanup.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fs-retry-"));

test.after(() => rmTestRetrySync(ROOT));

/** Spawn a child that sits with `cwd` inside `dir` for `ms` (Windows locks it). */
async function holdDir(dir: string, ms: number): Promise<ChildProcess> {
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  const child = spawn(process.execPath, ["-e", `setTimeout(()=>{}, ${ms})`], {
    cwd: dir,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((r) => setTimeout(r, 300));
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.on("exit", () => r());
  });
}

test("fs_retry: plain rmSync fails while a child holds the folder", async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "old-"));
  const child = await holdDir(dir, 1200);
  try {
    assert.throws(
      () => fs.rmSync(dir, { recursive: true, force: true }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "EPERM" || (e as NodeJS.ErrnoException).code === "EBUSY",
      "expected the old bare cleanup line to fail on the locked folder"
    );
  } finally {
    await exited(child);
    rmTestRetrySync(dir);
  }
  assert.ok(!fs.existsSync(dir));
});

test("fs_retry: helper removes a folder locked by a child for ~700 ms", async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "new-"));
  const child = await holdDir(dir, 700);
  try {
    rmRetrySync(dir);
  } finally {
    await exited(child);
    try {
      rmTestRetrySync(dir);
    } catch {}
  }
  assert.ok(!fs.existsSync(dir), "locked folder removed after the holder exited");
});
