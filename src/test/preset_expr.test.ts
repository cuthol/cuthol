// Preset expression language and anchor resolution (no workspace needed).
import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicRand,
  evalValueExpression,
  generatePresetPoints,
  gridHash,
  parseAnchor,
  parseManifestPresetsSection,
  parseValueExpression,
} from "../extensions/presets.js";
import { parseExtensionEffectRef } from "../extensions/ext_effects.js";
import { parsePresetRef } from "../effects/preset_apply.js";

function presetSpec(overrides: Record<string, unknown> = {}) {
  return {
    description: "test",
    params: { amount: { type: "number", default: 1, min: 0, max: 2 } },
    entries: [
      {
        kind: "motion",
        keys: {
          scale_x: [
            { at: "end-300ms", value: 1 },
            { at: "end", value: "1+0.3*amount" },
          ],
        },
      },
    ],
    ...overrides,
  };
}

test("preset anchors parse", () => {
  assert.deepEqual(parseAnchor("start", "p", "w"), { kind: "start", offsetMs: 0 });
  assert.deepEqual(parseAnchor("start+400ms", "p", "w"), { kind: "start", offsetMs: 400 });
  assert.deepEqual(parseAnchor("end", "p", "w"), { kind: "end", offsetMs: 0 });
  assert.deepEqual(parseAnchor("end-300ms", "p", "w"), { kind: "end", offsetMs: 300 });
  assert.deepEqual(parseAnchor("50%", "p", "w"), { kind: "ratio", ratio: 50 });
  assert.deepEqual(parseAnchor("1700ms", "p", "w"), { kind: "absolute", offsetMs: 1700 });
  assert.deepEqual(parseAnchor("1700", "p", "w"), { kind: "absolute", offsetMs: 1700 });
  assert.throws(() => parseAnchor("middle", "p", "w"), /anchor/);
  assert.throws(() => parseAnchor("150%", "p", "w"), /outside/);
  assert.throws(() => parseAnchor("", "p", "w"), /at/);
});

test("preset value expressions evaluate, anything else is rejected", () => {
  const run = (expr: string, params: Record<string, number> = { amount: 1 }, i = 0) =>
    evalValueExpression(parseValueExpression(expr, "p", "w"), params, i, "p:c:0", "p", "w");
  assert.equal(run("1"), 1);
  assert.equal(run("1+0.3*amount"), 1.3);
  assert.equal(run("(1+amount)/2"), 1);
  assert.equal(run("-amount"), -1);
  assert.equal(run("2*i", {}, 3), 6);
  assert.equal(run("i", {}, 7), 7);
  const r1 = run("rand(0)");
  assert.ok(r1 >= 0 && r1 < 1, "rand in [0,1)");
  assert.equal(run("rand(0)"), r1, "deterministic");
  assert.equal(run("rand(0)"), deterministicRand("p:c:0", 0));
  assert.notEqual(run("rand(0)", { amount: 1 }, 0), run("rand(1)", { amount: 1 }, 1));
  assert.throws(() => parseValueExpression("eval(1)", "p", "w"), /bad value expression/);
  assert.throws(() => parseValueExpression("foo(1)", "p", "w"), /bad value expression/);
  assert.throws(() => parseValueExpression("1;2", "p", "w"), /bad value expression/);
  assert.throws(() => parseValueExpression("amount$", "p", "w"), /bad value expression/);
  assert.throws(() => parseValueExpression("", "p", "w"), /bad value expression/);
  assert.throws(() => parseValueExpression("(1+2", "p", "w"), /bad value expression/);
  assert.throws(() => parseValueExpression("Math.max(1,2)", "p", "w"), /bad value expression/);
  assert.throws(() => run("unknown+1"), /unknown name/);
  assert.throws(() => run("1/0"), /finite/);
  assert.throws(() => run("rand(-1)"), /rand/);
  assert.throws(() => run("rand(1.5)"), /rand/);
});

test("preset point generation resolves anchors against duration", () => {
  const out = generatePresetPoints({
    preset: "ext:t/punch_out",
    spec: presetSpec() as never,
    args: { amount: 1 },
    durationMs: 2000,
  });
  assert.deepEqual(
    out.channels.scale_x.map((p) => [p.offsetMs, p.value]),
    [[1700, 1], [2000, 1.3]]
  );
  assert.deepEqual(
    out.records.map((r) => [r.channel, r.anchor, (r as { offset_ms?: number }).offset_ms, r.value]),
    [["scale_x", "end", 300, 1], ["scale_x", "end", 0, 1.3]]
  );
  const out2 = generatePresetPoints({
    preset: "ext:t/punch_out",
    spec: presetSpec() as never,
    args: { amount: 2 },
    durationMs: 1600,
  });
  assert.deepEqual(
    out2.channels.scale_x.map((p) => [p.offsetMs, p.value]),
    [[1300, 1], [1600, 1.6]]
  );
});

