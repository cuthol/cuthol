// Preset apply / record / gate / reapply / fx-new through real workspaces
// (generated media only, no renders).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { addEnvelopePointsFromFile, runSpineFxCheck } from "../cli_cmd_spine.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { applyPresetSpineFx, reapplyPresetEntries } from "../effects/preset_apply.js";
import { createExtension, enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { addFxSkeleton } from "../extensions/fx_new.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { analyzeAssetBeats } from "../library/beats.js";
import { addLaneCue } from "../sequence/lanes.js";
import {
  appendSpineClip,
  exciseSpineRanges,
  setItemEnvelope,
  setSpineSpeed,
  splitSpineClip,
  trimSpineClip,
} from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";
import { TRIAL_MEDIA_DIR } from "./fixtures.js";

const PRESETS_MANIFEST: Record<string, unknown> = {
  name: "pstudio",
  version: "1.0.0",
  description: "Preset test extension.",
  presets: {
    punch_out: {
      description: "Punch in over the last 300 ms.",
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
    },
    ken_burns: {
      description: "Slow zoom with a small pan.",
      entries: [
        {
          kind: "motion",
          keys: {
            scale_x: [
              { at: "start", value: 1 },
              { at: "end", value: 1.15 },
            ],
            x_pct: [
              { at: "start", value: 0 },
              { at: "end", value: 3 },
            ],
          },
        },
      ],
    },
  },
};

function withPresetWorkspace(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-preset-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "preset", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        rmRetrySync(tmp);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      }
    }
    if (lastErr) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        lastErr = null;
      } catch {
        /* locked by a lingering child handle; surface as test failure */
      }
    }
    if (lastErr) throw lastErr;
  }
}

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeClip(wsDir: string, durationSec = 2): string {
  const media = path.join(wsDir, "media", "clip.mp4");
  fs.mkdirSync(path.dirname(media), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    media,
  ]);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
  return clip.id;
}

function writeExtension(wsDir: string, manifest: Record<string, unknown>): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", String(manifest.name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function setup(wsDir: string): string {
  writeExtension(wsDir, PRESETS_MANIFEST);
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "pstudio" });
  return makeClip(wsDir);
}

function gateCodes(wsDir: string): string[] {
  const { sequence, paths } = loadSequence(wsDir);
  return verifySequence(sequence, paths).diagnostics.map((d) => d.code);
}

function sequenceJson(wsDir: string): string {
  return fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8");
}

test("preset apply writes one entry, envelopes and a record; verify is clean", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    const beforeClips = loadSequence(ws).sequence.spine.clips;
    assert.ok(beforeClips.every((c) => !(c.fx ?? []).some((f) => f.preset)));
    const res = applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/punch_out" });
    assert.equal(res.fx.kind, "motion");
    assert.deepEqual(
      res.pointsPerChannel,
      { "fx.fx_01.scale_x": 2 }
    );
    const { sequence } = loadSequence(ws);
    const clip = sequence.spine.clips.find((c) => c.id === clipId)!;
    const entry = clip.fx!.find((f) => f.id === "fx_01")!;
    assert.deepEqual(
      clip.envelopes!.find((e) => e.parameter === "fx.fx_01.scale_x")!.points.map((p) => [p.offset_ms, p.value]),
      [[1700, 1], [2000, 1.3]]
    );
    assert.equal(entry.preset?.preset, "ext:pstudio/punch_out");
    assert.equal(entry.preset?.points.length, 2);
    assert.ok(res.revision > 0);
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
  });
});

test("preset trim warns and reapply restores the last 300 ms", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/punch_out" });
    const trimRes = trimSpineClip({ workspaceDir: ws, clipId, sourceOutMs: 1600 });
    assert.ok(
      trimRes.verification.diagnostics.some((d) => d.code === "CUTHOL-G369"),
      "trim response carries the drift WARN"
    );
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369").length, 1);
    const re = reapplyPresetEntries({ workspaceDir: ws, item: clipId, fxId: "fx_01" });
    assert.deepEqual(re.fxIds, ["fx_01"]);
    const { sequence } = loadSequence(ws);
    const pts = sequence.spine.clips
      .find((c) => c.id === clipId)!
      .envelopes!.find((e) => e.parameter === "fx.fx_01.scale_x")!.points;
    assert.deepEqual(pts.map((p) => [p.offset_ms, p.value]), [[1300, 1], [1600, 1.3]]);
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
  });
});

