/**
 * Fx on plain text cues: a text cue with active fx leaves the lane's shared ASS file and
 * renders as its own transparent layer (text alone on a stage-size transparent canvas, the
 * fx stage with `itemHasAlpha: true`, straight-alpha overlay at the cue's timing). Text cues
 * without fx keep the shared direct burn, byte for byte.
 */
import "./test_setup.js";
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
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import type { CutholSequence } from "../core/schema.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-textfx-"));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

type CueFx = CutholSequence["lanes"][number]["cues"][number]["fx"];

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
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4,eq=saturation=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function makeStaticFootage(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=#3A5A8C:s=1280x720:r=30:d=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/** Project with footage underneath and several text cues (titles, a rotated one, a caption). */
function makeProject(wsDir: string, bgKind: "moving" | "static" = "moving"): { cueIds: string[] } {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "textfx", aspect: "16:9", fps: 30 });
  const bg = path.join(TMP, bgKind === "static" ? "bgstatic.mp4" : "bg.mp4");
  if (bgKind === "static") makeStaticFootage(bg);
  else makeFootage(bg);
  const staged = path.join(wsDir, "bg.mp4");
  fs.copyFileSync(bg, staged);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [staged] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });

  const ids: string[] = [];
  ids.push(addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 500, durationMs: 1500, yPct: -20, fontSizePx: 72,
    colorHex: "#FFFFFF", text: "PLAIN TITLE ONE",
  }).cue.id);
  ids.push(addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 1000, durationMs: 1500, yPct: 0, fontSizePx: 72, rotationDeg: 8,
    colorHex: "#FFE080", text: "ROTATED MIDDLE",
  }).cue.id);
  ids.push(addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 1500, durationMs: 1500, yPct: 20, fontSizePx: 72,
    colorHex: "#FFFFFF", text: "PLAIN TITLE TWO",
  }).cue.id);
  ids.push(addLaneCue({
    workspaceDir: wsDir, laneId: "ln_caps", kind: "caption",
    atMs: 500, durationMs: 2500, yPct: 32, fontSizePx: 48,
    colorHex: "#FFFFFF", text: "a caption line here",
  }).cue.id);
  return { cueIds: ids };
}

function setCueFx(wsDir: string, cueId: string, fx: CueFx): void {
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) cue.fx = fx;
    }
  });
}

function planJson(wsDir: string, preset: "draft_480p" | "master_1080p"): string {
  const { sequence, paths } = loadSequence(wsDir);
  // ASS file contents (not just names) are part of the plan.
  const plan = compileSequenceRenderPlan(sequence, paths, preset);
  const assContents = Object.fromEntries(
    plan.assFilePaths.map((f) => [path.basename(f), fs.readFileSync(f, "utf8")])
  );
  return JSON.stringify({ plan, assContents });
}

