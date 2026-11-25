import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  createEmptySequence,
  ParameterEnvelope,
  SpineClip,
  VisualTreatments,
} from "../core/schema.js";
import { isKnownEnvelopeParameter } from "../sequence/envelope_params.js";
import { buildSpineClipMaskFilters, spineClipMaskRequiresRgba } from "../compositor/compile_spine_mask.js";
import { resolveSourceColorSpec } from "../library/probe.js";
import { verifySequence } from "../verify/gates.js";

function spineClip(id: string, treatments: VisualTreatments, envelopes: ParameterEnvelope[] = []): SpineClip {
  return {
    id,
    asset_handle: "vid_01",
    source_in_ms: 0,
    source_out_ms: 1000,
    timeline_in_ms: 0,
    duration_ms: 1000,
    playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
    placement: createDefaultPlacement(),
    audio_chain: createDefaultAudioChain(),
    treatments,
    transition_out: null,
    envelopes,
  };
}

const colorSpec = { isRgb: false } as ReturnType<typeof resolveSourceColorSpec>;

function maskFilters(t: VisualTreatments, envelopes: ParameterEnvelope[] = []): string[] {
  const seq = createEmptySequence({ projectId: "mask", title: "mask" });
  const clip = spineClip("sp_01", t, envelopes);
  seq.spine.clips.push(clip);
  return buildSpineClipMaskFilters({ clip, clipColorSpec: colorSpec, targetW: 640, targetH: 360, renderWidth: 1280 });
}

test("mask: no mask emits no filters and needs no RGBA", () => {
  const t = createDefaultTreatments();
  const seq = createEmptySequence({ projectId: "m", title: "m" });
  const clip = spineClip("sp_01", t);
  seq.spine.clips.push(clip);
  assert.deepEqual(buildSpineClipMaskFilters({ clip, clipColorSpec: colorSpec, targetW: 640, targetH: 360, renderWidth: 1280 }), []);
  assert.equal(spineClipMaskRequiresRgba(clip), false);
});

test("mask: hard rect uses the exact crop+pad fast path", () => {
  const t = createDefaultTreatments();
  t.mask = { shape: "rect", center_x_pct: 50, center_y_pct: 50, width_pct: 40, height_pct: 30, feather_px: 0, invert: false };
  const filters = maskFilters(t);
  assert.equal(filters.length, 3);
  assert.match(filters[1], /^crop=w=256:h=108:x='192':y='126'$/);
  assert.match(filters[2], /^pad=640:360/);
  const seq = createEmptySequence({ projectId: "m", title: "m" });
  seq.spine.clips.push(spineClip("sp_01", t));
  assert.equal(spineClipMaskRequiresRgba(seq.spine.clips[0]), true);
});

test("mask: soft rect multiplies alpha through geq", () => {
  const t = createDefaultTreatments();
  t.mask = { shape: "rect", center_x_pct: 50, center_y_pct: 50, width_pct: 40, height_pct: 30, feather_px: 8, invert: false };
  const filters = maskFilters(t);
  assert.equal(filters.length, 2);
  assert.match(filters[1], /geq=.*alpha\(X,Y\)/);
});

test("mask: ellipse, split and invert shapes compile", () => {
  for (const shape of ["rect", "ellipse", "split"] as const) {
    const t = createDefaultTreatments();
    t.mask = { shape, center_x_pct: 30, center_y_pct: 70, width_pct: 50, height_pct: 50, feather_px: 8, invert: false };
    const plain = maskFilters(t).join(",");
    const ti = createDefaultTreatments();
    ti.mask = { shape, center_x_pct: 30, center_y_pct: 70, width_pct: 50, height_pct: 50, feather_px: 8, invert: true };
    const inverted = maskFilters(ti).join(",");
    assert.notEqual(plain, inverted, `${shape}: invert must change the filter`);
  }
});

test("mask: animated parameters compile per frame through T", () => {
  const t = createDefaultTreatments();
  t.mask = { shape: "rect", center_x_pct: 20, center_y_pct: 50, width_pct: 40, height_pct: 40, feather_px: 4, invert: false };
  const env: ParameterEnvelope = {
    parameter: "treatments.mask.center_x_pct",
    points: [
      { offset_ms: 0, value: 20, easing: "linear" },
      { offset_ms: 1000, value: 80, easing: "linear" },
    ],
  };
  assert.ok(isKnownEnvelopeParameter("treatments.mask.center_x_pct"));
  assert.ok(isKnownEnvelopeParameter("treatments.mask.feather_px"));
  const filters = maskFilters(t, [env]).join(",");
  assert.match(filters, /T/, "animated mask must reference geq time T");
  assert.ok(!/\bt\b/.test(filters.replaceAll("hypot", "").replaceAll("sqrt", "").replaceAll("abs", "").replaceAll("max", "").replaceAll("clip", "").replaceAll("if", "").replaceAll("lte", "")), "no bare t may remain");
});

test("mask: no G409 for mask or motion blur on spine clips", () => {
  const seq = createEmptySequence({ projectId: "m", title: "m" });
  const t = createDefaultTreatments();
  t.mask = { shape: "ellipse", center_x_pct: 50, center_y_pct: 50, width_pct: 60, height_pct: 60, feather_px: 10, invert: false };
  t.motion_blur = { enabled: true, shutter_deg: 180, subframes: 4 };
  seq.spine.clips.push(spineClip("sp_01", t));
  const report = verifySequence(seq);
  const g409 = report.diagnostics.filter((d) => d.code === "CUTHOL-G409");
  assert.deepEqual(g409, [], `expected no G409, got ${JSON.stringify(g409)}`);
});
