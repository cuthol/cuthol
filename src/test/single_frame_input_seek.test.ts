// Single-frame input narrowing: a late instant seeks the input near the
// requested frame (CFR), while a late VFR instant keeps the old path and
// still matches the render frame.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import { missingTrialMedia, TRIAL_MEDIA_DIR } from "./fixtures.js";

import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSingleCompositeFrameRgb24 } from "../render/render_frames.js";
import { appendSpineClip } from "../sequence/spine_edit.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir: string): void {
  try {
    rmRetrySync(dir);
  } catch {
    // ignore cleanup error
  }
}

function makeCfr(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=s=480x270:r=30:d=${seconds}`,
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    { encoding: "utf8", timeout: 120_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg cfr failed: ${proc.stderr}`);
}

function makeVfrSubclip(outPath: string): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      "55",
      "-t",
      "10",
      "-i",
      path.join(TRIAL_MEDIA_DIR, "talk.mp4"),
      "-c",
      "copy",
      outPath,
    ],
    { encoding: "utf8", timeout: 120_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg subclip failed: ${proc.stderr}`);
}

function seekOfPlan(plan: { inputArgs: string[] }): number | null {
  for (let k = 0; k < plan.inputArgs.length; k++) {
    if (plan.inputArgs[k] === "-ss") return Number(plan.inputArgs[k + 1]);
  }
  return null;
}

test("single-frame plan of a late instant seeks the input near the instant", { timeout: 300_000 }, () => {
  const tmpDir = makeTempDir("cuthol-sf-seek-");
  try {
    const mediaPath = path.join(tmpDir, "cfr.mp4");
    makeCfr(mediaPath, 12);
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "sf-seek", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaPath] });
    const { sequence: seq0 } = loadSequence(wsDir);
    const handle = seq0.library.find((a) => a.probe.has_video)!.handle;
    appendSpineClip({ workspaceDir: wsDir, assetHandle: handle, sourceInMs: 0, sourceOutMs: 11000 });

    const { paths, sequence } = loadSequence(wsDir);
    const ms = 9000;
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      workers: 1,
      activeWindowMs: [ms, ms + 1000 / 30],
      singleFrameAtMs: ms,
      includeAudio: false,
    });
    // Late instant (9 s into the clip, 2 s margin): the input seeks to ~7 s
    // instead of decoding from the clip start.
    const seek = seekOfPlan(plan);
    assert.ok(seek !== null && seek > 6 && seek < 8, `expected input -ss near 7 s, got ${seek}`);
    // The timeline placement is re-anchored to the narrowed start so the
    // selected slot lands exactly on the frame-grid instant (9 s - 2 s).
    assert.ok(
      plan.filterComplex.includes("setpts=PTS+7.000000/TB"),
      `expected re-anchored setpts, got ${plan.filterComplex.slice(0, 400)}`
    );
  } finally {
    safeRm(tmpDir);
  }
});

test("late VFR single frame matches the render frame", { timeout: 300_000, skip: missingTrialMedia("talk.mp4") }, () => {
  const tmpDir = makeTempDir("cuthol-sf-vfr-");
  try {
    const mediaPath = path.join(tmpDir, "vfr.mp4");
    makeVfrSubclip(mediaPath);
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "sf-vfr", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaPath] });
    const { sequence: seq0 } = loadSequence(wsDir);
    const asset = seq0.library.find((a) => a.probe.has_video)!;
    assert.equal(asset.probe.is_vfr, true, "subclip must stay VFR for this test");
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: asset.handle,
      sourceInMs: 0,
      sourceOutMs: 10000,
    });

    const { paths, sequence } = loadSequence(wsDir);
    const ms = 9000;
    const single = renderSingleCompositeFrameRgb24(sequence, paths, ms, "draft_480p", {
      skipGates: ["G2_ASSETS"],
    });
    const fullPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { workers: 1 });
    const fps = sequence.stage.fps;
    const frameIdx = Math.floor((ms * fps) / 1000 + 1e-6);
    const vi = fullPlan.filterComplex.indexOf(fullPlan.videoOutPad);
    const fc = `${fullPlan.filterComplex.slice(0, vi + fullPlan.videoOutPad.length)};${fullPlan.videoOutPad}select='eq(n,${frameIdx})',scale=in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24[o]`;
    const proc = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        ...fullPlan.inputArgs,
        "-filter_complex",
        fc,
        "-map",
        "[o]",
        "-fps_mode",
        "passthrough",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { cwd: paths.rootDir, maxBuffer: 2 ** 31, timeout: 240_000, windowsHide: true }
    );
    assert.equal(proc.status, 0, `render-plan decode failed: ${String(proc.stderr).slice(0, 300)}`);
    const rendered = proc.stdout as Buffer;
    assert.equal(rendered.length, single.rgbBuf.length);
    const a = Buffer.from(single.rgbBuf);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== rendered[i]) diff++;
    assert.equal(diff, 0, `late VFR single frame differs from render in ${diff} bytes`);
  } finally {
    safeRm(tmpDir);
  }
});
