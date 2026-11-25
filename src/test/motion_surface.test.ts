/**
 * Motion layers on the agent surface: `spine fx list` grouping, `spine value`
 * breakdown, `brief` motion notes, verify G288/G289, range-based bounds,
 * monitor box single-counting, and `spine fx set --enabled`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { renderSequenceBrief } from "../brief/inspector.js";
import { verifySequence } from "../verify/gates.js";
import { measureCuePixelBox } from "../verify/gates.js";
import { resolveMonitorBoxCue } from "../monitor/preview.js";
import { addLaneCue } from "../sequence/lanes.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setItemEnvelope } from "../sequence/spine.js";
import { addSpineFx, listSpineFx, setSpineFx } from "../sequence/spine_fx.js";
import { readEnvelopeValueAt } from "../sequence/envelope_points.js";
import { placementChannelRange, placementValueAt } from "../sequence/placement_resolve.js";

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-mosurf-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "mosurf", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeAvMp4(outPath: string, durationSec = 4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", outPath,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr || "ffmpeg failed");
}

/** Spine clip with two motion layers (one animated, one static) plus a pixel effect. */
function setupClip(wsDir: string): string {
  const media = path.join(wsDir, "media", "a.mp4");
  makeAvMp4(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({
    workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 4000,
  });
  addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "motion", params: { scale_x: 1.1, opacity: 0.9 } });
  addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "motion", params: { x_pct: 5 } });
  setItemEnvelope({
    workspaceDir: wsDir, targetId: clip.id, parameter: "fx.fx_02.x_pct",
    points: [
      { offset_ms: 0, value: 0, easing: "linear" },
      { offset_ms: 4000, value: 10, easing: "linear" },
    ],
  });
  addSpineFx({ workspaceDir: wsDir, item: clip.id, filter: "gblur=sigma=2" });
  return clip.id;
}

/** Footage (broll) cue with one static motion layer. */
function setupBrollCue(wsDir: string): string {
  const media = path.join(wsDir, "media", "b.mp4");
  makeAvMp4(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { cue } = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_broll", kind: "broll",
    assetHandle: item.handle, atMs: 0, durationMs: 4000,
    sourceInMs: 0, sourceOutMs: 4000,
  });
  addSpineFx({ workspaceDir: wsDir, item: cue.id, kind: "motion", params: { y_pct: -20 } });
  return cue.id;
}

test("fx list groups motion layers with channels and animated flags", () => {
  withWs((ws) => {
    const clipId = setupClip(ws);
    const l = listSpineFx({ workspaceDir: ws, item: clipId });
    // Pixel entries list as today.
    assert.deepEqual(l.fx.map((f) => f.kind), ["motion", "motion", "ffmpeg"]);
    assert.equal(l.motion.length, 2);
    assert.equal(l.motion[0].id, "fx_01");
    assert.equal(l.motion[0].enabled, true);
    assert.deepEqual(l.motion[0].channels.scale_x, { value: 1.1, animated: false });
    assert.deepEqual(l.motion[0].channels.opacity, { value: 0.9, animated: false });
    assert.equal(l.motion[1].id, "fx_02");
    assert.deepEqual(l.motion[1].channels.x_pct, { value: 5, animated: true });
  });
});

test("spine value placement query gives effective value and breakdown", () => {
  withWs((ws) => {
    const clipId = setupClip(ws);
    const at = 2000;
    const got = readEnvelopeValueAt({ workspaceDir: ws, targetId: clipId, parameter: "placement.scale_x", localMs: at });
    assert.ok(got.breakdown, "expected a breakdown");
    // Breakdown terms combine to the effective value (multiply rule).
    const combined = got.breakdown!.layers.reduce((v, l) => v * l.value, got.breakdown!.base);
    assert.ok(Math.abs(combined - got.value) < 1e-9, `breakdown ${combined} != value ${got.value}`);
    assert.equal(got.breakdown!.combine, "multiply");
    assert.deepEqual(
      got.breakdown!.layers.map((l) => l.id),
      ["fx_01"]
    );
    // Additive channel: base 0 + static 5 + animated layer value at t.
    const x = readEnvelopeValueAt({ workspaceDir: ws, targetId: clipId, parameter: "placement.x_pct", localMs: at });
    const xCombined = x.breakdown!.layers.reduce((v, l) => v + l.value, x.breakdown!.base);
    assert.ok(Math.abs(xCombined - x.value) < 1e-9, `breakdown ${xCombined} != value ${x.value}`);
    // An fx.<id>.<channel> query on a motion entry returns that layer's own value.
    const own = readEnvelopeValueAt({ workspaceDir: ws, targetId: clipId, parameter: "fx.fx_02.x_pct", localMs: at });
    assert.equal(own.layer?.id, "fx_02");
    assert.ok(Math.abs(own.value - 5) < 1e-9, `layer value ${own.value} != 5 at midpoint`);
    const ownStatic = readEnvelopeValueAt({ workspaceDir: ws, targetId: clipId, parameter: "fx.fx_01.scale_x", localMs: at });
    assert.equal(ownStatic.value, 1.1);
    assert.equal(ownStatic.source, "static");
  });
});

test("brief canvas shows motion note; fx summary skips motion entries", () => {
  withWs((ws) => {
    const clipId = setupClip(ws);
    const cueId = setupBrollCue(ws);
    const { sequence } = loadSequence(ws);
    const md = renderSequenceBrief(sequence, { lens: "canvas" });
    assert.match(md, /motion: fx_01\(scale_x, opacity\), fx_02\(x_pct~\)/);
    assert.match(md, new RegExp(`motion: fx_0\\d\\(y_pct\\)`));
    void cueId;
    void clipId;
    // Overview fx summary lists only the pixel effect.
    const overview = renderSequenceBrief(sequence, { lens: "overview" });
    assert.match(overview, /`fx: ffmpeg`/);
    assert.doesNotMatch(overview, /motion:/);
  });
});

