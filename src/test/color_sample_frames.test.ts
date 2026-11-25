// Frame sampling for colour measurement: still-image clamp and batched input-seek decodes.
import "./test_setup.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace, resolveSourceColorSpec } from "../library/probe.js";
import { buildSourceScaleFilter } from "../compositor/compile_color.js";
import { appendSpineClip } from "../sequence/spine.js";
import { decodeFrameRgb24, loadReferenceFrames, sampleItemFrames } from "../color/frames.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-frames-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function ffmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

/** Legacy single-frame decode exactly like the old output-seek path (reference oracle). */
function legacyOutputSeek(file: string, atSec: number, width: number, vf: string, height: number): Buffer {
  const out = path.join(ROOT, `legacy-${Math.round(Math.random() * 1e9)}.raw`);
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", file, "-ss", String(Math.max(0, atSec)), "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", out],
    { encoding: "buffer", windowsHide: true }
  );
  assert.equal(r.status, 0, String(r.stderr).slice(0, 300));
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  return buf.subarray(0, width * height * 3);
}

function solidPng(out: string, color: string): void {
  ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1`, "-frames:v", "1", out]);
}

function withWorkspace(name: string, files: string[]): string {
  const wsDir = path.join(ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: files });
  return wsDir;
}

function streamHeight(file: string, width: number): number {
  const probe = spawnSync(
    "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true }
  );
  const [sw, sh] = String(probe.stdout).trim().split(/[,\s]+/).map(Number);
  return Math.max(2, Math.round((sh * width) / sw / 2) * 2);
}

describe("still-image spine clip sampling", () => {
  it("samples the still frame instead of failing past its duration", () => {
    const png = path.join(ROOT, "still.png");
    solidPng(png, "0xC2185B");
    const wsDir = withWorkspace("ws-still", [png]);
    const handle = loadSequence(wsDir).sequence.library[0].handle;
    appendSpineClip({ workspaceDir: wsDir, assetHandle: handle, sourceInMs: 0, sourceOutMs: 5000 });
    const set = sampleItemFrames({ workspaceDir: wsDir, itemId: "sp_01", width: 64 });
    assert.equal(set.frames.length, 7);
    for (const f of set.frames) assert.deepEqual(f, set.frames[0], "a still has no time axis: every sample is the same frame");
    assert.ok(set.frames[0][0] > 0.5, "the still decodes to its red pixels, not black");
  });

  it("sees a replaced source file (no stale cache hides real changes)", () => {
    const png = path.join(ROOT, "counter.png");
    solidPng(png, "0xC2185B");
    const setA = loadReferenceFrames(png, { width: 64 });
    solidPng(png, "0x2563EB");
    const st = fs.statSync(png);
    fs.utimesSync(png, st.atime, new Date(st.mtimeMs + 2000));
    const setB = loadReferenceFrames(png, { width: 64 });
    assert.notDeepEqual(Array.from(setB.frames[0].slice(0, 48)), Array.from(setA.frames[0].slice(0, 48)), "edited source must decode differently");
  });
});

describe("batched input-seek decode equality", () => {
  it("matches the old output-seek decode byte-for-byte (full-range, 10-bit, in-point)", async () => {
    const full = path.join(ROOT, "fullrange.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=3", "-vf", "format=yuvj420p", "-c:v", "libx264", "-pix_fmt", "yuvj420p", full]);
    const bit10 = path.join(ROOT, "bit10.mp4");
    ffmpeg(["-f", "lavfi", "-i", "smptebars=size=320x180:rate=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv422p10le", bit10]);
    const wsDir = withWorkspace("ws-batch", [full, bit10]);
    const lib = loadSequence(wsDir).sequence.library;
    assert.equal(lib.length, 2, "both clips ingested");
    const fullAsset = lib[0];
    const bitAsset = lib[1];
    appendSpineClip({ workspaceDir: wsDir, assetHandle: fullAsset.handle, sourceInMs: 1200, sourceOutMs: 3000 });
    const framesModule = (await import("../color/frames.js")) as typeof import("../color/frames.js") & {
      decodeFramesBatch?: (file: string, atSecs: number[], width: number, asset?: never) => Array<{ width: number; height: number; data: Buffer }>;
    };
    assert.ok(framesModule.decodeFramesBatch, "batched input-seek decoder missing");
    const decodeFramesBatch = framesModule.decodeFramesBatch;
    for (const [file, asset] of [[full, fullAsset], [bit10, bitAsset]] as const) {
      const atSecs = [0.2, 1.0, 1.7];
      const batched = decodeFramesBatch(file, atSecs, 96, asset as never);
      const spec = { ...resolveSourceColorSpec(asset.probe, file), fitPixFmt: undefined };
      const chain = spec.isRgb ? `scale=96:-2` : `${buildSourceScaleFilter(96, -2, spec)},scale=in_color_matrix=bt709:in_range=tv:out_range=full`;
      const h = streamHeight(file, 96);
      for (let i = 0; i < atSecs.length; i++) {
        const legacy = legacyOutputSeek(file, atSecs[i], 96, chain, h);
        assert.deepEqual(Buffer.from(batched[i].data), legacy, `${path.basename(file)} @${atSecs[i]}s differs from output-seek decode`);
      }
    }
    const set = sampleItemFrames({ workspaceDir: wsDir, itemId: "sp_01", width: 96, count: 5 });
    assert.equal(set.frames.length, 5);
    void decodeFrameRgb24;
  });
});
