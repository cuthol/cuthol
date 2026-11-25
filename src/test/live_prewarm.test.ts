/**
 * Live idle pre-production (B2, `src/test/live_prewarm.test.ts`): the playhead
 * endpoint, the prewarm window/disk-cap helpers, the scheduler's start/stop
 * decisions, and the `live.prewarm` switch on a small generated project with
 * one composition.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rmRetrySync } from "./b_helpers.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import { resolveLivePaths } from "../live/live_paths.js";
import {
  LivePrewarmer,
  PREWARM_IDLE_MS,
  prewarmOverCap,
  prewarmOverlayBytes,
  prewarmWindowFor,
  sweepPrewarmTemp,
} from "../live/live_prewarm.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-prewarm-"));
const DIRS: string[] = [];

function compHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="3">
  <div id="box" class="clip" data-start="0" data-duration="3" style="position:absolute;left:10px;top:10px;width:60px;height:60px;background:#ff0000;"></div>
</div>
<script src="assets/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to("#box", { x: 100, duration: 3, ease: "none" }, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
}

/** Workspace with one 3 s composition cue on a motion lane. */
function makeCompWorkspace(name: string): string {
  const dir = path.join(ROOT, name);
  rmRetrySync(dir);
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  const compDir = path.join(dir, "compositions", "card");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), compHtml(), "utf8");
  fs.writeFileSync(path.join(compDir, "assets/gsap.min.js"), "/* stub */", "utf8");
  addLaneCue({
    workspaceDir: dir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 3000,
    composition: { composition_dir: "compositions/card", entry_html: "index.html", props: {}, transparent: true },
  });
  DIRS.push(dir);
  return dir;
}

