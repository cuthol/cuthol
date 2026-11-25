/**
 * Parakeet empty-retry second chance (`src/test/speech_parakeet_empty_retry.test.ts`).
 *
 * When the gap-slice decode comes back empty (the engine misses a
 * speech-like slice it decodes fine with a one-bit nudge), the bridge
 * decodes once more instead of accepting the hole. Uses the same fake
 * HyperFrames bin contract as the gap-retry tests: pool[n] serves call n.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import {
  PARAKEET_MODEL_FILES,
  resetParakeetProbeCache,
  runLocalAsrBridge,
  takeParakeetGapRetry,
} from "../speech/local_engine.js";

function makeFakeParakeetCache(): string {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-empty-pcache-"));
  const dir = path.join(cache, "parakeet", "parakeet-tdt-0.6b-v3-int8");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of PARAKEET_MODEL_FILES) {
    const fd = fs.openSync(path.join(dir, f.name), "w");
    try {
      fs.ftruncateSync(fd, f.bytes);
    } finally {
      fs.closeSync(fd);
    }
  }
  return cache;
}

function makeLoudHoleWav(outPath: string): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1.5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=4.5",
      "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
      "-ar", "16000", "-ac", "1", outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

function makeFakeBin(dir: string): void {
  const bin = path.join(dir, "fake_hf.mjs");
  fs.writeFileSync(
    bin,
    `import fs from "node:fs";\n` +
      `const record = process.env.CUTHOL_TEST_ARGV_RECORD;\n` +
      `fs.appendFileSync(record, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");\n` +
      `const countFile = process.env.CUTHOL_TEST_CALL_COUNT;\n` +
      `let n = 0;\n` +
      `try { n = Number(fs.readFileSync(countFile, "utf8").trim() || "0"); } catch {}\n` +
      `fs.writeFileSync(countFile, String(n + 1), "utf8");\n` +
      `const pool = JSON.parse(fs.readFileSync(process.env.CUTHOL_TEST_TRANSCRIPTS, "utf8"));\n` +
      `const words = pool[Math.min(n, pool.length - 1)];\n` +
      `const out = process.env.CUTHOL_TEST_TRANSCRIPT_OUT + "." + n + ".json";\n` +
      `fs.writeFileSync(out, JSON.stringify(words), "utf8");\n` +
      `process.stdout.write(JSON.stringify({ transcriptPath: out }));\n`,
    "utf8"
  );
}

const FIRST_WITH_HOLE = [
  { text: "hello", start: 0.1, end: 0.4 },
  { text: "world", start: 5.0, end: 5.4 },
];

test("an empty gap-slice decode is tried once more and recovered words land", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-gap-empty-"));
  makeFakeBin(dir);
  // Call 0 (full audio): hole over the loud part. Call 1 (gap slice):
  // empty engine miss. Call 2 (same slice nudged): the sentence.
  const recovered = [
    { text: "middle", start: 2.5, end: 2.8 },
    { text: "words", start: 3.0, end: 3.4 },
  ];
  fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify([FIRST_WITH_HOLE, [], recovered]), "utf8");
  fs.writeFileSync(path.join(dir, "calls.txt"), "0", "utf8");
  fs.writeFileSync(path.join(dir, "argv.jsonl"), "", "utf8");
  const fakeCache = makeFakeParakeetCache();
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({
    CUTHOL_HYPERFRAMES_BIN: path.join(dir, "fake_hf.mjs"),
    CUTHOL_TEST_ARGV_RECORD: path.join(dir, "argv.jsonl"),
    CUTHOL_TEST_CALL_COUNT: path.join(dir, "calls.txt"),
    CUTHOL_TEST_TRANSCRIPTS: path.join(dir, "pool.json"),
    CUTHOL_TEST_TRANSCRIPT_OUT: path.join(dir, "words"),
    HYPERFRAMES_CACHE_DIR: fakeCache,
  })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const wav = path.join(dir, "loud.wav");
    makeLoudHoleWav(wav);
    const res = runLocalAsrBridge({ audioFilePath: wav, language: "en", engine: "parakeet", durationMs: 6000 });
    // Full decode + empty retry + one nudged re-decode.
    assert.equal(Number(fs.readFileSync(path.join(dir, "calls.txt"), "utf8").trim()), 3);
    assert.deepEqual(res.gapRetry, { gaps: 1, words: 2 });
    assert.equal(res.gapRetryNote, null);
    assert.deepEqual(res.words.map((w) => w.word), ["hello", "middle", "words", "world"]);
    const taken = takeParakeetGapRetry();
    assert.deepEqual(taken?.retry, { gaps: 1, words: 2 });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetParakeetProbeCache();
    takeParakeetGapRetry();
    fs.rmSync(fakeCache, { recursive: true, force: true });
    rmRetrySync(dir);
  }
});
