/**
 * A stop keeps finished overlays (`src/test/live_prewarm_stop_keeps.test.ts`):
 * the sequential collector runner finalizes each overlay right after its own
 * capture, so killing the process mid-batch loses at most the capture in
 * flight. Fake jobs stand in for HyperFrames captures (same tmp + rename
 * contract); the sort case covers nearest-to-playhead-first ordering.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginOverlayCollect,
  overlayCollector,
  runCollectedOverlaysSequential,
  sortCollectedOverlays,
} from "../compositor/hf_overlay_tracking.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CUTHOL_STALL_TIMEOUT_SEC = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-prewarm-stop-"));
const DIST_URL =
  "file://" + path.resolve(process.cwd(), "dist", "compositor", "hf_overlay_tracking.js").replace(/\\/g, "/");

test.after(() => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
      return;
    } catch {
      // A just-killed capture may still hold a lock; retry briefly.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  rmRetrySync(ROOT);
});

test("collected overlays sort nearest-to-playhead first, forward before backward", () => {
  beginOverlayCollect();
  const jobs = overlayCollector as unknown as Array<{
    outBlob: string;
    compositionDir: string;
    absCompDir: string;
  }>;
  // Compile order: far-forward, backward, near-forward.
  jobs.push(
    { outBlob: "f2.mp4", compositionDir: "c2", absCompDir: path.resolve(ROOT, "c2") },
    { outBlob: "b1.mp4", compositionDir: "c1", absCompDir: path.resolve(ROOT, "c1") },
    { outBlob: "f1.mp4", compositionDir: "c0", absCompDir: path.resolve(ROOT, "c0") }
  );
  const cueStart = new Map([
    [path.resolve(ROOT, "c2"), 9000],
    [path.resolve(ROOT, "c1"), 4000],
    [path.resolve(ROOT, "c0"), 6000],
  ]);
  const playhead = 5000;
  sortCollectedOverlays((job) => {
    const start = cueStart.get(path.resolve(job.absCompDir))!;
    return Math.abs(start - playhead) * 2 + (start < playhead ? 1 : 0);
  });
  // c0 (+1000 fwd) < c1 (-1000 back) < c2 (+4000 fwd).
  assert.deepEqual(jobs.map((j) => j.outBlob), ["f1.mp4", "b1.mp4", "f2.mp4"]);
});

test("killing the batch mid-capture keeps the finished overlay", { timeout: 120000 }, async () => {
  const dir = path.join(ROOT, "batch");
  const blobs = path.join(dir, "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  const tmp1 = path.join(blobs, `hf_comp_aaa.${process.pid}_1.tmp.mp4`);
  const out1 = path.join(blobs, "hf_comp_aaa.mp4");
  const tmp2 = path.join(blobs, `hf_comp_bbb.${process.pid}_2.tmp.mp4`);
  const out2 = path.join(blobs, "hf_comp_bbb.mp4");
  const helper = path.join(dir, "helper.mjs");
  fs.writeFileSync(
    helper,
    `import fs from "node:fs";
import { beginOverlayCollect, runCollectedOverlaysSequential, sortCollectedOverlays } from ${JSON.stringify(DIST_URL)};
const blobs = ${JSON.stringify(blobs)};
const tmp1 = ${JSON.stringify(tmp1)};
const out1 = ${JSON.stringify(out1)};
const tmp2 = ${JSON.stringify(tmp2)};
const out2 = ${JSON.stringify(out2)};
function fakeJob(tmp, out, script) {
  return {
    compName: out, compositionDir: "comp", absCompDir: "comp",
    outBlob: out, tmpBlob: tmp, watchTargetPath: tmp, expectedFrames: undefined,
    args: ["-e", script], fallbackNoGpuArgs: null, wantGpu: false, workers: 1,
    stageDirToClean: null,
    finalizeSuccess: () => {
      fs.renameSync(tmp, out);
      fs.writeFileSync(out + ".meta.json", JSON.stringify({ finished: true }));
    },
    cleanupTemp: () => {},
  };
}
beginOverlayCollect();
const { overlayCollector } = await import(${JSON.stringify(DIST_URL)});
overlayCollector.push(
  fakeJob(tmp1, out1, "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(tmp1) + ", Buffer.alloc(2000, 65));"),
  fakeJob(tmp2, out2, "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(tmp2) + ", Buffer.alloc(2000, 66)); await new Promise((r) => setTimeout(r, 30000));")
);
sortCollectedOverlays(() => 0);
runCollectedOverlaysSequential({ workers: 1 });
process.stdout.write("batch done\\n");
`,
    "utf8"
  );
  const child = spawn(process.execPath, [helper], {
    cwd: dir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1", CUTHOL_STALL_TIMEOUT_SEC: "0" },
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  try {
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 30000) {
      if (fs.existsSync(out1) && fs.existsSync(tmp2)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true, `first overlay never finalized before the kill (stderr: ${stderr.slice(-500)})`);
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    } else {
      child.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    // The finished overlay survives as a final blob; the in-flight one never does.
    assert.equal(fs.existsSync(out1), true, "finished overlay lost after the stop");
    assert.equal(fs.existsSync(out1 + ".meta.json"), true, "finished overlay meta lost after the stop");
    assert.equal(fs.existsSync(out2), false, "in-flight capture must not appear as a final blob");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});
