/**
 * Automatic filler cuts that cannot reach a quiet kept edge are withheld and
 * listed for the agent instead of cut.
 *
 * 1. Glued filler (continuous speech around the span, no quiet pair): the cut
 *    is dropped from the plan and appears in `review_candidates` with the
 *    stable `cf_<asset>_<start>_<end>` id and a reason; pause cuts are cut.
 * 2. The same listed id passed via `cut_candidates` is cut (agent's choice).
 * 3. Counter-checks: a filler with a quiet placement is cut as before and a
 *    pause cut is untouched by the withholding.
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
import type { TranscriptDocument } from "../speech/providers.js";

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_cleanup_no_quiet_edge");

function makeMedia(wsDir: string, name: string): string {
  const mediaFile = path.join(wsDir, name);
  // 10 s: speech-like tone 0..2.0 s and 7.0..10 s, true digital silence 2.0..7.0 s.
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

function gluedDoc(): TranscriptDocument {
  return {
    provider: "local",
    model: "test",
    language: "tr",
    duration_ms: 10000,
    text: "merhaba um devam ediyoruz",
    words: [
      { word: "merhaba", punctuated_word: "merhaba", source_start_ms: 1000, source_end_ms: 1500, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "um", punctuated_word: "um", source_start_ms: 8000, source_end_ms: 8500, confidence: 0.9, is_filler: true, is_repetition: false },
      { word: "devam", punctuated_word: "devam", source_start_ms: 8560, source_end_ms: 9260, confidence: 0.99, is_filler: false, is_repetition: false },
      { word: "ediyoruz", punctuated_word: "ediyoruz.", source_start_ms: 9300, source_end_ms: 9900, confidence: 0.99, is_filler: false, is_repetition: false },
    ],
    disfluencies: [
      // Glued filler: continuous tone on both sides, no quiet pair in reach.
      { kind: "filler", source_start_ms: 8000, source_end_ms: 8500, duration_ms: 500, label: "um" },
      // Genuine pause inside the silence gap.
      { kind: "pause", source_start_ms: 3000, source_end_ms: 4500, duration_ms: 1500, label: "<pause 1500ms>" },
    ],
  };
}

function quietDoc(): TranscriptDocument {
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
      { kind: "filler", source_start_ms: 1940, source_end_ms: 7060, duration_ms: 5120, label: "um" },
    ],
  };
}

function setupWs(name: string, doc: TranscriptDocument): string {
  const wsDir = path.join(TEST_ROOT, name);
  rmDir(wsDir);
  initWorkspace({ dir: wsDir, title: "No Quiet Edge", aspect: "9:16", fps: 30 });
  const mediaFile = makeMedia(wsDir, "talk.mp4");
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 10000 });
  const { paths, sequence } = loadSequence(wsDir);
  const ledger = new MediaLedger(paths.ledgerFile);
  ledger.setTranscript(sequence.library[0].digest_sha256, "tr", doc);
  ledger.close();
  return wsDir;
}

test("1. glued filler is listed with a reason, not cut; pause is cut", () => {
  const wsDir = setupWs("ws_glued", gluedDoc());
  try {
    const res = cleanupClipDialogue({
      workspaceDir: wsDir,
      clipId: "sp_01",
      minPauseMs: 600,
      padMs: 75,
      removePauses: true,
      dryRun: true,
    });
    assert.equal(
      res.cuts.filter((c) => c.kind === "filler").length,
      0,
      `Glued filler must not be cut: ${JSON.stringify(res.cuts)}`
    );
    const listed = res.review_candidates.find((c) => c.id === "cf_vid_01_8000_8500");
    assert.ok(listed, `Expected cf_vid_01_8000_8500 listed: ${JSON.stringify(res.review_candidates.map((c) => c.id))}`);
    assert.match(listed?.reason ?? "", /audible jump/, "Listed candidate must explain the audible jump");
    assert.equal(res.edge_placement?.filler.cuts, 0, "Listed cuts must not count as cuts");
    assert.equal(res.edge_placement?.filler.listed, 1);
    assert.match(res.edge_placement_summary ?? "", /filler 0 cuts, 0 edges moved, 0 still loud, 1 listed \(no quiet edge\)/);
    assert.equal(
      res.cuts.filter((c) => c.kind === "pause").length,
      1,
      `Pause must still be cut: ${JSON.stringify(res.cuts)}`
    );
  } finally {
    rmDir(wsDir);
  }
});

test("2. the same listed id via cut_candidates is cut", () => {
  const wsDir = setupWs("ws_selected", gluedDoc());
  try {
    const res = cleanupClipDialogue({
      workspaceDir: wsDir,
      clipId: "sp_01",
      minPauseMs: 600,
      padMs: 75,
      removePauses: true,
      cutCandidates: ["cf_vid_01_8000_8500"],
      dryRun: true,
    });
    assert.ok(
      res.cuts.some((c) => c.kind === "filler" && c.candidate_id === "cf_vid_01_8000_8500"),
      `Selected filler must be cut: ${JSON.stringify(res.cuts)}`
    );
  } finally {
    rmDir(wsDir);
  }
});

test("3. counter-check: quiet filler is cut as before, nothing listed", () => {
  const wsDir = setupWs("ws_quiet", quietDoc());
  try {
    const res = cleanupClipDialogue({
      workspaceDir: wsDir,
      clipId: "sp_01",
      minPauseMs: 600,
      padMs: 75,
      removePauses: false,
      dryRun: true,
    });
    assert.equal(
      res.cuts.filter((c) => c.kind === "filler").length,
      1,
      `Quiet filler must be cut: ${JSON.stringify(res.cuts)}`
    );
    assert.equal(res.edge_placement?.filler.cuts, 1);
    assert.equal(res.edge_placement?.filler.listed ?? 0, 0);
    assert.ok(!(res.edge_placement_summary ?? "").includes("listed"));
  } finally {
    rmDir(wsDir);
  }
});
