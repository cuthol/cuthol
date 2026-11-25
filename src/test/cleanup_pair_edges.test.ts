/**
 * Pair-wise quiet-edge placement for automatic filler/repetition cuts.
 *
 * Each test builds a small synthetic 25 ms acoustic profile plus ASR words
 * (no media files) and calls `refineAutomaticCutEdgesAcoustically` or
 * `summarizeJoinEdgeLoudness` directly.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isKeptEdgeLoud,
  refineAutomaticCutEdgesAcoustically,
  summarizeJoinEdgeLoudness,
} from "../speech/cleanup_acoustic.js";
import type { SpineClip } from "../core/schema.js";
import type { RawTranscriptWord } from "../speech/providers.js";

const WIN_MS = 25;

interface MiniProfile {
  sample_rate_hz: number;
  window_ms: number;
  duration_ms: number;
  silence_floor_dbfs: number;
  has_silence_variation: boolean;
  window_dbfs: Float64Array;
}

/** Background -60 dBFS, speech runs at -20 dBFS over the given ms ranges. */
function profileWithRuns(durationMs: number, runs: Array<[number, number]>): MiniProfile {
  const n = Math.ceil(durationMs / WIN_MS);
  const window_dbfs = new Float64Array(n).fill(-60);
  for (const [s, e] of runs) {
    for (let w = Math.floor(s / WIN_MS); w < Math.ceil(e / WIN_MS); w++) {
      if (w >= 0 && w < n) window_dbfs[w] = -20;
    }
  }
  return {
    sample_rate_hz: 16000,
    window_ms: WIN_MS,
    duration_ms: durationMs,
    silence_floor_dbfs: -60,
    has_silence_variation: true,
    window_dbfs,
  };
}

function clip(inMs: number, outMs: number): SpineClip {
  return { id: "sp_01", source_in_ms: inMs, source_out_ms: outMs } as unknown as SpineClip;
}

function word(text: string, s: number, e: number): RawTranscriptWord {
  return {
    word: text,
    punctuated_word: text,
    source_start_ms: s,
    source_end_ms: e,
    confidence: 0.99,
    is_filler: false,
    is_repetition: false,
  };
}

function refine(
  rawStart: number,
  rawEnd: number,
  words: RawTranscriptWord[],
  profile: MiniProfile,
  preferKeptIntact = true
) {
  return refineAutomaticCutEdgesAcoustically({
    rawStart,
    rawEnd,
    clip: clip(0, profile.duration_ms),
    transcriptWords: words,
    acousticProfile: profile as unknown as ReturnType<
      typeof import("../library/waveform.js").measureAssetAcousticWindows
    >,
    preferKeptIntact,
  });
}

test("1. quiet point past the kept-word guard: start crosses the silent ASR tail", () => {
  // Kept word ASR [700,1010] but true speech ends at 975 (grid: the
  // [975,1000) window stays active); filler island [1025,1175). The quiet
  // start 1020 sits past the old prevEnd + 20 ms guard (1030), so the old
  // build stops inside speech, loud. The new build crosses the silent tail
  // without touching the loud part before 1000.
  const profile = profileWithRuns(3000, [
    [700, 995],
    [1025, 1175],
    [1225, 1500],
  ]);
  const words = [word("merhaba", 700, 1010), word("um", 1000, 1200), word("devam", 1200, 1500)];
  const r = refine(1000, 1200, words, profile);
  assert.equal(r.startMs, 1020, `start must cross the silent tail, got ${r.startMs}`);
  assert.equal(isKeptEdgeLoud(profile as never, r.startMs, "before"), false);
  assert.equal(r.stillLoudBefore, false);
  assert.ok(r.endMs - r.startMs >= 80, "cut must stay >= 80 ms");
});

test("2. counter-check: glued loud kept onset is never cut into", () => {
  // Kept word true speech runs right up to the raw start (no silent tail):
  // no pair satisfies "both quiet" without removing loud kept speech, so
  // the old best-effort placement is kept and the loud part stays intact.
  const profile = profileWithRuns(3000, [
    [700, 1000],
    [1000, 1180],
    [1230, 1500],
  ]);
  const words = [word("merhaba", 700, 1000), word("um", 1000, 1200), word("devam", 1200, 1500)];
  const r = refine(1000, 1200, words, profile);
  assert.ok(r.startMs >= 990, `must not remove loud kept speech, got ${r.startMs}`);
  assert.ok(r.endMs <= 1200, `must not cut into the next kept word, got ${r.endMs}`);
});

