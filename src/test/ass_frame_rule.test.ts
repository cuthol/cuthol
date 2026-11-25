/**
 * ASS caption frame rule: generated ASS Start/End times must show the caption
 * on exactly the frames that `cueCoversTimeMs` gives (half-open [start, end)
 * evaluated at frame times `n * 1000 / fps`), at 24/25/30/60 fps, including
 * times on and just past frame boundaries.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatAssTime } from "../compositor/ass_generator.js";
import { cueCoversTimeMs, snapAssEndMs, snapAssStartMs } from "../core/frame_time.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine_edit.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

function parseAssMs(t: string): number {
  const m = /^(\d+):(\d\d):(\d\d)\.(\d\d)$/.exec(t);
  assert.ok(m, `bad ASS time ${t}`);
  return (
    Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10
  );
}

function framesShownByRule(startMs: number, endMs: number, fps: number): number[] {
  const out: number[] = [];
  const lo = Math.max(0, Math.floor((startMs / 1000) * fps) - 3);
  const hi = Math.ceil((endMs / 1000) * fps) + 3;
  for (let n = lo; n <= hi; n++) {
    if (cueCoversTimeMs(startMs, endMs, (n * 1000) / fps)) out.push(n);
  }
  return out;
}

function framesShownByAss(startMs: number, endMs: number, fps: number): number[] {
  // Same path as the Dialogue events: snap to the frame grid, then format.
  const aStart = parseAssMs(formatAssTime(snapAssStartMs(startMs, fps)));
  const aEnd = parseAssMs(formatAssTime(snapAssEndMs(endMs, fps)));
  assert.ok(aEnd > aStart, `ASS end must be after start for [${startMs}, ${endMs})`);
  const out: number[] = [];
  const lo = Math.max(0, Math.floor((startMs / 1000) * fps) - 3);
  const hi = Math.ceil((endMs / 1000) * fps) + 3;
  for (let n = lo; n <= hi; n++) {
    if (cueCoversTimeMs(aStart, aEnd, (n * 1000) / fps)) out.push(n);
  }
  return out;
}

test("ass caption times cover exactly the cue frames", () => {
  const fpsList = [24, 25, 30, 60];
  const cases: Array<[number, number]> = [
    [1035, 2005],
    [1000, 2000],
    [0, 500],
    [100, 100],
    [100, 101],
    [999, 1001],
    [1000, 1001],
    [33, 67],
    [34, 68],
    [1000 / 3, 2000],
    [1500, 2500],
    [41, 42],
    [40, 80],
    [1234, 5678],
  ];
  for (const fps of fpsList) {
    // Times exactly on frame boundaries and 1ms past them.
    const frameMs = [0, 1, 2, 7, 29, 30, 31, 59, 60, 61, 100].map(
      (n) => (n * 1000) / fps
    );
    const gridCases: Array<[number, number]> = [];
    for (const t of frameMs) {
      gridCases.push([Math.round(t), Math.round(t) + 500]);
      gridCases.push([Math.round(t) + 1, Math.round(t) + 501]);
    }
    for (const [rawS, rawE] of [...cases, ...gridCases]) {
      // Cue times are integer milliseconds in practice (`formatAssTime` rounds).
      const s = Math.round(rawS);
      const e = Math.round(rawE);
      if (e <= s) continue;
      // A cue covering zero frames cannot be represented as an ASS event;
      // real caption cues always span frames.
      if (framesShownByRule(s, e, fps).length === 0) continue;
      assert.deepEqual(
        framesShownByAss(s, e, fps),
        framesShownByRule(s, e, fps),
        `fps=${fps} cue=[${s}, ${e})`
      );
    }
  }
});

test("draft render shows each caption on exactly the cue frames", () => {
  const wsDir = path.join(TEST_ROOT, "ass_frame_rule_render");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "ASS frame rule", aspect: "16:9", fps: 30 });

  const bgFile = path.join(wsDir, "bg.mp4");
  let proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=#1E3A8A:s=1280x720:r=30:d=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      bgFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [bgFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 5000 });

  // Caption 1 lives in the upper half, caption 2 in the lower half, so a
  // white-pixel scan per half tells which caption each frame shows.
  addLaneCue({
    workspaceDir: wsDir, laneId: "ln_captions", kind: "caption",
    atMs: 1035, durationMs: 970, yPct: -25, fontSizePx: 64,
    colorHex: "#FFFFFF", text: "CAPTION ONE HERE",
  });
  addLaneCue({
    workspaceDir: wsDir, laneId: "ln_captions", kind: "caption",
    atMs: 2500, durationMs: 1500, yPct: 25, fontSizePx: 64,
    colorHex: "#FFFFFF", text: "CAPTION TWO HERE",
  });

  const res = renderSequenceToMp4({
    workspaceDir: wsDir, preset: "draft_480p",
    outputPath: "output/ass_rule.mp4", workers: 2, encoder: "libx264",
  });
  assert.equal(res.ok, true);
  const fps = 30;
  const cue1Expected: number[] = [];
  const cue2Expected: number[] = [];
  for (let n = 0; n < Math.ceil((5000 / 1000) * fps); n++) {
    const t = (n * 1000) / fps;
    if (cueCoversTimeMs(1035, 2005, t)) cue1Expected.push(n);
    if (cueCoversTimeMs(2500, 4000, t)) cue2Expected.push(n);
  }
  assert.ok(cue1Expected.length > 0 && cue2Expected.length > 0);

  const rawPath = path.join(wsDir, "frames.raw");
  proc = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", res.output_path, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
  const frameBytes = res.width * res.height * 3;
  const raw = fs.readFileSync(rawPath);
  const frameCount = Math.floor(raw.length / frameBytes);
  assert.ok(frameCount >= cue2Expected[cue2Expected.length - 1], `only ${frameCount} frames dumped`);

  const WHITE_MIN = 200;
  const PIXEL_THRESHOLD = 100;
  const cue1Shown: number[] = [];
  const cue2Shown: number[] = [];
  for (let n = 0; n < frameCount; n++) {
    const base = n * frameBytes;
    let topWhite = 0;
    let bottomWhite = 0;
    for (let y = 0; y < res.height; y++) {
      const rowBase = base + y * res.width * 3;
      for (let x = 0; x < res.width; x++) {
        const o = rowBase + x * 3;
        if (raw[o] >= WHITE_MIN && raw[o + 1] >= WHITE_MIN && raw[o + 2] >= WHITE_MIN) {
          if (y < res.height / 2) topWhite++;
          else bottomWhite++;
        }
      }
    }
    if (topWhite > PIXEL_THRESHOLD) cue1Shown.push(n);
    if (bottomWhite > PIXEL_THRESHOLD) cue2Shown.push(n);
  }
  fs.rmSync(rawPath, { force: true });
  assert.deepEqual(cue1Shown, cue1Expected, `caption 1 frames, got ${cue1Shown.join(",")}`);
  assert.deepEqual(cue2Shown, cue2Expected, `caption 2 frames, got ${cue2Shown.join(",")}`);
});
