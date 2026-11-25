/**
 * Explicit local provider reads its own engine-scoped cache key
 * (`src/test/explicit_provider_engine_cache.test.ts`).
 *
 * No venv and no network: the whisper install and bridge are faked on disk
 * (the bridge counts its runs), so the second identical explicit-provider
 * call must be served from the cache without running the engine again.
 * A whisper request must never be served a parakeet record.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { LOCAL_ASR_ENGINE_REVISION, resetParakeetProbeCache } from "../speech/local_engine.js";
import { TranscriptDocument } from "../speech/providers.js";
import { localAsrCachePrefix, transcribeLibraryAsset } from "../speech/transcribe.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/explicit_provider_engine_cache");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

function makeFakeWhisperRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-exp-wh-"));
  const inst = path.join(root, "local-speech");
  fs.mkdirSync(inst, { recursive: true });
  const venvPy =
    process.platform === "win32"
      ? path.join(inst, "venv", "Scripts", "python.exe")
      : path.join(inst, "venv", "bin", "python");
  fs.mkdirSync(path.dirname(venvPy), { recursive: true });
  fs.writeFileSync(venvPy, "");
  fs.mkdirSync(path.join(inst, "models", "small"), { recursive: true });
  fs.writeFileSync(path.join(inst, "models", "small", "model.bin"), Buffer.alloc(8));
  fs.mkdirSync(path.join(inst, "voices"), { recursive: true });
  fs.writeFileSync(path.join(inst, "voices", "tr_TR-dfki-medium.onnx"), Buffer.alloc(8));
  fs.writeFileSync(
    path.join(inst, "local-speech.json"),
    JSON.stringify({
      model: "small",
      voice: "tr_TR-dfki-medium",
      fasterWhisper: "1.2.1",
      piperTts: "1.8.0",
      installedAt: new Date().toISOString(),
    }),
    "utf8"
  );
  return root;
}

function writeToneMp4(mediaFile: string, durationSec: number): void {
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
}

function setupMedia(name: string): { wsDir: string; mediaFile: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  return { wsDir, mediaFile };
}

function runCount(counterFile: string): number {
  try {
    return fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("explicit --provider local --engine whisper hits its engine key on repeat", async () => {
  const whisperRoot = makeFakeWhisperRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-exp-env-"));
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-exp-nocache-"));
  const counterFile = path.join(dir, "runs.txt");
  fs.writeFileSync(counterFile, "");
  const bridge = path.join(dir, "fake_bridge.mjs");
  fs.writeFileSync(
    bridge,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(process.env.CUTHOL_TEST_RUN_COUNTER, "run\\n", "utf8");\n` +
      `process.stdout.write(JSON.stringify({ language: "en", words: [{ word: "hello", punctuated_word: "Hello", source_start_ms: 100, source_end_ms: 400, confidence: 0.9 }] }));\n`,
    "utf8"
  );
  const { wsDir } = setupMedia("ws_explicit_whisper");
  const saved: Record<string, string | undefined> = {
    CUTHOL_DATA_DIR: process.env.CUTHOL_DATA_DIR,
    CUTHOL_LOCAL_SPEECH_PYTHON: process.env.CUTHOL_LOCAL_SPEECH_PYTHON,
    CUTHOL_LOCAL_BRIDGE: process.env.CUTHOL_LOCAL_BRIDGE,
    CUTHOL_TEST_RUN_COUNTER: process.env.CUTHOL_TEST_RUN_COUNTER,
    CUTHOL_LOCAL_ASR_CMD: process.env.CUTHOL_LOCAL_ASR_CMD,
    HYPERFRAMES_CACHE_DIR: process.env.HYPERFRAMES_CACHE_DIR,
    CUTHOL_ASR_PROVIDER: process.env.CUTHOL_ASR_PROVIDER,
  };
  process.env.CUTHOL_DATA_DIR = whisperRoot;
  process.env.CUTHOL_LOCAL_SPEECH_PYTHON = process.execPath;
  process.env.CUTHOL_LOCAL_BRIDGE = bridge;
  process.env.CUTHOL_TEST_RUN_COUNTER = counterFile;
  delete process.env.CUTHOL_LOCAL_ASR_CMD;
  delete process.env.CUTHOL_ASR_PROVIDER;
  process.env.HYPERFRAMES_CACHE_DIR = emptyCache;
  try {
    const base = {
      workspaceDir: wsDir,
      handle: "vid_01",
      language: "en",
      provider: "local",
      engine: "whisper",
    } as const;
    const first = await transcribeLibraryAsset({ ...base });
    assert.equal(first.cached, false);
    assert.equal(runCount(counterFile), 1);
    const second = await transcribeLibraryAsset({ ...base });
    assert.equal(second.cached, true);
    assert.equal(runCount(counterFile), 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetParakeetProbeCache();
    fs.rmSync(whisperRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
});

test("explicit whisper never serves a parakeet record", async () => {
  const whisperRoot = makeFakeWhisperRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-exp-xeng-"));
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-exp-xnocache-"));
  const counterFile = path.join(dir, "runs.txt");
  fs.writeFileSync(counterFile, "");
  const bridge = path.join(dir, "fake_bridge.mjs");
  fs.writeFileSync(
    bridge,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(process.env.CUTHOL_TEST_RUN_COUNTER, "run\\n", "utf8");\n` +
      `process.stdout.write(JSON.stringify({ language: "en", words: [{ word: "hello", punctuated_word: "Hello", source_start_ms: 100, source_end_ms: 400, confidence: 0.9 }] }));\n`,
    "utf8"
  );
  const { wsDir } = setupMedia("ws_explicit_xengine");
  const saved: Record<string, string | undefined> = {
    CUTHOL_DATA_DIR: process.env.CUTHOL_DATA_DIR,
    CUTHOL_LOCAL_SPEECH_PYTHON: process.env.CUTHOL_LOCAL_SPEECH_PYTHON,
    CUTHOL_LOCAL_BRIDGE: process.env.CUTHOL_LOCAL_BRIDGE,
    CUTHOL_TEST_RUN_COUNTER: process.env.CUTHOL_TEST_RUN_COUNTER,
    CUTHOL_LOCAL_ASR_CMD: process.env.CUTHOL_LOCAL_ASR_CMD,
    HYPERFRAMES_CACHE_DIR: process.env.HYPERFRAMES_CACHE_DIR,
    CUTHOL_ASR_PROVIDER: process.env.CUTHOL_ASR_PROVIDER,
  };
  process.env.CUTHOL_DATA_DIR = whisperRoot;
  process.env.CUTHOL_LOCAL_SPEECH_PYTHON = process.execPath;
  process.env.CUTHOL_LOCAL_BRIDGE = bridge;
  process.env.CUTHOL_TEST_RUN_COUNTER = counterFile;
  delete process.env.CUTHOL_LOCAL_ASR_CMD;
  delete process.env.CUTHOL_ASR_PROVIDER;
  process.env.HYPERFRAMES_CACHE_DIR = emptyCache;
  try {
    const { paths, sequence } = loadSequence(wsDir);
    const item = sequence.library.find((x) => x.handle === "vid_01");
    assert.ok(item);
    const parakeetDoc = {
      provider: "local",
      model: "parakeet-tdt-0.6b-v3",
      engine: "parakeet",
      engineRev: LOCAL_ASR_ENGINE_REVISION,
      language: "en",
      duration_ms: 2000,
      text: "hello from parakeet",
      words: [
        {
          word: "hello",
          punctuated_word: "hello",
          source_start_ms: 100,
          source_end_ms: 400,
          confidence: 0.99,
          is_filler: false,
          is_repetition: false,
        },
      ],
      disfluencies: [],
      keyterms: [],
    } as unknown as TranscriptDocument;
    const ledger = new MediaLedger(paths.ledgerFile);
    try {
      ledger.setTranscript(item.digest_sha256, `${localAsrCachePrefix("parakeet")}:en`, parakeetDoc);
    } finally {
      ledger.close();
    }
    const res = await transcribeLibraryAsset({
      workspaceDir: wsDir,
      handle: "vid_01",
      language: "en",
      provider: "local",
      engine: "whisper",
    });
    assert.equal(res.cached, false);
    assert.equal(runCount(counterFile), 1);
    assert.ok(!res.transcript.text.includes("parakeet"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetParakeetProbeCache();
    fs.rmSync(whisperRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
});
