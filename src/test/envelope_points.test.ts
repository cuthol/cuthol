/**
 * Single-keyframe envelope points: add/move/remove on spine clips and lane cues,
 * clip-local/sequence-time/beat clocks, journaled mutations.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";
import {
  addEnvelopePoint,
  beatToLocalMs,
  moveEnvelopePoint,
  removeEnvelopePoint,
  sequenceTimeToLocalMs,
} from "../sequence/envelope_points.js";

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-envpt-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "envpt", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function makeAv(outPath: string, durationSec = 4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", outPath,
  ]);
}

function setup(wsDir: string): { clipId: string; handle: string } {
  const media = path.join(wsDir, "media", "a.mp4");
  makeAv(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
  return { clipId: clip.id, handle: item.handle };
}

test("add/move/remove points; replace at same time; last remove drops entry", () => {
  withWs((wsDir) => {
    const { clipId } = setup(wsDir);
    const a = addEnvelopePoint({
      workspaceDir: wsDir, targetId: clipId,
      parameter: "placement.opacity", offsetMs: 1000, value: 0.5,
    });
    assert.equal(a.envelope.points.length, 1);
    const b = addEnvelopePoint({
      workspaceDir: wsDir, targetId: clipId,
      parameter: "placement.opacity", offsetMs: 1000, value: 0.8,
    });
    assert.equal(b.envelope.points.length, 1);
    assert.equal(b.envelope.points[0].value, 0.8);
    addEnvelopePoint({
      workspaceDir: wsDir, targetId: clipId,
      parameter: "placement.opacity", offsetMs: 2000, value: 1,
    });
    const moved = moveEnvelopePoint({
      workspaceDir: wsDir, targetId: clipId,
      parameter: "placement.opacity", fromMs: 2000, toMs: 3000,
    });
    assert.deepEqual(moved.envelope.points.map((p) => p.offset_ms), [1000, 3000]);
    assert.equal(moved.envelope.points[1].value, 1);
    const removed = removeEnvelopePoint({
      workspaceDir: wsDir, targetId: clipId,
      parameter: "placement.opacity", offsetMs: 1000,
    });
    assert.equal(removed.envelope?.points.length, 1);
    const last = removeEnvelopePoint({
      workspaceDir: wsDir, targetId: clipId,
      parameter: "placement.opacity", offsetMs: 3000,
    });
    assert.equal(last.envelope, null);
    const { sequence } = loadSequence(wsDir);
    const clip = sequence.spine.clips.find((c) => c.id === clipId)!;
    assert.equal(clip.envelopes.find((e) => e.parameter === "placement.opacity"), undefined);
  });
});

test("unknown parameter is G140, out-of-range offset is G305", () => {
  withWs((wsDir) => {
    const { clipId } = setup(wsDir);
    assert.throws(
      () => addEnvelopePoint({
        workspaceDir: wsDir, targetId: clipId,
        parameter: "placement.opasity" as "placement.opacity", offsetMs: 100, value: 1,
      }),
      (e: unknown) => e instanceof CutholError && e.diagnostic.code === "CUTHOL-G140"
    );
    assert.throws(
      () => addEnvelopePoint({
        workspaceDir: wsDir, targetId: clipId,
        parameter: "placement.opacity", offsetMs: 99999, value: 1,
      }),
      (e: unknown) => e instanceof CutholError && e.diagnostic.code === "CUTHOL-G305"
    );
    assert.throws(
      () => moveEnvelopePoint({
        workspaceDir: wsDir, targetId: clipId,
        parameter: "placement.opacity", fromMs: 100, toMs: 200,
      }),
      (e: unknown) => e instanceof CutholError && e.diagnostic.code === "CUTHOL-G174"
    );
  });
});

test("sequence-time conversion includes stage tempo", () => {
  withWs((wsDir) => {
    const { clipId } = setup(wsDir);
    commitSequenceMutation(wsDir, "tempo.set", (seq) => {
      (seq as unknown as { stage: unknown }).stage = { ...(seq.stage as object), tempo: 2 };
      return null;
    });
    const { sequence } = loadSequence(wsDir);
    const start = sequence.spine.clips.find((c) => c.id === clipId)!.timeline_in_ms;
    // Output clock runs at half speed under tempo 2: output t maps to sequence 2t.
    const local = sequenceTimeToLocalMs(sequence, clipId, start + 1000);
    assert.equal(local, 2000);
  });
});

test("beat mapping: grid to cue-local to item-local; diagnostics", () => {
  withWs((wsDir) => {
    const { handle } = setup(wsDir);
    const { sequence, paths } = loadSequence(wsDir);
    const item = sequence.library.find((x) => x.handle === handle)!;
    const ledger = new MediaLedger(paths.ledgerFile);
    ledger.setBeats(item.digest_sha256, 1.35, {
      grid_ms: [0, 500, 1000, 1500],
      grid_count: 4,
    });
    ledger.close();
    const { cue } = addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_bgm",
      kind: "music",
      assetHandle: handle,
      atMs: 2000,
      durationMs: 4000,
    });
    const again = loadSequence(wsDir).sequence;
    // Second beat (500ms asset time) lands at cue start + 500ms.
    const local = beatToLocalMs({
      seq: again, targetId: cue.id, beat: 2, beatsOf: handle,
      gridMs: [0, 500, 1000, 1500],
    });
    assert.equal(local, 500);
    // No grid.
    assert.throws(
      () => beatToLocalMs({ seq: again, targetId: cue.id, beat: 1, beatsOf: handle, gridMs: null }),
      (e: unknown) => e instanceof CutholError && e.diagnostic.code === "CUTHOL-G170"
    );
    // Unplaced asset.
    assert.throws(
      () => beatToLocalMs({ seq: again, targetId: cue.id, beat: 1, beatsOf: "aud_99", gridMs: [0] }),
      (e: unknown) => e instanceof CutholError && e.diagnostic.code === "CUTHOL-G171"
    );
  });
});