test("disabled fx on a text cue keeps the render plan byte-identical (both presets)", () => {
  const wsDir = path.join(TMP, "ws_plan");
  const { cueIds } = makeProject(wsDir);
  const before480 = planJson(wsDir, "draft_480p");
  const before1080 = planJson(wsDir, "master_1080p");
  setCueFx(wsDir, cueIds[1], [
    { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" }, enabled: false },
  ]);
  assert.equal(planJson(wsDir, "draft_480p"), before480, "draft plan changed with disabled fx");
  assert.equal(planJson(wsDir, "master_1080p"), before1080, "master plan changed with disabled fx");
});

test("active fx text cue leaves the shared ASS and becomes its own alpha layer", () => {
  const wsDir = path.join(TMP, "ws_layer");
  const { cueIds } = makeProject(wsDir);
  setCueFx(wsDir, cueIds[1], [
    { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } },
  ]);
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const graph = plan.filterComplex;
  const inputs = plan.inputArgs.join(" ");
  assert.ok(inputs.includes("color=c=black@0"), "no transparent canvas layer input");
  assert.ok(graph.includes("alphaextract") && graph.includes("alphamerge"), "keep fx must hold the alpha plane aside");
  assert.ok(graph.includes("format=rgba"), "fx layer must pin rgba around the alpha split");
  assert.ok(graph.includes("overlay=x=0:y=0:eval=frame:enable='gte(t,1.000)*lt(t,2.500)'"), `fx overlay timing wrong: ${graph.slice(0, 400)}`);
  assert.equal(plan.assFilePaths.length, 4, `expected 2 plain segments + 1 fx layer + captions, got ${plan.assFilePaths.length}`);
  const bodies = plan.assFilePaths.map((f) => ({ file: path.basename(f), body: fs.readFileSync(f, "utf8") }));
  const fxFile = bodies.find((b) => b.file.includes("_fx_"));
  assert.ok(fxFile, "no single-cue fx ASS file");
  assert.ok(fxFile.body.includes("ROTATED MIDDLE"), "fx ASS must carry the fx cue text");
  assert.ok(!fxFile.body.includes("PLAIN TITLE"), "fx ASS must not carry other cues");
  for (const b of bodies.filter((x) => !x.file.includes("_fx_"))) {
    assert.ok(!b.body.includes("ROTATED MIDDLE"), `shared segment ${b.file} must exclude the fx cue`);
  }
  const single = bodies.find((b) => b.file.includes("_fx_"))!;
  assert.ok(single.body.includes("\\frz-8"), "rotated-text style patch must apply to the single-cue file");
});

/** Runs the compiled graph to raw yuv420p frames (no encoder in between). */
function renderRawFrames(wsDir: string, outName: string, preset: "draft_480p" | "master_1080p"): { buf: Buffer; w: number; h: number; frames: number } {
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
  const w = plan.renderWidth;
  const h = plan.renderHeight;
  const frameSize = Math.round((w * h * 3) / 2);
  assert.equal(buf.length % frameSize, 0, "truncated raw dump");
  return { buf, w, h, frames: buf.length / frameSize };
}

function psnr(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length);
  let sq = 0;
  for (let i = 0; i < a.length; i++) sq += (a[i] - b[i]) ** 2;
  return sq === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / sq);
}

function frameAt(r: { buf: Buffer; w: number; h: number }, n: number): Buffer {
  const size = Math.round((r.w * r.h * 3) / 2);
  return r.buf.subarray(n * size, (n + 1) * size);
}

test("neutral eq on a text cue stays within the method floor (both presets)", () => {
  // Brief-like content (outlined title over real footage): the transparent-layer path measures
  // 57.4 dB draft / 56.3 dB master against the direct burn, and the neutral fx stage on top of
  // it is bit-identical to the layer without fx (measured: inf). The difference lives only on
  // glyph edges.
  for (const preset of ["draft_480p", "master_1080p"] as const) {
    const wsDir = path.join(TMP, `ws_neutral_${preset}`);
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "textfx-neutral", aspect: "16:9", fps: 30 });
    fs.copyFileSync(
      "test-workspace/fixtures/trial-media/broll_1.mp4",
      path.join(wsDir, "bg.mp4")
    );
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "bg.mp4")] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const cueId = addLaneCue({
      workspaceDir: wsDir, laneId: "ln_title", kind: "title",
      atMs: 500, durationMs: 1500, fontSizePx: 48,
      colorHex: "#FFFFFF", text: "TITLE",
    }).cue.id;
    const plain = renderRawFrames(wsDir, "plain.yuv", preset);
    setCueFx(wsDir, cueId, [
      { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } },
    ]);
    const fxed = renderRawFrames(wsDir, "fx.yuv", preset);
    assert.equal(fxed.frames, plain.frames);
    assert.ok(plain.frames >= 100, `expected ~120 frames, got ${plain.frames}`);
    // Frames before the cue starts must be bit-identical: the difference lives at the cue.
    assert.ok(frameAt(plain, 5).equals(frameAt(fxed, 5)), `${preset}: pre-cue frame differs`);
    let minPsnr = Infinity;
    let diffCount = 0;
    let x0 = plain.w, x1 = 0, y0 = plain.h, y1 = 0;
    for (let n = 0; n < plain.frames; n++) {
      const a = frameAt(plain, n);
      const b = frameAt(fxed, n);
      minPsnr = Math.min(minPsnr, psnr(a, b));
      for (let y = 0; y < plain.h; y++) {
        for (let x = 0; x < plain.w; x++) {
          if (a[y * plain.w + x] !== b[y * plain.w + x]) {
            diffCount++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
    }
    assert.ok(minPsnr >= 48, `${preset}: worst-frame PSNR ${minPsnr.toFixed(1)} dB below the 48 dB method floor`);
    const total = plain.w * plain.h * plain.frames;
    assert.ok(diffCount / total < 0.02, `${preset}: ${(100 * diffCount / total).toFixed(2)}% of pixels differ`);
    assert.ok(y1 - y0 < 0.2 * plain.h, `${preset}: luma diffs span y ${y0}..${y1}, not glyph edges`);
  }
});

