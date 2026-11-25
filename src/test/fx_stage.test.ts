/**
 * One fx stage for spine clips and lane cues (`src/compositor/compile_fx_stage.ts`).
 *
 * Chain-only parts inline into the same single chain as before (byte-identical to the old
 * spine stage); `alpha_keep` parts split the chain, hold the alpha plane aside with
 * `alphaextract` while the effect runs, and merge it back with `alphamerge`.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import type { ClipFxSpec } from "../core/schema.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import {
  buildItemFxStage,
  emitFxStageParts,
  SPINE_FX_ENTRY_CONVERTER,
  SPINE_FX_RGBA_EXIT,
} from "../compositor/compile_fx_stage.js";
import { buildSpineClipFxFilters } from "../compositor/compile_spine_fx.js";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { getSequenceEffectRegistry } from "../extensions/ext_effects.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxstage-"));

test.after(() => rmRetrySync(TMP));

function ffmpeg(args: string[], cwd?: string): { status: number; stderr: string } {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 300_000 });
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
    assert.fail(`ffmpeg timed out after 300 s: ffmpeg ${args.slice(0, 6).join(" ")}…`);
  return { status: proc.status ?? 1, stderr: proc.stderr ?? "" };
}

function makeMedia(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  const r = ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2,eq=saturation=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
  assert.equal(r.status, 0, `synthetic media failed: ${r.stderr}`);
}

function fakeCtx(seq: unknown, rootDir: string): VideoGraphCompileContext {
  return { seq, paths: { rootDir }, vStepCounter: 0 } as unknown as VideoGraphCompileContext;
}

test("chain-only parts inline byte-identical to the old spine stage", () => {
  const wsDir = path.join(TMP, "ws_chain");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "chain", aspect: "16:9", fps: 30 });
  const { sequence, paths } = loadSequence(wsDir);
  const owner = {
    id: "sp_01",
    fx: [
      { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0.05,rgbashift=rh=2" } },
      { id: "fx_02", kind: "ffmpeg", params: { filter: "eq=contrast=1.1" } },
    ],
    envelopes: [],
  };
  const ctx = fakeCtx(sequence, paths.rootDir);
  const parts = buildItemFxStage(ctx, { owner, receivedPixFmt: "yuv420p", itemHasAlpha: false });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, "chain");
  const legacy = buildSpineClipFxFilters(ctx, {
    clip: owner,
    asset: undefined as never,
    absAssetPath: "",
    clipColorSpec: undefined as never,
    targetW: 0,
    targetH: 0,
    receivedPixFmt: "yuv420p",
  });
  assert.deepEqual(parts[0].type === "chain" ? parts[0].filters : [], legacy);
  const vFilters = ["scale=640:360", "setsar=1"];
  const { exitFilterIdx } = emitFxStageParts(ctx, vFilters, parts);
  assert.equal(exitFilterIdx, vFilters.length - 1);
  assert.ok(vFilters.includes(SPINE_FX_ENTRY_CONVERTER));
});

test("keep entries share one alpha_keep part, process entries stay chain", () => {
  const wsDir = path.join(TMP, "ws_alpha");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "alpha", aspect: "16:9", fps: 30 });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "alphademo");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({
      name: "alphademo",
      version: "1.0.0",
      description: "alpha demo",
      fx: {
        soft: { video_filter: "eq=brightness=0.05", alpha: "keep" },
        wobble: {
          description: "shift",
          params: { amount: { type: "number", default: 2, min: 0, max: 20 } },
          video_filter: "rgbashift=rh={{amount}}",
          alpha: "process",
        },
      },
    }),
    "utf8"
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "alphademo" });
  const { sequence, paths } = loadSequence(wsDir);
  const reg = getSequenceEffectRegistry(sequence, paths.rootDir);
  assert.equal(reg.fx.get("ext:alphademo/soft")?.spec.alpha, "keep");
  assert.equal(reg.fx.get("ext:alphademo/wobble")?.spec.alpha, "process");
  const owner = {
    id: "cue_01",
    fx: [
      { id: "fx_01", kind: "ext:alphademo/soft", params: {} },
      { id: "fx_02", kind: "ffmpeg", params: { filter: "eq=contrast=1.1" } },
      { id: "fx_03", kind: "ext:alphademo/wobble", params: { amount: 2 } },
    ] as ClipFxSpec[],
    envelopes: [],
  };
  const ctx = fakeCtx(sequence, paths.rootDir);
  const parts = buildItemFxStage(ctx, { owner, receivedPixFmt: "rgba", itemHasAlpha: true });
  assert.deepEqual(parts.map((p) => p.type), ["alpha_keep", "chain", "chain"]);
  const vFilters: string[] = ["format=rgba"];
  const { exitFilterIdx } = emitFxStageParts(ctx, vFilters, parts);
  assert.equal(exitFilterIdx, vFilters.length - 1);
  const joined = vFilters.join(",");
  assert.match(joined, /split\[fxk\d+a\]\[fxk\d+b\]/);
  assert.match(joined, /alphaextract/);
  assert.match(joined, /alphamerge/);
});

test("manifest fx alpha rejects anything but keep or process", () => {
  const wsDir = path.join(TMP, "ws_alphabad");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "alphabad", aspect: "16:9", fps: 30 });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "alphabad");
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({
      name: "alphabad",
      version: "1.0.0",
      fx: { broken: { video_filter: "null", alpha: "sometimes" } },
    }),
    "utf8"
  );
  assert.throws(() => enableExtensionInWorkspace({ workspaceDir: wsDir, name: "alphabad" }), /alpha/);
});

/** Compile a one-cue broll project and return that cue's filter chain. */
function cueChain(wsDir: string, cueId: string, color?: { exposure: { stops: number } }): string {
  updateSequenceInPlace(wsDir, (seq) => {
    const cue = seq.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    assert.ok(cue, "cue exists");
    cue.fx = [{ id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } }];
    if (color) cue.color = color;
  });
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const chain = plan.filterComplex.split(";").find((c) => c.endsWith(`[v_cue_${cueId}]`));
  assert.ok(chain, `no chain for cue ${cueId}`);
  return chain;
}

