/**
 * Parakeet dropped-gap retry (`src/test/speech_parakeet_gap_retry.test.ts`).
 *
 * The Parakeet bridge re-decodes speech-like holes (>= 1.5 s between words
 * with >= 40 % of 20 ms frames above the silence floor + 15 dB) with one
 * extra CLI call over the gap slices, and merges the recovered words back.
 * A fake HyperFrames bin (`CUTHOL_HYPERFRAMES_BIN`) drives every case: no
 * network, no model, small generated wavs. Each behaviour case fails on the
 * old build (single CLI call, no recovery, no note).
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
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-gap-pcache-"));
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
  // 1.5 s digital silence (pins the 20th-percentile frame low) then 4.5 s
  // tone: the 0.4-5.0 s word hole is loud speech-like audio.
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

function makeQuietHoleWav(outPath: string): void {
  // 0.5 s tone, 4.5 s digital silence, 1 s tone: the 0.4-5.0 s word hole is silent.
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=0.5",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=4.5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
      "-ar", "16000", "-ac", "1", outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

/**
 * Fake HyperFrames bin: on call N serves transcripts pool[N] (last repeats)
 * unless CUTHOL_TEST_FAIL_FROM says to exit 1 from that call index on.
 * Records argv lines and per-call transcript files for assertions.
 */
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
      `const rawFail = (process.env.CUTHOL_TEST_FAIL_FROM ?? "").trim();\n` +
      `const failFrom = rawFail === "" ? -1 : Number(rawFail);\n` +
      `if (failFrom >= 0 && n >= failFrom) { process.exitCode = 1; process.stderr.write("boom"); }\n` +
      `else {\n` +
      `  const pool = JSON.parse(fs.readFileSync(process.env.CUTHOL_TEST_TRANSCRIPTS, "utf8"));\n` +
      `  const words = pool[Math.min(n, pool.length - 1)];\n` +
      `  const out = process.env.CUTHOL_TEST_TRANSCRIPT_OUT + "." + n + ".json";\n` +
      `  fs.writeFileSync(out, JSON.stringify(words), "utf8");\n` +
      `  process.stdout.write(JSON.stringify({ transcriptPath: out }));\n` +
      `}\n`,
    "utf8"
  );
}

interface GapTestEnv {
  dir: string;
  saved: Record<string, string | undefined>;
}

function setupEnv(dir: string, transcripts: unknown[][]): GapTestEnv {
  makeFakeBin(dir);
  fs.writeFileSync(path.join(dir, "pool.json"), JSON.stringify(transcripts), "utf8");
  fs.writeFileSync(path.join(dir, "calls.txt"), "0", "utf8");
  fs.writeFileSync(path.join(dir, "argv.jsonl"), "", "utf8");
  const fakeCache = makeFakeParakeetCache();
  const saved: Record<string, string | undefined> = {};
  const vars: Record<string, string> = {
    CUTHOL_HYPERFRAMES_BIN: path.join(dir, "fake_hf.mjs"),
    CUTHOL_TEST_ARGV_RECORD: path.join(dir, "argv.jsonl"),
    CUTHOL_TEST_CALL_COUNT: path.join(dir, "calls.txt"),
    CUTHOL_TEST_TRANSCRIPTS: path.join(dir, "pool.json"),
    CUTHOL_TEST_TRANSCRIPT_OUT: path.join(dir, "words"),
    HYPERFRAMES_CACHE_DIR: fakeCache,
  };
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.CUTHOL_TEST_FAIL_FROM = process.env.CUTHOL_TEST_FAIL_FROM;
  (setupEnv as { cache?: string }).cache = fakeCache;
  return { dir, saved };
}

