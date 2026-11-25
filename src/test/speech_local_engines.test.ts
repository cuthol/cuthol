/**
 * Local engine choice: whisper vs Parakeet (`src/test/speech_local_engines.test.ts`).
 *
 * No venv and no network: the whisper install is faked on disk, Parakeet is
 * driven through `HYPERFRAMES_CACHE_DIR` (model files present = installed,
 * empty folder = not installed). One test transcribes a 1 s tone through
 * the real Parakeet engine to pin the stored transcript shape.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import {
  describeLocalSpeechSetup,
  planLocalSpeechSetup,
  resolveLocalSpeechEngine,
} from "../core/local_speech_setup.js";
import {
  isParakeetLanguage,
  PARAKEET_LANGUAGES,
  PARAKEET_MODEL_FILES,
  resetParakeetProbeCache,
  resolveLocalEngine,
} from "../speech/local_engine.js";
import { transcribeWithLocalProvider } from "../speech/providers.js";
import { describeLocalEngines } from "../speech/provider_select.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_local_engines");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  };
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

function makeFakeWhisperRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-wh-"));
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

/**
 * Fake installed Parakeet: model files with the exact byte sizes the
 * HyperFrames CLI requires, under a temp `HYPERFRAMES_CACHE_DIR`. Sparse
 * files allocate nothing; detection only stats them.
 */
function makeFakeParakeetCache(): string {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-pcache-"));
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

test("parakeet covers documented languages, never Turkish or auto", () => {
  assert.equal(isParakeetLanguage("en"), true);
  assert.equal(isParakeetLanguage("en-US"), true);
  assert.equal(isParakeetLanguage("de"), true);
  assert.equal(isParakeetLanguage("fr"), true);
  assert.equal(isParakeetLanguage("es"), true);
  assert.equal(isParakeetLanguage("ru"), true);
  assert.equal(isParakeetLanguage("uk"), true);
  assert.equal(isParakeetLanguage("tr"), false);
  assert.equal(isParakeetLanguage("auto"), false);
  assert.equal(isParakeetLanguage(undefined), false);
  assert.equal(isParakeetLanguage("ja"), false);
  assert.equal(PARAKEET_LANGUAGES.length, 25);
  assert.ok(!PARAKEET_LANGUAGES.includes("tr"));
});

test("forced engine on an empty machine names the engine and the setup command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-none-"));
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-nocache-"));
  try {
    withEnv({ CUTHOL_DATA_DIR: dir, HYPERFRAMES_CACHE_DIR: emptyCache }, () => {
      assert.throws(
        () => resolveLocalEngine({ language: "en", forced: "whisper" }),
        /CUTHOL-G237.*whisper.*cuthol setup --local-speech --engine whisper --apply/
      );
      assert.throws(
        () => resolveLocalEngine({ language: "en", forced: "parakeet" }),
        /CUTHOL-G237.*parakeet.*cuthol setup --local-speech --engine parakeet --apply/
      );
      assert.throws(() => resolveLocalEngine({ language: "en", forced: "cuda" }), /CUTHOL-G230/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
});

test("forced parakeet on an uncovered language fails with the same diagnostic", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-forced-tr-"));
  const fakeCache = makeFakeParakeetCache();
  const whisperRoot = makeFakeWhisperRoot();
  try {
    // Even with both engines installed, forcing parakeet for Turkish fails
    // before the CLI runs (it would only report its own runtime error).
    withEnv({ CUTHOL_DATA_DIR: whisperRoot, HYPERFRAMES_CACHE_DIR: fakeCache }, () => {
      assert.throws(
        () => resolveLocalEngine({ language: "tr", forced: "parakeet" }),
        /CUTHOL-G237.*'tr'.*Parakeet.*cuthol setup --local-speech --engine whisper --apply/
      );
      assert.equal(resolveLocalEngine({ language: "tr", forced: "whisper" }), "whisper");
    });
    void dir;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(whisperRoot, { recursive: true, force: true });
    fs.rmSync(fakeCache, { recursive: true, force: true });
  }
});

test("turkish with only parakeet fails naming the language, engine and whisper setup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-tr-"));
  const fakeCache = makeFakeParakeetCache();
  try {
    withEnv({ CUTHOL_DATA_DIR: dir, HYPERFRAMES_CACHE_DIR: fakeCache }, () => {
      // No whisper install under CUTHOL_DATA_DIR; Parakeet reports installed.
      assert.throws(
        () => resolveLocalEngine({ language: "tr" }),
        /CUTHOL-G237.*'tr'.*Parakeet.*cuthol setup --local-speech --engine whisper --apply/
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeCache, { recursive: true, force: true });
  }
});