test("preset anchors that cross on a short clip are an error", () => {
  assert.throws(
    () =>
      generatePresetPoints({
        preset: "ext:t/p",
        spec: presetSpec({
          entries: [
            {
              kind: "motion",
              keys: {
                scale_x: [
                  { at: "start+400ms", value: 1 },
                  { at: "end-300ms", value: 1.3 },
                ],
              },
            },
          ],
        }) as never,
        args: { amount: 1 },
        durationMs: 600,
      }),
    /anchors cross/
  );
});

test("preset ratio and absolute anchors", () => {
  const out = generatePresetPoints({
    preset: "ext:t/k",
    spec: presetSpec({
      entries: [
        {
          kind: "motion",
          keys: {
            scale_x: [
              { at: "0%", value: 1 },
              { at: "100%", value: 1.15 },
            ],
            x_pct: [{ at: "500", value: 3 }],
          },
        },
      ],
    }) as never,
    args: { amount: 1 },
    durationMs: 2000,
  });
  assert.deepEqual(
    out.channels.scale_x.map((p) => [p.offsetMs, p.value]),
    [[0, 1], [2000, 1.15]]
  );
  assert.deepEqual(
    out.channels.x_pct.map((p) => [p.offsetMs, p.value]),
    [[500, 3]]
  );
  assert.deepEqual(
    out.records.filter((r) => r.channel === "scale_x").map((r) => r.anchor),
    ["ratio", "ratio"]
  );
});

test("preset ms repeat tiles the pattern inside the clip", () => {
  const out = generatePresetPoints({
    preset: "ext:t/b",
    spec: presetSpec({
      entries: [
        {
          kind: "motion",
          keys: { scale_x: [{ at: "start", value: 1 }, { at: "100ms", value: 1.08 }] },
        },
      ],
      repeat: { every: "250ms", pattern_ms: 200 },
    }) as never,
    args: { amount: 1 },
    durationMs: 600,
  });
  assert.deepEqual(
    out.channels.scale_x.map((p) => p.offsetMs),
    [0, 100, 250, 350, 500, 600]
  );
  assert.ok(out.records.every((r) => r.anchor === "start"));
});

test("preset beat repeat needs beats, and records beat anchors", () => {
  const spec = presetSpec({
    entries: [
      {
        kind: "motion",
        keys: { scale_x: [{ at: "start", value: 1 }, { at: "200ms", value: 1.08 }] },
      },
    ],
    repeat: { every: "beat", pattern_ms: 200 },
  }) as never;
  assert.throws(
    () => generatePresetPoints({ preset: "ext:t/b", spec, args: { amount: 1 }, durationMs: 2000 }),
    /no beat grid/
  );
  const out = generatePresetPoints({
    preset: "ext:t/b",
    spec,
    args: { amount: 1 },
    durationMs: 2000,
    beatsLocalMs: [0, 500, 1000, 1500],
    beatsAsset: "aud_01",
  });
  assert.deepEqual(
    out.channels.scale_x.map((p) => p.offsetMs),
    [0, 200, 500, 700, 1000, 1200, 1500, 1700]
  );
  assert.ok(out.records.every((r) => r.anchor === "beat"));
  assert.deepEqual(
    out.records.map((r) => r.beat_index),
    [1, 1, 2, 2, 3, 3, 4, 4]
  );
  assert.equal(out.beats?.asset_handle, "aud_01");
  assert.equal(out.beats?.grid_hash, gridHash([0, 500, 1000, 1500]));
});

test("preset manifest section validates shape", () => {
  const ok = parseManifestPresetsSection({ p: presetSpec() }, "t");
  assert.ok(ok?.p);
  assert.throws(() => parseManifestPresetsSection({ p: { ...presetSpec(), entries: [] } }, "t"), /exactly one entry/);
  assert.throws(
    () => parseManifestPresetsSection({ p: { ...presetSpec(), entries: [{ kind: "ffmpeg", keys: {} }] } }, "t"),
    /not "motion"/
  );
  assert.throws(
    () => parseManifestPresetsSection({ p: presetSpec({ entries: [{ kind: "motion", keys: {} }] }) }, "t"),
    /at least one channel/
  );
  assert.throws(
    () => parseManifestPresetsSection({ p: presetSpec({ repeat: { every: "bar", pattern_ms: 200 } }) }, "t"),
    /repeat.every/
  );
  assert.throws(() => parseManifestPresetsSection({ BadName: presetSpec() }, "t"), /invalid name/);
  assert.throws(
    () => parseManifestPresetsSection({ p: presetSpec({ params: { amount: { type: "string" } } }) }, "t"),
    /must be a number/
  );
});

test("preset ref parsing", () => {
  assert.deepEqual(parsePresetRef("ext:studio/punch_out"), { extension: "studio", name: "punch_out" });
  assert.deepEqual(parseExtensionEffectRef("ext:studio/punch_out"), { extension: "studio", name: "punch_out" });
  assert.throws(() => parsePresetRef("motion"), /preset ref/);
  assert.throws(() => parsePresetRef("studio/punch"), /preset ref/);
});
