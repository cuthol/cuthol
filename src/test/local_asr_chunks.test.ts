/**
 * Keyless local ASR engine contract (`src/test/local_asr_chunks.test.ts`).
 *
 * No models: the pure-TypeScript parts (jobs parsing, cache revision, stale
 * record detection) run always; the Python chunk planner / filler prompt /
 * time-shift checks load `scripts/local_speech.py` with the system Python
 * (numpy only, never faster-whisper) and skip cleanly when it is absent.
 *
 * Rules pinned here:
 * - Chunk boundaries sit inside silence valleys and no chunk exceeds 28 s.
 * - Every language gets a filler-bearing initial prompt (en/tr/neutral).
 * - Word times shift back to source time; output order is deterministic.
 * - Old whole-file keyless records are stale; cloud and sidecar records never are.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { LOCAL_ASR_ENGINE_REVISION, localAsrCpuThreads, localAsrJobs } from "../speech/local_engine.js";
import { isStaleLocalEngineRecord, localAsrCachePrefix } from "../speech/transcribe.js";
import type { TranscriptDocument } from "../speech/providers.js";

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("localAsrJobs parses CUTHOL_LOCAL_ASR_JOBS with a safe default and clamp", () => {
  withEnv("CUTHOL_LOCAL_ASR_JOBS", undefined, () => assert.equal(localAsrJobs(), 4));
  withEnv("CUTHOL_LOCAL_ASR_JOBS", "", () => assert.equal(localAsrJobs(), 4));
  withEnv("CUTHOL_LOCAL_ASR_JOBS", "3", () => assert.equal(localAsrJobs(), 3));
  withEnv("CUTHOL_LOCAL_ASR_JOBS", "0", () => assert.equal(localAsrJobs(), 1));
  withEnv("CUTHOL_LOCAL_ASR_JOBS", "-4", () => assert.equal(localAsrJobs(), 1));
  withEnv("CUTHOL_LOCAL_ASR_JOBS", "64", () => assert.equal(localAsrJobs(), 8));
  withEnv("CUTHOL_LOCAL_ASR_JOBS", "lots", () => assert.equal(localAsrJobs(), 4));
});

test("localAsrCpuThreads parses CUTHOL_LOCAL_ASR_THREADS with a safe default and clamp", () => {
  withEnv("CUTHOL_LOCAL_ASR_THREADS", undefined, () => assert.equal(localAsrCpuThreads(), 3));
  withEnv("CUTHOL_LOCAL_ASR_THREADS", "", () => assert.equal(localAsrCpuThreads(), 3));
  withEnv("CUTHOL_LOCAL_ASR_THREADS", "1", () => assert.equal(localAsrCpuThreads(), 1));
  withEnv("CUTHOL_LOCAL_ASR_THREADS", "0", () => assert.equal(localAsrCpuThreads(), 0));
  withEnv("CUTHOL_LOCAL_ASR_THREADS", "-3", () => assert.equal(localAsrCpuThreads(), 0));
  withEnv("CUTHOL_LOCAL_ASR_THREADS", "64", () => assert.equal(localAsrCpuThreads(), 16));
  withEnv("CUTHOL_LOCAL_ASR_THREADS", "lots", () => assert.equal(localAsrCpuThreads(), 3));
});

test("local engine revision namespaces the local cache key only", () => {
  assert.equal(LOCAL_ASR_ENGINE_REVISION, "v6");
  assert.equal(localAsrCachePrefix(), "local@v6");
});

function keylessDoc(extra: Partial<TranscriptDocument> = {}): TranscriptDocument {
  return {
    provider: "local",
    model: "faster-whisper-small",
    language: "en",
    duration_ms: 1000,
    text: "hello",
    words: [],
    disfluencies: [],
    ...extra,
  };
}

test("isStaleLocalEngineRecord flags only older keyless-engine records", () => {
  assert.equal(isStaleLocalEngineRecord(keylessDoc()), true);
  assert.equal(isStaleLocalEngineRecord(keylessDoc({ engineRev: "v1" })), true);
  assert.equal(isStaleLocalEngineRecord(keylessDoc({ engineRev: "v4" })), true);
  assert.equal(isStaleLocalEngineRecord(keylessDoc({ engineRev: "v5" })), true);
  assert.equal(isStaleLocalEngineRecord(keylessDoc({ engineRev: "v6" })), false);
  assert.equal(
    isStaleLocalEngineRecord(
      keylessDoc({ engine: "parakeet", model: "parakeet-tdt-0.6b-v3", engineRev: "v5" })
    ),
    true
  );
  assert.equal(
    isStaleLocalEngineRecord(
      keylessDoc({ engine: "parakeet", model: "parakeet-tdt-0.6b-v3", engineRev: "v6" })
    ),
    false
  );
  assert.equal(
    isStaleLocalEngineRecord({ ...keylessDoc(), provider: "deepgram", model: "nova-3" }),
    false
  );
  assert.equal(
    isStaleLocalEngineRecord({ ...keylessDoc(), model: "local-sidecar" }),
    false
  );
  assert.equal(
    isStaleLocalEngineRecord({ ...keylessDoc(), model: "custom-cli" }),
    false
  );
});

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

function runBridgeProbe(expr: string): unknown {
  const script = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("local_speech", ${JSON.stringify(BRIDGE)})`,
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    `sys.stdout.write(json.dumps(${expr}))`,
  ].join("\n");
  const proc = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

test("filler prompt exists per language and keeps keyterms", { skip: NEED_PYTHON }, () => {
  const prompts = runBridgeProbe("{k: mod.filler_prompt_for(k) for k in ['en', 'tr', 'auto', 'xx']}") as Record<
    string,
    string
  >;
  assert.match(prompts.en, /um/i, "en prompt must name fillers");
  assert.match(prompts.en, /uh/i, "en prompt must name fillers");
  assert.match(prompts.tr, /ee/, "tr prompt must carry Turkish fillers");
  assert.match(prompts.neutral ?? prompts.auto, /ee/, "neutral prompt must carry Turkish fillers");
  for (const lang of ["en", "tr", "auto", "xx"]) {
    assert.ok(prompts[lang].length > 20, `${lang} prompt must be non-empty`);
  }
  const withKeys = runBridgeProbe("mod.filler_prompt_for('en', ['Cuthol'])") as string;
  assert.ok(withKeys.startsWith("Cuthol."), "keyterms stay at the front of the prompt");
  assert.match(withKeys, /um/i, "keyterms must not displace the filler prompt");
});

test("chunk planner splits long audio at silence valleys", { skip: NEED_PYTHON }, () => {
  const chunks = runBridgeProbe(
    "(lambda rms, n: mod.plan_chunks(n, rms))([0.09 if (i // 50) % 2 == 0 else 0.001 for i in range(15000)], 15000 * 320)"
  ) as Array<[number, number]>;
  assert.ok(chunks.length > 1, "300 s of alternating speech/silence must split");
  for (const [s, e] of chunks) {
    assert.ok((e - s) / 16000 <= 28.0 + 1e-9, `chunk ${(e - s) / 16000}s exceeds 28 s`);
  }
  assert.equal(chunks[0][0], 0);
  assert.equal(chunks[chunks.length - 1][1], 15000 * 320);
  // Contiguous, non-overlapping, fully covering.
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i][0], chunks[i - 1][1]);
  }
});

test("chunk planner keeps short audio whole and cuts hard without valleys", { skip: NEED_PYTHON }, () => {
  const single = runBridgeProbe("mod.plan_chunks(16000 * 20, [0.09] * 2000)") as Array<[number, number]>;
  assert.deepEqual(single, [[0, 16000 * 20]]);
  const hard = runBridgeProbe("mod.plan_chunks(16000 * 60, [0.09] * 6000)") as Array<[number, number]>;
  assert.ok(hard.length >= 2, "60 s without silence must still split");
  for (const [s, e] of hard) {
    assert.ok((e - s) / 16000 <= 28.0 + 1e-9, "hard-cut chunk exceeds 28 s");
  }
});

test("shift_words returns word times to source time", { skip: NEED_PYTHON }, () => {
  const shifted = runBridgeProbe(
    "mod.shift_words([{'word': 'um', 'punctuated_word': 'Um,', 'start': 0.12, 'end': 0.3, 'confidence': 0.5}], 22.5)"
  ) as Array<{ word: string; source_start_ms: number; source_end_ms: number; confidence: number }>;
  assert.deepEqual(shifted, [
    { word: "um", punctuated_word: "Um,", source_start_ms: 22620, source_end_ms: 22800, confidence: 0.5 },
  ]);
});
