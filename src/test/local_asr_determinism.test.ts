/**
 * Local ASR determinism and hallucination filter
 * (`src/test/local_asr_determinism.test.ts`).
 *
 * No models: the pure segment filter and the `temperature` call argument
 * are checked with a fake faster-whisper model through the system Python
 * (numpy only, never faster-whisper); skips cleanly when it is absent.
 *
 * Rules pinned here:
 * - `transcribe_chunk` passes no single fixed `temperature` (faster-whisper
 *   default fallback list) and seeds `ctranslate2.set_random_seed` with the
 *   constant before each chunk.
 * - A segment is dropped when it is likely not speech (no-speech
 *   probability above the faster-whisper default while avg logprob is low)
 *   or looping (compression ratio above the faster-whisper default).
 *   Kept speech and the time ranges of dropped segments are reported
 *   next to the words, never silently.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const BRIDGE = path.resolve(process.cwd(), "scripts", "local_speech.py");

function pythonCheck(): string | false {
  const ver = spawnSync("python", ["--version"], { encoding: "utf8" });
  if (ver.status !== 0) return "system python is absent";
  const numpy = spawnSync("python", ["-c", "import numpy"], { encoding: "utf8" });
  if (numpy.status !== 0) return "system python has no numpy";
  if (ver.error) return "system python is absent";
  return false;
}

const NEED_PYTHON = pythonCheck();

function runProbe(script: string): unknown {
  const proc = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

const PRELUDE = [
  "import importlib.util, json, sys",
  `spec = importlib.util.spec_from_file_location("local_speech", ${JSON.stringify(BRIDGE)})`,
  "mod = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
].join("\n");

test("drop thresholds are the faster-whisper defaults", { skip: NEED_PYTHON }, () => {
  const vals = runProbe(
    `${PRELUDE}\nsys.stdout.write(json.dumps({"no_speech": mod.SEGMENT_NO_SPEECH_PROB_THRESHOLD, "logprob": mod.SEGMENT_AVG_LOGPROB_THRESHOLD, "ratio": mod.SEGMENT_COMPRESSION_RATIO_THRESHOLD}))`
  ) as { no_speech: number; logprob: number; ratio: number };
  assert.equal(vals.no_speech, 0.6);
  assert.equal(vals.logprob, -1.0);
  assert.equal(vals.ratio, 2.4);
});

test("should_drop_segment keeps speech, drops non-speech and loops", { skip: NEED_PYTHON }, () => {
  const res = runProbe(
    `${PRELUDE}\nsys.stdout.write(json.dumps([` +
      "mod.should_drop_segment(0.1, -0.5, 1.0)," +
      "mod.should_drop_segment(0.9, -2.0, 1.0)," +
      "mod.should_drop_segment(0.1, -0.3, 3.0)," +
      "mod.should_drop_segment(0.6, -5.0, 1.0)," +
      "mod.should_drop_segment(0.1, -0.2, 2.4)," +
      "mod.should_drop_segment(None, None, None)" +
      "]))"
  ) as boolean[];
  assert.deepEqual(res, [false, true, true, false, false, false]);
});

const FAKE_MODEL_PROBE = (segmentsExpr: string) => [
  PRELUDE,
  "import numpy as np",
  "import sys, types",
  "seed_calls = []",
  "fake_ct2 = types.ModuleType('ctranslate2')",
  "fake_ct2.set_random_seed = lambda s: seed_calls.append(s)",
  "sys.modules['ctranslate2'] = fake_ct2",
  "captured = {}",
  "class FakeModel:",
  "    def transcribe(self, pcm, **kw):",
  "        captured.update(kw)",
  `        return (${segmentsExpr}, None)`,
  "def seg(s, e, p, l, r, texts):",
  "    o = type('S', (), {})()",
  "    o.start = s; o.end = e; o.no_speech_prob = p; o.avg_logprob = l; o.compression_ratio = r",
  "    ws = []",
  "    for t, a, b in texts:",
  "        w = type('W', (), {})()",
  "        w.word = t; w.start = a; w.end = b; w.probability = 0.9",
  "        ws.append(w)",
  "    o.words = ws",
  "    return o",
  "pcm = np.zeros(16000, dtype=np.float32)",
  "words, dropped = mod.transcribe_chunk(pcm, FakeModel(), 'en', 'prompt', None)",
  "sys.stdout.write(json.dumps({",
  "  'has_temperature': 'temperature' in captured,",
  "  'temperature': captured.get('temperature', 'MISSING'),",
  "  'seeds': seed_calls,",
  "  'seed_const': mod.LOCAL_ASR_DECODE_SEED,",
  "  'beam_size': captured.get('beam_size'),",
  "  'cond': captured.get('condition_on_previous_text'),",
  "  'nwords': len(words),",
  "  'dropped': dropped,",
  "}))",
].join("\n");

test("transcribe_chunk uses the default temperature fallback and seeds each chunk", { skip: NEED_PYTHON }, () => {
  const res = runProbe(
    FAKE_MODEL_PROBE(
      "[seg(0.0, 2.0, 0.05, -0.2, 1.1, [('hello', 0.0, 0.5)]), seg(2.0, 4.0, 0.95, -3.0, 1.0, [('thanks for watching', 2.0, 3.5)]), seg(4.0, 6.0, 0.05, -0.2, 5.0, [('bye bye bye bye', 4.0, 5.0)])]"
    )
  ) as { has_temperature: boolean; temperature: unknown; seeds: unknown[]; seed_const: unknown; beam_size: unknown; cond: unknown; nwords: number; dropped: Array<{ start: number; end: number; reason: string }> };
  assert.equal(res.has_temperature, false);
  assert.deepEqual(res.seeds, [res.seed_const]);
  assert.equal(res.beam_size, 5);
  assert.equal(res.cond, false);
  assert.equal(res.nwords, 1);
  assert.equal(res.dropped.length, 2);
  assert.deepEqual(res.dropped[0], { start: 2.0, end: 4.0, reason: "not_speech" });
  assert.deepEqual(res.dropped[1], { start: 4.0, end: 6.0, reason: "looping" });
});

test("shift_dropped returns source-ms ranges", { skip: NEED_PYTHON }, () => {
  const res = runProbe(
    `${PRELUDE}\nsys.stdout.write(json.dumps(mod.shift_dropped([{'start': 2.0, 'end': 4.0, 'reason': 'not_speech'}], 22.5)))`
  ) as Array<{ start_ms: number; end_ms: number; reason: string }>;
  assert.deepEqual(res, [{ start_ms: 24500, end_ms: 26500, reason: "not_speech" }]);
});