function makeCueProject(name: string): { wsDir: string; cueId: string } {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const media = path.join(TMP, "cue_src.mp4");
  makeMedia(media);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { cue } = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_broll",
    assetHandle: item.handle,
    kind: "broll",
    atMs: 0,
    durationMs: 2000,
  });
  return { wsDir, cueId: cue.id };
}

test("footage cue without colour runs fx after scale/mirrors, before the RGBA conversion", () => {
  const { wsDir, cueId } = makeCueProject("ws_cueplain");
  const chain = cueChain(wsDir, cueId);
  const fxAt = chain.indexOf("eq=brightness=0.05");
  assert.ok(fxAt > 0, "effect present");
  assert.ok(chain.indexOf("scale=") < fxAt, "fx runs after the fit scale");
  const rgbaAt = chain.indexOf("format=rgba");
  assert.ok(rgbaAt > fxAt, "fx runs before the RGBA conversion");
});

test("footage cue with colour runs fx after the colour stage", () => {
  const { wsDir, cueId } = makeCueProject("ws_cuecolor");
  const chain = cueChain(wsDir, cueId, { exposure: { stops: 0.5 } });
  const fxAt = chain.indexOf("eq=brightness=0.05");
  assert.ok(fxAt > 0, "effect present");
  const colorAt = chain.indexOf("lut3d");
  assert.ok(colorAt > 0, "colour stage present");
  assert.ok(colorAt < fxAt, "fx runs after the colour stage");
});

