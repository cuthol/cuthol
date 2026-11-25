/**
 * Safe-area check on the resting segments of an animated title.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultPlacement,
  createEmptySequence,
  type LaneCue,
  type TypographySpec,
} from "../core/schema.js";

function typo(): TypographySpec {
  return {
    text: "Hi",
    font_family: "Inter",
    font_size_px: 64,
    font_weight: 700,
    color_hex: "#ffffff",
    stroke_color_hex: null,
    stroke_width_px: 0,
    box_color_hex: null,
    box_opacity: 1,
    align: "center",
    max_width_pct: 80,
  };
}
import { placementRestingSegments } from "../sequence/placement_resolve.js";
import { measureCuePixelBox, verifySequence } from "../verify/gates.js";

function titleCue(id: string, xPoints: Array<[number, number]>, durationMs: number): LaneCue {
  return {
    id,
    kind: "title",
    anchor: null,
    at_ms: 0,
    duration_ms: durationMs,
    z_index: 1,
    placement: { ...createDefaultPlacement(), x_pct: 0 },
    envelopes: [
      {
        parameter: "placement.x_pct",
        points: xPoints.map(([offset_ms, value]) => ({ offset_ms, value, easing: "linear" as const })),
      },
    ],
    typography: typo(),
  } as LaneCue;
}

function staticTitleCue(id: string, xPct: number, durationMs: number): LaneCue {
  return {
    id,
    kind: "title",
    anchor: null,
    at_ms: 0,
    duration_ms: durationMs,
    z_index: 1,
    placement: { ...createDefaultPlacement(), x_pct: xPct },
    envelopes: [],
    typography: typo(),
  } as LaneCue;
}

function g401LeftCodes(cue: LaneCue): string[] {
  const seq = createEmptySequence({
    projectId: "safe-zone-resting",
    title: "safe zone resting",
    size: { width: 1920, height: 1080 },
  });
  seq.lanes.push({
    id: "ln_titles",
    kind: "title",
    muted: false,
    locked: false,
    z_index: 1,
    cues: [cue],
  });
  const report = verifySequence(seq, undefined, ["G4_STAGE"]);
  return report.diagnostics
    .filter((d) => d.code === "CUTHOL-G401" && d.what.includes("left"))
    .map((d) => d.what);
}

test("slide-in title resting on stage gets no safe-area warning", () => {
  const cue = titleCue("cue_slide_in", [[0, -120], [800, 0]], 4000);
  const resting = placementRestingSegments(cue, cue.duration_ms);
  assert.deepEqual(resting, [[800, 4000]]);
  assert.deepEqual(g401LeftCodes(cue), []);
});

test("title resting outside the safe area keeps the warning", () => {
  const cue = titleCue("cue_rest_out", [[0, 0], [800, -120]], 4000);
  const resting = placementRestingSegments(cue, cue.duration_ms);
  assert.deepEqual(resting, [[800, 4000]]);
  assert.equal(g401LeftCodes(cue).length, 1);
});

test("title moving across the boundary the whole time keeps the warning", () => {
  const cue = titleCue("cue_always_moving", [[0, -120], [4000, 120]], 4000);
  assert.deepEqual(placementRestingSegments(cue, cue.duration_ms), []);
  assert.equal(g401LeftCodes(cue).length, 1);
});

test("static title outside the safe area keeps the warning", () => {
  const cue = staticTitleCue("cue_static_out", -120, 4000);
  assert.equal(g401LeftCodes(cue).length, 1);
  const box = measureCuePixelBox({ width: 1920, height: 1080, aspect: "custom", fps: 30, timebase: "ms", color_space: "bt709" } as never, cue);
  assert.ok(box.left < 0, `expected the static box off stage, got left=${box.left}`);
});
