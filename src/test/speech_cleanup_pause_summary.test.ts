/**
 * Pause edge summary (`src/test/speech_cleanup_pause_summary.test.ts`).
 *
 * Rule pinned here: the summary counts only edges moved by the
 * quiet-point placement for filler/repetition; for pauses it prints just
 * the cut count and the still-loud count. The pause path's own older
 * acoustic refinement count is kept separately as `edges_refined`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import {
  emptyEdgePlacementStats,
  formatEdgePlacementSummary,
} from "../speech/cleanup_plan.js";
import type { TranscriptDocument } from "../speech/providers.js";
import { rmRetrySync } from "./fs_cleanup.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_cleanup_pause_summary");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

test("summary shows no edges-moved for pause; filler line unchanged", () => {
  const stats = emptyEdgePlacementStats();
  stats.filler = { cuts: 1, edges_moved: 2, edges_still_loud: 0 };
  stats.repetition = { cuts: 0, edges_moved: 0, edges_still_loud: 0 };
  stats.pause = { cuts: 50, edges_moved: 99, edges_still_loud: 3, edges_refined: 99 };
  const summary = formatEdgePlacementSummary(stats);
  assert.ok(
    summary.includes("pause 50 cuts, 3 still loud"),
    `pause part must be cut count + still loud, got: ${summary}`
  );
  assert.ok(
    !summary.includes("pause 50 cuts, 99 edges moved"),
    `pause must not claim moved edges, got: ${summary}`
  );
  assert.ok(
    summary.includes("filler 1 cuts, 2 edges moved, 0 still loud"),
    `filler line unchanged, got: ${summary}`
  );
  assert.ok(
    summary.includes("repetition 0 cuts, 0 edges moved, 0 still loud"),
    `repetition line unchanged, got: ${summary}`
  );
});

function makeTalkWithGap(wsDir: string, name: string): string {
  const mediaFile = path.join(wsDir, name);
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

function pauseDoc(): TranscriptDocument {
  return {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 10000,
    text: "merhaba devam ediyoruz",
    words: [
      { word: "merhaba", punctuated_word: "merhaba", source_start_ms: 1300, source_end_ms: 2000, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "um", punctuated_word: "um", source_start_ms: 2100, source_end_ms: 2400, confidence: 0.9, is_filler: true, is_repetition: false },
      { word: "devam", punctuated_word: "devam", source_start_ms: 7000, source_end_ms: 7700, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "ediyoruz", punctuated_word: "ediyoruz.", source_start_ms: 7750, source_end_ms: 8450, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      { kind: "pause", source_start_ms: 2000, source_end_ms: 7000, duration_ms: 5000, label: "<pause 5000ms>" },
      { kind: "filler", source_start_ms: 2100, source_end_ms: 2400, duration_ms: 300, label: "um" },
    ],
  };
}

test("pause cuts keep their refinement count out of edges_moved", () => {
  const wsDir = path.join(TEST_ROOT, "ws_pause_summary");
  fs.rmSync(wsDir, { recursive: true, force: true });
  try {
    initWorkspace({ dir: wsDir, title: "Pause Summary", aspect: "9:16", fps: 30 });
    const mediaFile = makeTalkWithGap(wsDir, "talk.mp4");
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });

    const { paths, sequence } = loadSequence(wsDir);
    const ledger = new MediaLedger(paths.ledgerFile);
    ledger.setTranscript(sequence.library[0].digest_sha256, "tr", pauseDoc());
    ledger.close();

    const res = cleanupClipDialogue({
      workspaceDir: wsDir,
      clipId: "sp_01",
      minPauseMs: 600,
      padMs: 75,
      removePauses: true,
      removeFillers: true,
      removeRepetitions: false,
      dryRun: true,
    });
    const pauseCuts = res.cuts.filter((c) => c.kind === "pause");
    assert.ok(pauseCuts.length > 0, `expected pause cuts, got ${JSON.stringify(res.cuts)}`);
    assert.equal(res.edge_placement?.pause.cuts, pauseCuts.length);
    assert.equal(res.edge_placement?.pause.edges_moved, 0);
    assert.ok(
      (res.edge_placement?.pause.edges_refined ?? 0) > 0,
      `pause refinement count must be kept as edges_refined, got ${JSON.stringify(res.edge_placement?.pause)}`
    );
    assert.ok(res.edge_placement_summary, "expected edge_placement_summary");
    assert.ok(
      !/pause \d+ cuts, \d+ edges moved/.test(res.edge_placement_summary),
      `summary must not claim pause edges moved, got: ${res.edge_placement_summary}`
    );
  } finally {
    rmRetrySync(wsDir);
  }
});
