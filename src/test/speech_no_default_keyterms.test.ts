/**
 * No default key terms (`src/test/speech_no_default_keyterms.test.ts`).
 *
 * - The Deepgram query and the local bridge payload carry no key terms by
 *   default and carry the caller's terms when given.
 * - A builtin-provider transcript cached before the keyterm stamp (no
 *   `keyterms` property) is re-transcribed once instead of being served;
 *   fresh transcripts are stamped, so the second request hits.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { initWorkspace } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { transcribeWithDeepgram, transcribeWithLocalProvider } from "../speech/providers.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_no_default_keyterms");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

function deepgramPayload(words: Array<{ word: string; start: number; end: number }>) {
  return {
    ok: true,
    status: 200,
    text: async () => "ok",
    json: async () => ({
      results: {
        channels: [
          {
            detected_language: "en",
            alternatives: [
              {
                transcript: words.map((w) => w.word).join(" "),
                words: words.map((w) => ({ ...w, confidence: 0.95 })),
              },
            ],
          },
        ],
      },
    }),
  };
}

function withDummyKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "dummy-test-key";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = prev;
  });
}

function withFetch(seen: string[], fn: () => Promise<void>): Promise<void> {
  const prev = globalThis.fetch;
  // @ts-expect-error test double
  globalThis.fetch = async (url: string) => {
    seen.push(String(url));
    return deepgramPayload([{ word: "hello", start: 0.1, end: 0.4 }]);
  };
  return fn().finally(() => {
    globalThis.fetch = prev;
  });
}

function tempWav(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-nokey-"));
  const file = path.join(dir, "tone.wav");
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", file],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  return file;
}

test("deepgram query carries no key terms by default, the caller's when given", async () => {
  const audio = tempWav();
  try {
    const seen: string[] = [];
    await withDummyKey(() =>
      withFetch(seen, async () => {
        await transcribeWithDeepgram({ audioFilePath: audio, language: "en", durationMs: 1000 });
        await transcribeWithDeepgram({
          audioFilePath: audio,
          language: "tr",
          durationMs: 1000,
          keyterms: ["Cuthol", "  ", "HyperFrames"],
        });
      })
    );
    assert.equal(seen.length, 2);
    const plain = new URL(seen[0]).searchParams;
    assert.deepEqual(plain.getAll("keyterm"), []);
    assert.deepEqual(plain.getAll("keywords"), []);
    const scoped = new URL(seen[1]).searchParams;
    assert.deepEqual(scoped.getAll("keyterm"), ["Cuthol", "HyperFrames"]);
  } finally {
    rmRetrySync(path.dirname(audio));
  }
});

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

test("unstamped legacy transcript is re-transcribed once, then served", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_legacy");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "legacy", aspect: "16:9", fps: 30 });
  writeToneMp4(path.join(wsDir, "talk.mp4"), 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "talk.mp4")] });
  // Sidecar-backed local provider: no install, no network.
  fs.writeFileSync(
    path.join(wsDir, "talk.mp4.transcript.json"),
    JSON.stringify({
      language: "tr",
      words: [{ word: "merhaba", source_start_ms: 100, source_end_ms: 500 }],
    }),
    "utf8"
  );
  const base = { workspaceDir: wsDir, handle: "vid_01", language: "tr", provider: "local" } as const;

  // Seed a legacy record exactly as the old build left it: no `keyterms`.
  const first = await transcribeLibraryAsset({ ...base });
  assert.equal(first.cached, false);
  const ledger = new MediaLedger(path.join(wsDir, ".cuthol", "ledger.sqlite"));
  const sha = first.sha256;
  try {
    const stored = ledger.getTranscript<Record<string, unknown>>(sha, "local@v5:tr");
    assert.ok(stored, "expected the fresh record under the local key");
    // Simulate the old build by stripping the stamp from every record.
    const keys = ["local@v5:tr", "tr", "auto", "latest"];
    for (const key of keys) {
      const rec = ledger.getTranscript<Record<string, unknown>>(sha, key);
      if (rec && "keyterms" in rec) {
        const { keyterms: _drop, ...rest } = rec;
        void _drop;
        ledger.setTranscript(sha, key, rest);
      }
    }
  } finally {
    ledger.close();
  }

  // The unstamped record must not be served: one re-transcribe, then a hit.
  const again = await transcribeLibraryAsset({ ...base });
  assert.equal(again.cached, false);
  assert.ok(
    Object.prototype.hasOwnProperty.call(again.transcript, "keyterms"),
    "fresh transcript carries the keyterm stamp"
  );
  const third = await transcribeLibraryAsset({ ...base });
  assert.equal(third.cached, true);
});

test("local provider passes caller keyterms to the bridge payload", async () => {
  const audio = tempWav();
  const dir = path.dirname(audio);
  // Fake keyless install: node acts as the bridge and echoes --keyterms.
  const inst = path.join(dir, "inst", "local-speech");
  const bridge = path.join(dir, "fake_bridge.mjs");
  fs.writeFileSync(
    bridge,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const terms = (flag("--keyterms") || "").split(",").filter(Boolean);
const words = [{ word: "hello", punctuated_word: "Hello", source_start_ms: 100, source_end_ms: 400, confidence: 0.9 }];
for (const t of terms) words.push({ word: t, punctuated_word: t, source_start_ms: 500, source_end_ms: 800, confidence: 0.9 });
process.stdout.write(JSON.stringify({ language: "en", words }));
`,
    "utf8"
  );
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
  const saved = {
    CUTHOL_DATA_DIR: process.env.CUTHOL_DATA_DIR,
    CUTHOL_LOCAL_SPEECH_PYTHON: process.env.CUTHOL_LOCAL_SPEECH_PYTHON,
    CUTHOL_LOCAL_BRIDGE: process.env.CUTHOL_LOCAL_BRIDGE,
  };
  process.env.CUTHOL_DATA_DIR = path.join(dir, "inst");
  process.env.CUTHOL_LOCAL_SPEECH_PYTHON = process.execPath;
  process.env.CUTHOL_LOCAL_BRIDGE = bridge;
  try {
    // Forced whisper: on machines with Parakeet installed the auto choice
    // would be parakeet, but this fake install only speaks the bridge.
    const plain = await transcribeWithLocalProvider({
      audioFilePath: audio,
      language: "en",
      durationMs: 1000,
      engine: "whisper",
    });
    assert.deepEqual(
      plain.words.map((w) => w.word),
      ["hello"]
    );
    const scoped = await transcribeWithLocalProvider({
      audioFilePath: audio,
      language: "en",
      durationMs: 1000,
      engine: "whisper",
      keyterms: ["Cuthol"],
    });
    assert.ok(
      scoped.words.some((w) => w.word === "cuthol" || w.punctuated_word === "Cuthol"),
      "caller keyterm reaches the bridge payload"
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmRetrySync(dir);
  }
});