test("text cue with fx compiles to its own layer, audio cue with fx stops the compile", () => {
  const { wsDir } = makeCueProject("ws_cuetext");
  updateSequenceInPlace(wsDir, (seq) => {
    const cue = seq.lanes.flatMap((l) => l.cues)[0];
    cue.typography = {
      text: "hello",
      font_family: "Arial",
      font_size_px: 48,
      font_weight: 400,
      color_hex: "#FFFFFF",
      stroke_color_hex: null,
      stroke_width_px: 0,
      box_color_hex: null,
      box_opacity: 0,
      align: "center",
      max_width_pct: 90,
    };
    cue.fx = [{ id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } }];
  });
  {
    // Text cues own their fx stage since the text wave: a transparent layer, no diagnostic.
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    assert.ok(plan.filterComplex.includes(`[v_txtfx_`), "text fx cue renders as its own layer");
  }
  const wsDir2 = path.join(TMP, "ws_cueaudio");
  fs.rmSync(wsDir2, { recursive: true, force: true });
  initWorkspace({ dir: wsDir2, title: "cueaudio", aspect: "16:9", fps: 30 });
  const { cue: audioCue } = addLaneCue({
    workspaceDir: wsDir2,
    laneId: "ln_bgm",
    kind: "music",
    atMs: 0,
    durationMs: 1000,
  });
  updateSequenceInPlace(wsDir2, (seq) => {
    seq.lanes.flatMap((l) => l.cues).find((c) => c.id === audioCue.id)!.fx = [
      { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } },
    ];
  });
  {
    const { sequence, paths } = loadSequence(wsDir2);
    assert.throws(() => compileSequenceRenderPlan(sequence, paths, "draft_480p"), /CUTHOL-G265/);
  }
});

/** RGBA input whose alpha is a horizontal ramp, so any alpha damage is measurable. */
function rgbaRampInput(): string {
  return "testsrc2=size=320x240:rate=30:duration=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='X'";
}

function psnr(fileA: string, fileB: string, pixFmt: string, size: string): string {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "info",
      "-s", size, "-pix_fmt", pixFmt, "-f", "rawvideo", "-i", fileA,
      "-s", size, "-pix_fmt", pixFmt, "-f", "rawvideo", "-i", fileB,
      "-lavfi", "[0:v][1:v]psnr",
      "-f", "null", "-",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 300_000 }
  );
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
    assert.fail(`ffmpeg timed out after 300 s (psnr probe)`);
  assert.equal(proc.status, 0, `psnr failed: ${proc.stderr}`);
  const m = /average:([0-9.inf]+)/.exec(proc.stderr);
  assert.ok(m, `no PSNR in output: ${proc.stderr.slice(-400)}`);
  return m[1];
}

/**
 * Runs one effect through the real `alpha_keep` wrapper and through the bare effect,
 * and returns the output files for plane comparison.
 */
function runWrapperComparison(
  name: string,
  effectFilter: string,
  sequence: unknown,
  rootDir: string
): { rgba: string; alpha: string; refAlpha: string; direct: string; verboseLog: string } {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Lossless RGBA ramp on disk: the measured graphs start from rawvideo, so any
  // auto-inserted scaler in the verbose log belongs to the wrapper under test.
  const ramp = path.join(dir, "ramp.rgba");
  const gen = ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", rgbaRampInput(),
    "-frames:v", "60",
    "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", ramp,
  ]);
  assert.equal(gen.status, 0, `ramp render failed: ${gen.stderr.slice(-300)}`);
  const inputArgs = ["-s", "320x240", "-pix_fmt", "rgba", "-f", "rawvideo", "-i", ramp];
  const ctx = fakeCtx(sequence, rootDir);
  const parts = buildItemFxStage(
    ctx,
    {
      owner: { id: "cue_01", fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: effectFilter } }], envelopes: [] },
      receivedPixFmt: "rgba",
      itemHasAlpha: true,
    }
  );
  assert.deepEqual(parts.map((p) => p.type), ["alpha_keep", "chain"]);
  const stage: string[] = [];
  emitFxStageParts(ctx, stage, parts);
  const out = path.join(dir, "wrapped.yuv");
  const alpha = path.join(dir, "wrapped_alpha.raw");
  const refAlpha = path.join(dir, "input_alpha.raw");
  const graph =
    `[0:v]format=rgba,split[inR][inW],[inR]alphaextract[refA],[inW]` +
    `${stage.join(",")},split[outV][outA],[outA]alphaextract[outAl]`;
  const wrapped = ffmpeg([
    "-y", "-v", "verbose",
    ...inputArgs,
    "-filter_complex", graph,
    "-map", "[outV]", "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", out,
    "-map", "[outAl]", "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "gray", alpha,
    "-map", "[refA]", "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "gray", refAlpha,
  ]);
  assert.equal(wrapped.status, 0, `wrapped run failed: ${wrapped.stderr.slice(-500)}`);
  const direct = path.join(dir, "direct.yuv");
  const bare = ffmpeg([
    "-y", "-v", "error",
    ...inputArgs,
    "-filter_complex", `[0:v]format=rgba,${SPINE_FX_ENTRY_CONVERTER},${effectFilter},${SPINE_FX_ENTRY_CONVERTER},format=rgba[dV]`,
    "-map", "[dV]", "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", direct,
  ]);
  assert.equal(bare.status, 0, `direct run failed: ${bare.stderr.slice(-500)}`);
  return { rgba: out, alpha, refAlpha, direct, verboseLog: wrapped.stderr };
}

