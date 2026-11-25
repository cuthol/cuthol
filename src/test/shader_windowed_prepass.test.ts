/**
 * Windowed shader pre-pass narrowing:
 * - `computeShaderNarrowWindow` returns null without a window, without a
 *   shader cut, or when the window covers the whole clip;
 * - a windowed compile trims the pre-pass to the window (frame count drops),
 *   stamps `frameOffset` on shader steps, remaps the suffix `setpts`, and
 *   names single-frame files `sh_fxshad1_`;
 * - narrowed and full intermediates hold identical frames over the overlap;
 * - `ensurePlanPrePasses` keeps only the latest single-frame file per clip.
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
import { computeShaderNarrowWindow } from "../compositor/compile_spine.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { acquireSingleFrameReadLock, ensurePlanPrePasses, pruneSingleFrameShaderIntermediates } from "../render/pre_pass.js";
import { renderMultipleCompositeFramesRgb24 } from "../render/render_frames.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadwin-"));
test.after(() => rmRetrySync(TMP));

const IDENTITY_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv); }
`;

test("computeShaderNarrowWindow: null without window, without cut, or for full coverage", () => {
  const base = {
    activeWindowMs: undefined as [number, number] | undefined,
    singleFrameAtMs: undefined as number | undefined,
    hasShaderCut: true,
    clipStartMs: 0,
    clipDurationMs: 10_000,
    winLeadStartMs: 0,
    winEndMs: 10_000,
    fps: 30,
  };
  assert.equal(computeShaderNarrowWindow(base), null, "no window");
  assert.equal(
    computeShaderNarrowWindow({ ...base, activeWindowMs: [2000, 2100], hasShaderCut: false }),
    null,
    "no shader cut"
  );
  assert.equal(
    computeShaderNarrowWindow({ ...base, activeWindowMs: [0, 10_000] }),
    null,
    "window covering the whole clip shares the full file"
  );
  const narrow = computeShaderNarrowWindow({
    ...base,
    activeWindowMs: [2000, 2034],
    singleFrameAtMs: 2000,
    winLeadStartMs: 1933.333,
    winEndMs: 2034,
  });
  assert.ok(narrow, "partial window narrows");
  assert.ok(narrow!.firstFrame >= 0 && narrow!.frameCount >= 1 && narrow!.firstFrame + narrow!.frameCount <= 301);
});

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 300_000 });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? proc.error}`);
}

function media(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function makeWs(name: string): { wsDir: string; clipId: string } {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const src = path.join(TMP, "src.mp4");
  media(src);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [src] });
  const { clip } = appendSpineClip({
    workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 3000,
  });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shdemo");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "shaders", "ident.glsl"), IDENTITY_GLSL);
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({
      name: "shdemo",
      version: "1.0.0",
      description: "proof",
      fx: { ident: { description: "ident", backend: "shader", shader: "shaders/ident.glsl" } },
    })
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shdemo" });
  addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ext:shdemo/ident", params: {} });
  return { wsDir, clipId: clip.id };
}

function frameCount(nutPath: string): number {
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", nutPath,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr ?? probe.error}`);
  return Number(probe.stdout.trim());
}

function rawFrame(nutPath: string, index: number, cwd: string): Buffer {
  const out = path.join(TMP, `wfr_${process.pid}_${index}_${path.basename(nutPath)}.raw`);
  ffmpeg(["-y", "-v", "error", "-i", nutPath, "-vf", `select=eq(n\\,${index})`, "-vframes", "1",
    "-f", "rawvideo", "-pix_fmt", "rgba", out], cwd);
  return fs.readFileSync(out);
}

test("windowed compile trims the pre-pass and matches full-clip frames", () => {
  const { wsDir } = makeWs("winmatch");
  const atMs = 2000;
  const winOpts = {
    includeAudio: false as const,
    activeWindowMs: [atMs, atMs + 1000 / 30] as [number, number],
    singleFrameAtMs: atMs,
  };
  // Windowed first (no full file yet): one narrowed job.
  const single = loadSequence(wsDir);
  const winPlan = compileSequenceRenderPlan(single.sequence, single.paths, "draft_480p", winOpts);
  assert.equal(winPlan.prePasses?.length, 1, "one windowed shader pre-pass");
  const winJob = winPlan.prePasses![0];
  assert.match(path.basename(winJob.outPath), /^sh_fxshad1_.+_[0-9a-f]{16}\.nut$/, "single-frame name marker");
  const trim = /trim=start_frame=(\d+):end_frame=(\d+)/.exec(winJob.filterComplex);
  assert.ok(trim, "windowed pre-pass carries a frame trim");
  const first = Number(trim![1]);
  const count = Number(trim![2]) - first;
  assert.ok(count >= 1 && count < 90, `windowed count ${count} is a small window`);
  const shaderStep = winJob.shader!.steps.find((s) => s.kind === "shader");
  assert.ok(shaderStep && shaderStep.kind === "shader" && shaderStep.frameOffset === first, "frameOffset matches the trim");
  assert.ok(
    winPlan.filterComplex.includes(`setpts=PTS+${((0 + (first * 1000) / 30) / 1000).toFixed(6)}/TB`),
    "suffix setpts remapped by the offset"
  );
  ensurePlanPrePasses(winPlan, { cwd: single.paths.rootDir, step: "test windowed" });
  assert.equal(frameCount(winJob.outPath), count, "windowed file holds the window frames");

  // Full compile shades the whole clip with the shared key (no trim, no marker).
  const full = loadSequence(wsDir);
  const fullPlan = compileSequenceRenderPlan(full.sequence, full.paths, "draft_480p", { includeAudio: false });
  assert.equal(fullPlan.prePasses?.length, 1, "one full shader pre-pass");
  const fullJob = fullPlan.prePasses![0];
  assert.ok(!/trim=start_frame/.test(fullJob.filterComplex), "full pre-pass has no trim");
  assert.ok(!/sh_fxshad1_/.test(fullJob.outPath), "full pre-pass keeps the shared name");
  assert.notEqual(fullJob.outPath, winJob.outPath, "windowed file differs from the full file");
  ensurePlanPrePasses(fullPlan, { cwd: full.paths.rootDir, step: "test full" });
  const fullFrames = frameCount(fullJob.outPath);
  assert.ok(first + count <= fullFrames, "window inside the full file");
  for (let j = 0; j < count; j++) {
    const a = rawFrame(fullJob.outPath, first + j, full.paths.rootDir as string);
    const b = rawFrame(winJob.outPath, j, single.paths.rootDir as string);
    assert.ok(a.equals(b), `windowed frame ${j} differs from full frame ${first + j}`);
  }

  // Render-then-monitor: with the full file present the windowed compile
  // reuses it (no new pre-pass job runs).
  const again = loadSequence(wsDir);
  const reusePlan = compileSequenceRenderPlan(again.sequence, again.paths, "draft_480p", winOpts);
  assert.equal(reusePlan.prePasses?.length ?? 0, 0, "no new pre-pass when the full file exists");
  assert.ok(reusePlan.inputArgs.includes(fullJob.outPath), "windowed plan reads the full file");
});

test("ensurePlanPrePasses keeps only the latest single-frame file per clip", () => {
  const wsDir = path.join(TMP, "prune");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "prune", aspect: "16:9", fps: 30 });
  const { paths } = loadSequence(wsDir);
  const blobs = paths.blobsDir as string;
  fs.mkdirSync(blobs, { recursive: true });
  const older = path.join(blobs, "sh_fxshad1_c1_aaaaaaaaaaaaaaaa.nut");
  const current = path.join(blobs, "sh_fxshad1_c1_bbbbbbbbbbbbbbbb.nut");
  const otherClip = path.join(blobs, "sh_fxshad1_c2_cccccccccccccccc.nut");
  const fullFile = path.join(blobs, "sh_fxshad_dddddddddddddddd.nut");
  for (const f of [older, current, otherClip, fullFile]) fs.writeFileSync(f, "x");
  // The prune never touches files younger than 30 s; age the fixtures.
  const old = new Date(Date.now() - 120_000);
  for (const f of [older, current, otherClip, fullFile]) fs.utimesSync(f, old, old);
  ensurePlanPrePasses(
    {
      inputArgs: [], filterComplex: "", videoOutPad: "[v]", audioOutPad: "[a]",
      totalDurationMs: 100, renderWidth: 16, renderHeight: 16, fps: 30,
      assFilePath: null, assFilePaths: [], hyperframesBlobs: [],
      prePasses: [{ id: "fxshad_c1_bbbbbbbbbbbbbbbb", inputArgs: ["-i", "x"], filterComplex: "null", outPath: current, pixFmt: "rgba", kind: "shader", shader: { steps: [], fps: 30, pixFmt: "rgba" } }],
    },
    { cwd: paths.rootDir as string, step: "test prune" }
  );
  assert.ok(!fs.existsSync(older), "older same-clip single-frame file pruned");
  assert.ok(fs.existsSync(current), "current file kept");
  assert.ok(fs.existsSync(otherClip), "other clip untouched");
  assert.ok(fs.existsSync(fullFile), "full-clip file untouched");
});

function shaderJob(outPath: string, id: string) {
  return {
    id, inputArgs: ["-i", "x"], filterComplex: "null", outPath, pixFmt: "rgba",
    kind: "shader" as const, shader: { steps: [], fps: 30, pixFmt: "rgba" },
  };
}

function fakePlan(outPaths: string[]) {
  return {
    inputArgs: [], filterComplex: "", videoOutPad: "[v]", audioOutPad: "[a]",
    totalDurationMs: 100, renderWidth: 16, renderHeight: 16, fps: 30,
    assFilePath: null, assFilePaths: [], hyperframesBlobs: [],
    prePasses: outPaths.map((p, i) => shaderJob(p, `fxshad_${i}`)),
  };
}

test("batch prune keeps the last file per clip and spares live readers", () => {
  const wsDir = path.join(TMP, "prunebatch");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "prunebatch", aspect: "16:9", fps: 30 });
  const { paths } = loadSequence(wsDir);
  const blobs = paths.blobsDir as string;
  fs.mkdirSync(blobs, { recursive: true });
  const first = path.join(blobs, "sh_fxshad1_c1_aaaaaaaaaaaaaaaa.nut");
  const second = path.join(blobs, "sh_fxshad1_c1_bbbbbbbbbbbbbbbb.nut");
  const readLocked = path.join(blobs, "sh_fxshad1_c1_cccccccccccccccc.nut");
  const stale = path.join(blobs, "sh_fxshad1_c1_dddddddddddddddd.nut");
  for (const f of [first, second, readLocked, stale]) fs.writeFileSync(f, "x");
  // The prune never touches files younger than 30 s; age the fixtures.
  const oldBatch = new Date(Date.now() - 120_000);
  for (const f of [first, second, readLocked, stale]) fs.utimesSync(f, oldBatch, oldBatch);
  // A live reader holds `readLocked`; a dead pid's lock guards `stale`.
  const release = acquireSingleFrameReadLock(readLocked);
  fs.writeFileSync(`${stale}.read.2147483647.lock`, "2147483647", "utf8");
  try {
    ensurePlanPrePasses(fakePlan([first, second]) as never, { cwd: paths.rootDir as string, step: "test batch prune" });
  } finally {
    release();
  }
  assert.ok(!fs.existsSync(first), "superseded batch file pruned");
  assert.ok(fs.existsSync(second), "last batch file per clip kept");
  assert.ok(fs.existsSync(readLocked), "live-reader file spared");
  assert.ok(!fs.existsSync(stale), "dead-locked file pruned");
  assert.ok(!fs.existsSync(`${stale}.read.2147483647.lock`), "dead read lock removed");
});

test("orphan shader spec files of dead pids are cleaned, live kept", () => {
  const wsDir = path.join(TMP, "orphanspec");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "orphanspec", aspect: "16:9", fps: 30 });
  const { paths } = loadSequence(wsDir);
  const blobs = paths.blobsDir as string;
  fs.mkdirSync(blobs, { recursive: true });
  const outPath = path.join(blobs, "sh_fxshad1_c9_eeeeeeeeeeeeeeee.nut");
  fs.writeFileSync(outPath, "x");
  const deadSpec = `${outPath}.2147483647.tmp.spec.json`;
  const liveSpec = `${outPath}.${process.pid}.tmp.spec.json`;
  fs.writeFileSync(deadSpec, "{}", "utf8");
  fs.writeFileSync(liveSpec, "{}", "utf8");
  // outPath exists, so no worker runs: only orphan cleanup applies.
  ensurePlanPrePasses(fakePlan([outPath]) as never, { cwd: paths.rootDir as string, step: "test orphan spec" });
  assert.ok(!fs.existsSync(deadSpec), "dead-pid spec removed at the next pre-pass");
  assert.ok(fs.existsSync(liveSpec), "live-pid spec kept");
  assert.ok(fs.existsSync(outPath), "output untouched");
  fs.unlinkSync(liveSpec);
});

test("a dropped shader intermediate is re-shaded, never preview-seeked", () => {
  const { wsDir } = makeWs("retrydrop");
  const first = loadSequence(wsDir);
  const ref = renderMultipleCompositeFramesRgb24(first.sequence, first.paths, [2000], "draft_480p")[0];
  process.env.CUTHOL_TEST_DROP_SHADER_INTERMEDIATE = "1";
  try {
    const second = loadSequence(wsDir);
    const got = renderMultipleCompositeFramesRgb24(second.sequence, second.paths, [2000], "draft_480p")[0];
    assert.ok(got.rgbBuf.equals(ref.rgbBuf), "re-shaded frame is byte-identical to the normal run");
  } finally {
    delete process.env.CUTHOL_TEST_DROP_SHADER_INTERMEDIATE;
  }
  const blobs = (loadSequence(wsDir).paths.blobsDir as string);
  const previews = fs.readdirSync(blobs).filter((f) => f.startsWith("preview_comp_"));
  assert.deepEqual(previews, [], "no preview composite was rendered as a fallback");
});
