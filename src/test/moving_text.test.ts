/**
 * Moving text cues: a text cue whose placement animates (base envelope or motion
 * layer envelope with points) renders on its own transparent full-stage layer with
 * neutral placement, positioned per frame by the footage-cue placement chain.
 * Static text cues keep the shared direct burn, byte for byte.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addLaneCue } from "../sequence/lanes.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-movingtext-"));

test.after(() => rmRetrySync(TMP));

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 120_000 });
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
    assert.fail(`ffmpeg timed out after 120 s: ffmpeg ${args.slice(0, 6).join(" ")}…`);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeSolidBg(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=#3A5A8C:s=1280x720:r=30:d=5",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/** Flat-backdrop project with one title cue at cue-local 0..durationMs. */
function makeProject(wsDir: string, durationMs = 3000): { cueId: string } {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "movingtext", aspect: "16:9", fps: 30 });
  const bg = path.join(TMP, "bg.mp4");
  makeSolidBg(bg);
  const staged = path.join(wsDir, "bg.mp4");
  fs.copyFileSync(bg, staged);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [staged] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 5000 });
  const cueId = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 0, durationMs, fontSizePx: 72,
    colorHex: "#FFFFFF", text: "MOVING WORDS HERE",
  }).cue.id;
  return { cueId };
}

function setEnvelopes(wsDir: string, cueId: string, envelopes: unknown[]): void {
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) (cue as unknown as { envelopes: unknown[] }).envelopes = envelopes as never[];
    }
  });
}

function xEnvelope(from: number, to: number, durationMs: number): unknown {
  return {
    parameter: "placement.x_pct",
    points: [
      { offset_ms: 0, value: from, easing: "linear" },
      { offset_ms: durationMs, value: to, easing: "linear" },
    ],
  };
}

function renderRaw(wsDir: string, outName: string, preset: "draft_480p" | "master_1080p"): { buf: Buffer; w: number; h: number } {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, preset);
  const outPath = path.join(wsDir, "out", outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const script = `${outPath}.graph.txt`;
  fs.writeFileSync(script, plan.filterComplex, "utf8");
  ffmpeg(
    [
      "-y", "-v", "error",
      ...plan.inputArgs,
      "-/filter_complex", script,
      "-map", plan.videoOutPad, "-f", "rawvideo", "-pix_fmt", "yuv420p", outPath,
      "-map", plan.audioOutPad, "-f", "null", "-",
    ],
    paths.rootDir
  );
  const buf = fs.readFileSync(outPath);
  return { buf, w: plan.renderWidth, h: plan.renderHeight };
}

function lumaFrame(r: { buf: Buffer; w: number; h: number }, n: number): Buffer {
  const size = r.w * r.h;
  const frameSize = Math.round((size * 3) / 2);
  return r.buf.subarray(n * frameSize, n * frameSize + size);
}

/** Backdrop luma sampled from the frame corner (flat solid source). */
function bgLuma(f: Buffer, w: number): number {
  return f[2 * w + 2];
}

/** Ink box: bbox of luma pixels differing from the backdrop by more than the threshold. */
function inkBox(f: Buffer, w: number, h: number, bg: number, thresh = 24): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(f[y * w + x] - bg) > thresh) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 };
}

const inkCentreX = (b: { x0: number; x1: number }): number => (b.x0 + b.x1) / 2;