function teardownEnv(env: GapTestEnv): void {
  for (const [k, v] of Object.entries(env.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetParakeetProbeCache();
  takeParakeetGapRetry();
  const cache = (setupEnv as { cache?: string }).cache;
  if (cache) fs.rmSync(cache, { recursive: true, force: true });
  rmRetrySync(env.dir);
}

function callCount(dir: string): number {
  return Number(fs.readFileSync(path.join(dir, "calls.txt"), "utf8").trim() || "0");
}

const FIRST_WITH_HOLE = [
  { text: "hello", start: 0.1, end: 0.4 },
  { text: "world", start: 5.0, end: 5.4 },
];

test("loud hole is re-decoded and recovered words land with source times", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-gap-loud-"));
  // Recovered word at combined 2.5 s == source 2.5 s (single slice from 0).
  const retry = [{ text: "middle", start: 2.5, end: 2.8 }];
  const env = setupEnv(dir, [FIRST_WITH_HOLE, retry]);
  try {
    const wav = path.join(dir, "loud.wav");
    makeLoudHoleWav(wav);
    const res = runLocalAsrBridge({ audioFilePath: wav, language: "en", engine: "parakeet", durationMs: 6000 });
    assert.equal(callCount(dir), 2);
    assert.equal(res.gapRetry.gaps, 1);
    assert.equal(res.gapRetry.words, 1);
    assert.equal(res.gapRetryNote, null);
    const texts = res.words.map((w) => w.word);
    assert.deepEqual(texts, ["hello", "middle", "world"]);
    const middle = res.words[1];
    assert.equal(middle.source_start_ms, 2500);
    assert.equal(middle.source_end_ms, 2800);
    // Sorted: no word may end after the next one starts here.
    for (let i = 0; i + 1 < res.words.length; i++) {
      assert.ok(res.words[i].source_start_ms <= res.words[i + 1].source_start_ms);
    }
    // The second CLI call targeted the gap wav, not the source file.
    const argvLines = fs.readFileSync(path.join(dir, "argv.jsonl"), "utf8").trim().split("\n");
    assert.equal(argvLines.length, 2);
    const secondAudio = (JSON.parse(argvLines[1]) as string[])[1];
    assert.notEqual(secondAudio, wav);
    assert.match(secondAudio, /gaps\.wav$/);
    // Out-of-band report for transcribe/verify matches the return value.
    const taken = takeParakeetGapRetry();
    assert.deepEqual(taken?.retry, { gaps: 1, words: 1 });
    assert.equal(taken?.note, null);
  } finally {
    teardownEnv(env);
  }
});

test("quiet hole makes no second call", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-gap-quiet-"));
  const env = setupEnv(dir, [FIRST_WITH_HOLE, [{ text: "middle", start: 2.5, end: 2.8 }]]);
  try {
    const wav = path.join(dir, "hole.wav");
    makeQuietHoleWav(wav);
    const res = runLocalAsrBridge({ audioFilePath: wav, language: "en", engine: "parakeet", durationMs: 6000 });
    assert.equal(callCount(dir), 1);
    assert.deepEqual(res.gapRetry, { gaps: 0, words: 0 });
    assert.deepEqual(res.words.map((w) => w.word), ["hello", "world"]);
    assert.equal(takeParakeetGapRetry()?.retry.gaps, 0);
  } finally {
    teardownEnv(env);
  }
});

test("failing retry keeps the first result with a note", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-gap-fail-"));
  const env = setupEnv(dir, [FIRST_WITH_HOLE, [{ text: "middle", start: 2.5, end: 2.8 }]]);
  process.env.CUTHOL_TEST_FAIL_FROM = "1";
  try {
    const wav = path.join(dir, "loud.wav");
    makeLoudHoleWav(wav);
    const res = runLocalAsrBridge({ audioFilePath: wav, language: "en", engine: "parakeet", durationMs: 6000 });
    assert.equal(callCount(dir), 2);
    assert.deepEqual(res.words.map((w) => w.word), ["hello", "world"]);
    assert.deepEqual(res.gapRetry, { gaps: 1, words: 0 });
    assert.ok(typeof res.gapRetryNote === "string" && res.gapRetryNote.length > 0);
    assert.match(res.gapRetryNote as string, /gap retry failed/);
    const taken = takeParakeetGapRetry();
    assert.deepEqual(taken?.retry, { gaps: 1, words: 0 });
    assert.ok((taken?.note ?? "").includes("gap retry failed"));
  } finally {
    teardownEnv(env);
  }
});

test("margin duplicates are dropped, silence words are dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-gap-margin-"));
  // Slice is [0, 5500]; retry returns the margin word (0.2 s, duplicate of
  // "hello"), one gap word, and one word in no slice (beyond combined end).
  const retry = [
    { text: "hello", start: 0.2, end: 0.35 },
    { text: "middle", start: 2.5, end: 2.8 },
    { text: "zzz", start: 99.0, end: 99.2 },
  ];
  const env = setupEnv(dir, [FIRST_WITH_HOLE, retry]);
  try {
    const wav = path.join(dir, "loud.wav");
    makeLoudHoleWav(wav);
    const res = runLocalAsrBridge({ audioFilePath: wav, language: "en", engine: "parakeet", durationMs: 6000 });
    assert.equal(callCount(dir), 2);
    assert.deepEqual(res.words.map((w) => w.word), ["hello", "middle", "world"]);
    assert.deepEqual(res.gapRetry, { gaps: 1, words: 1 });
  } finally {
    teardownEnv(env);
  }
});
