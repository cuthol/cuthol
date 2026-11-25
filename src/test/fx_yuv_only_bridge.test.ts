/**
 * YUV-only builtin fx entries get an explicit precise bridge whatever their
 * parameters are (no parameter inspection, the filter is never skipped).
 *
 * `eq` only takes 8-bit YUV (measured on ffmpeg 8.1: `yuv444p16le` negotiates
 * down to `yuv444p`, `yuva420p10le` to `yuva420p`, `gray10le` to `gray`), so
 * ffmpeg used to auto-insert a default-precision conversion around it: a
 * neutral `eq` cost ~53 dB on JPG stills (full-range RGB input) and ~55 dB of
 * luma on 10-bit paths. The fx stage now bridges RGB inputs explicitly to
 * limited-range `yuv444p` and deeper-than-8-bit YUV to its 8-bit twin (same
 * subsampling/alpha), so nothing lossy is left to negotiation.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, transformSpineClip } from "../sequence/spine.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { rmRetrySync } from "./fs_cleanup.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxyuv-"));

test.after(() => rmRetrySync(TMP));

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 300_000 });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

/** Single-frame JPG still with content that survives an 8-bit YUV round trip. */
function makeJpgStill(outPath: string): void {
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1,eq=saturation=0.6",
    "-frames:v", "1", "-q:v", "2",
    outPath,
  ]);
}

/** Short true-10-bit clip (x264 high10 re-quantizes the low bits, as real footage does). */
function makeHi10Clip(outPath: string): void {
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1,eq=saturation=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p10le",
    outPath,
  ]);
}

function buildProject(kind: "still" | "hi10opacity"): { ws: string; clipId: string } {
  const ws = path.join(TMP, `proj-${kind}`);
  initWorkspace({ dir: ws, title: "fxyuv", aspect: "16:9", fps: 30 });
  const media = kind === "still" ? path.join(TMP, "still.jpg") : path.join(TMP, "hi10.mp4");
  if (kind === "still") {
    if (!fs.existsSync(media)) makeJpgStill(media);
  } else if (!fs.existsSync(media)) {
    makeHi10Clip(media);
  }
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
  if (kind === "hi10opacity") transformSpineClip({ workspaceDir: ws, clipId: clip.id, opacity: 0.7 });
  return { ws, clipId: clip.id };
}

/** The filter chain of spine clip #0 (its output pad is `[v_sp_0]`). */
function clipChain(ws: string): string {
  const { sequence, paths } = loadSequence(ws);
  const graph = compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex;
  const chain = graph.split(";").find((c) => c.endsWith("[v_sp_0]"));
  assert.ok(chain, "no chain for spine clip #0");
  return chain;
}

/** Render the whole timeline to raw yuv420p frames. */
function renderRawFrames(ws: string, name: string): Buffer {
  const { sequence, paths } = loadSequence(ws);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const script = path.join(ws, `${name}.graph.txt`);
  fs.writeFileSync(script, plan.filterComplex, "utf8");
  const out = path.join(ws, `${name}.yuv`);
  ffmpeg(
    [
      "-y", "-v", "error",
      ...plan.inputArgs,
      "-/filter_complex", script,
      "-map", plan.videoOutPad, "-f", "rawvideo", "-pix_fmt", "yuv420p", out,
      "-map", plan.audioOutPad, "-f", "null", "-",
    ],
    paths.rootDir
  );
  return fs.readFileSync(out);
}

function psnr(a: Buffer, b: Buffer, w: number, h: number): { y: number; c: number } {
  assert.equal(a.length, b.length);
  const ySize = w * h;
  const frameSize = (ySize * 3) / 2;
  const frames = a.length / frameSize;
  assert.ok(frames >= 25, `expected ~30 frames, got ${frames}`);
  let ySq = 0;
  let cSq = 0;
  for (let f = 0; f < frames; f++) {
    const o = f * frameSize;
    for (let i = 0; i < ySize; i++) ySq += (a[o + i] - b[o + i]) ** 2;
    for (let i = ySize; i < frameSize; i++) cSq += (a[o + i] - b[o + i]) ** 2;
  }
  const p = (sq: number, n: number) => (sq === 0 ? Infinity : 10 * Math.log10((255 * 255 * n) / sq));
  return { y: p(ySq, ySize * frames), c: p(cSq, (frameSize - ySize) * frames) };
}

test("yuv-only entries bridge explicitly: rgb to yuv444p, deep yuv to its 8-bit twin", () => {
  const still = buildProject("still");
  addSpineFx({ workspaceDir: still.ws, clipId: still.clipId, filter: "eq=brightness=0" });
  const stillChain = clipChain(still.ws);
  assert.ok(
    stillChain.includes("format=yuv444p,eq=brightness=0"),
    `still (rgba) must bridge to limited-range yuv444p before eq: ${stillChain.slice(-400)}`
  );

  const hi = buildProject("hi10opacity");
  addSpineFx({ workspaceDir: hi.ws, clipId: hi.clipId, filter: "eq=brightness=0" });
  const hiChain = clipChain(hi.ws);
  assert.ok(
    hiChain.includes("format=yuv420p,eq=brightness=0"),
    `10-bit 420 input must bridge to its 8-bit twin before eq: ${hiChain.slice(-400)}`
  );

  // The bridge does not depend on the parameters: a non-neutral eq gets the same entry.
  const hi2 = buildProject("hi10opacity");
  addSpineFx({ workspaceDir: hi2.ws, clipId: hi2.clipId, filter: "eq=brightness=0.05" });
  assert.ok(
    clipChain(hi2.ws).includes("format=yuv420p,eq=brightness=0.05"),
    "non-neutral eq gets the same precise bridge (no parameter inspection)"
  );
});

test("neutral eq keeps a jpg still: luma exact, chroma at the 8-bit floor (old path: ~53 dB)", () => {
  const { ws, clipId } = buildProject("still");
  const before = renderRawFrames(ws, "nofx");
  addSpineFx({ workspaceDir: ws, clipId, filter: "eq=brightness=0" });
  const after = renderRawFrames(ws, "fx");
  const { y, c } = psnr(before, after, 854, 480);
  assert.ok(y >= 60, `luma PSNR ${y.toFixed(1)} dB`);
  assert.ok(c >= 55, `chroma PSNR ${c.toFixed(1)} dB`);
});

test("non-neutral eq is never skipped: output must differ from the no-fx output", () => {
  for (const kind of ["still", "hi10opacity"] as const) {
    const { ws, clipId } = buildProject(kind);
    const before = renderRawFrames(ws, `nofx-${kind}`);
    addSpineFx({ workspaceDir: ws, clipId, filter: "eq=brightness=0.1" });
    const after = renderRawFrames(ws, `fx-${kind}`);
    assert.notDeepEqual(after, before, `${kind}: eq=brightness=0.1 must change the picture`);
  }
});