test("moving text: x envelope -30..30 moves the ink centre by the expected pixels", () => {
  const wsDir = path.join(TMP, "ws_xmove");
  const { cueId } = makeProject(wsDir);
  setEnvelopes(wsDir, cueId, [xEnvelope(-30, 30, 3000)]);
  const r = renderRaw(wsDir, "xmove.yuv", "draft_480p");
  // Cue-local 100 ms -> frame 3, cue-local 2800 ms -> frame 84.
  const early = lumaFrame(r, 3);
  const late = lumaFrame(r, 84);
  const bg = bgLuma(lumaFrame(r, 0), r.w);
  const boxEarly = inkBox(early, r.w, r.h, bg);
  const boxLate = inkBox(late, r.w, r.h, bg);
  assert.ok(boxEarly && boxLate, "ink box must be measurable in both frames");
  const xAt = (localMs: number): number => -30 + (60 * localMs) / 3000;
  const expectedEarly = r.w / 2 + (xAt(100) / 100) * r.w;
  const expectedLate = r.w / 2 + (xAt(2800) / 100) * r.w;
  const gotEarly = inkCentreX(boxEarly);
  const gotLate = inkCentreX(boxLate);
  console.log(`xmove draft: w=${r.w} early centre=${gotEarly.toFixed(1)} (expected ${expectedEarly.toFixed(1)}), late centre=${gotLate.toFixed(1)} (expected ${expectedLate.toFixed(1)})`);
  assert.ok(Math.abs(gotEarly - expectedEarly) <= 3, `early centre ${gotEarly} far from ${expectedEarly}`);
  assert.ok(Math.abs(gotLate - expectedLate) <= 3, `late centre ${gotLate} far from ${expectedLate}`);
  assert.ok(gotLate - gotEarly > 0.4 * r.w, "text must travel with the envelope");
});

function scaleEnvelope(from: number, to: number, durationMs: number): unknown {
  const mk = (parameter: string): unknown => ({
    parameter,
    points: [
      { offset_ms: 0, value: from, easing: "linear" },
      { offset_ms: durationMs, value: to, easing: "linear" },
    ],
  });
  return [mk("placement.scale_x"), mk("placement.scale_y")];
}

function opacityEnvelope(from: number, to: number, durationMs: number): unknown {
  return {
    parameter: "placement.opacity",
    points: [
      { offset_ms: 0, value: from, easing: "linear" },
      { offset_ms: durationMs, value: to, easing: "linear" },
    ],
  };
}

function inkWidth(b: { x0: number; x1: number }): number {
  return b.x1 - b.x0 + 1;
}

function maxDelta(f: Buffer, w: number, h: number, bg: number): number {
  let m = 0;
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(f[i] - bg);
    if (d > m) m = d;
  }
  return m;
}

test("moving text: scale 1..1.3 grows the ink box, opacity 1..0.5 fades it (three instants)", () => {
  const wsDir = path.join(TMP, "ws_scaleop");
  const { cueId } = makeProject(wsDir);
  setEnvelopes(wsDir, cueId, [...(scaleEnvelope(1, 1.3, 3000) as unknown[]), opacityEnvelope(1, 0.5, 3000)]);
  const r = renderRaw(wsDir, "scaleop.yuv", "draft_480p");
  const bg = bgLuma(lumaFrame(r, 0), r.w);
  // Cue-local 100 ms, 1500 ms, 2800 ms.
  const frames = [3, 45, 84].map((n) => lumaFrame(r, n));
  const boxes = frames.map((f) => inkBox(f, r.w, r.h, bg));
  assert.ok(boxes.every(Boolean), "ink box must be measurable at all three instants");
  const widths = boxes.map((b) => inkWidth(b!));
  const scaleAt = (localMs: number): number => 1 + (0.3 * localMs) / 3000;
  const opAt = (localMs: number): number => 1 - (0.5 * localMs) / 3000;
  const locals = [100, 1500, 2800];
  console.log(`scaleop draft: widths=${widths.map((x) => x.toFixed(1)).join(",")} maxdeltas=${frames.map((f) => maxDelta(f, r.w, r.h, bg)).join(",")}`);
  for (let i = 1; i < 3; i++) {
    const want = scaleAt(locals[i]) / scaleAt(locals[0]);
    const got = widths[i] / widths[0];
    assert.ok(Math.abs(got - want) < 0.06, `ink width ratio ${got.toFixed(3)} far from ${want.toFixed(3)}`);
  }
  const deltas = frames.map((f) => maxDelta(f, r.w, r.h, bg));
  for (let i = 1; i < 3; i++) {
    const want = opAt(locals[i]) / opAt(locals[0]);
    const got = deltas[i] / deltas[0];
    assert.ok(Math.abs(got - want) < 0.12, `ink alpha ratio ${got.toFixed(3)} far from ${want.toFixed(3)}`);
  }
});