test("3. one-frame filler offset from its voiced island: cut covers the island", () => {
  // Raw ASR span is a single 80 ms frame [2000,2080]; the spoken island is
  // [2100,2300]. The cut must grow to cover the island with both edges quiet.
  const profile = profileWithRuns(4000, [
    [1500, 1850],
    [2100, 2300],
    [2500, 2700],
  ]);
  const words = [word("once", 1500, 1900), word("uh", 2000, 2080), word("devam", 2400, 2700)];
  const r = refine(2000, 2080, words, profile);
  assert.ok(r.startMs <= 2100, `cut must cover the island start, got ${r.startMs}`);
  assert.ok(r.endMs >= 2300, `cut must cover the island end, got ${r.endMs}`);
  assert.ok(r.endMs - r.startMs >= 80);
  assert.equal(isKeptEdgeLoud(profile as never, r.startMs, "before"), false);
  assert.equal(isKeptEdgeLoud(profile as never, r.endMs, "after"), false);
});

test("4. quiet 150 ms past the raw edge is found", () => {
  // Filler island [1000,1550); raw end 1400 sits in speech; quiet starts at
  // 1550, beyond the old 100 ms search. The kept word starts at 1600 with
  // true speech from 1650, so reaching 1550 trespasses no loud audio.
  const profile = profileWithRuns(3000, [
    [700, 950],
    [1000, 1550],
    [1650, 2000],
  ]);
  const words = [word("merhaba", 700, 1000), word("um", 1000, 1400), word("devam", 1600, 2000)];
  const r = refine(1000, 1400, words, profile);
  assert.equal(r.endMs, 1550, `end must reach the quiet at +150 ms, got ${r.endMs}`);
  assert.equal(isKeptEdgeLoud(profile as never, r.endMs, "after"), false);
});

test("5. glued speech with no quiet pair keeps best-effort placement", () => {
  // Island [1000,1220) runs into the kept word starting at 1200; no pair
  // satisfies "both quiet" without cutting loud kept speech. The cut must
  // not move into the kept word and must not shrink below the raw span.
  const profile = profileWithRuns(3000, [
    [700, 950],
    [1000, 1220],
    [1220, 1500],
  ]);
  const words = [word("merhaba", 700, 1000), word("um", 1000, 1200), word("open", 1200, 1500)];
  const r = refine(1000, 1200, words, profile);
  assert.ok(r.endMs <= 1200, `must not cut into the loud kept word, got ${r.endMs}`);
  assert.ok(r.startMs >= 700, `must not run past the kept word start, got ${r.startMs}`);
});

test("6. join share counts joins with any loud edge", () => {
  // Two joins: the first has exactly one loud edge, the second is quiet.
  // Per-join share is 1/2 = 0.5 (abnormal); the old per-edge code read
  // 1/4 = 0.25 (no warning).
  const window_dbfs = new Float64Array(600).fill(-60);
  for (let w = 199; w <= 200; w++) window_dbfs[w] = -20; // [4975,5025): left edge of join 1 loud
  const profile = { silence_floor_dbfs: -60, window_dbfs, window_ms: 25 };
  const clips = [
    { id: "sp_01", asset_handle: "vid_01", source_in_ms: 0, source_out_ms: 5000 },
    { id: "sp_02", asset_handle: "vid_01", source_in_ms: 6000, source_out_ms: 10000 },
    { id: "sp_03", asset_handle: "vid_01", source_in_ms: 11000, source_out_ms: 15000 },
  ];
  const s = summarizeJoinEdgeLoudness({
    clips,
    profileByHandle: new Map([["vid_01", profile]]),
  });
  assert.equal(s.total_joins, 2);
  assert.equal(s.loud_joins, 1);
  assert.equal(s.loud_share, 0.5);
  assert.equal(s.abnormal, true);
  assert.ok(s.summary_line.includes("1/2 loud joins"));
});
