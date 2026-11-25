/**
 * (u3) Acoustic edge placement for automatic filler/repetition cuts,
 * `spine excise --snap`, and the `verify-cleanup` join-edge summary.
 *
 * 1. A synthetic clip with a filler whose ASR span is offset 60 ms into
 *    neighbouring speech: the old build cuts at the raw edge (loud), the new
 *    build moves both edges into the gap (quiet).
 * 2. `summarizeJoinEdgeLoudness`: a deliberately bad cut copy reports loud
 *    joins; a clean cut reports 0.
 * 3. Counter-checks: pause-only cleanup has no moved edges and no
 *    filler/repetition cuts; `exciseSpineRanges` without `snap` is untouched.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { measureAssetAcousticWindows } from "../library/waveform.js";
import { appendSpineClip, exciseSpineRanges } from "../sequence/spine.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import {
  isKeptEdgeLoud,
  snapRangesToQuietEdges,
  summarizeJoinEdgeLoudness,
} from "../speech/cleanup_acoustic.js";
import { buildJoinEdgeSummary } from "../speech/verify_cleanup.js";
import type { TranscriptDocument } from "../speech/providers.js";

function rmRetrySync(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_cleanup_edge_placement_tests");

function makeTalkWithGap(wsDir: string, name: string): string {
  const mediaFile = path.join(wsDir, name);
  // 10 s: speech-like tone 0..2.0 s and 7.0..10 s, true digital silence 2.0..7.0 s
  // (50% silence, so the p20 edge threshold sits in the quiet baseline).
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=640x360:r=30:d=10",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='if(between(t,2.0,7.0),0,0.12*sin(2*PI*220*t)+0.05*sin(2*PI*880*t))':s=16000:d=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, `FFmpeg failed: ${ff.stderr}`);
  return mediaFile;
}

function fillerDoc(): TranscriptDocument {
  return {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 10000,
    text: "merhaba um devam ediyoruz",
    words: [
      { word: "merhaba", punctuated_word: "merhaba", source_start_ms: 1300, source_end_ms: 2000, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "um", punctuated_word: "um", source_start_ms: 1940, source_end_ms: 7060, confidence: 0.9, is_filler: true, is_repetition: false },
      { word: "devam", punctuated_word: "devam", source_start_ms: 7000, source_end_ms: 7700, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "ediyoruz", punctuated_word: "ediyoruz.", source_start_ms: 7750, source_end_ms: 8450, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      // ASR filler span offset 60 ms into the neighbouring kept speech on both sides.
      { kind: "filler", source_start_ms: 1940, source_end_ms: 7060, duration_ms: 5120, label: "um" },
    ],
  };
}

test("1. filler cut with ASR edges 60 ms inside speech moves both edges into the gap", () => {
  const wsDir = path.join(TEST_ROOT, "ws_filler_edge");
  fs.rmSync(wsDir, { recursive: true, force: true });
  try {
    initWorkspace({ dir: wsDir, title: "Filler Edge", aspect: "9:16", fps: 30 });
    const mediaFile = makeTalkWithGap(wsDir, "talk.mp4");
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });

    const { paths, sequence } = loadSequence(wsDir);
    const ledger = new MediaLedger(paths.ledgerFile);
    ledger.setTranscript(sequence.library[0].digest_sha256, "tr", fillerDoc());
    ledger.close();

    const res = cleanupClipDialogue({
      workspaceDir: wsDir,
      clipId: "sp_01",
      minPauseMs: 600,
      padMs: 75,
      removePauses: false,
      dryRun: true,
    });
    const fillerCuts = res.cuts.filter((c) => c.kind === "filler");
    assert.equal(fillerCuts.length, 1, `Expected 1 filler cut, got ${JSON.stringify(res.cuts)}`);
    const cut = fillerCuts[0];
    // Old build keeps the raw ASR edges (no acoustic_edge_trimmed, no original_*).
    assert.equal(cut.acoustic_edge_trimmed, true, "Filler cut edge must be acoustically moved");
    assert.equal(cut.original_source_start_ms, 1940);
    assert.equal(cut.original_source_end_ms, 7060);
    // Both edges move inward (into the removed part) and stay within +-100 ms.
    assert.ok(cut.padded_source_start_ms > 1940 && cut.padded_source_start_ms <= 2040);
    assert.ok(cut.padded_source_end_ms < 7060 && cut.padded_source_end_ms >= 6960);
    // Kept words intact: start edge at/after the kept word end, end edge at/before next kept start.
    assert.ok(cut.padded_source_start_ms >= 2000, "Start edge must not cut into 'merhaba'");
    assert.ok(cut.padded_source_end_ms <= 7000, "End edge must not cut into 'devam'");
    // Moved edges are quiet now.
    const profile = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" });
    assert.ok(profile?.has_silence_variation, "Expected measurable acoustic profile");
    assert.equal(isKeptEdgeLoud(profile, cut.padded_source_start_ms, "before"), false);
    assert.equal(isKeptEdgeLoud(profile, cut.padded_source_end_ms, "after"), false);
    // The raw ASR edges were loud (this is what the old build cut at).
    assert.equal(isKeptEdgeLoud(profile, 1940, "before"), true, "Raw start edge must be loud speech");
    assert.equal(isKeptEdgeLoud(profile, 7060, "after"), true, "Raw end edge must be loud speech");
    // Aggregate JSON field + summary line.
    assert.ok(res.edge_placement, "Expected edge_placement in cleanup result");
    assert.equal(res.edge_placement?.filler.cuts, 1);
    assert.ok((res.edge_placement?.filler.edges_moved ?? 0) >= 2);
    assert.equal(res.edge_placement?.filler.edges_still_loud, 0);
    assert.ok(res.edge_placement_summary?.includes("filler 1 cuts"));
  } finally {
    rmRetrySync(wsDir);
  }
});

test("2. join summary: bad cut copy reports loud joins, clean cut reports 0", () => {
  const wsDir = path.join(TEST_ROOT, "ws_join_summary");
  fs.rmSync(wsDir, { recursive: true, force: true });
  try {
    initWorkspace({ dir: wsDir, title: "Join Summary", aspect: "9:16", fps: 30 });
    const mediaFile = makeTalkWithGap(wsDir, "talk.mp4");
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
    // Bad cut: excise 1000..1500 ms, right in the middle of tone (both joins loud).
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });
    exciseSpineRanges({
      workspaceDir: wsDir,
      clipId: "sp_01",
      ranges: [{ start_ms: 1000, end_ms: 1500 }],
      coordinateSpace: "source",
    });
    const badSeq = loadSequence(wsDir).sequence;
    const bad = buildJoinEdgeSummary(wsDir, badSeq);
    assert.equal(bad.total_joins, 1);
    assert.ok(bad.loud_joins >= 1, `Bad cut must report loud joins, got ${JSON.stringify(bad)}`);
    assert.ok(bad.worst.length >= 1 && bad.worst.length <= 5);
    assert.ok(bad.summary_line.includes("[CUTHOL-G741]"), "Abnormal share must use the WARN code");
    assert.equal(bad.abnormal, true);

    // Clean cut: excise inside the true silence gap (both joins quiet).
    const wsDir2 = path.join(TEST_ROOT, "ws_join_summary_clean");
    fs.rmSync(wsDir2, { recursive: true, force: true });
    try {
      initWorkspace({ dir: wsDir2, title: "Join Summary Clean", aspect: "9:16", fps: 30 });
      const media2 = makeTalkWithGap(wsDir2, "talk.mp4");
      ingestAssetsIntoWorkspace({ workspaceDir: wsDir2, filePaths: [media2] });
      appendSpineClip({ workspaceDir: wsDir2, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });
      exciseSpineRanges({
        workspaceDir: wsDir2,
        clipId: "sp_01",
        ranges: [{ start_ms: 2100, end_ms: 2500 }],
        coordinateSpace: "source",
      });
      const cleanSeq = loadSequence(wsDir2).sequence;
      const clean = buildJoinEdgeSummary(wsDir2, cleanSeq);
      assert.equal(clean.total_joins, 1);
      assert.equal(clean.loud_joins, 0, `Clean cut must report 0 loud joins, got ${JSON.stringify(clean)}`);
      assert.equal(clean.abnormal, false);
      assert.ok(clean.summary_line.includes("[CUTHOL-G740]"), "Normal share must use the INFO code");
    } finally {
      rmRetrySync(wsDir2);
    }
  } finally {
    rmRetrySync(wsDir);
  }
});

test("3. counter-check: pause-only cleanup moves no edges; excise without snap is raw", () => {
  const wsDir = path.join(TEST_ROOT, "ws_countercheck");
  fs.rmSync(wsDir, { recursive: true, force: true });
  try {
    initWorkspace({ dir: wsDir, title: "Countercheck", aspect: "9:16", fps: 30 });
    const mediaFile = makeTalkWithGap(wsDir, "talk.mp4");
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });

    const { paths, sequence } = loadSequence(wsDir);
    const ledger = new MediaLedger(paths.ledgerFile);
    const doc = fillerDoc();
    doc.disfluencies = [
      { kind: "pause", source_start_ms: 2000, source_end_ms: 2600, duration_ms: 600, label: "<pause 600ms>" },
    ];
    ledger.setTranscript(sequence.library[0].digest_sha256, "tr", doc);
    ledger.close();

    const res = cleanupClipDialogue({
      workspaceDir: wsDir,
      clipId: "sp_01",
      minPauseMs: 400,
      padMs: 75,
      removePauses: true,
      removeFillers: false,
      dryRun: true,
    });
    assert.equal(res.cuts.filter((c) => c.kind === "filler" || c.kind === "repetition").length, 0);
    // No filler/repetition cuts: the aggregate field is omitted (byte-identical output shape).
    assert.ok(!("edge_placement" in res), "edge_placement must be absent without word cuts");
    assert.ok(!("edge_placement_summary" in res));
    for (const c of res.cuts) {
      assert.equal(c.acoustic_edge_trimmed ?? false, false, "Pause path must stay byte-identical");
    }

    // exciseSpineRanges without snap keeps raw ranges.
    const exc = exciseSpineRanges({
      workspaceDir: wsDir,
      clipId: "sp_01",
      ranges: [{ start_ms: 1940, end_ms: 2660 }],
      coordinateSpace: "source",
    });
    const kept = exc.remainingClips.map((c) => [c.source_in_ms, c.source_out_ms]);
    assert.deepEqual(kept, [[0, 1940], [2660, 10000]]);
  } finally {
    rmRetrySync(wsDir);
  }
});

test("4b. snapRangesToQuietEdges moves loud explicit ranges, keeps quiet ones", () => {
  // Speech 0..2 s, silence 2..7 s, speech 7..10 s (same shape as the generated media).
  const window_dbfs = new Float64Array(400).fill(-70);
  for (let w = 0; w < 80; w++) window_dbfs[w] = -20;
  for (let w = 280; w < 400; w++) window_dbfs[w] = -20;
  const profile = {
    sample_rate_hz: 16000,
    window_ms: 25,
    duration_ms: 10000,
    silence_floor_dbfs: -40,
    has_silence_variation: true,
    window_dbfs,
  };
  const clip = {
    id: "sp_01",
    source_in_ms: 0,
    source_out_ms: 10000,
  } as unknown as import("../core/schema.js").SpineClip;
  const words: import("../speech/providers.js").RawTranscriptWord[] = [
    { word: "merhaba", punctuated_word: "merhaba", source_start_ms: 1300, source_end_ms: 2000, confidence: 0.99, is_filler: false, is_repetition: false },
    { word: "um", punctuated_word: "um", source_start_ms: 2000, source_end_ms: 7000, confidence: 0.9, is_filler: true, is_repetition: false },
    { word: "devam", punctuated_word: "devam", source_start_ms: 7000, source_end_ms: 7700, confidence: 0.99, is_filler: false, is_repetition: false },
  ];
  // Explicit range with ASR edges 60 ms inside speech: both edges move into the gap.
  const snapped = snapRangesToQuietEdges({
    clip,
    ranges: [{ start_ms: 1940, end_ms: 7060 }],
    transcriptWords: words,
    acousticProfile: profile,
  });
  assert.equal(snapped.length, 1);
  assert.ok(snapped[0].start_ms >= 2000 && snapped[0].start_ms <= 2100, JSON.stringify(snapped));
  assert.ok(snapped[0].end_ms < 7060 && snapped[0].end_ms >= 6900, JSON.stringify(snapped));
  assert.equal(isKeptEdgeLoud(profile, snapped[0].start_ms, "before"), false);
  assert.equal(isKeptEdgeLoud(profile, snapped[0].end_ms, "after"), false);
  // Without a profile the ranges pass through untouched (opt-in snap stays exact).
  const raw = snapRangesToQuietEdges({ clip, ranges: [{ start_ms: 1940, end_ms: 7060 }], transcriptWords: words, acousticProfile: null });
  assert.deepEqual(raw, [{ start_ms: 1940, end_ms: 7060 }]);
});

test("4. summarizeJoinEdgeLoudness pure unit: threshold and worst-cap", () => {
  // Threshold is p20 + 15 dB: background at -60, speech runs at -20.
  const window_dbfs = new Float64Array(400).fill(-60);
  for (let w = 195; w <= 205; w++) window_dbfs[w] = -20;
  for (let w = 235; w <= 245; w++) window_dbfs[w] = -20;
  const profile = { silence_floor_dbfs: -40, window_dbfs, window_ms: 25 };
  const clips = [
    { id: "sp_01", asset_handle: "vid_01", source_in_ms: 0, source_out_ms: 5000 },
    { id: "sp_02", asset_handle: "vid_01", source_in_ms: 6000, source_out_ms: 10000 },
  ];
  // Join at 5000..6000: kept edge before=5000 (loud), after=6000 (loud).
  const s = summarizeJoinEdgeLoudness({ clips, profileByHandle: new Map([["vid_01", profile]]) });
  assert.equal(s.total_joins, 1);
  assert.equal(s.loud_joins, 1);
  assert.equal(s.loud_share, 1);
  assert.equal(s.abnormal, true);
  assert.ok(s.worst.length <= 5);
  assert.ok(s.summary_line.includes("1/1 loud joins"));
  // Quiet join: profile quiet at edges.
  const quiet = new Float64Array(400).fill(-60);
  const q = summarizeJoinEdgeLoudness({
    clips,
    profileByHandle: new Map([["vid_01", { silence_floor_dbfs: -40, window_dbfs: quiet, window_ms: 25 }]]),
  });
  assert.equal(q.loud_joins, 0);
  assert.equal(q.abnormal, false);
});
