/**
 * A placement envelope entry with no points means "use the static value",
 * like render. The monitor box and the render scan read through the same
 * resolver, so a visible clip (static opacity 1, scale 0.5) must not read
 * as invisible or zero-size.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createDefaultPlacement, type CutholSequence, type LaneCue } from "../core/schema.js";
import {
  placementValueAt,
  resolvePlacementValuesAt,
  type PlacementOwner,
} from "../sequence/placement_resolve.js";
import { compilePlacementChannelExpr } from "../compositor/compile_filters.js";
import { resolveMonitorBoxCue } from "../monitor/preview.js";
import { isIntentionalFadeOrTransparentAtMs } from "../render/render_scan.js";
import { measureCuePixelBox } from "../verify/gates.js";

function clipLike(): PlacementOwner {
  return {
    placement: { ...createDefaultPlacement(), opacity: 1, scale_x: 0.5, scale_y: 0.5 },
    envelopes: [
      { parameter: "placement.opacity", points: [] },
      { parameter: "placement.scale_x", points: [] },
    ],
  };
}

function cueLike(): PlacementOwner {
  return {
    placement: { ...createDefaultPlacement(), opacity: 1, scale_x: 0.5, scale_y: 0.5 },
    envelopes: [
      { parameter: "placement.opacity", points: [] },
      { parameter: "placement.scale_x", points: [] },
    ],
  };
}

test("a point-less envelope on a clip reads the static value render uses", () => {
  const clip = clipLike();
  assert.equal(placementValueAt(clip, "opacity", 120), 1);
  assert.equal(placementValueAt(clip, "scale_x", 120), 0.5);
  assert.equal(resolvePlacementValuesAt(clip, 120).opacity, 1);
  assert.equal(resolvePlacementValuesAt(clip, 120).scale_x, 0.5);
  assert.equal(compilePlacementChannelExpr(clip, "opacity", { timeBaseOffsetMs: 0, mode: "raw" }), null);
  assert.equal(compilePlacementChannelExpr(clip, "scale_x", { timeBaseOffsetMs: 0, mode: "raw" }), null);
});

test("a point-less envelope on a lane cue reads the static value render uses", () => {
  const cue = cueLike();
  assert.equal(placementValueAt(cue, "opacity", 120), 1);
  assert.equal(placementValueAt(cue, "scale_x", 120), 0.5);
  assert.equal(resolvePlacementValuesAt(cue, 120).opacity, 1);
  assert.equal(resolvePlacementValuesAt(cue, 120).scale_x, 0.5);
  assert.equal(compilePlacementChannelExpr(cue, "opacity", { timeBaseOffsetMs: 0, mode: "raw" }), null);
  assert.equal(compilePlacementChannelExpr(cue, "scale_x", { timeBaseOffsetMs: 0, mode: "raw" }), null);
});

test("the monitor box measures the static size for a point-less scale envelope", () => {
  const cue = {
    id: "cue_01",
    kind: "footage",
    placement: { ...createDefaultPlacement(), opacity: 1, scale_x: 0.5, scale_y: 0.5 },
    envelopes: [
      { parameter: "placement.opacity", points: [] },
      { parameter: "placement.scale_x", points: [] },
    ],
  } as unknown as LaneCue;
  const stage = { width: 1920, height: 1080 } as CutholSequence["stage"];
  const forBox = resolveMonitorBoxCue(cue, 120);
  assert.equal(forBox.placement.scale_x, 0.5);
  assert.deepEqual(
    measureCuePixelBox(stage, forBox, 16 / 9),
    measureCuePixelBox(stage, { ...cue, envelopes: [] }, 16 / 9)
  );
});

test("the render scan treats a point-less opacity envelope as visible", () => {
  const clip = {
    id: "sp_01",
    timeline_in_ms: 0,
    duration_ms: 2000,
    transition_out: null,
    placement: { ...createDefaultPlacement(), opacity: 1, scale_x: 0.5 },
    envelopes: [{ parameter: "placement.opacity", points: [] }],
    treatments: { color_grade: { brightness: 0 } },
  };
  const seq = { spine: { clips: [clip] } } as unknown as CutholSequence;
  assert.equal(isIntentionalFadeOrTransparentAtMs(seq, 0, 500, 1000 / 30), false);
});

test("no reader asks for a zero value for a point-less envelope", () => {
  for (const file of [
    "src/sequence/placement_resolve.ts",
    "src/monitor/preview.ts",
    "src/render/render_scan.ts",
  ]) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url));
    assert.ok(!text.includes("emptyEnvelope"), `${file} must not mention emptyEnvelope`);
  }
});
