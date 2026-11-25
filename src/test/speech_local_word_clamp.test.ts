import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { formatCaptionsDigest } from "../library/query.js";
import { clampLocalWordsToAcousticSpeech } from "../speech/transcribe.js";

test("stretched local word is clamped to the acoustic speech boundary", () => {
  const words = [
    { source_start_ms: 12100, source_end_ms: 13920, text: "again." },
    { source_start_ms: 13920, source_end_ms: 14300, text: "Most" },
  ];
  clampLocalWordsToAcousticSpeech(words, [{ start_ms: 12250, end_ms: 14100 }]);
  assert.ok(words[0].source_end_ms <= 12250);
  assert.ok(words[1].source_start_ms >= 14100);
  assert.ok(words[0].source_start_ms < words[0].source_end_ms);
  assert.ok(words[1].source_start_ms < words[1].source_end_ms);
  assert.ok(words[0].source_start_ms <= words[1].source_start_ms);
});

test("short overlaps below 300 ms are left alone", () => {
  const words = [{ source_start_ms: 1000, source_end_ms: 1400, text: "hi" }];
  clampLocalWordsToAcousticSpeech(words, [{ start_ms: 1200, end_ms: 1400 }]);
  assert.equal(words[0].source_end_ms, 1400);
});

test("local G213 names --lang en, the language list and --engine whisper", () => {
  const d = DIAGNOSTICS.ASR_LANGUAGE_REQUIRED("local");
  assert.equal(d.code, "CUTHOL-G213");
  assert.match(d.suggestion, /--lang en/);
  assert.match(d.suggestion, /--engine whisper/);
  assert.match(d.suggestion, /25 European languages/);
});

test("non-local G213 keeps the generic suggestion", () => {
  const d = DIAGNOSTICS.ASR_LANGUAGE_REQUIRED("deepgram");
  assert.match(d.suggestion, /--lang en/);
  assert.doesNotMatch(d.suggestion, /Parakeet/);
});

test("captions digest shows kept cues", () => {
  const res = {
    style: "pop-on",
    cues_created: 1,
    cues_kept: ["cue_01", "cue_02"],
    skipped_excised_words: 0,
    cues: [],
    decision_trace: {
      summary: { text: "", effect: { mean_cps: 10 } },
      near_misses: [],
    },
    revision: 1,
    verification: { warning_count: 0, error_count: 0, diagnostics: [] },
  };
  const out = formatCaptionsDigest(res as never);
  assert.equal(out.cues_kept, 2);
  assert.equal((out.digest.counts as Record<string, number>).cues_kept, 2);
});
