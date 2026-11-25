import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue, updateLaneCue } from "../sequence/lanes.js";
import { normalizeSequenceAudio } from "../mix/mix_normalize.js";
import { exportSequenceToCueSheet, mergeCueSheetIntoSequence } from "../sequence/cuesheet.js";

const TEST_ROOT = path.resolve("test-workspace/mix_normalize_offset");

function makeTone(filePath: string, freq: number, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-ar", "48000", filePath],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, `tone render failed: ${proc.stderr}`);
}

function buildVoiceProject(wsDir: string): void {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Normalize offset" });
  const voWav = path.join(wsDir, "vo.wav");
  makeTone(voWav, 440, 2.3);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [voWav] });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    assetHandle: "aud_01",
    atMs: 0,
    durationMs: 2300,
  });
}

function voiceCueOf(wsDir: string): { id: string; gain: number; norm: number | null | undefined } {
  const { sequence } = loadSequence(wsDir);
  const lane = sequence.lanes.find((l) => l.id === "ln_vo")!;
  const cue = lane.cues[0];
  return { id: cue.id, gain: cue.audio_chain!.gain_db, norm: cue.audio_chain!.normalize_gain_db };
}

test("manual voiceover gain survives normalize as an offset and re-runs are idempotent", () => {
  const wsDir = path.join(TEST_ROOT, "ws_offset");
  buildVoiceProject(wsDir);

  const first = normalizeSequenceAudio({ workspaceDir: wsDir });
  const base = voiceCueOf(wsDir);
  assert.ok(first.adjusted_clips.length >= 1, "voiceover cue must be adjusted");
  const n0 = base.norm;
  assert.equal(typeof n0, "number", "normalize must store its own share");

  // Old-version project: normalize_gain_db missing but loudness_target_lufs set
  // means the whole gain is the old normalize result -> offset 0, gains unchanged.
  commitSequenceMutation(wsDir, "test.strip-normalize-share", (seq) => {
    for (const lane of seq.lanes) for (const cue of lane.cues) {
      if (cue.audio_chain) delete (cue.audio_chain as { normalize_gain_db?: number | null }).normalize_gain_db;
    }
  });
  const legacyBefore = voiceCueOf(wsDir);
  normalizeSequenceAudio({ workspaceDir: wsDir });
  const legacyAfter = voiceCueOf(wsDir);
  assert.equal(legacyAfter.gain, legacyBefore.gain, "old-project normalize must keep the same gains");
  assert.equal(legacyAfter.norm, legacyBefore.gain, "old-project gain becomes the stored normalize share");

  for (const manual of [-6, 5, 12]) {
    updateLaneCue({ workspaceDir: wsDir, cueId: base.id, gainDb: manual });
    const res = normalizeSequenceAudio({ workspaceDir: wsDir });
    const after = voiceCueOf(wsDir);
    const expected = Number((after.norm! + (manual - n0!)).toFixed(2));
    assert.ok(
      Math.abs(after.gain - expected) <= 0.05,
      `manual ${manual}: gain ${after.gain} must equal normalized ${after.norm} + offset (${expected})`
    );
    const item = res.decision_trace.decisions.find((d) => d.id === base.id)!;
    assert.ok(
      (item.note ?? "").includes("kept manual offset"),
      "decision_trace must name the kept offset"
    );
    void res;
  }

  const gains = [-6, 5, 12].map((manual) => {
    updateLaneCue({ workspaceDir: wsDir, cueId: base.id, gainDb: manual });
    normalizeSequenceAudio({ workspaceDir: wsDir });
    return voiceCueOf(wsDir).gain;
  });
  assert.ok(Math.abs(gains[1] - gains[0] - 11) <= 0.1, `+5 vs -6 differ by 11dB, got ${gains[1] - gains[0]}`);
  assert.ok(Math.abs(gains[2] - gains[1] - 7) <= 0.1, `+12 vs +5 differ by 7dB, got ${gains[2] - gains[1]}`);

  const chainBefore = JSON.stringify(voiceCueOf(wsDir));
  normalizeSequenceAudio({ workspaceDir: wsDir });
  const chainAfter = JSON.stringify(voiceCueOf(wsDir));
  assert.equal(chainAfter, chainBefore, "second normalize run must not change gains");
});

test("cue export/apply round trip keeps the normalize share", () => {
  const wsDir = path.join(TEST_ROOT, "ws_roundtrip");
  buildVoiceProject(wsDir);
  normalizeSequenceAudio({ workspaceDir: wsDir });
  const before = voiceCueOf(wsDir);

  const { sequence } = loadSequence(wsDir);
  const sheet = exportSequenceToCueSheet(sequence);
  const cueEntry = sheet.cues!.find((c: { id?: string }) => c.id === before.id)!;
  assert.equal(cueEntry.normalize_gain_db, before.norm, "export must carry normalize_gain_db");
  const { nextSeq } = mergeCueSheetIntoSequence(structuredClone(sequence), sheet);
  const lane = nextSeq.lanes.find((l) => l.id === "ln_vo")!;
  assert.equal(lane.cues[0].audio_chain!.normalize_gain_db, before.norm, "apply must restore normalize_gain_db");

  updateLaneCue({ workspaceDir: wsDir, cueId: before.id, gainDb: 5 });
  normalizeSequenceAudio({ workspaceDir: wsDir });
  const kept = voiceCueOf(wsDir);
  assert.ok(Math.abs(kept.gain - (kept.norm! + (5 - before.norm!))) <= 0.05, "offset survives export/apply");
});