test("english resolves parakeet when installed, whisper otherwise", () => {
  const whisperRoot = makeFakeWhisperRoot();
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-empty-"));
  const fakeCache = makeFakeParakeetCache();
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-nocache2-"));
  try {
    // Both installed: English goes to Parakeet.
    withEnv({ CUTHOL_DATA_DIR: whisperRoot, HYPERFRAMES_CACHE_DIR: fakeCache }, () => {
      assert.equal(resolveLocalEngine({ language: "en" }), "parakeet");
      // Forced whisper still works when both are installed.
      assert.equal(resolveLocalEngine({ language: "en", forced: "whisper" }), "whisper");
      // Unknown languages (auto) stay on full-coverage whisper when both exist.
      assert.equal(resolveLocalEngine({ language: "auto" }), "whisper");
    });
    // Only whisper (no Parakeet model files): everything stays on whisper.
    withEnv({ CUTHOL_DATA_DIR: whisperRoot, HYPERFRAMES_CACHE_DIR: emptyCache }, () => {
      assert.equal(resolveLocalEngine({ language: "en" }), "whisper");
      assert.equal(resolveLocalEngine({ language: "tr" }), "whisper");
      assert.throws(() => resolveLocalEngine({ language: "en", forced: "parakeet" }), /CUTHOL-G237/);
    });
    // Neither installed: every request fails with the install hint.
    withEnv({ CUTHOL_DATA_DIR: emptyRoot, HYPERFRAMES_CACHE_DIR: emptyCache }, () => {
      assert.throws(() => resolveLocalEngine({ language: "en" }), /CUTHOL-G237/);
    });
  } finally {
    fs.rmSync(whisperRoot, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(fakeCache, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
});

test("setup dry run without --engine prints both options and both install commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-plan-"));
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-nocache3-"));
  try {
    withEnv({ CUTHOL_DATA_DIR: dir, HYPERFRAMES_CACHE_DIR: emptyCache }, () => {
      const plan = planLocalSpeechSetup({});
      assert.equal(plan.engine, undefined);
      const text = describeLocalSpeechSetup(plan).join("\n");
      assert.ok(text.includes("parakeet"), "names parakeet");
      assert.ok(text.includes("whisper"), "names whisper");
      assert.ok(
        text.includes("cuthol setup --local-speech --engine parakeet --apply"),
        "parakeet install command"
      );
      assert.ok(
        text.includes("cuthol setup --local-speech --engine whisper --apply"),
        "whisper install command"
      );
      assert.ok(text.includes("640 MB"), "parakeet size");
      assert.ok(text.includes("not Turkish"), "parakeet language bound");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
});

test("setup rejects unknown engines and --apply without --engine asks for the choice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-apply-"));
  try {
    withEnv({ CUTHOL_DATA_DIR: dir }, () => {
      assert.throws(() => resolveLocalSpeechEngine("cuda"), /CUTHOL-G238/);
      assert.equal(resolveLocalSpeechEngine("parakeet"), "parakeet");
      assert.equal(resolveLocalSpeechEngine(undefined), undefined);
    });
    const { applyLocalSpeechSetup } = await import("../core/local_speech_setup.js");
    await assert.rejects(applyLocalSpeechSetup({}), /CUTHOL-G238.*Choose one engine/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("providers listing names the installed engines and their languages", () => {
  const whisperRoot = makeFakeWhisperRoot();
  const fakeCache = makeFakeParakeetCache();
  try {
    withEnv({ CUTHOL_DATA_DIR: whisperRoot, HYPERFRAMES_CACHE_DIR: fakeCache }, () => {
      const { engines } = describeLocalEngines();
      const ids = engines.map((e) => e.id).sort();
      assert.deepEqual(ids, ["parakeet", "whisper"]);
      const whisper = engines.find((e) => e.id === "whisper");
      assert.equal(whisper?.installed, true);
      assert.ok(whisper?.languages.includes("Turkish"));
      const parakeet = engines.find((e) => e.id === "parakeet");
      assert.equal(parakeet?.installed, true);
      assert.ok(parakeet?.languages.includes("not Turkish"));
    });
  } finally {
    fs.rmSync(whisperRoot, { recursive: true, force: true });
    fs.rmSync(fakeCache, { recursive: true, force: true });
  }
});

test("whisper transcript records provider, engine and word shape", async () => {
  const whisperRoot = makeFakeWhisperRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-doc-"));
  const wav = path.join(dir, "tone.wav");
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", wav],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  const bridge = path.join(dir, "fake_bridge.mjs");
  fs.writeFileSync(
    bridge,
    `process.stdout.write(JSON.stringify({ language: "en", words: [{ word: "hello", punctuated_word: "Hello", source_start_ms: 100, source_end_ms: 400, confidence: 0.9 }] }));\n`,
    "utf8"
  );
  const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-nocache4-"));
  const saved = {
    CUTHOL_DATA_DIR: process.env.CUTHOL_DATA_DIR,
    CUTHOL_LOCAL_SPEECH_PYTHON: process.env.CUTHOL_LOCAL_SPEECH_PYTHON,
    CUTHOL_LOCAL_BRIDGE: process.env.CUTHOL_LOCAL_BRIDGE,
    HYPERFRAMES_CACHE_DIR: process.env.HYPERFRAMES_CACHE_DIR,
  };
  process.env.CUTHOL_DATA_DIR = whisperRoot;
  process.env.CUTHOL_LOCAL_SPEECH_PYTHON = process.execPath;
  process.env.CUTHOL_LOCAL_BRIDGE = bridge;
  process.env.HYPERFRAMES_CACHE_DIR = emptyCache;
  try {
    const doc = await transcribeWithLocalProvider({
      audioFilePath: wav,
      language: "en",
      durationMs: 1000,
    });
    assert.equal(doc.provider, "local");
    assert.equal(doc.engine, "whisper");
    assert.equal(doc.model, "faster-whisper-small");
    assert.ok(doc.words.length > 0);
    for (const w of doc.words) {
      assert.ok(Number.isFinite(w.source_start_ms) && Number.isFinite(w.source_end_ms));
      assert.equal(typeof w.is_filler, "boolean");
    }
    assert.ok(Array.isArray(doc.disfluencies));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetParakeetProbeCache();
    rmRetrySync(dir);
    fs.rmSync(whisperRoot, { recursive: true, force: true });
    fs.rmSync(emptyCache, { recursive: true, force: true });
  }
});

test("parakeet transcript records provider, engine and word shape", { timeout: 290_000 }, async () => {
  // Needs the real `hyperframes models install parakeet` on this machine.
  const { parakeetInstallState } = await import("../speech/local_engine.js");
  if (!parakeetInstallState().installed) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-para-"));
  const wav = path.join(dir, "tone.wav");
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", wav],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  const doc = await transcribeWithLocalProvider({
    audioFilePath: wav,
    language: "en",
    durationMs: 1000,
    engine: "parakeet",
  });
  assert.equal(doc.provider, "local");
  assert.equal(doc.engine, "parakeet");
  assert.equal(doc.model, "parakeet-tdt-0.6b-v3");
  assert.equal(doc.language, "en");
  assert.ok(doc.words.length > 0);
  for (const w of doc.words) {
    assert.ok(Number.isFinite(w.source_start_ms) && Number.isFinite(w.source_end_ms));
    assert.equal(typeof w.is_filler, "boolean");
  }
  assert.ok(Array.isArray(doc.disfluencies));
  fs.rmSync(dir, { recursive: true, force: true });
});
