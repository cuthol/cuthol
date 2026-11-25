/**
 * w1e aggregation proofs: empty-composition repeats (G720/G722/G723) emit one
 * line per cue, and a single aggregated line (count + id range, every id in
 * `subject_ids`, `warning_count` counts lines) when 2+ cues are empty.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CutholSequence, LaneCue } from "../core/schema.js";
import {
  emptyFrameDiagnostics,
  emptySheetDiagnostics,
} from "../monitor/preview.js";
import { collectEmptyRenderDiagnostics } from "../render/render_main.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-w1e-agg-"));
test.after(() => rmRetrySync(TMP));

function makeCompDir(root: string, name: string, empty: boolean): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  if (empty) {
    fs.writeFileSync(
      path.join(dir, "assets/cuthol-bbox.json"),
      JSON.stringify({ empty: true })
    );
  }
  return dir;
}

function makeCue(id: string, compDir: string): LaneCue {
  return {
    id,
    kind: "composition",
    at_ms: 0,
    duration_ms: 1000,
    composition: { composition_dir: compDir, entry_html: "index.html" },
  } as unknown as LaneCue;
}

function makeSequence(cues: LaneCue[]): CutholSequence {
  return {
    meta: { schema_version: 1, title: "t", revision: 1 },
    stage: { width: 1280, height: 720, fps: 30 },
    spine: { clips: [] },
    library: [],
    lanes: [{ id: "ln1", kind: "overlay", muted: false, cues }],
  } as unknown as CutholSequence;
}

test("G720 aggregation: two empty cues collapse to one line with both ids", () => {
  const root = path.join(TMP, "render2");
  const seq = makeSequence([
    makeCue("cue_001", makeCompDir(root, "a", true)),
    makeCue("cue_002", makeCompDir(root, "b", true)),
  ]);
  const diags = collectEmptyRenderDiagnostics(seq, root);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]?.code, "CUTHOL-G720");
  assert.deepEqual(diags[0]?.subject_ids, ["cue_001", "cue_002"]);
  assert.match(diags[0]?.formatted ?? "", /2 composition cues/);
});

test("G720 aggregation: one empty cue stays a single line", () => {
  const root = path.join(TMP, "render1");
  const seq = makeSequence([
    makeCue("cue_001", makeCompDir(root, "a", true)),
    makeCue("cue_002", makeCompDir(root, "b", false)),
  ]);
  const diags = collectEmptyRenderDiagnostics(seq, root);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]?.code, "CUTHOL-G720");
  assert.match(diags[0]?.formatted ?? "", /'cue_001' draws nothing/);
});

test("G723 aggregation: two empty cues collapse to one line with both ids", () => {
  const root = path.join(TMP, "sheet2");
  const cues = [
    makeCue("cue_011", makeCompDir(root, "a", true)),
    makeCue("cue_012", makeCompDir(root, "b", true)),
  ];
  const diags = emptySheetDiagnostics(cues, root);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]?.code, "CUTHOL-G723");
  assert.deepEqual(diags[0]?.subject_ids, ["cue_011", "cue_012"]);
});

test("G723 aggregation: one empty cue stays a single line", () => {
  const root = path.join(TMP, "sheet1");
  const cues = [
    makeCue("cue_011", makeCompDir(root, "a", true)),
    makeCue("cue_012", makeCompDir(root, "b", false)),
  ];
  const diags = emptySheetDiagnostics(cues, root);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]?.code, "CUTHOL-G723");
  assert.match(diags[0]?.formatted ?? "", /'cue_011' draws nothing/);
});

test("G722 aggregation: two empty cues at one frame collapse to one line", () => {
  const root = path.join(TMP, "frame2");
  const seq = makeSequence([
    makeCue("cue_021", makeCompDir(root, "a", true)),
    makeCue("cue_022", makeCompDir(root, "b", true)),
  ]);
  const cues = (seq.lanes as { cues: LaneCue[] }[])[0]?.cues ?? [];
  const diags = emptyFrameDiagnostics(seq, root, cues, 200);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]?.code, "CUTHOL-G722");
  assert.deepEqual(diags[0]?.subject_ids, ["cue_021", "cue_022"]);
  assert.match(diags[0]?.formatted ?? "", /200ms/);
});