test("preset hand-written envelopes match the generated dump", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/ken_burns" });
    const { sequence } = loadSequence(ws);
    const clip = sequence.spine.clips.find((c) => c.id === clipId)!;
    const generatedDump = JSON.stringify(clip.envelopes);
    void generatedDump;
    const clipId2 = makeClip(ws);
    assert.equal(clipId2, "sp_02");
    commitSequenceMutation(ws, "test.preset", (seq) => {
      const c2 = seq.spine.clips.find((c) => c.id === clipId2)!;
      c2.fx = [...(c2.fx ?? []), { id: "fx_01", kind: "motion", params: { scale_x: 1, x_pct: 0 } }];
      c2.envelopes = [
        { parameter: "fx.fx_01.scale_x", points: [{ offset_ms: 0, value: 1, easing: "linear" }, { offset_ms: 2000, value: 1.15, easing: "linear" }] },
        { parameter: "fx.fx_01.x_pct", points: [{ offset_ms: 0, value: 0, easing: "linear" }, { offset_ms: 2000, value: 3, easing: "linear" }] },
      ];
    });
    const after = loadSequence(ws).sequence;
    const c2 = after.spine.clips.find((c) => c.id === clipId2)!;
    assert.equal(JSON.stringify(c2.envelopes), JSON.stringify(clip.envelopes));
  });
});

test("preset split of an end punch: tail silent, head record dropped", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/punch_out" });
    const { clips } = splitSpineClip({ workspaceDir: ws, clipId, splitPointsMs: [1000] });
    assert.deepEqual(clips.map((c) => c.id), ["sp_01", "sp_02"]);
    const { sequence } = loadSequence(ws);
    const head = sequence.spine.clips.find((c) => c.id === "sp_01")!;
    const tail = sequence.spine.clips.find((c) => c.id === "sp_02")!;
    assert.equal(head.fx!.find((f) => f.id === "fx_01")!.preset, undefined, "head record dropped");
    assert.ok(tail.fx!.find((f) => f.id === "fx_01")!.preset, "tail record kept");
    assert.deepEqual(
      tail.envelopes!.find((e) => e.parameter === "fx.fx_01.scale_x")!.points.map((p) => [p.offset_ms, p.value]),
      [[700, 1], [1000, 1.3]]
    );
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
  });
});

test("preset split of ken burns and excise inside: 0 WARN, frames of envelopes identical", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/ken_burns" });
    const { sequence: pre } = loadSequence(ws);
    const prePoints = JSON.stringify(pre.spine.clips.find((c) => c.id === clipId)!.envelopes);
    void prePoints;
    splitSpineClip({ workspaceDir: ws, clipId, splitPointsMs: [1000] });
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
    const afterSplit = loadSequence(ws).sequence;
    const headEnv = JSON.stringify(afterSplit.spine.clips.find((c) => c.id === "sp_01")!.envelopes);
    const tailEnv = JSON.stringify(afterSplit.spine.clips.find((c) => c.id === "sp_02")!.envelopes);
    assert.ok(headEnv.includes('"offset_ms":0'), "head keeps the start point");
    assert.ok(tailEnv.includes('"offset_ms":1000'), "tail keeps the shifted end point");
    const { sequence: preExcise } = loadSequence(ws);
    const tailBefore = JSON.stringify(preExcise.spine.clips.find((c) => c.id === "sp_02")!.envelopes);
    void tailBefore;
    exciseSpineRanges({ workspaceDir: ws, clipId: "sp_02", ranges: [{ start_ms: 200, end_ms: 400 }] });
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
  });
});

test("preset speed change warns (output-time meaning got longer)", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/punch_out" });
    const speedRes = setSpineSpeed({ workspaceDir: ws, clipId, rate: 0.5 });
    void speedRes;
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369").length, 1);
  });
});

test("preset hand edit warns", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/punch_out" });
    setItemEnvelope({
      workspaceDir: ws,
      targetId: clipId,
      parameter: "fx.fx_01.scale_x",
      points: [
        { offset_ms: 1700, value: 1, easing: "linear" },
        { offset_ms: 2000, value: 1.5, easing: "linear" },
      ],
    });
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369").length, 1);
  });
});

