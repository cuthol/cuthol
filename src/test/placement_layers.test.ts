import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPlacement } from "../core/schema.js";
import {
  placementChannelAnimates,
  placementChannelHasEnvelopeInput,
  placementChannelRange,
  placementStaticValue,
  placementValueAt,
  type PlacementOwner,
} from "../sequence/placement_resolve.js";
import { compilePlacementChannelExpr } from "../compositor/compile_filters.js";

function ownerWithLayers(): PlacementOwner {
  return {
    placement: { ...createDefaultPlacement(), x_pct: 10, scale_x: 0.8 },
    envelopes: [
      { parameter: "fx.m1.x_pct", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 1000, value: 3, easing: "linear" }] },
      { parameter: "fx.m2.x_pct", points: [{ offset_ms: 0, value: 10, easing: "linear" }, { offset_ms: 1000, value: 20, easing: "linear" }] },
      { parameter: "fx.m1.scale_x", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 1000, value: 1.2, easing: "linear" }] },
      { parameter: "fx.m2.scale_x", points: [{ offset_ms: 0, value: 2, easing: "linear" }, { offset_ms: 1000, value: 3, easing: "linear" }] },
    ],
    fx: [
      { id: "m1", kind: "motion", params: { x_pct: 99, scale_x: 99 } },
      { id: "m2", kind: "motion", params: { x_pct: 99, scale_x: 99 } },
      { id: "m3", kind: "motion", enabled: false, params: { x_pct: 1000, scale_x: 1000 } },
    ] as PlacementOwner["fx"],
  };
}

test("two layers combine per channel kind; disabled layer ignored", () => {
  const o = ownerWithLayers();
  assert.equal(placementValueAt(o, "x_pct", 0), 10 + 1 + 10);
  assert.equal(placementValueAt(o, "scale_x", 0), 0.8 * 1 * 2);
  assert.equal(placementValueAt(o, "x_pct", 1000), 10 + 3 + 20);
});

test("animated layer drives animates/hasEnvelopeInput; range is interval arithmetic", () => {
  const o = ownerWithLayers();
  assert.equal(placementChannelAnimates(o, "x_pct"), true);
  assert.equal(placementChannelHasEnvelopeInput(o, "x_pct"), true);
  assert.deepEqual(placementChannelRange(o, "x_pct"), { min: 21, max: 33 });
  assert.deepEqual(placementChannelRange(o, "scale_x"), { min: 1.6, max: 2.88 });
});

test("static non-identity layer changes the static value and the range", () => {
  const o: PlacementOwner = {
    placement: { ...createDefaultPlacement(), x_pct: 5, scale_x: 1 },
    envelopes: [],
    fx: [{ id: "m1", kind: "motion", params: { x_pct: 2, scale_x: 0.5 } }] as PlacementOwner["fx"],
  };
  assert.equal(placementStaticValue(o, "x_pct"), 7);
  assert.equal(placementStaticValue(o, "scale_x"), 0.5);
  assert.equal(placementValueAt(o, "x_pct", 400), 7);
  assert.equal(placementChannelAnimates(o, "x_pct"), false);
  assert.equal(placementChannelHasEnvelopeInput(o, "x_pct"), false);
  assert.deepEqual(placementChannelRange(o, "x_pct"), { min: 7, max: 7 });
});

test("identity base plus one layer envelope equals the base-envelope text", () => {
  const pts = [{ offset_ms: 0, value: -4, easing: "linear" as const }, { offset_ms: 1000, value: 6, easing: "linear" as const }];
  const base: PlacementOwner = {
    placement: { ...createDefaultPlacement() },
    envelopes: [{ parameter: "placement.x_pct", points: pts }],
  };
  const layered: PlacementOwner = {
    placement: { ...createDefaultPlacement() },
    envelopes: [{ parameter: "fx.m1.x_pct", points: pts }],
    fx: [{ id: "m1", kind: "motion", params: {} }] as PlacementOwner["fx"],
  };
  const a = compilePlacementChannelExpr(base, "x_pct", { timeBaseOffsetMs: 0, mode: "pixel_offset", baseCenterPx: 960, canvasDimPx: 1920 });
  const b = compilePlacementChannelExpr(layered, "x_pct", { timeBaseOffsetMs: 0, mode: "pixel_offset", baseCenterPx: 960, canvasDimPx: 1920 });
  assert.equal(b, a);
  const c = compilePlacementChannelExpr(base, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  const d = compilePlacementChannelExpr(layered, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  assert.equal(d, c);
});

test("opacity clamps only when the range leaves [0,1]", () => {
  const inRange: PlacementOwner = {
    placement: { ...createDefaultPlacement(), opacity: 0.5 },
    envelopes: [{ parameter: "fx.m1.opacity", points: [{ offset_ms: 0, value: 0.5, easing: "linear" }, { offset_ms: 1000, value: 0.6, easing: "linear" }] }],
    fx: [{ id: "m1", kind: "motion", params: {} }] as PlacementOwner["fx"],
  };
  const plain = compilePlacementChannelExpr(inRange, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  assert.ok(plain && !plain.includes("clip("));
  const outRange: PlacementOwner = {
    placement: { ...createDefaultPlacement(), opacity: 0.9 },
    envelopes: [{ parameter: "fx.m1.opacity", points: [{ offset_ms: 0, value: 1.5, easing: "linear" }, { offset_ms: 1000, value: 0.5, easing: "linear" }] }],
    fx: [{ id: "m1", kind: "motion", params: {} }] as PlacementOwner["fx"],
  };
  assert.equal(placementValueAt(outRange, "opacity", 0), 1);
  const clamped = compilePlacementChannelExpr(outRange, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  assert.ok(clamped && clamped.includes("clip("));
});