test("alpha_keep wrapper: vignette leaves the alpha plane untouched", () => {
  const wsDir = path.join(TMP, "ws_ffvignette");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "ffv", aspect: "16:9", fps: 30 });
  const { sequence, paths } = loadSequence(wsDir);
  const r = runWrapperComparison("ff_vignette", "vignette=PI/4", sequence, paths.rootDir);
  assert.equal(psnr(r.alpha, r.refAlpha, "gray", "320x240"), "inf");
  assert.ok(!/auto_scale/.test(r.verboseLog), "no auto-inserted scaler inside the wrapper");
});

test("alpha_keep wrapper: RGB-only effect matches the bare effect, alpha untouched", () => {
  const wsDir = path.join(TMP, "ws_ffshift");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "ffs", aspect: "16:9", fps: 30 });
  const { sequence, paths } = loadSequence(wsDir);
  const r = runWrapperComparison("ff_shift", "rgbashift=rh=2", sequence, paths.rootDir);
  assert.equal(psnr(r.alpha, r.refAlpha, "gray", "320x240"), "inf");
  // RGB-only comparison: drop the alpha on both sides, then compare.
  const dir = path.join(TMP, "ff_shift");
  const rgbA = path.join(dir, "wrapped_rgb.raw");
  const rgbD = path.join(dir, "direct_rgb.raw");
  for (const [src, dst] of [[r.rgba, rgbA], [r.direct, rgbD]] as const) {
    const p = ffmpeg([
      "-y", "-v", "error",
      "-s", "320x240", "-pix_fmt", "rgba", "-f", "rawvideo", "-i", src,
      "-vf", "format=gbrp",
      "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "gbrp", dst,
    ]);
    assert.equal(p.status, 0, `rgb extract failed: ${p.stderr.slice(-300)}`);
  }
  assert.equal(psnr(rgbA, rgbD, "gbrp", "320x240"), "inf");
  assert.ok(!/auto_scale/.test(r.verboseLog), "no auto-inserted scaler inside the wrapper");
});

