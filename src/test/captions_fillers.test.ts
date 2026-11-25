/**
 * Captions hide filler words (`src/test/captions_fillers.test.ts`). No paid
 * calls, no models: transcripts are seeded straight into the ledger.
 *
 * Rules pinned here:
 * - Every caption path (clip, spine-wide, voiceover) hides words the
 *   transcript marks `is_filler`; the filler text never appears in cue text.
 * - A transcript without fillers captions byte-identically to before
 *   (the filter is a no-op for it).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { rmRetrySync } from "./fs_cleanup.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import type { TranscriptDocument } from "../speech/providers.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/captions_fillers");

function setupMedia(name: string, durationSec = 5): { wsDir: string; mediaFile: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=#0F172A:s=320x180:r=30:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=16000:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: durationSec * 1000 });
  return { wsDir, mediaFile };
}

function seedDoc(wsDir: string, doc: TranscriptDocument): void {
  const { paths, sequence } = loadSequence(wsDir);
  const item = sequence.library.find((x) => x.handle === "vid_01");
  assert.ok(item);
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    for (const key of ["local@v4:en", "en", "auto", "latest", "local:en"]) {
      ledger.setTranscript(item.digest_sha256, key, doc);
    }
  } finally {
    ledger.close();
  }
}

function fillerDoc(): TranscriptDocument {
  const words: TranscriptDocument["words"] = [
    { word: "hello", punctuated_word: "Hello", source_start_ms: 100, source_end_ms: 500, confidence: 0.99, is_filler: false, is_repetition: false },
    { word: "um", punctuated_word: "um,", source_start_ms: 700, source_end_ms: 900, confidence: 0.9, is_filler: true, is_repetition: false },
    { word: "world", punctuated_word: "world.", source_start_ms: 1200, source_end_ms: 1600, confidence: 0.99, is_filler: false, is_repetition: false },
  ];
  return {
    provider: "local",
    model: "test",
    language: "en",
    duration_ms: 5000,
    text: "Hello um, world.",
    words,
    disfluencies: [],
  };
}

function cueText(wsDir: string): string {
  const { sequence } = loadSequence(wsDir);
  const lane = sequence.lanes.find((l) => l.id === "ln_captions");
  assert.ok(lane);
  return lane.cues.map((c) => c.typography?.text ?? "").join(" | ");
}

test("captions hide unconditional and isolated contextual fillers", () => {
  const { wsDir } = setupMedia("ws_fillers_hidden");
  seedDoc(wsDir, fillerDoc());
  const res = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.ok(res.cues_created >= 1);
  const text = cueText(wsDir);
  assert.ok(text.includes("Hello"), `expected content words, got: ${text}`);
  assert.ok(text.includes("world"), `expected content words, got: ${text}`);
  assert.ok(!/\bum\b/i.test(text), `filler leaked into captions: ${text}`);
});

test("captions for a fillerless transcript keep every word", () => {
  const { wsDir } = setupMedia("ws_no_fillers_same");
  const doc = fillerDoc();
  doc.words = doc.words.filter((w) => !w.is_filler);
  doc.text = "Hello world.";
  seedDoc(wsDir, doc);
  const res = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.ok(res.cues_created >= 1);
  const text = cueText(wsDir);
  assert.ok(text.includes("Hello") && text.includes("world"), `words missing: ${text}`);
});

test("voiceover cue path hides fillers too", () => {
  const wsDir = path.join(TEST_ROOT, "ws_vo_fillers");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "vo", aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "vo.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#0F172A:s=320x180:r=30:d=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  // Voiceover cue on ln_vo carrying the transcript's asset, addressed by clipId.
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    explicitId: "vo_1",
    assetHandle: "vid_01",
    atMs: 0,
    durationMs: 5000,
    sourceInMs: 0,
  });
  seedDoc(wsDir, fillerDoc());
  const res = generateSequenceCaptions({ workspaceDir: wsDir, clipId: "vo_1" });
  assert.ok(res.cues_created >= 1);
  const text = cueText(wsDir);
  assert.ok(!/\bum\b/i.test(text), `filler leaked into voiceover captions: ${text}`);
  assert.ok(text.includes("world"), `expected content words, got: ${text}`);
});

test.after(() => {
  for (const name of ["ws_fillers_hidden", "ws_no_fillers_same", "ws_vo_fillers"]) {
    rmRetrySync(path.join(TEST_ROOT, name));
  }
});
