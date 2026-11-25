/**
 * Spine overlay frame rule: spine clip overlays must use the same half-open
 * enable rule as lane cues (`gte(t,in)*lt(t,out)`), never the closed
 * `between(t,in,out)` which keeps both clips enabled on a frame that lands
 * exactly on a cut point.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { cueCoversTimeMs } from "../core/frame_time.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine_edit.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const FONT = "C:/Windows/Fonts/arial.ttf";

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
}

/** Solid colour source with the source frame number burned in. */
function makeNumberedSource(outPath: string, color: string, seconds: number, fps: number): void {
  ffmpeg([
    "-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=${fps}:d=${seconds}`,
    "-vf", `drawtext=fontfile=${FONT.replace(/:/g, "\\\\:")}:text='%{frame_num}':x=10:y=10:fontsize=24:fontcolor=white`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function spineEnables(wsDir: string): string[] {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { workers: 2 });
  const enables: string[] = [];
  const re = /enable='([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan.filterComplex)) !== null) enables.push(m[1]);
  return enables;
}

function renderAndClassify(
  wsDir: string,
  outName: string,
  probe: (corner: [number, number, number], n: number) => string
): { frames: string[]; width: number; height: number; count: number } {
  const res = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: `output/${outName}`,
    workers: 2,
    encoder: "libx264",
  });
  assert.equal(res.ok, true);
  const rawPath = path.join(wsDir, `${outName}.raw`);
  ffmpeg(["-i", res.output_path, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath]);
  const frameBytes = res.width * res.height * 3;
  const raw = fs.readFileSync(rawPath);
  const count = Math.floor(raw.length / frameBytes);
  const frames: string[] = [];
  for (let n = 0; n < count; n++) {
    // Corner pixel stays clear of the burned-in frame number.
    const o = n * frameBytes + 5 * res.width * 3 + 5 * 3;
    frames.push(probe([raw[o], raw[o + 1], raw[o + 2]], n));
  }
  fs.rmSync(rawPath, { force: true });
  return { frames, width: res.width, height: res.height, count };
}

function colorOf([r, g, b]: [number, number, number]): string {
  if (r > 150 && g < 110 && b < 110) return "red";
  if (g > 150 && r < 110 && b < 110) return "green";
  if (b > 150 && r < 110 && g < 110) return "blue";
  if (r < 60 && g < 60 && b < 60) return "backdrop";
  return `other(${r},${g},${b})`;
}

function setupThreeClip(wsDir: string, cuts: [number, number], fps: number): void {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "spine enable", aspect: "16:9", fps });
  makeNumberedSource(path.join(wsDir, "red.mp4"), "#FF0000", 4, 30);
  makeNumberedSource(path.join(wsDir, "green.mp4"), "#00FF00", 4, 30);
  makeNumberedSource(path.join(wsDir, "blue.mp4"), "#0000FF", 4, 30);
  ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [path.join(wsDir, "red.mp4"), path.join(wsDir, "green.mp4"), path.join(wsDir, "blue.mp4")],
  });
  let at = 0;
  const handles = ["vid_01", "vid_02", "vid_03"];
  for (let i = 0; i < 3; i++) {
    const dur = i < 2 ? cuts[i] - at : 6000 - at;
    appendSpineClip({ workspaceDir: wsDir, assetHandle: handles[i], sourceInMs: 0, sourceOutMs: dur });
    at = cuts[i];
  }
}

test("spine overlay enables use the half-open lane rule", () => {
  const wsDir = path.join(TEST_ROOT, "spine_enable_rule_plan");
  setupThreeClip(wsDir, [2000, 4000], 30);
  const enables = spineEnables(wsDir);
  assert.ok(enables.length >= 3, `expected >= 3 spine enables, got ${enables.length}`);
  for (const e of enables) {
    assert.ok(!e.includes("between(t,"), `spine enable must not use between(): ${e}`);
  }
  assert.ok(
    enables.some((e) => /^gte\(t,.+\)\*lt\(t,.+\)$/.test(e)),
    `expected half-open enables, got: ${enables.join(" | ")}`
  );
});