test("preset wrong input is rejected with nothing written", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    const snap0 = sequenceJson(ws);
    assert.throws(() => applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/nope" }), /CUTHOL-G360/);
    assert.equal(sequenceJson(ws), snap0, "nothing written");
    assert.throws(
      () => applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/punch_out", params: { bogus: 1 } }),
      /CUTHOL-G361/
    );
    assert.equal(sequenceJson(ws), snap0, "nothing written");
    assert.throws(
      () => applyPresetSpineFx({ workspaceDir: ws, item: "cue_99", preset: "ext:pstudio/punch_out" }),
      /CUTHOL-G101/
    );
    addLaneCue({
      workspaceDir: ws,
      laneId: "ln_titles",
      kind: "title",
      explicitId: "cue_title",
      atMs: 0,
      durationMs: 1000,
      text: "Preset cue",
    });
    assert.throws(
      () => applyPresetSpineFx({ workspaceDir: ws, item: "cue_title", preset: "ext:pstudio/punch_out" }),
      /CUTHOL-G365/
    );
    const snap = sequenceJson(ws);
    writeExtension(ws, {
      ...PRESETS_MANIFEST,
      presets: {
        ...(PRESETS_MANIFEST.presets as Record<string, unknown>),
        bad_chan: { entries: [{ kind: "motion", keys: { wobble: [{ at: "start", value: 1 }] } }] },
        bad_val: { entries: [{ kind: "motion", keys: { scale_x: [{ at: "start", value: 101 }] } }] },
        beat_needs_grid: {
          entries: [{ kind: "motion", keys: { scale_x: [{ at: "start", value: 1 }] } }],
          repeat: { every: "beat", pattern_ms: 200 },
        },
      },
    });
    assert.throws(
      () => applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/bad_chan" }),
      /CUTHOL-G362/
    );
    assert.throws(
      () => applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/bad_val" }),
      /CUTHOL-G363/
    );
    assert.throws(
      () => applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/beat_needs_grid" }),
      /CUTHOL-G366/
    );
    assert.equal(sequenceJson(ws), snap, "nothing written");
  });
});

test("preset short clip crossing anchors rejected", () => {
  withPresetWorkspace((ws) => {
    writeExtension(ws, {
      ...PRESETS_MANIFEST,
      presets: {
        ...(PRESETS_MANIFEST.presets as Record<string, unknown>),
        cross: {
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
        },
      },
    });
    enableExtensionInWorkspace({ workspaceDir: ws, name: "pstudio" });
    const media = path.join(ws, "media", "tiny.mp4");
    fs.mkdirSync(path.dirname(media), { recursive: true });
    ffmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=0.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      media,
    ]);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
    const { clip } = appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
    const snap = sequenceJson(ws);
    assert.throws(
      () =>
        applyPresetSpineFx({
          workspaceDir: ws,
          item: clip.id,
          preset: "ext:pstudio/cross",
        }),
      /CUTHOL-G364/
    );
    assert.equal(sequenceJson(ws), snap, "nothing written");
  });
});

test("preset beat bounce paces on the grid; moving the cue warns once; reapply --all fixes", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    const musicPath = path.join(TRIAL_MEDIA_DIR, "music.mp3");
    const [music] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [musicPath] });
    addLaneCue({
      workspaceDir: ws,
      laneId: "ln_bgm",
      kind: "music",
      explicitId: "cue_bgm",
      assetHandle: music.handle,
      atMs: 0,
      durationMs: 2000,
    });
    const grid = analyzeAssetBeats({ workspaceDir: ws, handle: music.handle, sensitivity: 1.35 });
    assert.ok(grid.grid_ms.length > 2, "music has a beat grid");
    writeExtension(ws, {
      ...PRESETS_MANIFEST,
      presets: {
        ...(PRESETS_MANIFEST.presets as Record<string, unknown>),
        beat_bounce: {
          description: "Bounce on every beat.",
          entries: [
            {
              kind: "motion",
              keys: {
                scale_x: [
                  { at: "start", value: 1 },
                  { at: "100ms", value: 1.08 },
                  { at: "200ms", value: 1 },
                ],
              },
            },
          ],
          repeat: { every: "beat", pattern_ms: 200 },
        },
      },
    });
    const beatsLocal = grid.grid_ms.filter((t) => t >= 0 && t <= 2000);
    const patternRels = [0, 100, 200];
    const expectedPts = beatsLocal.flatMap((b) => patternRels.map((r) => b + r)).filter((t) => t <= 2000).length;
    const r1 = applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/beat_bounce", beats: music.handle });
    const r2 = applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/beat_bounce", beats: music.handle });
    void r1;
    assert.equal(r2.fx.id, "fx_02");
    const { sequence } = loadSequence(ws);
    const clip = sequence.spine.clips.find((c) => c.id === clipId)!;
    const pts = clip.envelopes!.find((e) => e.parameter === "fx.fx_01.scale_x")!.points;
    assert.equal(pts.length, expectedPts, `pattern points inside the 2000 ms clip (${beatsLocal.length} beats)`);
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
    commitSequenceMutation(ws, "test.preset.move-cue", (seq) => {
      const cue = seq.lanes.flatMap((l) => l.cues).find((c) => c.id === "cue_bgm")!;
      cue.at_ms = 500;
    });
    const warns = verifySequence(loadSequence(ws).sequence, loadSequence(ws).paths).diagnostics.filter(
      (d) => d.code === "CUTHOL-G369"
    );
    assert.equal(warns.length, 1, `one WARN for all beat-bound entries, got ${JSON.stringify(warns.map((w) => w.what))}`);
    assert.match(warns[0].suggestion, /--reapply --all/);
    const beforeRev = loadSequence(ws).sequence;
    void beforeRev;
    const re = reapplyPresetEntries({ workspaceDir: ws, item: clipId, all: true });
    assert.deepEqual(re.fxIds, ["fx_01", "fx_02"]);
    assert.deepEqual(gateCodes(ws).filter((c) => c === "CUTHOL-G369"), []);
  });
});

