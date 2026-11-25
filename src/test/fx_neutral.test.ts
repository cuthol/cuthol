/**
 * A neutral effect must leave the clip's pixels alone.
 *
 * RGB-only filters (`rgbashift`) used to run behind ffmpeg's auto-inserted YUV→RGB converter, whose
 * default path is inexact: on a downscaled, detailed clip a neutral `rgbashift` cost ~25 dB of luma.
 * The fx stage now puts an accurate converter before every entry and hands back the format it
 * received (or RGBA when every later stage works on RGBA); full-range `yuvj*` sources are pinned to
 * their limited-range twin in the fit scale so the range conversion does not move with the filters.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { SPINE_FX_ENTRY_CONVERTER, SPINE_FX_RGBA_EXIT } from "../compositor/compile_spine_fx.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace, NON_FULL_RANGE_FIT_PIX_FMTS } from "../library/probe.js";
import { appendSpineClip, transformSpineClip } from "../sequence/spine.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { setSpineGrade } from "../sequence/spine_grade.js";
import { setSpineMask } from "../sequence/spine_treatments.js";

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

/**
 * Detailed synthetic clip. Saturation is lowered to 0.6 so that every sample stays inside the RGB
 * gamut after scaling: out-of-gamut YUV (full-saturation test bars ring past it when downscaled) is
 * clipped by any trip through RGB, which no converter can undo.
 */
function makeClip(outPath: string, size: string, pixFmt: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=1,eq=saturation=0.6`,
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", pixFmt,
    outPath,
  ]);
}

function withWorkspace(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxn-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "fxn", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The filter chain of the spine clip at `index` (its output pad is `[v_sp_<index>]`). */
function clipChain(filterComplex: string, index: number): string {
  const chain = filterComplex.split(";").find((c) => c.endsWith(`[v_sp_${index}]`));
  assert.ok(chain, `no chain for spine clip #${index}`);
  return chain;
}

test("fx stage: accurate converter per entry, exit to the received format or straight to RGBA", () => {
  withWorkspace((ws) => {
    const tv = path.join(ws, "media", "tv.mp4");
    const full = path.join(ws, "media", "full.mp4");
    makeClip(tv, "640x360", "yuv420p");
    makeClip(full, "640x360", "yuvj420p");
    const [a, b] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [tv, full] });
    const order = ["opaque", "opacity", "mask", "rotation", "contain", "graded", "nofx_full"];
    const ids: Record<string, string> = {};
    for (const name of order) {
      ids[name] = appendSpineClip({ workspaceDir: ws, assetHandle: name === "nofx_full" ? b.handle : a.handle }).clip.id;
    }
    for (const name of ["opaque", "opacity", "mask", "rotation", "contain", "graded"]) {
      addSpineFx({ workspaceDir: ws, clipId: ids[name], filter: "rgbashift=rh=0:bh=0" });
    }
    transformSpineClip({ workspaceDir: ws, clipId: ids.opacity, opacity: 0.7 });
    transformSpineClip({ workspaceDir: ws, clipId: ids.rotation, rotationDeg: 5 });
    setSpineMask({ workspaceDir: ws, clipId: ids.mask, shape: "ellipse", widthPct: 80, heightPct: 80 });
    transformSpineClip({ workspaceDir: ws, clipId: ids.contain, fitMode: "contain", scale: 0.8 });
    // A legacy grade with a colour temperature negotiates its own format: the exit must not force one.
    setSpineGrade({ workspaceDir: ws, clipId: ids.graded, brightness: 0.05, temperatureK: 5500 });

    const { sequence, paths } = loadSequence(ws);
    const graph = compileSequenceRenderPlan(sequence, paths, "draft_480p").filterComplex;

    const opaque = clipChain(graph, order.indexOf("opaque"));
    assert.ok(opaque.includes(`${SPINE_FX_ENTRY_CONVERTER},rgbashift=rh=0:bh=0,${SPINE_FX_ENTRY_CONVERTER}:out_range=tv,format=yuv420p`), opaque);
    assert.ok(!opaque.includes(SPINE_FX_RGBA_EXIT), "opaque full-frame clip stays YUV after fx");
    for (const name of ["opacity", "mask", "rotation", "contain"]) {
      const chain = clipChain(graph, order.indexOf(name));
      assert.ok(chain.includes(`rgbashift=rh=0:bh=0,${SPINE_FX_RGBA_EXIT}`), `${name}: ${chain}`);
    }
    const graded = clipChain(graph, order.indexOf("graded"));
    assert.ok(graded.includes(`colortemperature=temperature=5500,${SPINE_FX_ENTRY_CONVERTER},rgbashift=rh=0:bh=0,${SPINE_FX_ENTRY_CONVERTER},`), graded);
    assert.ok(!graded.includes(`rgbashift=rh=0:bh=0,${SPINE_FX_ENTRY_CONVERTER}:out_range=tv,format=`), "unknown received format is not forced");
    const pinned = clipChain(graph, order.indexOf("nofx_full"));
    assert.ok(
      pinned.includes(`in_range=pc:out_range=tv,format=pix_fmts=${NON_FULL_RANGE_FIT_PIX_FMTS},`),
      "full-range source leaves the fit scale in a limited-range format"
    );
    assert.ok(!NON_FULL_RANGE_FIT_PIX_FMTS.includes("yuvj"));
    assert.ok(!pinned.includes(SPINE_FX_ENTRY_CONVERTER), "no fx, no converter");
  });
});

