/**
 * Motion layers in the Live window (`src/test/live_motion_layers.test.ts`).
 *
 * The window computes placement itself (native): base placement combined with
 * the active `motion` fx entries (`effectivePlacement` in `src/live/ui/preview.js`,
 * mirroring `resolvePlacementValuesAt` in `src/sequence/placement_resolve.ts`).
 * `needsApprox` (same file, inside `mount`) only flags pixel entries for the
 * server frame; the inspector shows one `Motion` row per item with layers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { effectivePlacement } from "../../src/live/ui/preview.js";
// @ts-ignore - plain JS UI modules without types; resolved at runtime
import { motionRow } from "../../src/live/ui/inspector.js";
import { evaluateEnvelopeAt } from "../sequence/spine_envelope.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");

/** `needsApprox` is nested in `mount`, so it is extracted from source, not imported. */
function loadNeedsApprox(): (item: unknown) => boolean {
  const src = fs.readFileSync(path.join(REPO, "src", "live", "ui", "preview.js"), "utf8");
  function extract(name: string): string {
    const sig = `function ${name}(item) {`;
    const i = src.indexOf(sig);
    assert.ok(i >= 0, `preview.js is missing ${name}`);
    const open = src.indexOf("{", i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    throw new Error(`unbalanced braces for ${name}`);
  }
  const factory = new Function(
    `${extract("nonShaderApprox")}\n${extract("fxApprox")}\n${extract("needsApprox")}\nconst shaderCovered = new Set();\nreturn needsApprox;`
  ) as () => (item: unknown) => boolean;
  return factory();
}
const needsApprox = loadNeedsApprox();

interface Item {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

function baseItem(over: Item = {}): Item {
  return {
    placement: { x_pct: 10, y_pct: -4, scale_x: 2, scale_y: 1, rotation_deg: 5, opacity: 0.9 },
    envelopes: [],
    fx: [],
    ...over,
  };
}

test("two static layers combine: add for x/y/rotation, multiply for scale/opacity", () => {
  const item = baseItem({
    fx: [
      { id: "m1", kind: "motion", params: { x_pct: 5, scale_x: 0.5 } },
      { id: "m2", kind: "motion", params: { x_pct: -2, rotation_deg: 10, opacity: 0.5 } },
    ],
  });
  const p = effectivePlacement(item, 0) as Item;
  assert.equal(p.x_pct, 13);
  assert.equal(p.y_pct, -4);
  assert.equal(p.scale_x, 1);
  assert.equal(p.scale_y, 1);
  assert.equal(p.rotation_deg, 15);
  assert.ok(Math.abs(p.opacity - 0.45) < 1e-9, `opacity ${p.opacity}`);
});

test("disabled motion entry is skipped", () => {
  const item = baseItem({
    fx: [
      { id: "m1", kind: "motion", enabled: false, params: { x_pct: 100, scale_x: 0.1, opacity: 0 } },
      { id: "m2", kind: "motion", params: { x_pct: 1 } },
    ],
  });
  const p = effectivePlacement(item, 0) as Item;
  assert.equal(p.x_pct, 11);
  assert.equal(p.scale_x, 2);
  assert.equal(p.opacity, 0.9);
});

test("envelope layer wins over the entry param while it has points", () => {
  const item = baseItem({
    envelopes: [
      {
        parameter: "fx.m1.x_pct",
        points: [
          { offset_ms: 0, value: 0, easing: "linear" },
          { offset_ms: 2000, value: 20, easing: "linear" },
        ],
      },
    ],
    fx: [{ id: "m1", kind: "motion", params: { x_pct: 999 } }],
  });
  assert.equal((effectivePlacement(item, 0) as Item).x_pct, 10);
  assert.equal((effectivePlacement(item, 1000) as Item).x_pct, 20);
  assert.equal((effectivePlacement(item, 2000) as Item).x_pct, 30);
});

test("empty-points envelope falls back to the entry param", () => {
  const item = baseItem({
    envelopes: [{ parameter: "fx.m1.scale_x", points: [] }],
    fx: [{ id: "m1", kind: "motion", params: { scale_x: 0.25 } }],
  });
  assert.equal((effectivePlacement(item, 500) as Item).scale_x, 0.5);
});

test("point-less base entry falls back to the static value", () => {
  const item = baseItem({
    envelopes: [{ parameter: "placement.y_pct", points: [] }],
  });
  assert.equal((effectivePlacement(item, 500) as Item).y_pct, -4);
  assert.equal((effectivePlacement(item, 500) as Item).x_pct, 10);
});

test("point-less base entry keeps the static base under motion layers", () => {
  const item = baseItem({
    placement: { x_pct: 10, y_pct: -4, scale_x: 2, scale_y: 1, rotation_deg: 5, opacity: 0.9 },
    envelopes: [
      { parameter: "placement.y_pct", points: [] },
      { parameter: "placement.scale_x", points: [] },
    ],
    fx: [{ id: "m1", kind: "motion", params: { y_pct: 3, scale_x: 0.5 } }],
  });
  const p = effectivePlacement(item, 500) as Item;
  assert.equal(p.y_pct, -1);
  assert.equal(p.scale_x, 1);
});

test("cubic_bezier segment matches the server evaluator", () => {
  const envelope = {
    parameter: "placement.x_pct",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 2000, value: 20, easing: "cubic_bezier", bezier: [0.2, 0, 0.3, 1.4] },
    ],
  };
  for (const t of [0, 250, 1000, 1750, 2000]) {
    const item = baseItem({ envelopes: [envelope] });
    const live = (effectivePlacement(item, t) as Item).x_pct as number;
    const server = evaluateEnvelopeAt(envelope as never, t) as number;
    assert.ok(Math.abs(live - server) < 1e-5, `t=${t} live=${live} server=${server}`);
  }
});