function constEnvelope(parameter: string, value: number, durationMs: number): unknown {
  return {
    parameter,
    points: [
      { offset_ms: 0, value, easing: "linear" },
      { offset_ms: durationMs, value, easing: "linear" },
    ],
  };
}

/** A static project and its constant-envelope twin must land the ink box within +-1 px. */
function checkNaturalPosition(kind: "title" | "caption-box" | "caption-words"): void {
  const mk = (wsDir: string, withEnvelope: boolean): void => {
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "natural", aspect: "16:9", fps: 30 });
    const bg = path.join(TMP, "bg.mp4");
    makeSolidBg(bg);
    const staged = path.join(wsDir, "bg.mp4");
    fs.copyFileSync(bg, staged);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [staged] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const isCaption = kind !== "title";
    const cueId = addLaneCue({
      workspaceDir: wsDir, laneId: "ln_t", kind: isCaption ? "caption" : "title",
      atMs: 0, durationMs: 3000, yPct: isCaption ? 32 : 0, fontSizePx: 64,
      colorHex: "#FFFFFF", text: isCaption ? "a caption line here" : "PLAIN TITLE",
    }).cue.id;
    updateSequenceInPlace(wsDir, (seq) => {
      for (const lane of seq.lanes) {
        const cue = lane.cues.find((c) => c.id === cueId);
        if (!cue?.typography) continue;
        if (kind === "caption-box") {
          cue.typography.box_color_hex = "#000000";
          cue.typography.box_opacity = 0.85;
        }
        if (kind === "caption-words") {
          cue.typography.active_word_color_hex = "#FFE080";
          cue.typography.words = [0, 1, 2, 3].map((i) => ({
            word: ["a", "caption", "line", "here"][i],
            sequence_start_ms: i * 500,
            sequence_end_ms: (i + 1) * 500,
            excised: false,
          })) as never;
        }
        if (withEnvelope) {
          cue.envelopes = [constEnvelope("placement.x_pct", 0, 3000)] as never;
        }
      }
    });
  };
  const a = path.join(TMP, `ws_nat_${kind}_static`);
  const b = path.join(TMP, `ws_nat_${kind}_const`);
  mk(a, false);
  mk(b, true);
  const ra = renderRaw(a, "nat.yuv", "draft_480p");
  const rb = renderRaw(b, "nat.yuv", "draft_480p");
  const n = 45;
  const fa = lumaFrame(ra, n);
  const fb = lumaFrame(rb, n);
  const bgA = bgLuma(fa, ra.w);
  const bgB = bgLuma(fb, rb.w);
  const boxA = inkBox(fa, ra.w, ra.h, bgA);
  const boxB = inkBox(fb, rb.w, rb.h, bgB);
  assert.ok(boxA && boxB, `${kind}: ink box must be measurable on both sides`);
  console.log(`natural ${kind}: static=[${boxA.x0},${boxA.x1},${boxA.y0},${boxA.y1}] const=[${boxB.x0},${boxB.x1},${boxB.y0},${boxB.y1}]`);
  for (const [k, va, vb] of [["x0", boxA.x0, boxB.x0], ["x1", boxA.x1, boxB.x1], ["y0", boxA.y0, boxB.y0], ["y1", boxA.y1, boxB.y1]] as const) {
    assert.ok(Math.abs(va - vb) <= 1, `${kind}: ink ${k} differs by more than 1 px (${va} vs ${vb})`);
  }
}

test("moving text: constant envelope lands where the same static cue lands (title, caption, boxed)", () => {
  checkNaturalPosition("title");
  checkNaturalPosition("caption-box");
  checkNaturalPosition("caption-words");
});

