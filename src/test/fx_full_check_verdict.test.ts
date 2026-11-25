// `--full` verdict fails on any failing row; long envelope filter
// graphs run from a file (Windows command line limit); every spawn in the fx
// check files hides its console window.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkFxChain } from "../effects/fx_check.js";
import { fxFullVerdict } from "../effects/fx_check_full.js";
import { compileEnvelopeToFfmpegExpr } from "../compositor/compile_filters.js";
import { substituteFxTemplateValues } from "../compositor/compile_fx_stage.js";

test("full verdict fails when any row is not ok, even with no ERROR finding", () => {
  assert.deepEqual(fxFullVerdict([{ ok: true }], []), { ok: true, result: "pass" });
  assert.deepEqual(fxFullVerdict([], []), { ok: true, result: "pass" });
  // The reported bug: an envelope row failed (spawnSync ENAMETOOLONG) while no
  // finding was an ERROR, and the command still said "pass".
  assert.deepEqual(
    fxFullVerdict([{ ok: true }, { ok: false }], []),
    { ok: false, result: "fail" }
  );
  assert.deepEqual(
    fxFullVerdict([{ ok: true }], [{ severity: "ERROR" }]),
    { ok: false, result: "fail" }
  );
  assert.deepEqual(
    fxFullVerdict([{ ok: true }], [{ severity: "WARN" }]),
    { ok: true, result: "pass" }
  );
});

test("20-point Bezier envelope chain (over the Windows limit) checks clean from a file", () => {
  const n = 20;
  const points = Array.from({ length: n }, (_, i) => ({
    offset_ms: Math.round((3000 * i) / (n - 1)),
    value: i / (n - 1),
    easing: "cubic_bezier" as const,
    bezier: [0.42, 0, 0.58, 1] as [number, number, number, number],
  }));
  const fail = (detail: string): never => {
    throw new Error(detail);
  };
  const expr = compileEnvelopeToFfmpegExpr({ envelope: { points } as never, timeBaseOffsetMs: 0, mode: "raw" });
  void fail;
  assert.ok(expr && expr.length > 1000, "envelope expression is long");
  const template = "eq=saturation=1+0.6*{{strength}}:brightness=0.08*{{strength}}:eval=frame";
  const chain = substituteFxTemplateValues(template, {}, new Map([["strength", expr]]), fail);
  assert.ok(chain.length > 32767, `substituted chain (${chain.length}) exceeds the Windows command line limit`);
  // On the old build this failed (ENAMETOOLONG: the graph went on the command
  // line); graphs now go through a file, so the check passes.
  const findings = checkFxChain(chain, { itemId: "definition", fxId: "strength", kind: "strength" });
  assert.deepEqual(findings, []);
});

test("every spawn in the fx check files hides its console window", () => {
  const files = ["fx_check.ts", "fx_sandbox.ts", "fx_try.ts", "fx_check_full.ts"];
  for (const file of files) {
    const src = fs.readFileSync(
      path.resolve("src", "effects", file),
      "utf8"
    );
    const calls: number[] = [];
    for (const m of src.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/g)) {
      calls.push(m.index ?? 0);
    }
    assert.ok(calls.length > 0, `${file} has spawn calls`);
    for (const at of calls) {
      const window = src.slice(at, at + 900);
      assert.ok(
        window.includes("windowsHide: true") || window.includes("windowsHide:true"),
        `${file}: spawn call hides its console window`
      );
    }
  }
});