/** Runs the compiled graph to raw yuv420p frames (no encoder in between). */
function renderRawFrames(ws: string, outPath: string): Buffer {
  const { sequence, paths } = loadSequence(ws);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  const script = path.join(path.dirname(outPath), `${path.basename(outPath)}.graph.txt`);
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
  return fs.readFileSync(outPath);
}

test("neutral rgbashift keeps luma on a downscaled vertical clip (old path: 38 dB)", () => {
  withWorkspace((ws) => {
    const tall = path.join(ws, "media", "tall.mp4");
    makeClip(tall, "720x1280", "yuv420p");
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [tall] });
    const { clip } = appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
    const out = path.join(ws, "out");
    fs.mkdirSync(out);
    const before = renderRawFrames(ws, path.join(out, "nofx.yuv"));
    addSpineFx({ workspaceDir: ws, clipId: clip.id, filter: "rgbashift=rh=0:bh=0" });
    const after = renderRawFrames(ws, path.join(out, "fx.yuv"));
    assert.equal(after.length, before.length);

    const w = 854;
    const h = 480;
    const ySize = w * h;
    const frameSize = ySize * 1.5;
    const frames = before.length / frameSize;
    assert.ok(frames >= 25, `expected ~30 frames, got ${frames}`);
    let ySq = 0;
    let cSq = 0;
    for (let f = 0; f < frames; f++) {
      const o = f * frameSize;
      for (let i = 0; i < ySize; i++) ySq += (before[o + i] - after[o + i]) ** 2;
      for (let i = ySize; i < frameSize; i++) cSq += (before[o + i] - after[o + i]) ** 2;
    }
    const psnr = (sq: number, n: number) => (sq === 0 ? Infinity : 10 * Math.log10((255 * 255 * n) / sq));
    const yPsnr = psnr(ySq, ySize * frames);
    const cPsnr = psnr(cSq, (frameSize - ySize) * frames);
    // Measured 2026-11: new path Y 70.6 dB / chroma ~51 dB; the auto-inserted converter gave Y 37.9 / chroma ~43.
    assert.ok(yPsnr >= 60, `luma PSNR ${yPsnr.toFixed(1)} dB`);
    assert.ok(cPsnr >= 47, `chroma PSNR ${cPsnr.toFixed(1)} dB`);
  });
});