/** Mean edge transition width (px) along the middle row of the ink box: 10%..90% rise. */
function edgeWidthPx(f: Buffer, w: number, h: number, bg: number, y: number, x0: number, x1: number): number {
  const peak = maxDelta(f, w, h, bg);
  const lo = bg + 0.1 * (peak - bg) * Math.sign(peak - bg);
  const hi = bg + 0.9 * (peak - bg) * Math.sign(peak - bg);
  const row = (x: number): number => f[y * w + x];
  // Left edge: first crossing of lo then hi going right.
  let xLo = -1, xHi = -1;
  for (let x = x0; x <= x1; x++) {
    const v = row(x);
    if (xLo < 0 && (peak > bg ? v >= lo : v <= lo)) xLo = x;
    if (xLo >= 0 && (peak > bg ? v >= hi : v <= hi)) { xHi = x; break; }
  }
  return xLo >= 0 && xHi >= 0 ? xHi - xLo : NaN;
}

test("moving text: scaled-as-pixels softness vs a static cue at the same size", () => {
  const mk = (wsDir: string, staticScale: boolean): void => {
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "soft", aspect: "16:9", fps: 30 });
    const bg = path.join(TMP, "bg.mp4");
    makeSolidBg(bg);
    const staged = path.join(wsDir, "bg.mp4");
    fs.copyFileSync(bg, staged);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [staged] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const cueId = addLaneCue({
      workspaceDir: wsDir, laneId: "ln_t", kind: "title",
      atMs: 0, durationMs: 3000, fontSizePx: 64,
      colorHex: "#FFFFFF", text: "SHARPNESS PROBE",
    }).cue.id;
    updateSequenceInPlace(wsDir, (seq) => {
      for (const lane of seq.lanes) {
        const cue = lane.cues.find((c) => c.id === cueId);
        if (!cue) continue;
        if (staticScale) {
          cue.placement.scale_x = 1.3;
          cue.placement.scale_y = 1.3;
        } else {
          cue.envelopes = [constEnvelope("placement.scale_x", 1.3, 3000), constEnvelope("placement.scale_y", 1.3, 3000)] as never;
        }
      }
    });
  };
  const a = path.join(TMP, "ws_soft_static");
  const b = path.join(TMP, "ws_soft_moving");
  mk(a, true);
  mk(b, false);
  const ra = renderRaw(a, "soft.yuv", "draft_480p");
  const rb = renderRaw(b, "soft.yuv", "draft_480p");
  const fa = lumaFrame(ra, 45);
  const fb = lumaFrame(rb, 45);
  const boxA = inkBox(fa, ra.w, ra.h, bgLuma(fa, ra.w))!;
  const boxB = inkBox(fb, rb.w, rb.h, bgLuma(fb, rb.w))!;
  const yA = Math.round((boxA.y0 + boxA.y1) / 2);
  const yB = Math.round((boxB.y0 + boxB.y1) / 2);
  const eA = edgeWidthPx(fa, ra.w, ra.h, bgLuma(fa, ra.w), yA, boxA.x0, boxA.x1);
  const eB = edgeWidthPx(fb, rb.w, rb.h, bgLuma(fb, rb.w), yB, boxB.x0, boxB.x1);
  console.log(`softness draft: static edge=${eA}px moving edge=${eB}px (scale 1.3, same size)`);
  assert.ok(Number.isFinite(eA) && Number.isFinite(eB), "edges must be measurable on both sides");
});

test("moving text: static cues keep the shared burn (point-less envelope changes nothing)", () => {
  const wsDir = path.join(TMP, "ws_staticplan");
  const { cueId } = makeProject(wsDir);
  const planOf = (): string => {
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    const assContents = Object.fromEntries(
      plan.assFilePaths.map((f) => [path.basename(f), fs.readFileSync(f, "utf8")])
    );
    // Blob file names hash the lane (including its envelopes): normalize them, the contents
    // and the graph must be identical.
    return JSON.stringify({ plan, assContents }).replace(/typography_r\d+_[a-z0-9_]+_[0-9a-f]{8}\.ass/g, "TYPOGRAPHY.ass");
  };
  const before = planOf();
  assert.ok(!before.includes("_fx_"), "static cue must not take its own layer");
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) cue.envelopes = [{ parameter: "placement.x_pct", points: [] }] as never;
    }
  });
  assert.equal(planOf(), before, "point-less envelope must not change the plan");
});

