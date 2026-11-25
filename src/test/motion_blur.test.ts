import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAudioChain,
  createDefaultPlacement,
  createDefaultTreatments,
  createEmptySequence,
  SpineClip,
  VisualTreatments,
} from "../core/schema.js";
import { buildSpineClipMotionBlurFilters, spineClipHasMotionBlur } from "../compositor/compile_spine_mask.js";

function spineClip(id: string, treatments: VisualTreatments): SpineClip {
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
    envelopes: [],
  };
}

function clipWithBlur(shutter: number, subframes: number, enabled = true): SpineClip {
  const t = createDefaultTreatments();
  t.motion_blur = { enabled, shutter_deg: shutter, subframes };
  return spineClip("sp_01", t);
}

test("motion blur: disabled by default emits nothing", () => {
  const clip = spineClip("sp_01", createDefaultTreatments());
  assert.equal(spineClipHasMotionBlur(clip), false);
  assert.deepEqual(buildSpineClipMotionBlurFilters(clip), []);
});

test("motion blur: enabled clip emits a tmix source-frame blend", () => {
  const clip = clipWithBlur(180, 4);
  assert.equal(spineClipHasMotionBlur(clip), true);
  const filters = buildSpineClipMotionBlurFilters(clip);
  assert.equal(filters.length, 1);
  assert.match(filters[0], /^tmix=frames=4:weights='/);
});

test("motion blur: shutter scales past-frame weights", () => {
  const soft = buildSpineClipMotionBlurFilters(clipWithBlur(90, 4)).join(",");
  const full = buildSpineClipMotionBlurFilters(clipWithBlur(360, 4)).join(",");
  assert.ok(soft.includes("0.25"), `90 deg should weight past frames 0.25, got ${soft}`);
  assert.ok(full.includes("1.0000 1.0000 1.0000 1"), `360 deg should blend uniformly, got ${full}`);
  assert.notEqual(soft, full);
});

test("motion blur: shutter 0 emits nothing but stays enabled=false-safe", () => {
  const clip = clipWithBlur(0, 4);
  assert.equal(spineClipHasMotionBlur(clip), false);
  assert.deepEqual(buildSpineClipMotionBlurFilters(clip), []);
});

test("motion blur: subframes set the blend window", () => {
  const filters = buildSpineClipMotionBlurFilters(clipWithBlur(180, 8));
  assert.match(filters[0], /^tmix=frames=8:/);
});
