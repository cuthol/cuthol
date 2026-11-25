/**
 * Live preview follow-ups (`src/test/live_preview_b1.test.ts`).
 *
 * The open window picks up compositions added outside (no reload), preloads
 * the next composition before its boundary, seeks compositions on first
 * open, and its watchdog reports + reloads a stuck preview. Browser checks
 * run against a small synthetic project built by the test itself (no
 * fixture); they skip with a reason when no headless Chrome is available.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
// @ts-ignore - plain JS UI module without types; resolved at runtime
import { applyDelta } from "../../src/live/ui/live_client.js";
import { resolveLiveComp } from "../live/live_comp_serve.js";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import { resolveLivePaths } from "../live/live_paths.js";
import { rmRetrySync, waitFor } from "./b_helpers.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "dist", "cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-b1-"));

function cli(dir: string, args: string[]): void {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    timeout: 120000,
  });
  assert.equal(proc.status, 0, `cli ${args.join(" ")} failed: ${(proc.stderr || proc.stdout).slice(0, 500)}`);
}

test("live b1: preview diagnostics G670-G676 exist with the documented shape", () => {
  const rows: Array<[string, () => { code: string; gate: string; severity: string; formatted: string }]> = [
    ["CUTHOL-G670", () => DIAGNOSTICS.LIVE_PREVIEW_RESYNCED("test")],
    ["CUTHOL-G671", () => DIAGNOSTICS.LIVE_PREVIEW_PRELOAD_DROPPED("cue_01", "test")],
    ["CUTHOL-G672", () => DIAGNOSTICS.LIVE_PREVIEW_INITIAL_SEEK()],
    ["CUTHOL-G673", () => DIAGNOSTICS.LIVE_PREVIEW_INCIDENT("no_frames", "cue_01")],
    ["CUTHOL-G674", () => DIAGNOSTICS.LIVE_PREVIEW_RELOADED("recovered")],
    ["CUTHOL-G675", () => DIAGNOSTICS.LIVE_PREVIEW_STILL_STUCK("cue_01")],
    ["CUTHOL-G676", () => DIAGNOSTICS.LIVE_PREVIEW_RELOAD_CAPPED("cue_01")],
  ];
  for (const [code, make] of rows) {
    const d = make();
    assert.equal(d.code, code);
    assert.match(d.formatted, new RegExp(`^\\[${code}\\] .+ \\| Suggestion: .+`));
  }
});

test("live b1: delta with a newly added composition cue applies to the client copy", () => {
  const state: Record<string, unknown> = { sequence: null, revision: 1, activity: [] };
  const store = {
    state,
    on: () => () => {},
    emit: () => {},
    set: (patch: Record<string, unknown>) => Object.assign(state, patch),
  };
  const sequence = {
    meta: { title: "t" },
    lanes: [
      { id: "ln_motion", muted: false, cues: [{ id: "cue_02", kind: "composition", composition: { composition_dir: "comps/c2" }, at_ms: 4000, duration_ms: 4000 }] },
    ],
    library: [],
  };
  applyDelta(store as never, {
    schema: "cuthol.live/1",
    from_revision: 2,
    revision: 3,
    entry: { revision: 3, timestamp: "t", operation: "lane.add", summary: "s", changed: ["cue_02"], actor: "agent" },
    paths: [],
    sequence,
    scenes: [],
    duration_ms: 8000,
  } as never);
  assert.equal(state.revision, 3);
  const cues = (state.sequence as { lanes: Array<{ cues: Array<{ id: string }> }> }).lanes[0].cues;
  assert.deepEqual(cues.map((c) => c.id), ["cue_02"]);
});

test("live b1: composition cue added after start resolves to its directory", () => {
  const dir = path.join(ROOT, "ws_comp_resolve");
  rmRetrySync(dir);
  initWorkspace({ dir, title: "resolve", aspect: "16:9", fps: 30 });
  // No composition cues yet: unknown ids do not resolve.
  assert.equal(resolveLiveComp(dir, "cue_99"), null);
  const compDir = path.join(dir, "comps", "c9");
  cli(dir, ["composition", "scaffold", "--comp-dir", "comps/c9"]);
  cli(dir, ["lane", "add-composition", "--comp-dir", "comps/c9", "--duration", "2000ms"]);
  const seq = loadSequence(dir).sequence as unknown as { lanes: Array<{ cues: Array<{ id: string }> }> };
  const cueId = seq.lanes.flatMap((l) => l.cues).find((c) => c.id.startsWith("cue_"))!.id;
  const resolved = resolveLiveComp(dir, cueId);
  assert.ok(resolved, "cue added after start resolves");
  assert.equal(resolved!.dir, compDir);
});

type PreviewState = {
  t: number;
  duration: number;
  comps: string[];
  preloads: string[];
  held: string[];
  frames: Array<{ id: string; loaded: boolean; visible: string }>;
  initialSeekDone: boolean;
  watchdog: null | { lastReason?: string; reloadedAt?: number; id?: string; stillStuck?: boolean; capped?: boolean };
  revisions: { seen: number | null; applied: number | null };
  notice: boolean;
};

async function chromePath(): Promise<string> {
  const { resolveCoordsChromePath } = await import("../compositor/coords_extract.js");
  return resolveCoordsChromePath();
}

async function openWindow(url: string): Promise<{ browser: never; page: never } | { browser: unknown; page: unknown }> {
  let puppeteer: { launch: (opts: Record<string, unknown>) => Promise<unknown> };
  try {
    puppeteer = (await import("puppeteer-core")).default as never;
  } catch {
    return { browser: null as never, page: null as never };
  }
  const executablePath = await chromePath().catch(() => "");
  if (!executablePath || !fs.existsSync(executablePath)) return { browser: null as never, page: null as never };
  const browser = (await (puppeteer.launch as (o: object) => Promise<unknown>)({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  })) as {
    newPage: () => Promise<unknown>;
    close: () => Promise<void>;
  };
  const page = (await browser.newPage()) as {
    setViewport: (v: object) => Promise<void>;
    goto: (u: string, o: object) => Promise<void>;
    waitForFunction: (f: () => unknown, o: object) => Promise<void>;
    evaluate: (f: (...a: never[]) => unknown, ...a: never[]) => Promise<never>;
    on: (ev: string, fn: (x: never) => void) => void;
    screenshot: (o: object) => Promise<void>;
  };
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => (window as unknown as { __livePreview: unknown }).__livePreview, { timeout: 30000 });
    await page.waitForFunction(
      () => ((window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state().duration ?? 0) > 0,
      { timeout: 30000 }
    );
  } catch (err) {
    // Never leave a headless browser behind: an open browser keeps the test process alive.
    await browser.close().catch(() => {});
    throw err;
  }
  return { browser: browser as never, page: page as never };
}

test("live b1: outside lane.add appears, boundary preloads, first frame seeks, watchdog reports", { timeout: 420000 }, async (t) => {
  let puppeteerOk = true;
  try {
    await import("puppeteer-core");
    await chromePath();
  } catch {
    puppeteerOk = false;
  }
  if (!puppeteerOk) {
    t.skip("headless chrome unavailable");
    return;
  }
  const dir = path.join(ROOT, "ws_b1_window");
  rmRetrySync(dir);
  initWorkspace({ dir, title: "b1win", aspect: "16:9", fps: 30 });
  cli(dir, ["composition", "scaffold", "--comp-dir", "comps/c1"]);
  cli(dir, ["composition", "scaffold", "--comp-dir", "comps/c2"]);
  cli(dir, ["lane", "add-composition", "--comp-dir", "comps/c1", "--duration", "4000ms"]);
  const info = await ensureLiveServer(dir);
  const url = `http://127.0.0.1:${info.port}/?t=${info.token}`;
  const opened = (await openWindow(url).catch(async (err) => {
    // An open Live server also keeps the process alive: stop it before failing.
    await stopLiveServer(dir).catch(() => {});
    throw err;
  })) as {
    browser: { close: () => Promise<void> } | null;
    page: {
      evaluate: (f: (...a: never[]) => unknown, ...a: never[]) => Promise<PreviewState>;
      on: (ev: string, fn: (x: { url: () => string; postData?: () => string }) => void) => void;
      screenshot: (o: object) => Promise<void>;
      waitForFunction: (f: (...a: never[]) => unknown, o: object, ...a: never[]) => Promise<void>;
    } | null;
  };
  if (!opened.page || !opened.browser) {
    await stopLiveServer(dir).catch(() => {});
    t.skip("headless chrome unavailable");
    return;
  }
  const { browser, page } = opened as { browser: { close: () => Promise<void> }; page: NonNullable<typeof opened.page> };
  const incidents: Array<{ url: string; body: string }> = [];
  page.on("request", (r) => {
    try {
      if (r.url().includes("/api/incident")) incidents.push({ url: r.url(), body: String(r.postData?.() ?? "").slice(0, 2000) });
    } catch {}
  });
  try {
    const s0 = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
    assert.deepEqual(s0.comps, ["cue_01"]);
    assert.equal(s0.initialSeekDone, true, "first frame sought on open");
    await page.evaluate(() => {
      (window as unknown as { __b1mark: number }).__b1mark = 1;
    });
    // Finding 1: add a composition from outside while the window is open.
    cli(dir, ["lane", "add-composition", "--comp-dir", "comps/c2", "--at", "4000ms", "--duration", "4000ms"]);
    // The new cue starts at 4 s, so it is not on screen at the playhead (0 s): first the window
    // must apply the new revision (duration grows), then a seek into the cue must show it.
    await waitFor(async () => {
      const s = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
      return s.duration === 8000 && s.revisions.seen === s.revisions.applied ? s : null;
    }, 30000, "outside lane.add applied without a reload");
    await page.evaluate(() => (window as unknown as { __livePreview: { seek: (ms: number) => void } }).__livePreview.seek(5000));
    const s1 = await waitFor(async () => {
      const s = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
      const f = s.frames.find((x) => x.id === "cue_02");
      return s.comps.includes("cue_02") && f?.loaded && f.visible === "visible" ? s : null;
    }, 30000, "outside composition appears without a reload");
    const mark = await page.evaluate(() => (window as unknown as { __b1mark?: number }).__b1mark);
    assert.equal(mark, 1, "window was not reloaded");
    assert.deepEqual(s1.revisions.seen, s1.revisions.applied);
    // Finding 2: preload the next composition while playing toward the boundary.
    const tSeekPlay = Date.now();
    await page.evaluate(() => (window as unknown as { __livePreview: { seek: (ms: number) => void } }).__livePreview.seek(2500));
    await page.evaluate(() => (window as unknown as { __livePreview: { play: () => void } }).__livePreview.play());
    const s2 = await waitFor(async () => {
      const s = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
      return s.preloads.includes("cue_02") ? s : null;
    }, 30000, "next composition preloaded ahead of the boundary");
    const tPreloadSeen = Date.now();
    assert.ok(s2.preloads.includes("cue_02"));
    // Play across the boundary; the new frame must be visible, never the backdrop.
    // The frame's first paint can lag the playhead under load, so wait for the
    // asserted event itself (frame loaded and visible past the boundary),
    // not for the playhead time alone.
    const crossed = await waitFor(async () => {
      const s = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
      const f = s.frames.find((x) => x.id === "cue_02");
      return s.t > 4200 && s.comps.includes("cue_02") && f?.loaded && f.visible === "visible" ? s : null;
    }, 30000, "cue_02 frame up after the boundary");
    const vis = crossed.frames.find((f) => f.id === "cue_02");
    const tFrameUp = Date.now();
    console.log(`b1 preload timings: seek+play=${tSeekPlay} preload_seen=+${tPreloadSeen - tSeekPlay}ms frame_up=+${tFrameUp - tSeekPlay}ms post_boundary_lag=+${tFrameUp - tPreloadSeen}ms`);
    assert.ok(vis && vis.loaded && vis.visible === "visible", `cue_02 frame up after the boundary: ${JSON.stringify(crossed.frames)}`);
    await page.screenshot({ path: path.join(ROOT, "b1_boundary.png") });
    // Finding 4: force a stuck clock (drop the timeline registry in the visible iframe).
    // Pause inside cue_02 first: playing on would run off the 8 s timeline, where no
    // composition is visible and there is nothing to watch.
    await page.evaluate(() => {
      const lp = (window as unknown as { __livePreview: { pause: () => void; seek: (ms: number) => void } }).__livePreview;
      lp.pause();
      lp.seek(5000);
    });
    await waitFor(async () => {
      const s = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
      const f = s.frames.find((x) => x.id === "cue_02");
      return f?.loaded && f.visible === "visible" ? s : null;
    }, 30000, "cue_02 visible before the stuck clock");
    await page.evaluate(() => {
      for (const frame of Array.from(document.querySelectorAll(".pv-comp-frame")) as HTMLIFrameElement[]) {
        if (getComputedStyle(frame).visibility !== "visible" || !frame.contentWindow) continue;
        (frame.contentWindow as unknown as { __timelines: unknown }).__timelines = {};
      }
    });
    const wd = await waitFor(async () => {
      const s = await page.evaluate(() => (window as unknown as { __livePreview: { state: () => PreviewState } }).__livePreview.state());
      return s.watchdog ? s : null;
    }, 60000, "watchdog fires on the stuck preview");
    assert.ok(wd.watchdog, "watchdog reported");
    await waitFor(() => (incidents.some((i) => i.body.includes("reloaded_preview")) ? true : null), 30000, "incident POST observed");
    const first = JSON.parse(incidents.find((i) => i.body.includes("reloaded_preview"))!.body) as { id: string; reason: string; action: string };
    assert.equal(first.action, "reloaded_preview");
    assert.ok(["no_frames", "clock_stalled", "load_failed", "revision_behind"].includes(first.reason), first.reason);
    await waitFor(() => (incidents.some((i) => i.body.includes("outcome")) ? true : null), 30000, "outcome POST observed");
    const outcome = JSON.parse(incidents.find((i) => i.body.includes("outcome"))!.body) as { id: string; outcome: string };
    assert.equal(outcome.id, first.id, "outcome reuses the incident id");
    assert.ok(["recovered", "still_stuck"].includes(outcome.outcome));
    await page.screenshot({ path: path.join(ROOT, "b1_watchdog.png") });
  } finally {
    await browser.close().catch(() => {});
    await stopLiveServer(dir).catch(() => {});
    try {
      rmRetrySync(path.join(dir, ".cuthol", "live"));
    } catch {}
  }
});