test("moving text: a motion layer envelope routes the cue to its own layer", () => {
  // Layers are not combined yet (the resolver returns the base): the path is proved with
  // base envelopes elsewhere. Here only the routing is proved: a motion envelope with
  // points takes the moving path, a disabled one stays in the shared burn.
  const wsDir = path.join(TMP, "ws_molayer");
  const { cueId } = makeProject(wsDir);
  const planOf = (): string => {
    const { sequence, paths } = loadSequence(wsDir);
    return compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex;
  };
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) cue.fx = [{ id: "mo_01", kind: "motion", params: { x_pct: 0 } }] as never;
    }
  });
  assert.ok(!planOf().includes(`[v_txtfx_${cueId}]`), "motion entry without envelope stays shared");
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) {
        cue.fx = [{ id: "mo_01", kind: "motion", params: { x_pct: 0 } }] as never;
        cue.envelopes = [{
          parameter: "fx.mo_01.x_pct",
          points: [
            { offset_ms: 0, value: -10, easing: "linear" },
            { offset_ms: 3000, value: 10, easing: "linear" },
          ],
        }] as never;
      }
    }
  });
  assert.ok(planOf().includes(`[v_txtfx_${cueId}]`), "motion envelope with points takes the moving layer");
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) cue.fx = [{ id: "mo_01", kind: "motion", enabled: false, params: { x_pct: 0 } }] as never;
    }
  });
  assert.ok(!planOf().includes(`[v_txtfx_${cueId}]`), "disabled motion entry stays shared");
});

test("moving text: pixel fx and motion together render and the ink travels", () => {
  const wsDir = path.join(TMP, "ws_fxmove");
  const { cueId } = makeProject(wsDir);
  setEnvelopes(wsDir, cueId, [xEnvelope(-30, 30, 3000)]);
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) cue.fx = [{ id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } }] as never;
    }
  });
  const r = renderRaw(wsDir, "fxmove.yuv", "draft_480p");
  const bg = bgLuma(lumaFrame(r, 0), r.w);
  const boxEarly = inkBox(lumaFrame(r, 3), r.w, r.h, bg);
  const boxLate = inkBox(lumaFrame(r, 84), r.w, r.h, bg);
  assert.ok(boxEarly && boxLate, "ink box must be measurable with fx and motion");
  console.log(`fxmove draft: early=${inkCentreX(boxEarly).toFixed(1)} late=${inkCentreX(boxLate).toFixed(1)}`);
  assert.ok(boxLate.x0 - boxEarly.x0 > 0.4 * r.w, "fx text must travel with the envelope");
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  assert.ok(plan.filterComplex.includes("colorchannelmixer=aa=") === false, "opacity untouched without envelope");
  assert.ok(plan.filterComplex.includes(`[v_txtfx_${cueId}]`), "fx+moving text keeps its own layer");
});

