/**
 * Hand-edited caption cues (`src/test/caption_hand_edit.test.ts`).
 *
 * - `lane update-cue --text` on a caption cue with `words` re-aligns the word
 *   timings (same count: times kept; different count: spread over the cue
 *   span weighted by character length) and marks the cue hand-edited.
 * - Re-running `speech captions` without `replace` keeps hand-edited cues
 *   (no new cue overlaps them) and lists the kept ids; with `replace=true`
 *   everything is rebuilt.
 * - `cue apply` re-aligns the same way when the sheet text changed but the
 *   sheet words are the stored ones.
 * - Plain (wordless) captions and titles are untouched by the re-align path.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue, updateLaneCue } from "../sequence/lanes.js";
import { mergeCueSheetIntoSequence } from "../sequence/cuesheet.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { TIMELINE_ACTION_SPECS } from "../mcp/catalog_specs_timeline.js";
import type { TranscriptDocument } from "../speech/providers.js";
import { rmRetrySync } from "./fs_cleanup.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/caption_hand_edit");

function setupMedia(name: string, durationSec = 8): string {
  const wsDir = path.join(TEST_ROOT, name);
  rmRetrySync(wsDir);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=#0F172A:s=320x180:r=30:d=${durationSec}`,
      "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=16000:duration=${durationSec}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: durationSec * 1000 });
  return wsDir;
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

function eightWordDoc(): TranscriptDocument {
  const raw: Array<[string, number, number]> = [
    ["one", 100, 400], ["two", 500, 800], ["three", 900, 1300], ["four", 1400, 1700],
    ["five", 2000, 2300], ["six", 2400, 2700], ["seven", 2800, 3200], ["eight.", 3300, 3700],
  ];
  return {
    provider: "local",
    model: "test",
    language: "en",
    duration_ms: 8000,
    text: raw.map(([w]) => w).join(" "),
    words: raw.map(([word, source_start_ms, source_end_ms]) => ({
      word, punctuated_word: word, source_start_ms, source_end_ms,
      confidence: 0.99, is_filler: false, is_repetition: false,
    })),
    disfluencies: [],
  };
}

function captionCues(wsDir: string) {
  const { sequence } = loadSequence(wsDir);
  const lane = sequence.lanes.find((l) => l.id === "ln_captions");
  assert.ok(lane);
  return lane.cues;
}

test("same-count text edit keeps each word time and marks hand-edited", () => {
  const wsDir = setupMedia("ws_same_count");
  seedDoc(wsDir, eightWordDoc());
  generateSequenceCaptions({ workspaceDir: wsDir });
  const before = captionCues(wsDir);
  assert.ok(before.length >= 1);
  const target = before[0];
  const oldTimes = (target.typography?.words ?? []).map((w) => [w.sequence_start_ms, w.sequence_end_ms]);
  assert.ok(oldTimes.length >= 2);
  const newText = (target.typography?.words ?? []).map((w) => `${w.word}x`).join(" ");
  updateLaneCue({ workspaceDir: wsDir, cueId: target.id, text: newText });
  const after = captionCues(wsDir).find((c) => c.id === target.id);
  assert.ok(after?.typography);
  assert.equal(after.typography.text, newText);
  assert.equal(after.typography.hand_edited, true);
  const newTimes = (after.typography.words ?? []).map((w) => [w.sequence_start_ms, w.sequence_end_ms]);
  assert.deepEqual(newTimes, oldTimes);
  assert.deepEqual((after.typography.words ?? []).map((w) => w.word), newText.split(" "));
});

test("different-count text edit spreads words monotonically inside the span", () => {
  const wsDir = setupMedia("ws_diff_count");
  seedDoc(wsDir, eightWordDoc());
  generateSequenceCaptions({ workspaceDir: wsDir });
  const target = captionCues(wsDir)[0];
  const prevWords = target.typography?.words ?? [];
  assert.ok(prevWords.length >= 2);
  const spanStart = prevWords[0].sequence_start_ms!;
  const spanEnd = prevWords[prevWords.length - 1].sequence_end_ms!;
  updateLaneCue({ workspaceDir: wsDir, cueId: target.id, text: "hi there friend" });
  const after = captionCues(wsDir).find((c) => c.id === target.id);
  const words = after?.typography?.words ?? [];
  assert.equal(words.length, 3);
  assert.deepEqual(words.map((w) => w.word), ["hi", "there", "friend"]);
  for (let i = 0; i < words.length; i++) {
    assert.ok((words[i].sequence_start_ms ?? -1) >= spanStart, `word ${i} starts inside the span`);
    assert.ok((words[i].sequence_end_ms ?? -1) <= spanEnd, `word ${i} ends inside the span`);
    assert.ok((words[i].sequence_end_ms ?? 0) > (words[i].sequence_start_ms ?? 0), `word ${i} has positive duration`);
    if (i > 0) assert.ok((words[i].sequence_start_ms ?? 0) >= (words[i - 1].sequence_start_ms ?? 0), `word ${i} monotonic`);
  }
  assert.equal(after?.typography?.hand_edited, true);
});

test("wordless caption and title edits set no flag and keep no words", () => {
  const wsDir = setupMedia("ws_wordless");
  seedDoc(wsDir, eightWordDoc());
  const title = addLaneCue({ workspaceDir: wsDir, laneId: "ln_titles", kind: "title", text: "Hello", durationMs: 2000 }).cue;
  updateLaneCue({ workspaceDir: wsDir, cueId: title.id, text: "World" });
  const { sequence } = loadSequence(wsDir);
  const lane = sequence.lanes.find((l) => l.id === "ln_titles")!;
  const edited = lane.cues.find((c) => c.id === title.id)!;
  assert.equal(edited.typography?.text, "World");
  assert.equal(edited.typography?.words, undefined);
  assert.equal(edited.typography?.hand_edited, undefined);
});

test("captions re-run without replace keeps the hand-edited cue", () => {
  const wsDir = setupMedia("ws_keep");
  seedDoc(wsDir, eightWordDoc());
  const first = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.ok(first.cues_created >= 1);
  const target = captionCues(wsDir)[0];
  const oldWords = (target.typography?.words ?? []).map((w) => w.word);
  assert.ok(oldWords.length >= 2);
  const newText = oldWords.map((w) => `${w}y`).join(" ");
  updateLaneCue({ workspaceDir: wsDir, cueId: target.id, text: newText });
  const second = generateSequenceCaptions({ workspaceDir: wsDir });
  assert.deepEqual(second.cues_kept, [target.id]);
  const kept = captionCues(wsDir).find((c) => c.id === target.id);
  assert.ok(kept, "hand-edited cue survives the re-run");
  assert.equal(kept.typography?.text, newText);
  const keptStart = kept.at_ms;
  const keptEnd = keptStart + kept.duration_ms;
  for (const c of captionCues(wsDir)) {
    if (c.id === target.id) continue;
    const s = c.at_ms;
    const e = s + c.duration_ms;
    assert.ok(e <= keptStart || s >= keptEnd, `new cue ${c.id} [${s},${e}] must not overlap kept [${keptStart},${keptEnd}]`);
  }
});

test("captions re-run with replace rebuilds everything", () => {
  const wsDir = setupMedia("ws_replace");
  seedDoc(wsDir, eightWordDoc());
  generateSequenceCaptions({ workspaceDir: wsDir });
  const target = captionCues(wsDir)[0];
  const newText = `${target.typography?.text} extra words here`;
  updateLaneCue({ workspaceDir: wsDir, cueId: target.id, text: newText });
  const rebuilt = generateSequenceCaptions({ workspaceDir: wsDir, replaceExistingCaptions: true });
  assert.deepEqual(rebuilt.cues_kept, []);
  const gone = captionCues(wsDir).find((c) => c.id === target.id);
  assert.equal(gone, undefined);
});

test("cue apply with changed text and stored words re-aligns", () => {
  const wsDir = setupMedia("ws_cuesheet");
  seedDoc(wsDir, eightWordDoc());
  generateSequenceCaptions({ workspaceDir: wsDir });
  const { sequence } = loadSequence(wsDir);
  const target = sequence.lanes.find((l) => l.id === "ln_captions")!.cues[0];
  const storedWords = target.typography?.words ?? [];
  assert.ok(storedWords.length >= 2);
  const oldTimes = storedWords.map((w) => [w.sequence_start_ms, w.sequence_end_ms]);
  const newText = storedWords.map((w) => `${w.word}z`).join(" ");
  const { diff, nextSeq } = mergeCueSheetIntoSequence(sequence, {
    cues: [{ id: target.id, lane_id: "ln_captions", typography: { text: newText, words: structuredClone(storedWords) } }],
  });
  assert.deepEqual(diff.cues_updated, [target.id]);
  const updated = nextSeq.lanes.find((l) => l.id === "ln_captions")!.cues.find((c) => c.id === target.id)!;
  assert.ok(updated?.typography);
  assert.equal(updated.typography.text, newText);
  assert.equal(updated.typography.hand_edited, true);
  assert.deepEqual(
    (updated.typography.words ?? []).map((w) => [w.sequence_start_ms, w.sequence_end_ms]),
    oldTimes
  );
});

test("help texts describe lane stacking and audio handles", () => {
  const byAction = new Map(TIMELINE_ACTION_SPECS.map((s) => [`${s.tool}.${s.action}`, s]));
  const addCue = byAction.get("lane.add_cue")!;
  const addComp = byAction.get("lane.add_composition")!;
  const updateCue = byAction.get("lane.update_cue")!;
  const spineAppend = byAction.get("spine.append")!;
  for (const spec of [addCue, addComp, updateCue]) {
    const z = spec.params.find((p) => p.name === "z_index")!;
    assert.ok(z.description.includes("within its lane"), `${spec.action}: orders cues within the lane`);
    assert.ok(z.description.includes("ln_broll (10)"), `${spec.action}: lists default lane order`);
    assert.ok(z.description.includes("ln_captions (30)"), `${spec.action}: lists default lane order`);
  }
  const asset = spineAppend.params.find((p) => p.name === "asset")!;
  assert.ok(asset.description.includes("aud_XX"), "spine append help lists audio handles");
});