test("opacity clamps to [0, 1]", () => {
  const over = baseItem({ fx: [{ id: "m1", kind: "motion", params: { opacity: 2 } }] });
  assert.equal((effectivePlacement(over, 0) as Item).opacity, 1);
  const under = baseItem({
    placement: { ...(baseItem().placement as Item), opacity: 0.4 },
    fx: [{ id: "m1", kind: "motion", params: { opacity: 0 } }],
  });
  assert.equal((effectivePlacement(under, 0) as Item).opacity, 0);
  const inside = baseItem({ fx: [{ id: "m1", kind: "motion", params: { opacity: 0.5 } }] });
  assert.ok(Math.abs(((effectivePlacement(inside, 0) as Item).opacity as number) - 0.45) < 1e-9);
});

test("base envelope still applies under motion layers", () => {
  const item = baseItem({
    envelopes: [
      {
        parameter: "placement.y_pct",
        points: [
          { offset_ms: 0, value: 0, easing: "linear" },
          { offset_ms: 1000, value: 10, easing: "linear" },
        ],
      },
    ],
    fx: [{ id: "m1", kind: "motion", params: { y_pct: 3 } }],
  });
  assert.equal((effectivePlacement(item, 1000) as Item).y_pct, 13);
});

test("needsApprox: motion-only item needs no server frame, pixel entry still does", () => {
  assert.equal(needsApprox(baseItem()), false);
  assert.equal(needsApprox(baseItem({ fx: [{ id: "m1", kind: "motion", params: { x_pct: 2 } }] })), false);
  assert.equal(
    needsApprox(
      baseItem({
        fx: [
          { id: "m1", kind: "motion", params: { x_pct: 2 } },
          { id: "g1", kind: "ffmpeg", params: { filter: "gblur=sigma=2" } },
        ],
      })
    ),
    true
  );
  assert.equal(needsApprox(baseItem({ fx: [{ id: "g1", kind: "shader", params: {} }] })), true);
});

test("inspector Motion row lists layer ids and channels, ~ for animated", () => {
  assert.equal(motionRow(baseItem()), null);
  const row = motionRow(
    baseItem({
      envelopes: [
        {
          parameter: "fx.m1.x_pct",
          points: [{ offset_ms: 0, value: 0, easing: "linear" }],
        },
      ],
      fx: [
        { id: "m1", kind: "motion", params: { x_pct: 2, scale_x: 0.5 } },
        { id: "m2", kind: "motion", enabled: false, params: { x_pct: 9 } },
        { id: "g1", kind: "ffmpeg", params: { filter: "x" } },
      ],
    })
  );
  assert.deepEqual(row, ["Motion", "m1(x_pct~, scale_x)"]);
});