test("verify warns on clamped opacity and zero-crossing scale, silent otherwise", () => {
  withWs((ws) => {
    const clipId = setupClip(ws);
    setupBrollCue(ws);
    // Offending layers: opacity above 1 (clamped) and a scale range touching 0.
    addSpineFx({ workspaceDir: ws, item: clipId, kind: "motion", params: { opacity: 1.4 } });
    addSpineFx({ workspaceDir: ws, item: clipId, kind: "motion", params: { scale_x: 0 } });
    const { sequence, paths } = loadSequence(ws);
    const report = verifySequence(sequence, paths);
    const codes = report.diagnostics.filter((d) => d.code === "CUTHOL-G288" || d.code === "CUTHOL-G289");
    assert.ok(codes.some((d) => d.code === "CUTHOL-G288" && d.what.includes(clipId) && d.what.includes("opacity")), "expected G288 opacity warn");
    assert.ok(codes.some((d) => d.code === "CUTHOL-G289" && d.what.includes(clipId) && d.what.includes("scale_x")), "expected G289 scale warn");
    assert.ok(codes.every((d) => d.severity === "WARN"), "verify motion warnings never stop anything");
    const g288 = codes.find((d) => d.code === "CUTHOL-G288")!;
    assert.match(g288.what, /fx_04/);
  });
  withWs((ws) => {
    setupClip(ws);
    setupBrollCue(ws);
    const { sequence, paths } = loadSequence(ws);
    const report = verifySequence(sequence, paths);
    const bad = report.diagnostics.filter((d) => d.code === "CUTHOL-G288" || d.code === "CUTHOL-G289");
    assert.deepEqual(bad, []);
  });
});

test("stage box is widest over an animating item; static items unchanged", () => {
  withWs((ws) => {
    const clipId = setupClip(ws);
    const cueId = setupBrollCue(ws);
    const loaded = loadSequence(ws);
    const clip = loaded.sequence.spine.clips.find((c) => c.id === clipId)!;
    const cue = loaded.sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    const range = placementChannelRange(clip, "x_pct");
    assert.ok(range.max - range.min > 0);
    const animatedBox = measureCuePixelBox(loaded.sequence.stage, clip as unknown as typeof cue, 16 / 9);
    // Same item with the animated layer off: a strictly narrower box.
    setSpineFx({ workspaceDir: ws, item: clipId, fxId: "fx_02", enabled: false });
    const still = loadSequence(ws).sequence.spine.clips.find((c) => c.id === clipId)!;
    const staticBox = measureCuePixelBox(loaded.sequence.stage, still as unknown as typeof cue, 16 / 9);
    assert.ok(animatedBox.width > staticBox.width, `animated ${animatedBox.width} <= static ${staticBox.width}`);
    // Static footage cue: same output on repeat (pure function of the item).
    const a = measureCuePixelBox(loaded.sequence.stage, cue, 16 / 9);
    const b = measureCuePixelBox(loaded.sequence.stage, cue, 16 / 9);
    assert.deepEqual(a, b);
  });
});

test("monitor box copy carries no motion entries or fx envelopes", () => {
  withWs((ws) => {
    const cueId = setupBrollCue(ws);
    const { sequence } = loadSequence(ws);
    const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    // Static motion layer, no envelopes at all: the early return must not skip it.
    assert.equal(cue.envelopes.length, 0);
    const copy = resolveMonitorBoxCue(cue, 1000);
    assert.notEqual(copy, cue);
    assert.deepEqual(copy.fx ?? [], []);
    assert.deepEqual(copy.envelopes, []);
    // Placement is baked once through the resolver (base + static layer).
    for (const c of ["x_pct", "y_pct", "scale_x", "scale_y", "rotation_deg", "opacity"] as const) {
      assert.equal(copy.placement[c], placementValueAt(cue, c, 1000));
    }
    assert.equal(copy.placement.y_pct, -20);
  });
});

test("spine fx set --enabled toggles pixel and motion entries", () => {
  withWs((ws) => {
    const clipId = setupClip(ws);
    const off = setSpineFx({ workspaceDir: ws, item: clipId, fxId: "fx_02", enabled: false });
    assert.equal(off.fx.enabled, false);
    assert.equal(listSpineFx({ workspaceDir: ws, item: clipId }).motion[1].enabled, false);
    // Disabled layers leave the resolver: effective x equals the base.
    const v = readEnvelopeValueAt({ workspaceDir: ws, targetId: clipId, parameter: "placement.x_pct", localMs: 2000 });
    assert.equal(v.breakdown!.layers.length, 0);
    assert.equal(v.value, 0);
    const on = setSpineFx({ workspaceDir: ws, item: clipId, fxId: "fx_02", enabled: true });
    assert.ok(!("enabled" in on.fx) || (on.fx as { enabled?: boolean }).enabled !== false);
    const v2 = readEnvelopeValueAt({ workspaceDir: ws, targetId: clipId, parameter: "placement.x_pct", localMs: 2000 });
    assert.equal(v2.breakdown!.layers.length, 1);
    // Pixel entries toggle the same way.
    const pix = setSpineFx({ workspaceDir: ws, item: clipId, fxId: "fx_03", enabled: false });
    assert.equal(pix.fx.enabled, false);
  });
});
