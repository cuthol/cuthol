/**
 * Windowed renders bounded by frame count: when the caller bounds the output
 * with its own `-frames:v`, the final video trim keeps `start=` (frames before
 * the window are still dropped) but no longer ends the stream with `end=`.
 * Without the option today's trim is kept. New plan output (encoder-free,
 * `-frames:v N`) matches the same window's frames of the full render; the old
 * plan (with `end=`) is never executed by this file.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-wintrim-"));

test.after(() => rmRetrySync(TMP));

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 300_000 });
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
    assert.fail(`ffmpeg timed out after 300 s: ffmpeg ${args.slice(0, 6).join(" ")}…`);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeFootage(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=5,eq=saturation=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function makeStill(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x4A6A9C:s=640x360",
    "-frames:v", "1", outPath,
  ]);
}

/** Project: footage spine, a moving text cue, an fx text cue, a still image cue and a caption. */
function makeProject(wsDir: string): { movingId: string; fxId: string } {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "wintrim", aspect: "16:9", fps: 30 });
  const bg = path.join(TMP, "bg.mp4");
  makeFootage(bg);
  const still = path.join(TMP, "still.png");
  makeStill(still);
  const stagedBg = path.join(wsDir, "bg.mp4");
  const stagedStill = path.join(wsDir, "still.png");
  fs.copyFileSync(bg, stagedBg);
  fs.copyFileSync(still, stagedStill);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [stagedBg, stagedStill] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  const movingId = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 0, durationMs: 3000, fontSizePx: 72,
    colorHex: "#FFFFFF", text: "MOVING WORDS HERE",
  }).cue.id;
  const fxId = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 500, durationMs: 2500, fontSizePx: 72,
    colorHex: "#FFFFFF", text: "FX WORDS HERE",
  }).cue.id;
  addLaneCue({
    workspaceDir: wsDir, laneId: "ln_broll", kind: "broll",
    assetHandle: "img_01", atMs: 2500, durationMs: 1000,
  });
  addLaneCue({
    workspaceDir: wsDir, laneId: "ln_caps", kind: "caption",
    atMs: 0, durationMs: 3000, fontSizePx: 48,
    colorHex: "#FFFFFF", text: "a caption line here",
  }).cue.id;
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (cue.id === movingId) {
          (cue as unknown as { envelopes: unknown[] }).envelopes = [{
            parameter: "placement.x_pct",
            points: [
              { offset_ms: 0, value: -30, easing: "linear" },
              { offset_ms: 3000, value: 30, easing: "linear" },
            ],
          }] as never[];
        }
        if (cue.id === fxId) {
          cue.fx = [{ id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } }] as never;
        }
      }
    }
  });
  return { movingId, fxId };
}

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

/** Render a compiled window plan to raw frames; `frames` bounds the output like the product's `-frames:v`. */
function renderRawPlan(
  wsDir: string,
  outName: string,
  plan: { inputArgs: string[]; filterComplex: string; videoOutPad: string; audioOutPad: string },
  rootDir: string,
  frames?: number
): Buffer {
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
      ...(frames !== undefined ? ["-frames:v", String(frames)] : []),
      "-f", "rawvideo", "-pix_fmt", "yuv420p", outPath,
      "-map", plan.audioOutPad, "-f", "null", "-",
    ],
    rootDir
  );
  return fs.readFileSync(outPath);
}

function finalVideoTrim(graph: string): string | null {
  const m = /trim=start=[\d.]+(?::end=[\d.]+)?[^;]*\[vout\]/.exec(graph);
  return m ? m[0] : null;
}

const WINDOWS: Array<[number, number]> = [[0, 2000], [1000, 2500]];

test("windowed plan: frame-bound option drops only end=, default keeps it", () => {
  const wsDir = path.join(TMP, "ws_trimshape");
  makeProject(wsDir);
  const { sequence, paths } = loadSequence(wsDir);
  for (const win of WINDOWS) {
    const oldPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { activeWindowMs: win });
    const newPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      activeWindowMs: win, windowEndByFrameCount: true,
    });
    const oldTrim = finalVideoTrim(oldPlan.filterComplex);
    const newTrim = finalVideoTrim(newPlan.filterComplex);
    assert.ok(oldTrim && oldTrim.includes(":end="), `window [${win}] default plan must keep end=: ${oldTrim}`);
    assert.ok(newTrim && !newTrim.includes(":end="), `window [${win}] frame-bound plan must drop end=: ${newTrim}`);
    assert.ok(newTrim && newTrim.includes("trim=start="), `window [${win}] frame-bound plan must keep start=: ${newTrim}`);
  }
});