function httpRequest(
  port: number,
  reqPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test.after(() => {
  rmRetrySync(ROOT);
});

test("prewarm window is forward-heavy and clamped", () => {
  assert.deepEqual(prewarmWindowFor(20000, 60000), [10000, 50000]);
  assert.deepEqual(prewarmWindowFor(2000, 60000), [0, 32000]);
  assert.deepEqual(prewarmWindowFor(59000, 60000), [49000, 60000]);
  assert.ok(PREWARM_IDLE_MS >= 1000, "idle delay is seconds, not ms-scale");
});

test("disk cap trips on a tiny cap and counts only overlay blobs", () => {
  const dir = makeCompWorkspace("capws");
  const blobs = path.join(dir, ".cuthol", "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  fs.writeFileSync(path.join(blobs, "hf_comp_abc.mp4"), Buffer.alloc(10));
  fs.writeFileSync(path.join(blobs, "hf_frame_abc.png"), Buffer.alloc(100));
  assert.equal(prewarmOverlayBytes(dir), 10);
  assert.equal(prewarmOverCap(dir, 0.000000001), true);
  assert.equal(prewarmOverCap(dir, 2), false);
});

test("disk cap counts .pngseq dirs and starts no child over a tiny cap", () => {
  const dir = makeCompWorkspace("capws_seq");
  const blobs = path.join(dir, ".cuthol", "blobs");
  const seq = path.join(blobs, "hf_comp_abc.pngseq");
  fs.mkdirSync(seq, { recursive: true });
  fs.writeFileSync(path.join(seq, "f0001.png"), Buffer.alloc(10));
  fs.writeFileSync(path.join(seq, "f0002.png"), Buffer.alloc(10));
  assert.equal(prewarmOverlayBytes(dir), 20);
  assert.equal(prewarmOverCap(dir, 0.000000001), true);
  const log: string[] = [];
  const prewarmer = new LivePrewarmer(dir, (m) => log.push(m));
  const now = Date.now();
  const prevCap = process.env.CUTHOL_LIVE_PREWARM_CAP_GB;
  process.env.CUTHOL_LIVE_PREWARM_CAP_GB = "0.000000001";
  try {
    prewarmer.maybeStart(now, {
      revision: 1,
      progressJson: "null",
      playheadMs: 1000,
      durationMs: 3000,
      windowActiveAt: 0,
      lastChangeAt: 0,
      lastProgressAt: 0,
    });
  } finally {
    if (prevCap === undefined) delete process.env.CUTHOL_LIVE_PREWARM_CAP_GB;
    else process.env.CUTHOL_LIVE_PREWARM_CAP_GB = prevCap;
  }
  assert.equal(prewarmer.running(), false);
  assert.ok(log.some((m) => m.includes("prewarm skipped: overlay blobs exceed the")), `log says why: ${JSON.stringify(log)}`);
  assert.equal(fs.existsSync(seq), true);
});

test("sweep removes only the child's own tmp/stage, never finished blobs", () => {
  const dir = makeCompWorkspace("sweepws");
  const blobs = path.join(dir, ".cuthol", "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  const dead = 424242;
  fs.writeFileSync(path.join(blobs, `hf_comp_aaa.${dead}_1_x.tmp.mp4`), "x");
  fs.mkdirSync(path.join(blobs, `hf_stage_aaa_${dead}_1`));
  fs.writeFileSync(path.join(blobs, "hf_comp_aaa.mp4"), "finished");
  fs.writeFileSync(path.join(blobs, "hf_comp_bbb.999_1_y.tmp.mp4"), "other child");
  const log: string[] = [];
  sweepPrewarmTemp(dir, dead, (m) => log.push(m));
  assert.equal(fs.existsSync(path.join(blobs, "hf_comp_aaa.mp4")), true);
  assert.equal(fs.existsSync(path.join(blobs, "hf_comp_bbb.999_1_y.tmp.mp4")), true);
  assert.equal(fs.existsSync(path.join(blobs, `hf_comp_aaa.${dead}_1_x.tmp.mp4`)), false);
  assert.equal(fs.existsSync(path.join(blobs, `hf_stage_aaa_${dead}_1`)), false);
  assert.equal(log.length, 2);
});

test("scheduler stays quiet before the idle gap, stops on demand", () => {
  const dir = makeCompWorkspace("schedws");
  const log: string[] = [];
  const prewarmer = new LivePrewarmer(dir, (m) => log.push(m));
  const idle = { revision: 1, progressJson: "null", playheadMs: 1000, durationMs: 3000, windowActiveAt: 0, lastChangeAt: 0, lastProgressAt: 0 };
  // Fresh activity: no child.
  const now = Date.now();
  prewarmer.maybeStart(now, { ...idle, windowActiveAt: now, lastChangeAt: now, lastProgressAt: now });
  assert.equal(prewarmer.running(), false);
  // A running render (progress file): no child.
  prewarmer.maybeStart(now, { ...idle, windowActiveAt: 0, lastChangeAt: 0, lastProgressAt: now });
  assert.equal(prewarmer.running(), false);
  // Stop on an idle instance is a no-op.
  prewarmer.stop();
  assert.equal(prewarmer.running(), false);
});

test("playhead endpoint stores the playhead and leaves the snapshot unchanged", { timeout: 60000 }, async () => {
  const dir = makeCompWorkspace("serverws");
  const prevSettingsFile = process.env.CUTHOL_SETTINGS_FILE;
  process.env.CUTHOL_SETTINGS_FILE = path.join(ROOT, "user-settings.json");
  const info = await ensureLiveServer(dir);
  try {
    const snap = (p: string): Promise<{ status: number; body: string }> =>
      httpRequest(info.port, `${p}?t=${info.token}`, { headers: { Host: `127.0.0.1:${info.port}` } });
    const before = await snap("/api/snapshot");
    assert.equal(before.status, 200);
    const bad = await httpRequest(info.port, `/api/playhead?t=${info.token}`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${info.port}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${info.port}` },
      body: JSON.stringify({ ms: -5 }),
    });
    assert.equal(bad.status, 400);
    const ok = await httpRequest(info.port, `/api/playhead?t=${info.token}`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${info.port}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${info.port}` },
      body: JSON.stringify({ ms: 1500 }),
    });
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.body) as { ms: number }).ms, 1500);
    const after = await snap("/api/snapshot");
    assert.equal(after.status, 200);
    assert.equal(after.body, before.body);
    // The settings view carries the prewarm switch, on by default.
    const settings = await snap("/api/settings");
    assert.equal(settings.status, 200);
    const view = JSON.parse(settings.body) as { settings: Array<{ key: string; value: unknown }> };
    assert.equal(view.settings.find((s) => s.key === "live.prewarm")?.value, true);
    const off = await httpRequest(info.port, `/api/settings?t=${info.token}`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${info.port}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${info.port}` },
      body: JSON.stringify({ key: "live.prewarm", value: false }),
    });
    assert.equal(off.status, 200);
    const back = await snap("/api/settings");
    assert.equal((JSON.parse(back.body) as typeof view).settings.find((s) => s.key === "live.prewarm")?.value, false);
  } finally {
    await stopLiveServer(dir);
    try {
      fs.rmSync(path.join(ROOT, "user-settings.json"), { force: true });
    } catch {
      // never written
    }
    if (prevSettingsFile === undefined) delete process.env.CUTHOL_SETTINGS_FILE;
    else process.env.CUTHOL_SETTINGS_FILE = prevSettingsFile;
    try {
      const live = JSON.parse(fs.readFileSync(resolveLivePaths(dir).serverFile, "utf8")) as { pid: number };
      try {
        process.kill(live.pid, "SIGKILL");
      } catch {
        // already gone
      }
    } catch {
      // server file already removed
    }
  }
});