test("vignette keep on a text cue leaves the footage around the text visible", () => {
  const wsDir = path.join(TMP, "ws_vignette");
  const { cueIds } = makeProject(wsDir);
  const plain = renderRawFrames(wsDir, "plain.yuv", "draft_480p");
  setCueFx(wsDir, cueIds[0], [
    { id: "fx_01", kind: "ffmpeg", params: { filter: "vignette=PI/4" } },
  ]);
  const fxed = renderRawFrames(wsDir, "fx.yuv", "draft_480p");
  // Top-left 64x64 corner is far from any glyph: straight alpha must copy the footage exactly.
  const { w, h } = plain;
  const corner = (r: { buf: Buffer; w: number; h: number }, n: number): Buffer => {
    const f = frameAt(r, n);
    const ySize = w * h;
    const uOff = ySize;
    const vOff = ySize + (ySize >> 2);
    const out = Buffer.alloc(64 * 64 + 2 * 32 * 32);
    for (let y = 0; y < 64; y++) f.copy(out, y * 64, y * w, y * w + 64);
    for (let y = 0; y < 32; y++) {
      f.copy(out, 64 * 64 + y * 32, uOff + y * (w >> 1), uOff + y * (w >> 1) + 32);
      f.copy(out, 64 * 64 + 32 * 32 + y * 32, vOff + y * (w >> 1), vOff + y * (w >> 1) + 32);
    }
    return out;
  };
  const mid = Math.round(1.2 * 30);
  assert.ok(!frameAt(plain, mid).equals(frameAt(fxed, mid)), "fx frame must differ where the text is");
  assert.ok(corner(plain, mid).equals(corner(fxed, mid)), "footage corner must survive a keep fx untouched");
});

test("animated extension fx param on a text cue differs between two instants", () => {
  const wsDir = path.join(TMP, "ws_anim");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "textanim", aspect: "16:9", fps: 30 });
  const bg = path.join(TMP, "bg.mp4");
  makeFootage(bg);
  const staged = path.join(wsDir, "bg.mp4");
  fs.copyFileSync(bg, staged);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [staged] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  const cueId = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_title", kind: "title",
    atMs: 500, durationMs: 2000, fontSizePx: 96,
    colorHex: "#FFFFFF", text: "PULSING TEXT",
  }).cue.id;
  const extDir = path.join(wsDir, ".cuthol", "extensions", "textanim");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({
      name: "textanim",
      version: "1.0.0",
      description: "animated brightness for text fx",
      fx: {
        pulse: {
          params: { amount: { type: "number", default: 0, min: -1, max: 1 } },
          animatable: ["amount"],
          video_filter: "eq=brightness={{amount}}",
          alpha: "keep",
        },
      },
    }),
    "utf8"
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "textanim" });
  updateSequenceInPlace(wsDir, (seq) => {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((c) => c.id === cueId);
      if (cue) {
        cue.fx = [{ id: "fx_01", kind: "ext:textanim/pulse", params: { amount: 0 } }];
        cue.envelopes = [{
          parameter: "fx.fx_01.amount",
          points: [
            { offset_ms: 0, value: -0.5, easing: "linear" },
            { offset_ms: 2000, value: 0.5, easing: "linear" },
          ],
        }];
      }
    }
  });
  const rendered = renderRawFrames(wsDir, "anim.yuv", "draft_480p");
  const early = frameAt(rendered, Math.round(0.7 * 30));
  const late = frameAt(rendered, Math.round(2.0 * 30));
  assert.ok(!early.equals(late), "cue-local animated fx must differ between two instants");
});

