/**
 * Chained shader steps on one clip:
 * - A (invert) then B (halve) on a generated clip: every frame of the
 *   lossless intermediate must equal (255 - identity) * 0.5 per channel
 *   (±2). A doubled/swapped/wrong-frame pass breaks this on the exact frame.
 * - A then B then C (red = fract(time)): red channel equals fract(t).
 * - The same A->B chain rendered 10 times from empty blobs: 0 wrong frames.
 * On master (racy shared page program) this fails: frames randomly render
 * under the sibling pass's program (invert twice or halve twice).
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
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { ensurePlanPrePasses } from "../render/pre_pass.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadchain-"));
test.after(() => rmRetrySync(TMP));

const INVERT_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { vec4 p = getInput(uv); return vec4(1.0 - p.rgb, p.a); }
`;

const HALVE_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { vec4 p = getInput(uv); return vec4(p.rgb * 0.5, p.a); }
`;

const TIMEFILL_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { vec4 p = getInput(uv); return vec4(fract(time), p.g, p.b, p.a); }
`;

const IDENTITY_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv); }
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

function makeWs(name: string, shaders: Record<string, string>): string {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const src = path.join(TMP, "src.mp4");
  media(src);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 10 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [src] });
  const { clip } = appendSpineClip({
    workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 2000,
  });
  void clip;
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shdemo");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  const fx: Record<string, unknown> = {};
  for (const [fxName, glsl] of Object.entries(shaders)) {
    fs.writeFileSync(path.join(extDir, "shaders", `${fxName}.glsl`), glsl);
    fx[fxName] = { description: fxName, backend: "shader", shader: `shaders/${fxName}.glsl` };
  }
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({ name: "shdemo", version: "1.0.0", description: "chain proof", fx })
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shdemo" });
  return wsDir;
}

function probeSize(file: string): { w: number; h: number } {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, "ffprobe failed");
  const [w, h] = probe.stdout.trim().split(",").map(Number);
  return { w, h };
}

function decodeRgba(file: string, outRaw: string): { buf: Buffer; w: number; h: number; frames: number } {
  ffmpeg(["-y", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", outRaw]);
  const { w, h } = probeSize(file);
  const buf = fs.readFileSync(outRaw);
  assert.equal(buf.length % (w * h * 4), 0, "whole frames");
  return { buf, w, h, frames: buf.length / (w * h * 4) };
}

/** Renders the clip's shader intermediate fresh (empty blobs) and decodes it. */
function renderChainIntermediate(wsDir: string, tag: string): { buf: Buffer; w: number; h: number; frames: number } {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { includeAudio: false });
  assert.equal(plan.prePasses?.length, 1, "one shader pre-pass");
  const job = plan.prePasses![0];
  try { fs.unlinkSync(job.outPath); } catch { // empty blobs: never reuse
  }
  ensurePlanPrePasses(plan, { cwd: paths.rootDir, step: "test shader chain" });
  return decodeRgba(job.outPath, path.join(TMP, `${tag}.raw`));
}

function checkAB(wsDir: string, ident: { buf: Buffer; w: number; h: number; frames: number }, tag: string): void {
  const got = renderChainIntermediate(wsDir, tag);
  assert.equal(got.frames, ident.frames, "same frame count");
  assert.equal(got.w, ident.w);
  assert.equal(got.h, ident.h);
  const fb = got.w * got.h * 4;
  let worst = 0;
  const bad: number[] = [];
  for (let f = 0; f < got.frames; f++) {
    let frameWorst = 0;
    for (let i = 0; i < fb; i += 4) {
      for (let c = 0; c < 3; c++) {
        const x = ident.buf[f * fb + i + c];
        const expected = Math.round((255 - x) * 0.5);
        const d = Math.abs(got.buf[f * fb + i + c] - expected);
        frameWorst = Math.max(frameWorst, d);
      }
      const da = Math.abs(got.buf[f * fb + i + 3] - ident.buf[f * fb + i + 3]);
      frameWorst = Math.max(frameWorst, da);
    }
    worst = Math.max(worst, frameWorst);
    if (frameWorst > 2) bad.push(f);
  }
  assert.deepEqual(bad, [], `wrong frames (max diff ${worst}): doubled/swapped pass on frames ${bad.join(",")}`);
}

const SHADERS = { inv: INVERT_GLSL, half: HALVE_GLSL, tfill: TIMEFILL_GLSL, ident: IDENTITY_GLSL };

test("A->B chain: every frame equals (255-identity)*0.5, 10 fresh renders", () => {
  const wsDir = makeWs("chain_ab", SHADERS);
  const { sequence } = loadSequence(wsDir);
  const clipId = sequence.spine.clips[0].id;
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/inv", params: {} });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/half", params: {} });
  // Identity reference: same clip, single identity shader, same point in chain.
  const refDir = makeWs("chain_ref", SHADERS);
  const refClip = loadSequence(refDir).sequence.spine.clips[0].id;
  addSpineFx({ workspaceDir: refDir, item: refClip, kind: "ext:shdemo/ident", params: {} });
  const ident = renderChainIntermediate(refDir, "chain_ident");
  assert.ok(ident.frames > 0, "identity intermediate has frames");
  for (let run = 0; run < 10; run++) {
    checkAB(wsDir, ident, `chain_ab_r${run}`);
  }
});

test("A->B->C chain: red channel equals fract(t) on every frame", () => {
  const wsDir = makeWs("chain_abc", SHADERS);
  const { sequence } = loadSequence(wsDir);
  const clipId = sequence.spine.clips[0].id;
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/inv", params: {} });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/half", params: {} });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shdemo/tfill", params: {} });
  for (let run = 0; run < 3; run++) {
    const got = renderChainIntermediate(wsDir, `chain_abc_r${run}`);
    const fb = got.w * got.h * 4;
    const bad: number[] = [];
    for (let f = 0; f < got.frames; f++) {
      const expected = Math.round(((f / 10) % 1) * 255);
      let frameWorst = 0;
      for (let i = 0; i < fb; i += 4) {
        frameWorst = Math.max(frameWorst, Math.abs(got.buf[f * fb + i] - expected));
      }
      if (frameWorst > 2) bad.push(f);
    }
    assert.deepEqual(bad, [], `run ${run}: red channel wrong on frames ${bad.join(",")}`);
  }
});