test("cuts on frame boundaries show every frame exactly once", () => {
  const wsDir = path.join(TEST_ROOT, "spine_enable_rule_cuts");
  setupThreeClip(wsDir, [2000, 4000], 30);
  const { frames, count } = renderAndClassify(wsDir, "cuts.mp4", (c) => colorOf(c));
  assert.equal(count, 180);
  for (let n = 0; n < count; n++) {
    const t = (n * 1000) / 30;
    const want = t < 2000 ? "red" : t < 4000 ? "green" : "blue";
    assert.equal(frames[n], want, `frame ${n} (t=${t}ms)`);
  }
});

test("a cut inside a frame interval shows every frame exactly once", () => {
  const wsDir = path.join(TEST_ROOT, "spine_enable_rule_offgrid");
  setupThreeClip(wsDir, [2033, 4011], 30);
  const { frames, count } = renderAndClassify(wsDir, "offgrid.mp4", (c) => colorOf(c));
  assert.equal(count, 180);
  for (let n = 0; n < count; n++) {
    const t = (n * 1000) / 30;
    const want = cueCoversTimeMs(0, 2033, t) ? "red" : cueCoversTimeMs(2033, 4011, t) ? "green" : "blue";
    assert.equal(frames[n], want, `frame ${n} (t=${t}ms)`);
  }
});

test("more than 24 clips and off-rate sources keep every frame", () => {
  // Segmented render path (> 24 clips) with 24 fps and 25 fps sources in a
  // 30 fps sequence; every output frame is scanned, not sampled.
  const wsDir = path.join(TEST_ROOT, "spine_enable_rule_segmented");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "spine segmented", aspect: "16:9", fps: 30 });
  makeNumberedSource(path.join(wsDir, "red24.mp4"), "#FF0000", 4, 24);
  makeNumberedSource(path.join(wsDir, "green25.mp4"), "#00FF00", 4, 25);
  ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [path.join(wsDir, "red24.mp4"), path.join(wsDir, "green25.mp4")],
  });
  const clipCount = 26;
  const ends: number[] = [];
  let at = 0;
  for (let i = 0; i < clipCount; i++) {
    const dur = 1000;
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: i % 2 === 0 ? "vid_01" : "vid_02",
      sourceInMs: 0,
      sourceOutMs: dur,
    });
    at += dur;
    ends.push(at);
  }
  const { frames, count } = renderAndClassify(wsDir, "segmented.mp4", (c) => colorOf(c));
  assert.equal(count, clipCount * 30);
  for (let n = 0; n < count; n++) {
    const t = (n * 1000) / 30;
    let idx = ends.findIndex((e) => t < e);
    if (idx < 0) idx = clipCount - 1;
    assert.equal(frames[n], idx % 2 === 0 ? "red" : "green", `frame ${n} (t=${t}ms)`);
  }
});

test("dissolve tail holds the outgoing clip with no missing frame", () => {
  const wsDir = path.join(TEST_ROOT, "spine_enable_rule_dissolve");
  setupThreeClip(wsDir, [2000, 4000], 30);
  setSpineTransition({
    workspaceDir: wsDir,
    clipId: "sp_01",
    transition: { kind: "dissolve", duration_ms: 400, easing: "linear" },
  });
  const { frames, count } = renderAndClassify(wsDir, "dissolve.mp4", (c) => colorOf(c));
  assert.equal(count, 180);
  for (let n = 0; n < count; n++) {
    const t = (n * 1000) / 30;
    if (t < 2000) assert.equal(frames[n], "red", `frame ${n} before transition`);
    else if (t < 2400) assert.notEqual(frames[n], "backdrop", `frame ${n} inside transition must not be blank`);
    else if (t < 4000) assert.equal(frames[n], "green", `frame ${n} after tail`);
    else assert.equal(frames[n], "blue", `frame ${n} after second cut`);
  }
});
