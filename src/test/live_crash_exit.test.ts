/**
 * Live server crash path (`src/test/live_crash_exit.test.ts`).
 *
 * A crashing server must not look like a clean stop: the log keeps the full
 * stack and the process exits non-zero.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { resolveLivePaths } from "../live/live_paths.js";
import { rmRetrySync } from "./fs_cleanup.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-crash-"));

test.after(() => rmRetrySync(ROOT));

function waitForExit(child: { exitCode: number | null; on: (e: string, l: () => void) => void }, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("server child did not exit in time"));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

test("live server crash: injected throw exits non-zero with the stack in the log", { timeout: 60000 }, async () => {
  const dir = path.join(ROOT, "crash_ws");
  rmRetrySync(dir);
  initWorkspace({ dir, title: "crash", aspect: "16:9", fps: 30 });
  const lp = resolveLivePaths(dir);
  const child = spawn(process.execPath, [CLI, "live", "serve", "--dir", dir], {
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1", CUTHOL_LIVE_CRASH_TEST: "throw" },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const code = await waitForExit(child, 30000);
    assert.notEqual(code, 0, `crashed server must exit non-zero (got ${code})`);
  } finally {
    try {
      child.kill();
    } catch {
      // already exited
    }
  }
  const log = fs.readFileSync(lp.logFile, "utf8");
  assert.ok(log.includes("CUTHOL_LIVE_CRASH_TEST injected crash"), `log must name the crash, got:\n${log.slice(-500)}`);
  assert.ok(log.includes("at "), `log must carry the stack (an "at " frame), got:\n${log.slice(-500)}`);
});
