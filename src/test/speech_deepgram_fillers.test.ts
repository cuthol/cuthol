/**
 * Deepgram English filler path (`src/test/speech_deepgram_fillers.test.ts`).
 * No paid API: `fetch` is stubbed, the API key is a dummy value.
 *
 * Rules pinned here:
 * - Explicit English (`en`, `en-*`) requests `nova-2` and sends the
 *   configured terms as `keywords` (nova-2 rejects `keyterm`); every other
 *   explicit language keeps `nova-3` + `keyterm`; `auto` keeps `nova-3` +
 *   `detect_language`.
 * - The transcript record stores the Deepgram model actually used.
 * - An English Deepgram record made with nova-3 is a miss only for
 *   `speech transcribe` (it re-transcribes once); readers keep returning
 *   the existing record. Non-English records never change.
 * - Auto mode with detected English and no filler token attaches one INFO
 *   note pointing at `--lang en`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  deepgramModelForLanguage,
  isDeepgramAutoEnglishWithoutFillers,
  isEnglishAsrLanguage,
  transcribeWithDeepgram,
  type TranscriptDocument,
} from "../speech/providers.js";
import {
  isStaleDeepgramNova3Record,
  loadCachedTranscriptForAsset,
  transcribeLibraryAsset,
} from "../speech/transcribe.js";
import { rmRetrySync } from "./fs_cleanup.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_deepgram_fillers");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

function withFetch(stub: (url: string) => unknown, fn: () => Promise<void>): Promise<void> {
  const prev = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = async (url: unknown) => stub(String(url));
  return fn().finally(() => {
    (globalThis as Record<string, unknown>).fetch = prev;
  });
}

function deepgramPayload(words: Array<{ word: string; start: number; end: number }>, detected?: string) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      results: {
        channels: [
          {
            ...(detected ? { detected_language: detected } : {}),
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

function tempWav(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-fillers-"));
  const file = path.join(dir, "tone.wav");
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", file],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
  return file;
}

test("request model and keyterm param follow the language", async () => {
  const audio = tempWav();
  try {
    const seen: string[] = [];
    await withDummyKey(() =>
      withFetch(
        (url) => {
          seen.push(url);
          return deepgramPayload([{ word: "hello", start: 0.1, end: 0.4 }]);
        },
        async () => {
          await transcribeWithDeepgram({ audioFilePath: audio, language: "en", durationMs: 1000 });
          await transcribeWithDeepgram({ audioFilePath: audio, language: "en-US", durationMs: 1000 });
          await transcribeWithDeepgram({ audioFilePath: audio, language: "tr", durationMs: 1000 });
          await transcribeWithDeepgram({ audioFilePath: audio, language: "auto", durationMs: 1000 });
          await transcribeWithDeepgram({ audioFilePath: audio, durationMs: 1000 });
        }
      )
    );
    assert.equal(seen.length, 5);
    const param = (i: number, name: string) => new URL(seen[i]).searchParams.getAll(name);
    assert.equal(new URL(seen[0]).searchParams.get("model"), "nova-2");
    assert.deepEqual(param(0, "keywords"), ["Cuthol", "HyperFrames"]);
    assert.deepEqual(param(0, "keyterm"), []);
    assert.equal(new URL(seen[1]).searchParams.get("model"), "nova-2");
    assert.deepEqual(param(1, "keywords"), ["Cuthol", "HyperFrames"]);
    assert.equal(new URL(seen[2]).searchParams.get("model"), "nova-3");
    assert.deepEqual(param(2, "keyterm"), ["Cuthol", "HyperFrames"]);
    assert.equal(new URL(seen[3]).searchParams.get("model"), "nova-3");
    assert.equal(new URL(seen[3]).searchParams.get("detect_language"), "true");
    assert.equal(new URL(seen[4]).searchParams.get("model"), "nova-3");
    assert.equal(new URL(seen[4]).searchParams.get("detect_language"), "true");
  } finally {
    rmRetrySync(path.dirname(audio));
  }
});

test("transcript record stores the Deepgram model used", async () => {
  const audio = tempWav();
  try {
    let doc: TranscriptDocument | undefined;
    await withDummyKey(() =>
      withFetch(() => deepgramPayload([{ word: "hello", start: 0.1, end: 0.4 }]), async () => {
        doc = await transcribeWithDeepgram({ audioFilePath: audio, language: "en", durationMs: 1000 });
      })
    );
    assert.equal(doc?.model, "nova-2");
    await withDummyKey(() =>
      withFetch(() => deepgramPayload([{ word: "merhaba", start: 0.1, end: 0.4 }]), async () => {
        doc = await transcribeWithDeepgram({ audioFilePath: audio, language: "tr", durationMs: 1000 });
      })
    );
    assert.equal(doc?.model, "nova-3");
  } finally {
    rmRetrySync(path.dirname(audio));
  }
});

test("language helpers pick nova-2 for English only", () => {
  assert.equal(isEnglishAsrLanguage("en"), true);
  assert.equal(isEnglishAsrLanguage("en-US"), true);
  assert.equal(isEnglishAsrLanguage("EN-gb"), true);
  assert.equal(isEnglishAsrLanguage("tr"), false);
  assert.equal(isEnglishAsrLanguage("auto"), false);
  assert.equal(isEnglishAsrLanguage(undefined), false);
  assert.equal(deepgramModelForLanguage("en"), "nova-2");
  assert.equal(deepgramModelForLanguage("en-US"), "nova-2");
  assert.equal(deepgramModelForLanguage("tr"), "nova-3");
  assert.equal(deepgramModelForLanguage("auto"), "nova-3");
  assert.equal(deepgramModelForLanguage(undefined), "nova-3");
});

function staleDoc(extra: Partial<TranscriptDocument> = {}): TranscriptDocument {
  return {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
    duration_ms: 1000,
    text: "hello world",
    words: [],
    disfluencies: [],
    ...extra,
  };
}

test("isStaleDeepgramNova3Record flags only English nova-3 records", () => {
  assert.equal(isStaleDeepgramNova3Record(staleDoc()), true);
  assert.equal(isStaleDeepgramNova3Record(staleDoc({ model: "nova-2" })), false);
  assert.equal(isStaleDeepgramNova3Record(staleDoc({ model: "nova-3", language: "tr" })), false);
  assert.equal(isStaleDeepgramNova3Record(staleDoc({ model: "nova-3", language: "en-US" })), true);
  assert.equal(isStaleDeepgramNova3Record({ ...staleDoc(), provider: "local" }), false);
});

function fillerDoc(words: Array<{ word: string; is_filler: boolean }>): TranscriptDocument {
  return {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
    duration_ms: 1000,
    text: words.map((w) => w.word).join(" "),
    words: words.map((w, i) => ({
      word: w.word,
      punctuated_word: w.word,
      source_start_ms: i * 300,
      source_end_ms: i * 300 + 200,
      confidence: 0.95,
      is_filler: w.is_filler,
      is_repetition: false,
    })),
    disfluencies: [],
  };
}

test("INFO predicate fires only for auto-detected English without fillers", () => {
  assert.equal(
    isDeepgramAutoEnglishWithoutFillers(fillerDoc([{ word: "hello", is_filler: false }])),
    true
  );
  assert.equal(
    isDeepgramAutoEnglishWithoutFillers(
      fillerDoc([
        { word: "um", is_filler: true },
        { word: "hello", is_filler: false },
      ])
    ),
    false
  );
  assert.equal(
    isDeepgramAutoEnglishWithoutFillers({
      ...fillerDoc([{ word: "merhaba", is_filler: false }]),
      language: "tr",
    }),
    false
  );
  assert.equal(
    isDeepgramAutoEnglishWithoutFillers({
      ...fillerDoc([{ word: "hello", is_filler: false }]),
      provider: "local",
    }),
    false
  );
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

function setupMedia(name: string): string {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  writeToneMp4(path.join(wsDir, "talk.mp4"), 3);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "talk.mp4")] });
  return wsDir;
}

function seedDeepgram(wsDir: string, key: string, doc: TranscriptDocument): void {
  const { paths, sequence } = loadSequence(wsDir);
  const item = sequence.library.find((x) => x.handle === "vid_01");
  assert.ok(item);
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    ledger.setTranscript(item.digest_sha256, key, doc);
  } finally {
    ledger.close();
  }
}

function ensureBuiltinProvider(): string | undefined {
  const prev = process.env.CUTHOL_ASR_PROVIDER;
  delete process.env.CUTHOL_ASR_PROVIDER;
  return prev;
}

test("explicit English re-transcribes a nova-3 record once; readers keep it", async () => {
  const wsDir = setupMedia("ws_en_nova3_stale");
  seedDeepgram(wsDir, "deepgram:en", staleDoc());
  // Readers keep returning the existing record, unchanged.
  const kept = loadCachedTranscriptForAsset(wsDir, "vid_01", "en");
  assert.equal(kept.model, "nova-3");
  const prevProvider = ensureBuiltinProvider();
  try {
    let calls = 0;
    await withDummyKey(() =>
      withFetch(
        (url) => {
          calls += 1;
          assert.equal(new URL(url).searchParams.get("model"), "nova-2");
          return deepgramPayload(
            [
              { word: "um", start: 0.1, end: 0.3 },
              { word: "hello", start: 0.4, end: 0.8 },
            ],
            "en"
          );
        },
        async () => {
          const res = await transcribeLibraryAsset({
            workspaceDir: wsDir,
            handle: "vid_01",
            language: "en",
          });
          assert.equal(res.cached, false);
          assert.equal(res.transcript.model, "nova-2");
        }
      )
    );
    assert.equal(calls, 1);
  } finally {
    if (prevProvider === undefined) delete process.env.CUTHOL_ASR_PROVIDER;
    else process.env.CUTHOL_ASR_PROVIDER = prevProvider;
  }
});

test("Turkish nova-3 records keep hitting with no network use", async () => {
  const wsDir = setupMedia("ws_tr_nova3_hit");
  seedDeepgram(wsDir, "deepgram:tr", staleDoc({ language: "tr", model: "nova-3" }));
  const prevProvider = ensureBuiltinProvider();
  const prevKey = process.env.DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  try {
    await withFetch(
      () => {
        throw new Error("network must not be used");
      },
      async () => {
        const res = await transcribeLibraryAsset({
          workspaceDir: wsDir,
          handle: "vid_01",
          language: "tr",
        });
        assert.equal(res.cached, true);
        assert.equal(res.transcript.model, "nova-3");
        assert.equal(res.transcript.language, "tr");
      }
    );
  } finally {
    if (prevProvider === undefined) delete process.env.CUTHOL_ASR_PROVIDER;
    else process.env.CUTHOL_ASR_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = prevKey;
  }
});

test("auto mode with detected English and no fillers attaches the INFO", async () => {
  const wsDir = setupMedia("ws_auto_info");
  const prevProvider = ensureBuiltinProvider();
  try {
    await withDummyKey(() =>
      withFetch(
        () =>
          deepgramPayload(
            [
              { word: "hello", start: 0.1, end: 0.4 },
              { word: "world", start: 0.5, end: 0.9 },
            ],
            "en"
          ),
        async () => {
          const res = await transcribeLibraryAsset({
            workspaceDir: wsDir,
            handle: "vid_01",
            language: "auto",
          });
          assert.equal(res.transcript.language, "en");
          assert.ok(
            (res.notes ?? []).some((n) => n.includes("CUTHOL-G760") && n.includes("--lang en")),
            `expected the G760 INFO in notes, got ${JSON.stringify(res.notes)}`
          );
        }
      )
    );
  } finally {
    if (prevProvider === undefined) delete process.env.CUTHOL_ASR_PROVIDER;
    else process.env.CUTHOL_ASR_PROVIDER = prevProvider;
  }
});