test("windowed plan: new output with -frames:v N matches the full render", () => {
  const wsDir = path.join(TMP, "ws_parity");
  makeProject(wsDir);
  const { sequence, paths } = loadSequence(wsDir);
  const fullPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const full = renderRawPlan(wsDir, "parity_full.yuv", fullPlan, paths.rootDir);
  const frameSize = Math.round((fullPlan.renderWidth * fullPlan.renderHeight * 3) / 2);
  assert.equal(full.length % frameSize, 0, "full render must hold whole frames");
  const totalFrames = full.length / frameSize;
  const fps = sequence.stage.fps;
  for (const win of WINDOWS) {
    const newPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      activeWindowMs: win, windowEndByFrameCount: true,
    });
    assert.equal(fullPlan.renderWidth, newPlan.renderWidth);
    assert.equal(fullPlan.renderHeight, newPlan.renderHeight);
    // The old windowed plan (with `end=`) is the graph shape that can deadlock
    // at close, so this test never runs it: the frame-bounded new output is
    // compared against the same window's frames of the full render instead.
    const wantFrames = Math.round(((win[1] - win[0]) / 1000) * fps);
    const part = renderRawPlan(wsDir, `new_${win[0]}_${win[1]}.yuv`, newPlan, paths.rootDir, wantFrames);
    const startFrame = Math.round((win[0] / 1000) * fps);
    assert.equal(part.length, wantFrames * frameSize, `window [${win}] frame count`);
    assert.ok(startFrame + wantFrames <= totalFrames, `window [${win}] must sit inside the full render`);
    for (let k = 0; k < wantFrames; k++) {
      const a = full.subarray((startFrame + k) * frameSize, (startFrame + k + 1) * frameSize);
      const b = part.subarray(k * frameSize, (k + 1) * frameSize);
      assert.ok(a.equals(b), `window [${win}] frame ${k} (global ${startFrame + k}) differs from the full render`);
    }
  }
});

test("full and windowed plans carry no unbounded input", () => {
  const wsDir = path.join(TMP, "ws_bounded");
  const { movingId } = makeProject(wsDir);
  const { sequence, paths } = loadSequence(wsDir);
  const plans = [
    compileSequenceRenderPlan(sequence, paths, "draft_480p"),
    ...WINDOWS.map((win) => compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      activeWindowMs: win, windowEndByFrameCount: true,
    })),
  ];
  assert.ok(plans[0].filterComplex.includes(`[v_txtfx_${movingId}]`), "moving cue must take its own layer");
  for (const plan of plans) {
    for (const g of planInputGroups(plan)) {
      const src = g[g.indexOf("-i") + 1] ?? "";
      if (g.includes("lavfi")) assert.ok(src.includes("d="), `lavfi input must carry d= (bounded): ${src}`);
      if (g.includes("-loop")) assert.ok(g.includes("-t"), `looped input must carry -t (bounded): ${src}`);
    }
  }
});

test("text layers crossing a window boundary match the full render", () => {
  const wsDir = path.join(TMP, "ws_segtext");
  makeProject(wsDir);
  const { sequence, paths } = loadSequence(wsDir);
  const fullPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const full = renderRawPlan(wsDir, "seg_full.yuv", fullPlan, paths.rootDir);
  const frameSize = Math.round((fullPlan.renderWidth * fullPlan.renderHeight * 3) / 2);
  assert.equal(full.length % frameSize, 0, "full render must hold whole frames");
  const totalFrames = full.length / frameSize;
  const fps = sequence.stage.fps;
  for (const win of WINDOWS) {
    const part = renderRawPlan(
      wsDir, `seg_${win[0]}_${win[1]}.yuv`,
      compileSequenceRenderPlan(sequence, paths, "draft_480p", {
        activeWindowMs: win, windowEndByFrameCount: true,
      }),
      paths.rootDir,
      Math.round(((win[1] - win[0]) / 1000) * fps)
    );
    const startFrame = Math.round((win[0] / 1000) * fps);
    const wantFrames = Math.round(((win[1] - win[0]) / 1000) * fps);
    assert.equal(part.length, wantFrames * frameSize, `window [${win}] frame count`);
    assert.ok(startFrame + wantFrames <= totalFrames, `window [${win}] must sit inside the full render`);
    for (let k = 0; k < wantFrames; k++) {
      const a = full.subarray((startFrame + k) * frameSize, (startFrame + k + 1) * frameSize);
      const b = part.subarray(k * frameSize, (k + 1) * frameSize);
      assert.ok(a.equals(b), `window [${win}] frame ${k} (global ${startFrame + k}) differs from the full render`);
    }
  }
});
