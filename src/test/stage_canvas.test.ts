/**
 * Dynamic canvas: free stage size, first-source adoption, stage resize.
 *
 * Covers `workspace init --size`, dimension-driven orientation (custom sizes),
 * first-visual-source adoption (and suggestion when explicit), `workspace
 * stage` rescale with journal undo, and custom-size cue sheet round-trip.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseStageSize } from "../core/schema.js";
import { isVerticalStage } from "../core/standards.js";
import { initWorkspace, loadSequence, resolveWorkspacePaths, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import {
  exportSequenceToCueSheet,
  mergeCueSheetIntoSequence,
} from "../sequence/cuesheet.js";
import { resizeStage } from "../sequence/stage_resize.js";

function makeClip(filePath: string, size: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=#334155:s=${size}:r=30:d=2`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      filePath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr}`);
}

test("stage: parseStageSize accepts even sizes and rejects bad input", () => {
  assert.deepEqual(parseStageSize("1920x800"), { width: 1920, height: 800 });
  assert.deepEqual(parseStageSize("1080X1350"), { width: 1080, height: 1350 });
  for (const bad of ["1920", "1920x801", "0x0", "15x16", "99999x16", "axb", ""]) {
    assert.throws(() => parseStageSize(bad), /Invalid stage size/);
  }
});

test("stage: custom sizes orient by dimensions, not by preset name", () => {
  assert.equal(isVerticalStage({ width: 1920, height: 800, aspect: "custom" }), false);
  assert.equal(isVerticalStage({ width: 800, height: 1920, aspect: "custom" }), true);
});

test("stage: init marks explicit vs adoptable projects", () => {
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-custom-"));
  const { sequence: custom } = initWorkspace({
    dir: customDir,
    size: { width: 1920, height: 800 },
    stageExplicit: true,
  });
  assert.equal(custom.stage.aspect, "custom");
  assert.deepEqual([custom.stage.width, custom.stage.height], [1920, 800]);
  assert.equal(custom.stage.set_explicit, true);

  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-cli-"));
  const { sequence: cliLike } = initWorkspace({ dir: cliDir, adoptFirstSource: true });
  assert.equal(cliLike.stage.aspect, "9:16");
  assert.equal(cliLike.stage.set_explicit, undefined);

  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-legacy-"));
  const { sequence: legacy } = initWorkspace({ dir: legacyDir, aspect: "9:16" });
  assert.equal(legacy.stage.set_explicit, true);
});

test("stage: first visual source is adopted on an adoptable project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-adopt-"));
  initWorkspace({ dir, adoptFirstSource: true });
  const clip = path.join(dir, "clip.mp4");
  makeClip(clip, "1080x1350");
  const ingested = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [clip] });
  assert.equal(ingested.length, 1);
  const { verification } = appendSpineClip({ workspaceDir: dir, assetHandle: ingested[0].handle });
  const { sequence } = loadSequence(dir);
  assert.deepEqual([sequence.stage.width, sequence.stage.height], [1080, 1350]);
  assert.equal(sequence.stage.aspect, "4:5");
  assert.ok(
    verification.diagnostics.some((d) => d.code === "CUTHOL-G151"),
    "adoption INFO line missing"
  );
});

test("stage: explicit stage only suggests the source size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-suggest-"));
  initWorkspace({ dir, aspect: "16:9" });
  const clip = path.join(dir, "clip.mp4");
  makeClip(clip, "1080x1350");
  const ingested = ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [clip] });
  const { verification } = appendSpineClip({ workspaceDir: dir, assetHandle: ingested[0].handle });
  const { sequence } = loadSequence(dir);
  assert.deepEqual([sequence.stage.width, sequence.stage.height], [1920, 1080]);
  assert.ok(
    verification.diagnostics.some((d) => d.code === "CUTHOL-G152"),
    "suggestion INFO line missing"
  );
});

test("stage: resize rescales fonts/uniforms and undo restores bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-resize-"));
  initWorkspace({ dir, aspect: "16:9" });
  addLaneCue({
    workspaceDir: dir,
    laneId: "ln_titles",
    kind: "title",
    text: "Hello",
    atMs: 0,
    durationMs: 2000,
  });
  const paths = resolveWorkspacePaths(dir);
  const beforeBytes = fs.readFileSync(paths.sequenceFile, "utf8");
  const beforeFont = loadSequence(dir).sequence.lanes.find((l) => l.id === "ln_titles")!.cues[0]
    .typography!.font_size_px;
  const res = resizeStage({ workspaceDir: dir, size: "960x540" });
  assert.deepEqual([res.next.width, res.next.height], [960, 540]);
  assert.equal(res.next.aspect, "custom");
  const after = loadSequence(dir).sequence;
  assert.equal(after.stage.set_explicit, true);
  // uniform factor min(0.5, 0.5) = 0.5 halves the font size
  assert.equal(
    after.lanes.find((l) => l.id === "ln_titles")!.cues[0].typography!.font_size_px,
    Math.max(1, Math.round(beforeFont * 0.5))
  );
  assert.equal(res.moved.captions, 1);
  // Placement scales are stage-relative (fit to the new stage): untouched, so full-frame stays full-frame.
  const beforeCue = JSON.parse(beforeBytes).lanes.find((l: { id: string }) => l.id === "ln_titles").cues[0];
  const afterCue = after.lanes.find((l) => l.id === "ln_titles")!.cues[0];
  assert.deepEqual([afterCue.placement.scale_x, afterCue.placement.scale_y], [beforeCue.placement.scale_x, beforeCue.placement.scale_y]);
  stepJournal(dir, "undo", 1);
  assert.equal(fs.readFileSync(paths.sequenceFile, "utf8"), beforeBytes);
});

test("stage: cue sheet round-trips a custom size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-sheet-"));
  const { sequence } = initWorkspace({ dir, size: { width: 1920, height: 800 }, stageExplicit: true });
  const sheet = exportSequenceToCueSheet(sequence);
  assert.equal(sheet.stage!.aspect, "custom");
  assert.equal(sheet.stage!.width, 1920);
  assert.equal(sheet.stage!.height, 800);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "stage-sheet2-"));
  const base = initWorkspace({ dir: dir2, aspect: "16:9" }).sequence;
  const { nextSeq } = mergeCueSheetIntoSequence(base, {
    stage: { aspect: "custom", width: 1920, height: 800 },
  });
  assert.deepEqual([nextSeq.stage.width, nextSeq.stage.height], [1920, 800]);
  assert.equal(nextSeq.stage.set_explicit, true);
});
