/**
 * Shader pre-pass proofs on tiny generated sources (fast tier):
 * - an identity shader at the first, middle and last fx position renders
 *   framemd5-identical to the same list with a raw `format=rgba` entry there;
 * - a bottom-left-red shader paints red bottom-left (orientation contract);
 * - the same blur renders twice to byte-identical intermediates (determinism);
 * - per-frame uniform values equal `spine value` over a 20-point envelope.
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ParameterEnvelopePoint } from "../core/schema.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import type { FxShaderRunStep } from "../compositor/compile_fx_stage.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { ensurePlanPrePasses } from "../render/pre_pass.js";
import { shaderFrameUniforms } from "../render/shader_worker.js";
import { readEnvelopeValueAt } from "../sequence/envelope_points.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadproof-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const IDENTITY_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv); }
`;

const QUARTER_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) {
  if (uv.x < 0.5 && uv.y < 0.5) return vec4(1.0, 0.0, 0.0, 1.0);
  return getInput(uv);
}
`;

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 300_000 });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? proc.error}`);
}

function media(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function makeWs(name: string, shaders: Record<string, string>): { wsDir: string; clipId: string } {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const src = path.join(TMP, "src.mp4");
  media(src);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 10 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [src] });
  const { clip } = appendSpineClip({
    workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 2000,
  });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shdemo");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  const fx: Record<string, unknown> = {};
  for (const [fxName, glsl] of Object.entries(shaders)) {
    fs.writeFileSync(path.join(extDir, "shaders", `${fxName}.glsl`), glsl);
    fx[fxName] = { description: fxName, backend: "shader", shader: `shaders/${fxName}.glsl` };
  }
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({ name: "shdemo", version: "1.0.0", description: "proof", fx })
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shdemo" });
  return { wsDir, clipId: clip.id };
}

function renderFramemd5(wsDir: string, outName: string, runPrepass: boolean): string {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { includeAudio: false });
  if (runPrepass) ensurePlanPrePasses(plan, { cwd: paths.rootDir, step: "test shader proof" });
  const out = path.join(TMP, outName);
  ffmpeg([
    "-y", "-v", "error",
    ...plan.inputArgs, "-filter_complex", plan.filterComplex,
    "-map", plan.videoOutPad, "-t", (plan.totalDurationMs / 1000).toFixed(3),
    "-c:v", "ffv1", out,
  ], paths.rootDir);
  const md5 = path.join(TMP, `${outName}.framemd5`);
  ffmpeg(["-y", "-v", "error", "-i", out, "-map", "0:v", "-f", "framemd5", md5]);
  return fs.readFileSync(md5, "utf8");
}

for (const pos of ["first", "middle", "last"]) {
  test(`identity shader at ${pos} position is framemd5-identical to format=rgba`, () => {
    const a = makeWs(`ident_${pos}_a`, { ident: IDENTITY_GLSL });
    const b = makeWs(`ident_${pos}_b`, { ident: IDENTITY_GLSL });
    const before = { kind: "ffmpeg", params: { filter: "eq=brightness=0.02" } };
    const after = { kind: "ffmpeg", params: { filter: "hue=h=5" } };
    const shaderEntry = { kind: "ext:shdemo/ident", params: {} };
    const rawEntry = { kind: "ffmpeg", params: { filter: "format=rgba" } };
    const lists: Record<string, { kind: string; params: Record<string, unknown> }[]> = {
      first: [shaderEntry, before, after],
      middle: [before, shaderEntry, after],
      last: [before, after, shaderEntry],
    };
    const raws: Record<string, { kind: string; params: Record<string, unknown> }[]> = {
      first: [rawEntry, before, after],
      middle: [before, rawEntry, after],
      last: [before, after, rawEntry],
    };
    for (const e of lists[pos]) addSpineFx({ workspaceDir: a.wsDir, item: a.clipId, kind: e.kind, params: e.params });
    for (const e of raws[pos]) addSpineFx({ workspaceDir: b.wsDir, item: b.clipId, kind: e.kind, params: e.params });
    const mdShader = renderFramemd5(a.wsDir, `ident_${pos}_a.nut`, true);
    const mdRaw = renderFramemd5(b.wsDir, `ident_${pos}_b.nut`, false);
    assert.equal(mdShader, mdRaw, `identity differs at ${pos}`);
  });
}

test("bottom-left quarter shader paints red bottom-left", () => {
  const { wsDir } = makeWs("quarter", { quarter: QUARTER_GLSL });
  const { sequence, paths } = loadSequence(wsDir);
  const { clipId } = { clipId: sequence.spine.clips[0].id };
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/quarter", params: {} });
  const { sequence: seq2, paths: paths2 } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(seq2, paths2, "draft_480p", { includeAudio: false });
  assert.equal(plan.prePasses?.length, 1);
  ensurePlanPrePasses(plan, { cwd: paths2.rootDir, step: "test shader proof" });
  // Orientation is checked on the intermediate itself: the main graph's YUV
  // round trip after the cut is not part of the shader contract.
  const out = plan.prePasses![0].outPath;
  const raw = path.join(TMP, "quarter.raw");
  ffmpeg(["-y", "-v", "error", "-i", out, "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw]);
  const buf = fs.readFileSync(raw);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", out],
    { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0);
  const [W, H] = probe.stdout.trim().split(",").map(Number);
  assert.equal(buf.length, W * H * 4, "one rgba frame");
  const px = (x: number, y: number): number[] => [...buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
  assert.deepEqual(px(Math.floor(W / 4), Math.floor((3 * H) / 4)), [255, 0, 0], "bottom-left is red");
  assert.notDeepEqual(px(Math.floor((3 * W) / 4), Math.floor(H / 4)), [255, 0, 0], "top-right keeps source");
});

test("the same shader pre-pass rendered twice is byte-identical", () => {
  const { wsDir, clipId } = makeWs("determinism", { ident: IDENTITY_GLSL });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ffmpeg", params: { filter: "eq=brightness=0.02" } });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/ident", params: {} });
  const hashes: string[] = [];
  for (let run = 0; run < 2; run++) {
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { includeAudio: false });
    assert.equal(plan.prePasses?.length, 1);
    const job = plan.prePasses![0];
    try { fs.unlinkSync(job.outPath); } catch { // force a fresh run
    }
    ensurePlanPrePasses(plan, { cwd: paths.rootDir, step: "test shader proof" });
    hashes.push(createHash("sha256").update(fs.readFileSync(job.outPath)).digest("hex"));
  }
  assert.equal(hashes[0], hashes[1], "intermediate differs between runs");
});

const AMOUNT_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
uniform float amount; // = 0.0
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv) * (0.5 + amount); }
`;

test("per-frame uniform values equal spine value over a 20-point envelope", () => {
  const { wsDir, clipId } = makeWs("uniforms", { amountfx: AMOUNT_GLSL });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/amountfx", params: { amount: 0 } });
  const { sequence } = loadSequence(wsDir);
  const firstClip = sequence.spine.clips[0];
  const firstFx = firstClip?.fx?.[0];
  assert.ok(firstClip && firstFx, "fx entry exists");
  const fxId = firstFx.id;
  // 20 bezier points over 2 s, amount 0 → 1.
  const points: ParameterEnvelopePoint[] = Array.from({ length: 20 }, (_, i) => ({
    offset_ms: Math.round((i * 2000) / 19),
    value: i / 19,
    easing: "cubic_bezier",
    bezier: [0.42, 0, 0.58, 1],
  }));
  commitSequenceMutation(wsDir, "test.uniforms", (seq) => {
    seq.spine.clips[0].envelopes = [{ parameter: `fx.${fxId}.amount`, points }];
  });
  const fps = 10;
  const frames = 20;
  let maxDiff = 0;
  const step: Extract<FxShaderRunStep, { kind: "shader" }> = {
    kind: "shader", entryId: fxId, file: "x", hash: "y",
    uniforms: { amount: 0 },
    envelopes: { amount: { parameter: `fx.${fxId}.amount`, points } },
  };
  for (let n = 0; n < frames; n++) {
    const localMs = (n / fps) * 1000;
    const expected = readEnvelopeValueAt({ workspaceDir: wsDir, targetId: clipId, parameter: `fx.${fxId}.amount`, localMs });
    const got = shaderFrameUniforms(step, { amount: "f" }, n, fps);
    maxDiff = Math.max(maxDiff, Math.abs((got.values.amount as { v: number }).v - expected.value));
    assert.ok(Math.abs(got.time - n / fps) < 1e-9, `frame ${n} time is item-local`);
  }
  assert.equal(maxDiff, 0, `uniform values differ from spine value (max ${maxDiff})`);
});
