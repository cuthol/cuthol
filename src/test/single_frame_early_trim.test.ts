import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setSpineSpeed, setSpineTransition, setItemEnvelope, transformSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { setSpineMask, setSpineMotionBlur } from "../sequence/spine_treatments.js";
import { setItemColor } from "../sequence/color_edit.js";
import { addLaneCue } from "../sequence/lanes.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { renderMultipleCompositeFramesRgb24 } from "../render/render_frames.js";
import { missingTrialMedia, TRIAL_MEDIA_DIR } from "./fixtures.js";

const TEST_ROOT = path.join(path.resolve(process.cwd(), "test-workspace"), "sf_early_trim");
const FPS = 30;

function ff(args: string[]): void {
  const p = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(p.status, 0, args.join(" ") + "\n" + p.stderr);
}

function ensureMedia(): { png: string; mp4: string } {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const png = path.join(TEST_ROOT, "still.png");
  const mp4 = path.join(TEST_ROOT, "clip.mp4");
  if (!fs.existsSync(png)) {
    ff(["-f", "lavfi", "-i", "color=c=0x90B8D8:s=320x320", "-frames:v", "1", png]);
  }
  if (!fs.existsSync(mp4)) {
    const fixtures = path.join(TRIAL_MEDIA_DIR, "broll_1.mp4");
    if (fs.existsSync(fixtures)) {
      fs.copyFileSync(fixtures, mp4);
    } else {
      test.skip("trial-media broll_1.mp4 absent and no cached clip");
    }
    ff([
      "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=12",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", mp4,
    ]);
  }
  return { png, mp4 };
}

function clipId(seq: { spine: { clips: Array<{ id: string }> } }, n: number): string {
  return seq.spine.clips[n].id;
}

