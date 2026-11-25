/**
 * G267: temporal fx on a composition cue warns on single-frame compiles.
 * A composition cue with `tmix` compiled for a single frame carries
 * CUTHOL-G267 in `compileWarnings` and in the `monitor frame` result;
 * without the fx there is no warning, and a full render never warns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { renderSingleCompositeFrameRgb24 } from "../render/render_frames.js";
import { addLaneCue } from "../sequence/lanes.js";
import { addSpineFx } from "../sequence/spine_fx.js";

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxg267-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "fxg267", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function mountComp(wsDir: string, withTmix: boolean): { cueId: string; atMs: number } {
  const { sequence } = loadSequence(wsDir);
  const compDir = path.join(wsDir, "compositions", withTmix ? "cmp_tmix" : "cmp_plain");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    width: sequence.stage.width,
    height: sequence.stage.height,
    fps: sequence.stage.fps,
    durationMs: 2000,
    preset: "counter",
    props: {},
    transparent: true,
  });
  const { cue } = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 2000,
    explicitDuration: true,
    composition: {
      composition_dir: compDir,
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });
  if (withTmix) {
    addSpineFx({ workspaceDir: wsDir, item: cue.id, filter: "tmix=frames=4" });
  }
  return { cueId: cue.id, atMs: 500 };
}

function warningCodes(diags: Array<{ code: string }> | undefined): string[] {
  return (diags ?? []).map((d) => d.code);
}

test("single-frame compile of a composition cue with tmix carries G267; full render does not", () => {
  withWs((wsDir) => {
    const { cueId } = mountComp(wsDir, true);
    const { sequence, paths } = loadSequence(wsDir);
    const full = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    assert.deepEqual(warningCodes(full.compileWarnings), []);
    const single = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      activeWindowMs: [500, 500 + 1000 / 30],
      singleFrameAtMs: 500,
      includeAudio: false,
      windowEndByFrameCount: true,
    });
    const codes = warningCodes(single.compileWarnings);
    assert.ok(codes.includes("CUTHOL-G267"), `expected G267, got ${JSON.stringify(codes)}`);
    const diag = (single.compileWarnings ?? []).find((d) => d.code === "CUTHOL-G267")!;
    assert.ok(diag.formatted.startsWith("[CUTHOL-G267]"));
    assert.ok(diag.formatted.includes("Suggestion:"));
    assert.ok(diag.what.includes(cueId));
  });
});

test("composition cue without temporal fx carries no G267 on a single frame", () => {
  withWs((wsDir) => {
    mountComp(wsDir, false);
    const { sequence, paths } = loadSequence(wsDir);
    const single = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      activeWindowMs: [500, 500 + 1000 / 30],
      singleFrameAtMs: 500,
      includeAudio: false,
      windowEndByFrameCount: true,
    });
    assert.deepEqual(warningCodes(single.compileWarnings), []);
  });
});

test("monitor frame of a composition cue with tmix carries G267; without the fx it does not", () => {
  withWs((wsDir) => {
    mountComp(wsDir, true);
    const { sequence, paths } = loadSequence(wsDir);
    const res = renderSingleCompositeFrameRgb24(sequence, paths, 500, "draft_480p", {
      skipGates: ["G2_ASSETS"],
    });
    assert.ok(res.rgbBuf.length > 0);
    assert.ok(
      warningCodes(res.diagnostics).includes("CUTHOL-G267"),
      `expected G267, got ${JSON.stringify(warningCodes(res.diagnostics))}`
    );
  });
  withWs((wsDir) => {
    mountComp(wsDir, false);
    const { sequence, paths } = loadSequence(wsDir);
    const res = renderSingleCompositeFrameRgb24(sequence, paths, 500, "draft_480p", {
      skipGates: ["G2_ASSETS"],
    });
    assert.ok(res.rgbBuf.length > 0);
    assert.deepEqual(warningCodes(res.diagnostics), []);
  });
});
