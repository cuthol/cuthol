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
import { renderSequenceToMp4, renderSingleCompositeFrameRgb24 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setItemEnvelope, transformSpineClip } from "../sequence/spine.js";
import { setStageBackdropColor } from "../sequence/stage.js";

function genMedia(target: string, lavfi: string, extraArgs: string[] = []): void {
  const proc = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", lavfi,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", ...extraArgs, target,
  ]);
  assert.equal(proc.status, 0, proc.stderr?.toString());
}

function nearPureRed(rgb: Buffer, x: number, y: number, w: number): boolean {
  const i = (y * w + x) * 3;
  return rgb[i] > 200 && rgb[i + 1] < 80 && rgb[i + 2] < 80;
}

function nearPureBlue(rgb: Buffer, x: number, y: number, w: number): boolean {
  const i = (y * w + x) * 3;
  return rgb[i + 2] > 200 && rgb[i] < 80 && rgb[i + 1] < 80;
}

function setupRedBackdropSpine(wsDir: string, rotation: { deg?: string; envelope?: boolean }): void {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "rot", aspect: "16:9", fps: 30 });
  setStageBackdropColor({ workspaceDir: wsDir, color: "#FF0000" });
  const media = path.join(wsDir, "nored.mp4");
  genMedia(media, "testsrc2=size=640x360:rate=30:d=8", ["-vf", "colorchannelmixer=rr=0"]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 8000 });
  if (rotation.deg) transformSpineClip({ workspaceDir: wsDir, clipId: "sp_02", rotationDeg: rotation.deg });
  if (rotation.envelope) {
    setItemEnvelope({
      workspaceDir: wsDir, targetId: "sp_02", parameter: "placement.rotation_deg",
      points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 6000, value: 20, easing: "linear" }],
    });
  }
}

function cornersAreRed(w: number, h: number, rgb: Buffer): boolean {
  return (
    nearPureRed(rgb, 0, 0, w) &&
    nearPureRed(rgb, w - 1, 0, w) &&
    nearPureRed(rgb, 0, h - 1, w) &&
    nearPureRed(rgb, w - 1, h - 1, w)
  );
}

/** Full render, then one frame out as rgb24: sequential frames leave no fresh zero buffer behind. */
function renderFrameRgb(wsDir: string, mp4Name: string, atSec: number): { w: number; h: number; rgb: Buffer } {
  const outMp4 = path.join(wsDir, mp4Name);
  const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 400));
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", outMp4,
  ]);
  assert.equal(probe.status, 0);
  const [w, h] = probe.stdout.toString().trim().split(",").map(Number);
  const raw = path.join(wsDir, "frame.rgb");
  const grab = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-ss", String(atSec), "-i", outMp4,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
  ]);
  assert.equal(grab.status, 0);
  const rgb = fs.readFileSync(raw);
  assert.equal(rgb.length, w * h * 3, `expected ${w}x${h} rgb24, got ${rgb.length} bytes`);
  fs.rmSync(raw, { force: true });
  return { w, h, rgb };
}

test("rotated spine clip corners show the backdrop, not stale pixels (static angle)", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-rot-static-"));
  try {
    setupRedBackdropSpine(wsDir, { deg: "15" });
    const { w, h, rgb } = renderFrameRgb(wsDir, "out.mp4", 4);
    assert.ok(cornersAreRed(w, h, rgb), "stage corners must be backdrop red over a rotated clip");
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("rotated spine clip corners show the backdrop, not stale pixels (rotation envelope)", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-rot-env-"));
  try {
    setupRedBackdropSpine(wsDir, { envelope: true });
    const { paths, sequence } = loadSequence(wsDir);
    const frame = renderSingleCompositeFrameRgb24(sequence, paths, 5500, "draft_480p");
    assert.ok(
      cornersAreRed(frame.width, frame.height, frame.rgbBuf),
      "stage corners must be backdrop red under a rotation envelope at 5.5s"
    );
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("rotated lane footage cue corners show the spine layer underneath (rotation envelope)", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-rot-lane-"));
  try {
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "rot lane", aspect: "16:9", fps: 30 });
    const blue = path.join(wsDir, "blue.mp4");
    genMedia(blue, "color=color=blue:size=640x360:rate=30:d=4");
    const nored = path.join(wsDir, "nored.mp4");
    genMedia(nored, "testsrc2=size=640x360:rate=30:d=4", ["-vf", "colorchannelmixer=rr=0"]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [blue, nored] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    addLaneCue({
      workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: "vid_02",
      atMs: 0, durationMs: 4000, explicitId: "cue_01",
    });
    setItemEnvelope({
      workspaceDir: wsDir, targetId: "cue_01", parameter: "placement.rotation_deg",
      points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 4000, value: 20, easing: "linear" }],
    });
    const { w, h, rgb } = renderFrameRgb(wsDir, "out.mp4", 2);
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) {
      assert.ok(nearPureBlue(rgb, x, y, w), `corner (${x},${y}) must show the blue spine layer`);
    }
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("single-frame compile of a lane footage cue applies the early trim behind a constant anchor", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-rot-trim-"));
  try {
    fs.rmSync(wsDir, { recursive: true, force: true });
    initWorkspace({ dir: wsDir, title: "rot trim", aspect: "16:9", fps: 30 });
    const media = path.join(wsDir, "nored.mp4");
    genMedia(media, "testsrc2=size=640x360:rate=30:d=12", ["-vf", "colorchannelmixer=rr=0"]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 12000 });
    addLaneCue({
      workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: "vid_01",
      atMs: 0, durationMs: 10000, rotationDeg: 15,
    });
    const { paths, sequence } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      includeAudio: false,
      singleFrameAtMs: 8000,
    });
    assert.match(plan.filterComplex, /trim=start_frame=\d+:end_frame=\d+/, "lane cue chain must carry the early single-frame trim");
    assert.ok(!plan.filterComplex.includes("PTS-STARTPTS+"), "trailing anchor must be the constant-offset form");
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