test("alpha_keep wrapper: duration-changing effect keeps its length and alpha", () => {
  const wsDir = path.join(TMP, "ws_fftpad");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "fft", aspect: "16:9", fps: 30 });
  const { sequence, paths } = loadSequence(wsDir);
  const dir = path.join(TMP, "ff_tpad");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ctx = fakeCtx(sequence, paths.rootDir);
  const parts = buildItemFxStage(
    ctx,
    {
      owner: {
        id: "cue_01",
        fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: "tpad=stop_mode=clone:stop_duration=1" } }],
        envelopes: [],
      },
      receivedPixFmt: "rgba",
      itemHasAlpha: true,
    }
  );
  const stage: string[] = [];
  emitFxStageParts(ctx, stage, parts);
  const out = path.join(dir, "tpad.yuv");
  const input = "testsrc2=size=320x240:rate=30:duration=1,format=rgba";
  const p = ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", input,
    "-filter_complex", `[0:v]${stage.join(",")}[outV]`,
    "-map", "[outV]", "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", out,
  ]);
  assert.equal(p.status, 0, `tpad run failed: ${p.stderr.slice(-500)}`);
  const frames = fs.statSync(out).size / (320 * 240 * 4);
  assert.equal(frames, 60, `effect length lost through the wrapper (got ${frames} frames)`);
  const alphaMean = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-s", "320x240", "-pix_fmt", "rgba", "-f", "rawvideo", "-i", out,
      "-vf", "alphaextract,signalstats",
      "-f", "null", "-",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 300_000 }
  );
  assert.equal(alphaMean.status, 0, `alpha probe failed`);
});

/** Single-frame RGBA still with a horizontal alpha ramp. */
function makeRgbaStill(outPath: string, size: string): void {
  if (fs.existsSync(outPath)) return;
  const [w, h] = size.split("x").map(Number);
  const r = ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='X*255/${w - 1}'`,
    "-frames:v", "1",
    outPath,
  ]);
  assert.equal(r.status, 0, `rgba still failed: ${r.stderr.slice(-300)}`);
  void h;
}

/** Spine clip chain of clip `index` from a compiled plan, without input/output pads. */
function spineChainInner(planFilterComplex: string, index: number): { inIdx: number; inner: string } {
  const chain = planFilterComplex.split(";").find((c) => c.endsWith(`[v_sp_${index}]`));
  assert.ok(chain, `no chain for spine clip #${index}`);
  const m = /^\[(\d+):v\]/.exec(chain);
  assert.ok(m, `no input pad in spine chain: ${chain.slice(0, 60)}`);
  const inner = chain.slice(m[0].length, chain.length - `[v_sp_${index}]`.length);
  return { inIdx: Number(m[1]), inner };
}