/** Split a plan's flat inputArgs into one group per `-i` input. */
function planInputGroups(plan: { inputArgs: string[] }): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  const args = plan.inputArgs;
  for (let i = 0; i < args.length; i++) {
    cur.push(args[i]);
    if (args[i] === "-i") {
      cur.push(args[++i]);
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

function assertNoUnboundedInput(plan: { inputArgs: string[]; fps: number }): void {
  for (const g of planInputGroups(plan)) {
    const src = g[g.indexOf("-i") + 1] ?? "";
    const isLavfi = g.includes("lavfi");
    if (isLavfi) assert.ok(src.includes("d="), `lavfi input must carry d= (bounded): ${src}`);
    if (g.includes("-loop")) assert.ok(g.includes("-t"), `looped input must carry -t (bounded): ${src}`);
  }
}

test("moving text: own-layer canvas input is bounded (cue seconds + 2/fps)", () => {
  for (const [name, fx] of [["moving", true], ["fx", false]] as Array<[string, boolean]>) {
    const wsDir = path.join(TMP, `ws_canvas_${name}`);
    const { cueId } = makeProject(wsDir);
    if (fx) {
      setEnvelopes(wsDir, cueId, [xEnvelope(-30, 30, 3000)]);
    } else {
      updateSequenceInPlace(wsDir, (seq) => {
        for (const lane of seq.lanes) {
          const cue = lane.cues.find((c) => c.id === cueId);
          if (cue) cue.fx = [{ id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } }] as never;
        }
      });
    }
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    assert.ok(plan.filterComplex.includes(`[v_txtfx_${cueId}]`), `${name} cue must take its own layer`);
    const groups = planInputGroups(plan);
    const canvas = groups.find((g) => (g[g.indexOf("-i") + 1] ?? "").startsWith("color=c=black@0"));
    assert.ok(canvas, `${name} cue must have a canvas input`);
    const want = `:d=${(3000 / 1000 + 2 / plan.fps).toFixed(3)}`;
    assert.ok(canvas!.join(" ").includes(want), `${name} canvas must carry ${want}: ${canvas!.join(" ")}`);
    assertNoUnboundedInput(plan);
  }
});

function renderRawWindowed(
  wsDir: string,
  outName: string,
  preset: "draft_480p" | "master_1080p",
  win: [number, number]
): { buf: Buffer; w: number; h: number; fps: number } {
  const { sequence, paths } = loadSequence(wsDir);
  const fps = sequence.stage.fps;
  const wantFrames = Math.round(((win[1] - win[0]) / 1000) * fps);
  const plan = compileSequenceRenderPlan(sequence, paths, preset, {
    activeWindowMs: win,
    // The product's segment encodes bound the output with `-frames:v`,
    // so the windowed plan keeps `start=` but no `end=`.
    windowEndByFrameCount: true,
  });
  const outPath = path.join(wsDir, "out", outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const script = `${outPath}.graph.txt`;
  fs.writeFileSync(script, plan.filterComplex, "utf8");
  ffmpeg(
    [
      "-y", "-v", "error",
      ...plan.inputArgs,
      "-/filter_complex", script,
      "-map", plan.videoOutPad,
      "-frames:v", String(wantFrames),
      "-f", "rawvideo", "-pix_fmt", "yuv420p", outPath,
      "-map", plan.audioOutPad, "-f", "null", "-",
    ],
    paths.rootDir
  );
  const buf = fs.readFileSync(outPath);
  return { buf, w: plan.renderWidth, h: plan.renderHeight, fps };
}

test("moving text: text layers crossing a segment boundary match the full render", () => {
  const wsDir = path.join(TMP, "ws_segtext");
  const { cueId } = makeProject(wsDir);
  setEnvelopes(wsDir, cueId, [xEnvelope(-30, 30, 3000)]);
  const cue2 = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 0, durationMs: 2500, fontSizePx: 72,
    colorHex: "#FFFFFF", text: "SECOND WORDS HERE",
  }).cue.id;
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cue2);
      if (cue) cue.fx = [{ id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } }] as never;
    }
  });
  const full = renderRaw(wsDir, "seg_full.yuv", "draft_480p");
  const frameSize = Math.round((full.w * full.h * 3) / 2);
  assert.equal(full.buf.length % frameSize, 0, "full render must hold whole frames");
  const totalFrames = full.buf.length / frameSize;
  for (const win of [[1000, 2500], [0, 2000]] as Array<[number, number]>) {
    const part = renderRawWindowed(wsDir, `seg_${win[0]}_${win[1]}.yuv`, "draft_480p", win);
    const startFrame = Math.round((win[0] / 1000) * part.fps);
    const wantFrames = Math.round(((win[1] - win[0]) / 1000) * part.fps);
    assert.equal(part.buf.length, wantFrames * frameSize, `window [${win}] frame count`);
    assert.ok(startFrame + wantFrames <= totalFrames, `window [${win}] must sit inside the full render`);
    for (let k = 0; k < wantFrames; k++) {
      const a = full.buf.subarray((startFrame + k) * frameSize, (startFrame + k + 1) * frameSize);
      const b = part.buf.subarray(k * frameSize, (k + 1) * frameSize);
      assert.ok(a.equals(b), `window [${win}] frame ${k} (global ${startFrame + k}) differs from the full render`);
    }
    console.log(`window [${win}]: ${wantFrames} frames match the full render`);
  }
});
