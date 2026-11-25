/**
 * Local speech path fixes (`src/test/speech_local_parakeet_path.test.ts`).
 *
 * - The HyperFrames CLI resolves the Node way (hoisted `node_modules`
 *   layouts keep working); `setup --local-speech --engine parakeet` reports
 *   a missing CLI instead of "already installed; nothing to do".
 * - The local Parakeet path raises `ASR_LANGUAGE_REQUIRED` (G213) before
 *   running when no language is given; Whisper and cloud paths are untouched.
 * - Word normalisation is language-aware: Turkish lowercasing only applies
 *   to Turkish transcripts, other languages use neutral lowercasing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import {
  describeLocalSpeechSetup,
  planLocalSpeechSetup,
} from "../core/local_speech_setup.js";
import { resolveHyperFramesCliMjs } from "../core/package_resolve.js";
import {
  hyperframesBin,
  PARAKEET_MODEL_FILES,
  resetParakeetProbeCache,
  runLocalAsrBridge,
} from "../speech/local_engine.js";
import {
  annotateWordsAndDisfluencies,
  normalizeTokenForMatch,
} from "../speech/providers.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_local_parakeet_path");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    resetParakeetProbeCache();
  }
}

function makeFakeParakeetCache(): string {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-path-pcache-"));
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

function makeTinyWav(outPath: string): void {
  const samples = new Int16Array(16000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  fs.writeFileSync(outPath, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

test("hyperframesBin: explicit override wins, otherwise the Node resolver", () => {
  withEnv({ CUTHOL_HYPERFRAMES_BIN: path.join("fake", "hf.mjs") }, () => {
    assert.equal(hyperframesBin(), path.join("fake", "hf.mjs"));
  });
  withEnv({ CUTHOL_HYPERFRAMES_BIN: undefined }, () => {
    const viaResolver = resolveHyperFramesCliMjs();
    if (viaResolver !== null) {
      assert.equal(hyperframesBin(), viaResolver);
    } else {
      assert.ok(hyperframesBin().endsWith(path.join("hyperframes", "bin", "hyperframes.mjs")));
    }
  });
});

test("setup --local-speech --engine parakeet reports a missing HyperFrames CLI", () => {
  const cache = makeFakeParakeetCache();
  const missing = path.join(os.tmpdir(), `cuthol-no-hf-${process.pid}.mjs`);
  try {
    withEnv({ HYPERFRAMES_CACHE_DIR: cache, CUTHOL_HYPERFRAMES_BIN: missing }, () => {
      const plan = planLocalSpeechSetup({ engine: "parakeet" });
      assert.equal(plan.alreadyInstalled, false);
      const lines = describeLocalSpeechSetup(plan);
      assert.ok(
        !lines.some((l) => l.includes("nothing to do")),
        `must not claim nothing to do while the CLI is missing: ${lines.join(" | ")}`
      );
      assert.ok(
        lines.some((l) => l.includes(missing)),
        `must name the missing CLI path: ${lines.join(" | ")}`
      );
    });
  } finally {
    rmRetrySync(cache);
  }
});

test("local Parakeet without --lang raises G213 before running", () => {
  const cache = makeFakeParakeetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-path-g213-"));
  try {
    const wav = path.join(dir, "tiny.wav");
    makeTinyWav(wav);
    withEnv(
      {
        HYPERFRAMES_CACHE_DIR: cache,
        CUTHOL_HYPERFRAMES_BIN: path.join(dir, "unused.mjs"),
      },
      () => {
        assert.throws(
          () => runLocalAsrBridge({ audioFilePath: wav, engine: "parakeet" }),
          (err: unknown) =>
            typeof err === "object" &&
            err !== null &&
            "diagnostic" in err &&
            (err as { diagnostic: { code: string } }).diagnostic.code === "CUTHOL-G213"
        );
        assert.throws(
          () => runLocalAsrBridge({ audioFilePath: wav, engine: "parakeet", language: "auto" }),
          (err: unknown) =>
            typeof err === "object" &&
            err !== null &&
            "diagnostic" in err &&
            (err as { diagnostic: { code: string } }).diagnostic.code === "CUTHOL-G213"
        );
      }
    );
  } finally {
    rmRetrySync(cache);
    rmRetrySync(dir);
  }
});

test("word normalisation follows the transcript language", () => {
  assert.equal(normalizeTokenForMatch("I", "en"), "i");
  assert.equal(normalizeTokenForMatch("It", "en"), "it");
  assert.equal(normalizeTokenForMatch("I", "tr"), "ı");
  assert.equal(normalizeTokenForMatch("IŞIK", "tr"), "ışık");
  assert.equal(normalizeTokenForMatch("IŞIK", "en"), "işik");
  // Records stored with the old rule keep their verbatim punctuated form,
  // so old and new records normalise the same on read.
  const { words: oldRecordWords } = annotateWordsAndDisfluencies(
    [{ word: "ı", punctuated_word: "I", source_start_ms: 0, source_end_ms: 100 }],
    1000,
    400,
    "en"
  );
  assert.equal(oldRecordWords[0].word, "i");
  const { words } = annotateWordsAndDisfluencies(
    [{ word: "I", punctuated_word: "I", source_start_ms: 0, source_end_ms: 100 }],
    1000,
    400,
    "en"
  );
  assert.equal(words[0].word, "i");
  const { words: trWords } = annotateWordsAndDisfluencies(
    [{ word: "I", punctuated_word: "I", source_start_ms: 0, source_end_ms: 100 }],
    1000,
    400,
    "tr"
  );
  assert.equal(trWords[0].word, "ı");
});