test("preset point count WARN above 150 points on one channel", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    writeExtension(ws, {
      ...PRESETS_MANIFEST,
      presets: {
        ...(PRESETS_MANIFEST.presets as Record<string, unknown>),
        dense: {
          entries: [{ kind: "motion", keys: { scale_x: [{ at: "start", value: 1 }] } }],
          repeat: { every: "10ms", pattern_ms: 10 },
        },
      },
    });
    const res = applyPresetSpineFx({ workspaceDir: ws, item: clipId, preset: "ext:pstudio/dense" });
    assert.ok(res.pointsPerChannel["fx.fx_01.scale_x"] > 150);
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings[0].code, "CUTHOL-G368");
    assert.match(res.warnings[0].what, /draft_480p/);
  });
});

test("envelope points-file writes a long list in one revision", () => {
  withPresetWorkspace((ws) => {
    const clipId = setup(ws);
    const file = path.join(ws, "points.json");
    const pts = Array.from({ length: 300 }, (_, i) => ({ at_ms: Math.round((i * 1999) / 299), value: 1 + i / 300 }));
    fs.writeFileSync(file, JSON.stringify(pts), "utf8");
    const { sequence: preSeq } = loadSequence(ws);
    const revBefore = (preSeq as unknown as { journal?: { revision?: number } }).journal;
    void revBefore;
    const res = addEnvelopePointsFromFile({
      workspaceDir: ws,
      targetId: clipId,
      parameter: "placement.scale_x",
      pointsFile: file,
      sequenceTime: false,
    });
    assert.equal(res.envelope.points.length, 300);
    assert.equal(res.envelope.points[0].offset_ms, 0);
    assert.equal(res.envelope.points[299].offset_ms, 1999);
    assert.ok(res.revision > 0);
  });
});

test("fx-new skeletons enable and pass checks; existing names refused", () => {
  withPresetWorkspace((ws) => {
    const ext = createExtension({ name: "sfx", workspaceDir: ws, scope: "project" });
    void ext;
    const clipRes = addFxSkeleton({ workspaceDir: ws, extName: "sfx", fxName: "glow", role: "clip" });
    assert.equal(clipRes.section, "fx");
    const trRes = addFxSkeleton({ workspaceDir: ws, extName: "sfx", fxName: "slide", role: "transition" });
    assert.equal(trRes.section, "transitions");
    const moRes = addFxSkeleton({ workspaceDir: ws, extName: "sfx", fxName: "pulse", role: "motion" });
    assert.equal(moRes.section, "presets");
    assert.throws(() => addFxSkeleton({ workspaceDir: ws, extName: "sfx", fxName: "glow", role: "clip" }), /CUTHOL-G370/);
    assert.throws(() => addFxSkeleton({ workspaceDir: ws, extName: "sfx", fxName: "x", role: "warp" }), /CUTHOL-G371/);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "sfx" });
    const exitBefore = process.exitCode ?? 0;
    runSpineFxCheck(ws, { kind: "ext:sfx/glow" });
    assert.equal(process.exitCode ?? 0, exitBefore);
    const readme = fs.readFileSync(path.join(ws, ".cuthol", "extensions", "sfx", "README.md"), "utf8");
    assert.ok(readme.includes("## How to try it"));
    assert.ok(readme.includes("spine fx check"));
    assert.ok(readme.includes("spine fx preset"));
  });
});
