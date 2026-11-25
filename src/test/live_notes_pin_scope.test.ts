// Pin-scoped coords measurement. The pin must measure only the
// compositions whose stage box covers the pin point, with the same
// topmost element answer as the whole-frame measurement.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadSequence } from "../core/workspace.js";
import { mapLocalBoxToStage } from "../compositor/coords_map.js";
import { readCompositionPixelSize } from "../compositor/coords_extract.js";
import {
  rankElements,
  selectPinCandidateCues,
} from "../live/live_notes_api.js";
import type { GeometryQueryResult } from "../compositor/coords_query.js";
import type { CutholSequence } from "../core/schema.js";

import { LIVE_DEMO_DIR, missingLiveDemo } from "./fixtures.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const DEMO = LIVE_DEMO_DIR;

function makeProject(): { dir: string; sequence: CutholSequence } {
  const dir = path.join(TEST_ROOT, `live_b3_${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(DEMO, dir, { recursive: true });
  const seqFile = path.join(dir, "cuthol.sequence.json");
  const sequence = JSON.parse(fs.readFileSync(seqFile, "utf8")) as CutholSequence;
  for (const lane of sequence.lanes) {
    for (const cue of lane.cues) {
      if (cue.id === "cue_02") {
        cue.at_ms = 1000;
        cue.duration_ms = 20000;
        cue.placement.x_pct = -25;
        cue.placement.y_pct = -20;
        cue.placement.scale_x = 0.35;
        cue.placement.scale_y = 0.35;
      }
      if (cue.id === "cue_03") {
        cue.at_ms = 1000;
        cue.duration_ms = 20000;
        cue.placement.x_pct = 28;
        cue.placement.y_pct = 24;
        cue.placement.scale_x = 0.3;
        cue.placement.scale_y = 0.3;
      }
    }
  }
  fs.writeFileSync(seqFile, JSON.stringify(sequence), "utf8");
  return { dir, sequence: loadSequence(dir).sequence };
}

function compBox(
  dir: string,
  sequence: CutholSequence,
  cueId: string,
  atMs: number
): [number, number, number, number] {
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
  const absCompDir = path.resolve(dir, cue.composition!.composition_dir);
  const size = readCompositionPixelSize(absCompDir, cue.composition!.entry_html || "index.html")!;
  const localMs = atMs - (cue.at_ms ?? 0);
  const r = mapLocalBoxToStage(
    { x: 0, y: 0, w: size.width, h: size.height },
    cue,
    { compWidth: size.width, compHeight: size.height, stageWidth: sequence.stage.width, stageHeight: sequence.stage.height },
    localMs
  ).box;
  return [r.x, r.y, r.w, r.h];
}

function center(b: [number, number, number, number]): [number, number] {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

test("pin inside one small composition measures only that cue", { skip: missingLiveDemo() }, () => {
  const { dir, sequence } = makeProject();
  try {
    const atMs = 2000;
    const box02 = compBox(dir, sequence, "cue_02", atMs);
    const box03 = compBox(dir, sequence, "cue_03", atMs);
    assert.ok(box02[2] < sequence.stage.width / 2, `cue_02 box is small: ${box02}`);
    assert.ok(box03[2] < sequence.stage.width / 2, `cue_03 box is small: ${box03}`);
    const [px, py] = center(box02);
    const inOther = px >= box03[0] && px <= box03[0] + box03[2] && py >= box03[1] && py <= box03[1] + box03[3];
    assert.equal(inOther, false, "test pins must discriminate the two cues");
    const frame = Math.floor((atMs / 1000) * sequence.stage.fps);
    const got = selectPinCandidateCues(sequence, dir, frame, px, py, 0, 0);
    assert.deepEqual(got, ["cue_02"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pin on empty space selects no composition cue", { skip: missingLiveDemo() }, () => {
  const { dir, sequence } = makeProject();
  try {
    const atMs = 2000;
    const box02 = compBox(dir, sequence, "cue_02", atMs);
    const box03 = compBox(dir, sequence, "cue_03", atMs);
    // Top-right corner: outside both small boxes.
    const px = sequence.stage.width - 20;
    const py = 20;
    for (const b of [box02, box03]) {
      const inside = px >= b[0] && px <= b[0] + b[2] && py >= b[1] && py <= b[1] + b[3];
      assert.equal(inside, false, "test pin must be on empty space");
    }
    const frame = Math.floor((atMs / 1000) * sequence.stage.fps);
    assert.deepEqual(selectPinCandidateCues(sequence, dir, frame, px, py, 0, 0), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scoped ranking gives the same top element as whole-frame ranking", { skip: missingLiveDemo() }, () => {
  const { dir, sequence } = makeProject();
  try {
    const atMs = 2000;
    const box02 = compBox(dir, sequence, "cue_02", atMs);
    const box03 = compBox(dir, sequence, "cue_03", atMs);
    const full: GeometryQueryResult = {
      mode: "geometry",
      detail: false,
      at: "60f",
      sequence_frame: 60,
      sequence_ms: 2000,
      stage: { width: sequence.stage.width, height: sequence.stage.height, fps: sequence.stage.fps },
      cues: [],
      measured: [],
      elements: [
        { cue: "cue_02", key: "a", kind: "text", label: "a", item: [box02[0] + 5, box02[1] + 5, 60, 30], ink: null, opacity: 1, z: 1 },
        { cue: "cue_03", key: "b", kind: "text", label: "b", item: [box03[0] + 5, box03[1] + 5, 60, 30], ink: null, opacity: 1, z: 1 },
      ],
      pairs: [],
    };
    const pins: Array<[number, number]> = [
      center(box02),
      [box02[0] + 10, box02[1] + 10],
      center(box03),
      [box03[0] + 10, box03[1] + 10],
      [sequence.stage.width - 20, 20],
    ];
    for (const [px, py] of pins) {
      const frame = Math.floor((atMs / 1000) * sequence.stage.fps);
      const scopedCues = new Set(selectPinCandidateCues(sequence, dir, frame, px, py, 0, 0));
      const scoped: GeometryQueryResult = {
        ...full,
        elements: full.elements.filter((e) => scopedCues.has(e.cue)),
      };
      const wholeTop = rankElements(sequence, full, atMs, px, py, 0, 0, false).elements[0]?.ref ?? null;
      const scopedTop = rankElements(sequence, scoped, atMs, px, py, 0, 0, false).elements[0]?.ref ?? null;
      assert.equal(scopedTop, wholeTop, `same top element at pin ${px},${py}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
