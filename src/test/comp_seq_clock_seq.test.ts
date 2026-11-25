import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCompositionDataUsage } from "../compositor/bridge_hash.js";
import {
  createCutholRuntime,
  type GsapLikeTimeline,
} from "../compositor/cuthol_runtime.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeBridge(cueStart: number, duration = 4) {
  return {
    schema: "cuthol.bridge/1",
    hash: "test",
    composition: {
      id: "main",
      cueId: "cue_01",
      duration,
      fps: 30,
      width: 1920,
      height: 1080,
      sequenceStartSec: cueStart,
    },
    words: [],
  };
}

function fakeTimeline(captured: {
  position?: number | string;
  fromVars?: Record<string, unknown>;
  toVars?: Record<string, unknown>;
}): GsapLikeTimeline {
  return {
    fromTo(
      _target: object,
      fromVars: Record<string, unknown>,
      toVars: Record<string, unknown>,
      position?: number | string
    ): GsapLikeTimeline {
      captured.position = position;
      captured.fromVars = fromVars;
      captured.toVars = toVars;
      return fakeTimeline(captured);
    },
  };
}

test("C.seq exposes the cue start and converts both ways", () => {
  const C = createCutholRuntime(makeBridge(10) as never);
  assert.equal(C.seq.start, 10);
  assert.equal(C.seq.toLocal(12), 2);
  assert.equal(C.seq.toSequence(2), 12);
});

test("drive and value accept sequence-clock times", () => {
  const C = createCutholRuntime(makeBridge(10) as never);
  const dCap: { position?: number | string } = {};
  C.drive(fakeTimeline(dCap), () => {}, { start: 10, end: 12, clock: "sequence" });
  assert.equal(dCap.position, 0);
  const vCap: { position?: number | string } = {};
  C.value(fakeTimeline(vCap), { to: 1, at: 11, clock: "sequence" }, () => {});
  assert.equal(vCap.position, 1);
  assert.ok(
    !C.warnings.some((w) => w.includes("clamped")),
    `in-window sequence times must not warn, got ${JSON.stringify(C.warnings)}`
  );
});

test("sequence times outside the window are reported instead of silently clamped", () => {
  const C = createCutholRuntime(makeBridge(10) as never);
  const vCap: { position?: number | string } = {};
  C.value(fakeTimeline(vCap), { to: 1, at: 53.92, clock: "sequence" }, () => {});
  assert.equal(vCap.position, 4);
  assert.ok(
    C.warnings.some((w) => w.includes("53.92") && w.includes("clamped")),
    `expected a clamp warning, got ${JSON.stringify(C.warnings)}`
  );
});

test("compositions using C.seq are detected as sequence-timing users", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-seq-usage-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<script>const t = C.seq.toLocal(53.92); C.value(tl, { to: 1, at: 53.92, clock: "sequence" }, () => {});</script>`
  );
  const usage = analyzeCompositionDataUsage(dir, "index.html");
  assert.equal(usage.usesSequenceTiming, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
