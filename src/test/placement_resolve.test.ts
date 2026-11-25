/**
 * Effective placement resolver (sequence/placement_resolve.ts) and its expression emitter
 * (compositor/compile_filters.ts `compilePlacementChannelExpr`): the single place that decides a
 * placement channel's value. Envelope with points replaces the static value; no envelope or an
 * envelope with no points keeps the static value, like render;
 * the first envelope on a parameter wins; non-finite values fall back only when asked.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPlacement, type ParameterEnvelope } from "../core/schema.js";
import {
  PLACEMENT_CHANNELS,
  placementAnimatesAny,
  placementBaseEnvelope,
  placementChannelAnimates,
  placementChannelHasEnvelopeInput,
  placementChannelRange,
  placementHasAnyEnvelopeInput,
  placementLayers,
  placementStaticValue,
  placementValueAt,
  resolvePlacementValuesAt,
  type PlacementOwner,
} from "../sequence/placement_resolve.js";
import { compileEnvelopeToFfmpegExpr, compilePlacementChannelExpr } from "../compositor/compile_filters.js";
import { PLACEMENT_LAYER_COMBINE, placementLayerIdentity } from "../effects/effect_types.js";

function owner(envelopes: ParameterEnvelope[], patch: Partial<ReturnType<typeof createDefaultPlacement>> = {}): PlacementOwner {
  return { placement: { ...createDefaultPlacement(), ...patch }, envelopes };
}

const linear = (parameter: ParameterEnvelope["parameter"], a: number, b: number): ParameterEnvelope => ({
  parameter,
  points: [
    { offset_ms: 0, value: a, easing: "linear" },
    { offset_ms: 1000, value: b, easing: "linear" },
  ],
});

test("static placement is returned when a channel has no envelope", () => {
  const o = owner([], { x_pct: 12, scale_x: 0.5, opacity: 0.7 });
  assert.equal(placementValueAt(o, "x_pct", 400), 12);
  assert.equal(placementValueAt(o, "scale_x", 400), 0.5);
  assert.equal(placementValueAt(o, "opacity", 400), 0.7);
  assert.equal(placementChannelAnimates(o, "x_pct"), false);
  assert.equal(compilePlacementChannelExpr(o, "x_pct", { timeBaseOffsetMs: 0, mode: "raw" }), null);
});

test("an envelope with points replaces the static value and interpolates", () => {
  const o = owner([linear("placement.x_pct", -10, 10)], { x_pct: 50 });
  assert.equal(placementValueAt(o, "x_pct", 0), -10);
  assert.equal(placementValueAt(o, "x_pct", 500), 0);
  assert.equal(placementValueAt(o, "x_pct", 2000), 10);
  assert.equal(placementChannelAnimates(o, "x_pct"), true);
  assert.equal(placementChannelAnimates(o, "y_pct"), false);
  assert.deepEqual(resolvePlacementValuesAt(o, 500), { ...pick(o), x_pct: 0 });
});

test("an envelope entry with no points keeps the static value", () => {
  const o = owner([{ parameter: "placement.opacity", points: [] }], { opacity: 0.6 });
  assert.equal(placementValueAt(o, "opacity", 100), 0.6);
  assert.equal(resolvePlacementValuesAt(o, 100).opacity, 0.6);
  assert.equal(placementChannelAnimates(o, "opacity"), false);
  assert.ok(placementBaseEnvelope(o, "opacity"), "the stored entry is still visible to callers that check presence");
  assert.equal(compilePlacementChannelExpr(o, "opacity", { timeBaseOffsetMs: 0, mode: "raw" }), null);
});

test("the first envelope on a parameter wins", () => {
  const o = owner([linear("placement.y_pct", 1, 1), linear("placement.y_pct", 9, 9)]);
  assert.equal(placementValueAt(o, "y_pct", 500), 1);
});

test("non-finite envelope values fall back to static only when asked", () => {
  const env: ParameterEnvelope = { parameter: "placement.rotation_deg", points: [{ offset_ms: 0, value: Number.NaN, easing: "linear" }] };
  const o = owner([env], { rotation_deg: 7 });
  assert.ok(Number.isNaN(placementValueAt(o, "rotation_deg", 0)));
  assert.equal(placementValueAt(o, "rotation_deg", 0, { nonFinite: "static" }), 7);
});

test("the channel expression equals the base envelope expression in every mode", () => {
  const env = linear("placement.y_pct", -5, 5);
  const o = owner([env]);
  for (const opts of [
    { timeBaseOffsetMs: 0, mode: "raw" as const },
    { timeBaseOffsetMs: 2500, mode: "pixel_offset" as const, baseCenterPx: 300, canvasDimPx: 1080 },
  ]) {
    assert.equal(compilePlacementChannelExpr(o, "y_pct", opts), compileEnvelopeToFfmpegExpr({ envelope: env, ...opts }));
  }
});

test("animates-any covers only the listed channels", () => {
  const o = owner([linear("placement.opacity", 0, 1)]);
  assert.equal(placementAnimatesAny(o, ["x_pct", "y_pct", "scale_x", "scale_y", "rotation_deg"]), false);
  assert.equal(placementAnimatesAny(o, PLACEMENT_CHANNELS), true);
});

test("layer combination rule: positions and rotation add, scale and opacity multiply", () => {
  assert.deepEqual(
    PLACEMENT_CHANNELS.map((c) => [c, PLACEMENT_LAYER_COMBINE[c], placementLayerIdentity(c)]),
    [
      ["x_pct", "add", 0],
      ["y_pct", "add", 0],
      ["scale_x", "multiply", 1],
      ["scale_y", "multiply", 1],
      ["rotation_deg", "add", 0],
      ["opacity", "multiply", 1],
    ]
  );
});

test("static value reads the stored field even when the channel animates", () => {
  const o = owner([linear("placement.scale_x", 2, 4)], { scale_x: 0.5 });
  assert.equal(placementStaticValue(o, "scale_x"), 0.5);
  assert.equal(placementStaticValue(o, "opacity"), o.placement.opacity);
});

test("envelope-input presence covers entries with no points", () => {
  const animated = owner([linear("placement.x_pct", -10, 10)]);
  const empty = owner([{ parameter: "placement.y_pct", points: [] }]);
  const plain = owner([]);
  assert.equal(placementChannelHasEnvelopeInput(animated, "x_pct"), true);
  assert.equal(placementChannelHasEnvelopeInput(empty, "y_pct"), true);
  assert.equal(placementChannelHasEnvelopeInput(plain, "y_pct"), false);
  assert.equal(placementChannelAnimates(empty, "y_pct"), false);
});

test("channel range spans envelope points, else the static value", () => {
  const animated = owner([linear("placement.x_pct", -10, 10)], { x_pct: 50 });
  assert.deepEqual(placementChannelRange(animated, "x_pct"), { min: -10, max: 10 });
  const empty = owner([{ parameter: "placement.y_pct", points: [] }], { y_pct: 3 });
  assert.deepEqual(placementChannelRange(empty, "y_pct"), { min: 3, max: 3 });
  const plain = owner([], { rotation_deg: 7 });
  assert.deepEqual(placementChannelRange(plain, "rotation_deg"), { min: 7, max: 7 });
});

test("layers list active motion entries in order with params and envelopes", () => {
  const o = owner(
    [{ parameter: "fx.fx_b.rotation_deg", points: [{ offset_ms: 0, value: -5, easing: "linear" }] }],
    {}
  );
  o.fx = [
    { id: "fx_a", kind: "motion", params: { scale_x: 1.2, x_pct: 5 } },
    { id: "fx_b", kind: "motion", params: { rotation_deg: 3 } },
    { id: "fx_off", kind: "motion", enabled: false, params: { x_pct: 99 } },
    { id: "fx_c", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } },
  ];
  const layers = placementLayers(o);
  assert.deepEqual(layers.map((l) => l.id), ["fx_a", "fx_b"]);
  assert.deepEqual(layers[0].channels.scale_x, { static: 1.2 });
  assert.deepEqual(layers[0].channels.x_pct, { static: 5 });
  assert.equal(layers[0].channels.rotation_deg, undefined);
  assert.equal(layers[1].channels.rotation_deg?.static, 3);
  assert.equal(layers[1].channels.rotation_deg?.envelope?.parameter, "fx.fx_b.rotation_deg");
});

test("layers are empty without motion entries", () => {
  const o = owner([]);
  o.fx = [{ id: "fx_1", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } }];
  assert.deepEqual(placementLayers(o), []);
  assert.deepEqual(placementLayers(owner([])), []);
});

test("placementHasAnyEnvelopeInput is true for an entry on any channel, even with no points", () => {
  assert.equal(placementHasAnyEnvelopeInput(owner([])), false);
  assert.equal(placementHasAnyEnvelopeInput(owner([{ parameter: "placement.y_pct", points: [] }])), true);
  assert.equal(placementHasAnyEnvelopeInput(owner([linear("placement.opacity", 0, 1)])), true);
  assert.equal(placementHasAnyEnvelopeInput(owner([{ parameter: "color.exposure", points: [] }])), false);
});

function pick(o: PlacementOwner): Record<string, number> {
  const p = o.placement;
  return { x_pct: p.x_pct, y_pct: p.y_pct, scale_x: p.scale_x, scale_y: p.scale_y, rotation_deg: p.rotation_deg, opacity: p.opacity };
}
