/**
 * 44.1 kHz source renders at 48 kHz on every render path
 * (`src/test/audio_48k_rate.test.ts`).
 *
 * The segmented render path resamples to 48 kHz stereo, but the
 * single-segment master-finalize path kept the source rate
 * (`buildMasterAudioFinalizeFilter`: the multi-pad finalize branch had no
 * `aformat`). This test fails on the old build for that reason.
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RENDER_AUDIO_OUT_RATE_ARGS } from "../render/render_encode.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_ROOT = path.resolve("test-workspace/audio_48k_rate");

function probeAudioRate(mp4Path: string): number {
  const proc = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate",
      "-of",
      "csv=p=0",
      mp4Path,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
  return Number(proc.stdout.trim());
}

test("1. Every render mux pins 48 kHz stereo output (plan itself unchanged)", () => {
  assert.deepEqual(RENDER_AUDIO_OUT_RATE_ARGS, ["-ar", "48000", "-ac", "2"]);
});

function build441Project(wsDir: string): void {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Audio 48k Rate", aspect: "16:9", fps: 30 });
  const mediaDir = path.join(wsDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const spineMp4 = path.join(mediaDir, "spine.mp4");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1E293B:s=640x360:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.2*sin(2*PI*220*t)':s=44100:d=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    spineMp4,
  ]);
  // Music source natively at 44.1 kHz (two pads -> master finalize path).
  const bgmWav = path.join(mediaDir, "bgm_441.wav");
  spawnSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.15*sin(2*PI*110*t)|0.15*sin(2*PI*110*t)':s=44100:d=3",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "44100",
    bgmWav,
  ]);
  const rate = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", bgmWav],
    { encoding: "utf8" }
  );
  assert.equal(Number(rate.stdout.trim()), 44100, "fixture music must be 44.1 kHz");
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [spineMp4, bgmWav] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 3000,
  });
}

test("2. Single-segment draft render of a 44.1 kHz project outputs 48 kHz audio", () => {
  const wsDir = path.join(TEST_ROOT, "ws_single_441");
  build441Project(wsDir);
  const prev = process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
  process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = "24";
  try {
    const out = path.join(wsDir, "output", "single_441.mp4");
    const summary = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
    assert.equal(summary.ok, true);
    assert.equal(probeAudioRate(out), 48000);
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
    else process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = prev;
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("3. Segmented draft render of a 44.1 kHz project outputs 48 kHz audio", () => {
  const wsDir = path.join(TEST_ROOT, "ws_seg_441");
  build441Project(wsDir);
  const prev = process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
  process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = "1";
  try {
    const out = path.join(wsDir, "output", "seg_441.mp4");
    const summary = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
    assert.equal(summary.ok, true);
    assert.equal(probeAudioRate(out), 48000);
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS;
    else process.env.CUTHOL_RENDER_SEGMENT_MAX_CLIPS = prev;
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});
