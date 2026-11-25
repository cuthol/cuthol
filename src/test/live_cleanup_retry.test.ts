/**
 * Live cleanup retry: a temp folder briefly held open by another process
 * (server child still exiting, indexer, antivirus) must not fail the test
 * run. `fs.rmSync` `maxRetries` does not retry a locked-file `EPERM` on
 * Windows, so cleanup lines use `rmRetrySync` from `./fs_cleanup.js`.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { rmRetrySync } from "./b_helpers.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOTS: string[] = [];
after(() => {
  for (const d of ROOTS) {
    try {
      rmRetrySync(d);
    } catch {}
  }
});

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

test("live cleanup: bare rmSync fails while a child holds the folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-clean-old-"));
  ROOTS.push(dir);
  const child = await holdDir(dir, 1200);
  try {
    assert.throws(
      () => fs.rmSync(dir, { recursive: true, force: true }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "EPERM" || (e as NodeJS.ErrnoException).code === "EBUSY",
      "expected the old bare cleanup line to fail on the locked folder"
    );
  } finally {
    await exited(child);
    rmRetrySync(dir);
  }
  assert.ok(!fs.existsSync(dir));
});

test("live cleanup: rmRetrySync removes a folder locked for ~500 ms", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-clean-new-"));
  ROOTS.push(dir);
  const child = await holdDir(dir, 500);
  try {
    rmRetrySync(dir);
  } finally {
    await exited(child);
    try {
      rmRetrySync(dir);
    } catch {}
  }
  assert.ok(!fs.existsSync(dir), "locked folder removed after the holder exited");
});