test("monitor frame equals render at the same instant for a text cue with fx", () => {
  // Static backdrop: single-frame input seeking on moving sources is outside this wave.
  const wsDir = path.join(TMP, "ws_monitor");
  const { cueIds } = makeProject(wsDir, "static");
  setCueFx(wsDir, cueIds[0], [
    { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } },
  ]);
  const rendered = renderRawFrames(wsDir, "plain.yuv", "draft_480p");
  const atMs = 1200;
  const pngOut = path.join(wsDir, "out", "monitor.png");
  const proc = spawnSync(
    "node",
    [path.resolve(process.cwd(), "dist/cli.js"), "monitor", "frame", "--at", `${atMs}ms`, "--boxes", "false", "--out", pngOut, "--dir", wsDir],
    { encoding: "utf8", env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" }, windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(fs.existsSync(pngOut), "monitor frame must write the png");
  const rgbPath = path.join(wsDir, "out", "monitor.rgb");
  ffmpeg(["-y", "-v", "error", "-i", pngOut, "-pix_fmt", "rgb24", "-f", "rawvideo", rgbPath]);
  const monitored = fs.readFileSync(rgbPath);
  const rgbFrame = path.join(wsDir, "out", "frame36.rgb");
  const frameIdx = Math.round((atMs / 1000) * 30);
  ffmpeg([
    "-y", "-v", "error", "-s", `${rendered.w}x${rendered.h}`, "-pix_fmt", "yuv420p",
    "-i", path.join(wsDir, "out", "plain.yuv"),
    "-vf", `select=eq(n\\,${frameIdx}),scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`,
    "-frames:v", "1", "-f", "rawvideo", rgbFrame,
  ]);
  const want = fs.readFileSync(rgbFrame);
  assert.equal(monitored.length, want.length, "monitor frame size must match the render frame");
  // The monitor PNG carries a top HUD telemetry strip with no CLI switch; compare the video
  // area below it (same crop on both sides).
  const hudRows = 32;
  const rowBytes = rendered.w * 3;
  const strip = (b: Buffer): Buffer => b.subarray(hudRows * rowBytes);
  const a = strip(want);
  const m = strip(monitored);
  let sq = 0;
  for (let i = 0; i < a.length; i++) sq += (a[i] - m[i]) ** 2;
  const p = sq === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / sq);
  // The monitor path itself (rgb24 PNG + repeated colorspace trips) measures 43.9 dB against
  // the render on this project without any fx; with the fx text layer it measures the same.
  // The threshold guards that the fx layer adds no gap of its own.
  assert.ok(p >= 40, `monitor frame differs from render (PSNR ${p.toFixed(1)} dB)`);
});

test("stacking order: plain segment, fx layer, plain segment in cue order", () => {
  const wsDir = path.join(TMP, "ws_stack");
  const { cueIds } = makeProject(wsDir);
  setCueFx(wsDir, cueIds[1], [
    { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0" } },
  ]);
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const graph = plan.filterComplex;
  const seg0 = graph.indexOf("_seg0_");
  const fx = graph.indexOf("_fx_");
  const seg1 = graph.indexOf("_seg1_");
  assert.ok(seg0 >= 0 && fx >= 0 && seg1 >= 0, "expected seg0, fx layer and seg1 burns");
  assert.ok(seg0 < fx && fx < seg1, "fx layer must overlay between the two plain segments");
});