test("single-frame early trim: on/off byte-equal, graph has frame trim and no loop", { skip: missingTrialMedia("broll_1.mp4") }, () => {
  const t0 = Date.now();
  const { png, mp4 } = ensureMedia();
  void png;
  const wsDir = path.join(TEST_ROOT, "ws");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "sf early trim", aspect: "16:9", fps: FPS });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mp4, path.join(TEST_ROOT, "still.png")] });

  const stillH = "img_01";
  const vidH = "vid_01";
  // Long still spine clip (0-20 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: stillH, sourceInMs: 0, sourceOutMs: 20000 });
  // Split still: second half starts at source > 0 (20-22 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: stillH, sourceInMs: 2000, sourceOutMs: 4000 });
  // Footage with rotation envelope (22-24 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 0, sourceOutMs: 2000 });
  // Footage with cubic-bezier scale overshoot + motion layer (24-26 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 2000, sourceOutMs: 4000 });
  // Speed ramp (26-28 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 4000, sourceOutMs: 6000 });
  // Dissolve pair (28-30 s, 30-32 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 6000, sourceOutMs: 8000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 8000, sourceOutMs: 10000 });
  // Raw eq fx (32-34 s), tmix (34-36 s), motion blur (36-38 s), mask (38-40 s),
  // colour block (40-42 s), mirror_x (42-44 s).
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 2000, sourceOutMs: 4000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 4000, sourceOutMs: 6000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 6000, sourceOutMs: 8000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 8000, sourceOutMs: 10000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: vidH, sourceInMs: 0, sourceOutMs: 2000 });

  let { sequence } = loadSequence(wsDir);
  const ids = sequence.spine.clips.map((c) => c.id);
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[2], parameter: "placement.rotation_deg", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: 8, easing: "linear" }] });
  setItemEnvelope({
    workspaceDir: wsDir, targetId: ids[3], parameter: "placement.scale_x",
    points: [
      { offset_ms: 0, value: 1, easing: "linear" },
      { offset_ms: 2000, value: 1.2, easing: "cubic_bezier", bezier: [0.2, 1.6, 0.4, 1] },
    ],
  });
  addSpineFx({ workspaceDir: wsDir, item: ids[3], kind: "motion", params: { x_pct: 4 } });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[3], parameter: "placement.x_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: 2, easing: "linear" }] });
  setSpineSpeed({ workspaceDir: wsDir, clipId: ids[4], speedRamp: [{ source_offset_ms: 0, rate: 1 }, { source_offset_ms: 2000, rate: 0.5 }] });
  setSpineTransition({ workspaceDir: wsDir, clipId: ids[5], transition: { kind: "dissolve", duration_ms: 500, easing: "linear" } });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[7], parameter: "placement.rotation_deg", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: 5, easing: "linear" }] });
  addSpineFx({ workspaceDir: wsDir, item: ids[7], filter: "eq=brightness=0.05" });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[8], parameter: "placement.x_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: -2, easing: "linear" }] });
  addSpineFx({ workspaceDir: wsDir, item: ids[8], filter: "tmix=frames=3" });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[9], parameter: "placement.y_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: 2, easing: "linear" }] });
  setSpineMotionBlur({ workspaceDir: wsDir, clipId: ids[9], shutterDeg: 180, subframes: 3 });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[10], parameter: "placement.scale_x", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 2000, value: 1.1, easing: "linear" }] });
  setSpineMask({ workspaceDir: wsDir, clipId: ids[10], shape: "ellipse", widthPct: 60, heightPct: 60 });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[11], parameter: "placement.rotation_deg", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: -4, easing: "linear" }] });
  setItemColor({ workspaceDir: wsDir, itemId: ids[11], patch: { exposure: { stops: 0.5 } } });
  setItemEnvelope({ workspaceDir: wsDir, targetId: ids[12], parameter: "placement.x_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: 3, easing: "linear" }] });
  transformSpineClip({ workspaceDir: wsDir, clipId: ids[12], mirrorX: true });

  // Still image cue (5-9 s) and moving text cue (10-14 s, base envelope + motion layer).
  const stillCue = addLaneCue({ workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: stillH, atMs: 5000, durationMs: 4000 });
  const textCue = addLaneCue({ workspaceDir: wsDir, laneId: "ln_title", kind: "title", text: "early trim", atMs: 10000, durationMs: 4000 });
  setItemEnvelope({ workspaceDir: wsDir, targetId: textCue.cue.id, parameter: "placement.x_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 4000, value: 4, easing: "linear" }] });
  addSpineFx({ workspaceDir: wsDir, item: textCue.cue.id, kind: "motion", params: { y_pct: -6 } });
  void stillCue;

  const reloaded = loadSequence(wsDir);
  const seq = reloaded.sequence;
  const paths = reloaded.paths;
  void clipId;

  // First, middle, last frame of each item + dissolve interior.
  const atMs: number[] = [];
  const push3 = (start: number, dur: number) => {
    atMs.push(start, start + Math.floor(dur / 2), start + dur - 34);
  };
  push3(0, 20000);
  push3(20000, 2000);
  push3(22000, 2000);
  push3(24000, 2000);
  push3(26000, 2000);
  push3(28000, 2000);
  push3(30000, 2000);
  atMs.push(29750);
  push3(32000, 2000);
  push3(34000, 2000);
  push3(36000, 2000);
  push3(38000, 2000);
  push3(40000, 2000);
  push3(42000, 2000);
  push3(5000, 4000);
  push3(10000, 4000);

  const on = renderMultipleCompositeFramesRgb24(seq, paths, atMs, "draft_480p", {});
  const off = renderMultipleCompositeFramesRgb24(seq, paths, atMs, "draft_480p", { singleFrameEarlyTrim: false });
  assert.equal(on.length, atMs.length);
  assert.equal(off.length, atMs.length);
  for (let i = 0; i < atMs.length; i++) {
    assert.ok(on[i].rgbBuf.equals(off[i].rgbBuf), `byte-equal at ${atMs[i]}ms (index ${i})`);
  }

  // Graph: still clip at 50 s equivalent — use 15000 ms here.
  const plan = compileSequenceRenderPlan(seq, paths, "draft_480p", {
    activeWindowMs: [15000, 15000 + 1000 / FPS],
    singleFrameAtMs: 15000,
  });
  assert.match(plan.filterComplex, /trim=start_frame=\d+:end_frame=\d+/);
  assert.ok(!plan.inputArgs.includes("-loop"), "no -loop inputs in single-frame compile");

  const ms = Date.now() - t0;
  console.log(`single_frame_early_trim total ${Math.round(ms)}ms for ${atMs.length} instants x2`);
});