test("alpha_keep wrapper runs inside a real compiled spine chain (RGBA png still)", () => {
  const still = path.join(TMP, "spine_alpha_src.png");
  makeRgbaStill(still, "320x240");
  const setup = (name: string, withFx: boolean): string => {
    const wsDir = path.join(TMP, name);
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [still] });
    const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
    if (withFx) addSpineFx({ workspaceDir: wsDir, clipId: clip.id, filter: "vignette=PI/4" });
    return wsDir;
  };
  const wsDir = setup("ws_spinewrap", true);
  const { sequence, paths } = loadSequence(wsDir);
  const clip = sequence.spine.clips[0];
  const asset = sequence.library.find((a) => a.handle === clip.asset_handle)!;
  const absPng = resolveLibraryItemPath(paths.rootDir, asset);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const { inner } = spineChainInner(plan.filterComplex, 0);
  // The compiled chain carries the fx stage chain-only (spine passes itemHasAlpha: false).
  // Rebuild the same stage with a live alpha, as the next wave will, and splice it in.
  const oldFx = `${SPINE_FX_ENTRY_CONVERTER},vignette=PI/4,${SPINE_FX_RGBA_EXIT}`;
  assert.ok(inner.includes(oldFx), `compiled spine chain has no fx stage to replace: ${inner.slice(0, 200)}`);
  const ctx = fakeCtx(sequence, paths.rootDir);
  const parts = buildItemFxStage(
    ctx,
    {
      owner: { id: clip.id, fx: clip.fx, envelopes: clip.envelopes },
      receivedPixFmt: "rgba",
      itemHasAlpha: true,
    }
  );
  assert.ok(parts.some((p) => p.type === "alpha_keep"), "RGB clip with alpha keeps it aside");
  const wrapped: string[] = [];
  emitFxStageParts(ctx, wrapped, parts);
  const spliced = inner.replace(oldFx, wrapped.join(","));
  const dir = path.join(TMP, "spine_wrap");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "wrapped.rgba");
  const run = ffmpeg([
    "-y", "-v", "error",
    "-loop", "1", "-i", absPng,
    "-filter_complex", `[0:v]${spliced}[outV]`,
    "-map", "[outV]", "-frames:v", "5",
    "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", out,
  ]);
  assert.equal(run.status, 0, `spine chain with alpha_keep wrapper failed: ${run.stderr.slice(-500)}`);
  // The wrapper must preserve the clip's own alpha: compare against the fx-less clip.
  const wsRef = setup("ws_spinewrap_ref", false);
  const refLoaded = loadSequence(wsRef);
  const refPlan = compileSequenceRenderPlan(refLoaded.sequence, refLoaded.paths, "draft_480p");
  const refInner = spineChainInner(refPlan.filterComplex, 0).inner;
  const refAsset = refLoaded.sequence.library.find((a) => a.handle === refLoaded.sequence.spine.clips[0].asset_handle)!;
  const refPng = resolveLibraryItemPath(refLoaded.paths.rootDir, refAsset);
  const refOut = path.join(dir, "ref.rgba");
  const ref = ffmpeg([
    "-y", "-v", "error",
    "-loop", "1", "-i", refPng,
    "-filter_complex", `[0:v]${refInner}[outV]`,
    "-map", "[outV]", "-frames:v", "5",
    "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", refOut,
  ]);
  assert.equal(ref.status, 0, `fx-less reference run failed: ${ref.stderr.slice(-500)}`);
  const alphaOf = (src: string, dst: string): void => {
    const p = ffmpeg([
      "-y", "-v", "error",
      "-s", "320x240", "-pix_fmt", "rgba", "-f", "rawvideo", "-i", src,
      "-vf", "alphaextract",
      "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "gray", dst,
    ]);
    assert.equal(p.status, 0, `alpha extract failed: ${p.stderr.slice(-300)}`);
  };
  const alphaW = path.join(dir, "wrapped_alpha.raw");
  const alphaR = path.join(dir, "ref_alpha.raw");
  alphaOf(out, alphaW);
  alphaOf(refOut, alphaR);
  assert.equal(psnr(alphaW, alphaR, "gray", "320x240"), "inf");
});

test("alpha_keep wrapper with a YUV received format pins to rgba and runs", () => {
  const wsDir = path.join(TMP, "ws_yuvwrap");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "yuvwrap", aspect: "16:9", fps: 30 });
  const { sequence, paths } = loadSequence(wsDir);
  const ctx = fakeCtx(sequence, paths.rootDir);
  // A YUV clip carries no alpha plane, so there is nothing to keep: the wrapper pins
  // to rgba (an opaque alpha) instead of depending on the upstream format.
  const parts = buildItemFxStage(
    ctx,
    {
      owner: { id: "cue_01", fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: "vignette=PI/4" } }], envelopes: [] },
      receivedPixFmt: "yuv420p",
      itemHasAlpha: true,
    }
  );
  assert.ok(parts.some((p) => p.type === "alpha_keep"), "still an alpha_keep part");
  const stage: string[] = [];
  emitFxStageParts(ctx, stage, parts);
  assert.match(stage.join(","), /format=rgba,split\[/, "wrapper pins rgba before the split");
  const dir = path.join(TMP, "yuv_wrap");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "out.rgba");
  const run = ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1,format=yuv420p",
    "-filter_complex", `[0:v]${stage.join(",")}[outV]`,
    "-map", "[outV]", "-frames:v", "5",
    "-f", "rawvideo", "-c:v", "rawvideo", "-pix_fmt", "rgba", out,
  ]);
  assert.equal(run.status, 0, `pinned wrapper on YUV input failed: ${run.stderr.slice(-500)}`);
  assert.ok(fs.statSync(out).size === 320 * 240 * 4 * 5, "five rgba frames out");
});
