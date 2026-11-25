/**
 * Speech keyterms: CLI `--keyterm`, MCP `keyterms`, provider request, cache key
 * (`src/test/speech_keyterms.test.ts`). No network; a fake `ext:` ASR provider
 * echoes the `keyterms` it receives back as words.
 *
 * Rules pinned here:
 * - `--keyterm <word>` is repeatable and comma-separated; the MCP `keyterms`
 *   param (string_list) reaches the provider request identically.
 * - Keyterms are part of the transcription request and of the transcript cache
 *   key: a scoped transcript never serves a request without keyterms and a
 *   plain transcript never serves a request with keyterms.
 * - Without keyterms every cache key keeps the old scheme except the local
 *   provider's key, which carries the engine revision (cloud keys stay
 *   byte-identical, so existing cloud transcripts keep hitting).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { initWorkspace } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { buildCliArgv, findActionSpec } from "../mcp/catalog.js";
import { cleanupClipDialogue } from "../speech/cleanup.js";
import {
  loadCachedTranscriptForAsset,
  localAsrCachePrefix,
  transcribeLibraryAsset,
} from "../speech/transcribe.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_keyterms");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

// The fake provider answers with one word per received keyterm (plus a base
// word), so the transcript proves exactly which keyterms reached the request.
function writeEchoAsrExtension(wsDir: string, name: string): void {
  const script = [
    "const fs = require('node:fs');",
    "const [requestPath, responsePath] = process.argv.slice(2);",
    "const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));",
    "const terms = Array.isArray(request.keyterms) ? request.keyterms : [];",
    "const words = [{ word: 'base', start_ms: 100, end_ms: 400 }];",
    "terms.forEach((t, i) => words.push({ word: String(t), start_ms: 500 + i * 400, end_ms: 800 + i * 400 }));",
    "fs.writeFileSync(responsePath, JSON.stringify({ language: 'tr', words }));",
    "",
  ].join("\n");
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify(
      {
        schema_version: "1.0.0",
        name,
        version: "1.0.0",
        description: "keyterm echo asr",
        providers: { asr: { script: "asr.cjs" } },
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "asr.cjs"), script, "utf8");
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

function setupWs(name: string): string {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  writeEchoAsrExtension(wsDir, "echo-asr");
  writeToneMp4(path.join(wsDir, "talk.mp4"), 4);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "talk.mp4")] });
  return wsDir;
}

function transcriptWords(doc: { words: Array<{ word: string }> }): string[] {
  return doc.words.map((w) => w.word);
}

test("keyterms reach the provider request and scope the cache key", async () => {
  const wsDir = setupWs("ws_keyterms");
  const base = { workspaceDir: wsDir, handle: "vid_01", language: "tr", provider: "ext:echo-asr" } as const;

  const plain = await transcribeLibraryAsset({ ...base });
  assert.equal(plain.cached, false);
  assert.deepEqual(transcriptWords(plain.transcript), ["base"]);

  // Same request again hits the plain record.
  const plainAgain = await transcribeLibraryAsset({ ...base });
  assert.equal(plainAgain.cached, true);

  // Keyterms change the request: the plain record must not serve it.
  const scoped = await transcribeLibraryAsset({ ...base, keyterms: ["Zentrix", "Cuthol"] });
  assert.equal(scoped.cached, false);
  assert.deepEqual(transcriptWords(scoped.transcript), ["base", "kutay", "cuthol"]);

  // Same keyterms hit the scoped record.
  const scopedAgain = await transcribeLibraryAsset({ ...base, keyterms: ["Zentrix", "Cuthol"] });
  assert.equal(scopedAgain.cached, true);
  assert.deepEqual(transcriptWords(scopedAgain.transcript), ["base", "kutay", "cuthol"]);

  // Different keyterms miss again.
  const other = await transcribeLibraryAsset({ ...base, keyterms: ["Other"] });
  assert.equal(other.cached, false);
  assert.deepEqual(transcriptWords(other.transcript), ["base", "other"]);

  // The scoped transcript never leaks back into plain requests: the plain
  // record still hits and still has no keyterm words.
  const plainAfter = await transcribeLibraryAsset({ ...base });
  assert.equal(plainAfter.cached, true);
  assert.deepEqual(transcriptWords(plainAfter.transcript), ["base"]);
});

test("cache keys without keyterms keep the old scheme except the revisioned local key", async () => {
  const wsDir = setupWs("ws_key_identity");
  // Sidecar-backed local provider: no install, no network, no paid call.
  fs.writeFileSync(
    path.join(wsDir, "talk.mp4.transcript.json"),
    JSON.stringify({
      language: "tr",
      words: [{ word: "merhaba", source_start_ms: 100, source_end_ms: 500 }],
    }),
    "utf8"
  );
  const res = await transcribeLibraryAsset({
    workspaceDir: wsDir,
    handle: "vid_01",
    language: "tr",
    provider: "local",
  });
  assert.equal(res.cached, false);
  const ledger = new MediaLedger(path.join(wsDir, ".cuthol", "ledger.sqlite"));
  try {
    const sha = res.sha256;
    // The local provider's key carries the engine revision (see
    // localAsrCachePrefix); every other key is byte-identical to the old
    // scheme so existing cloud transcripts keep hitting.
    for (const key of [`${localAsrCachePrefix()}:tr`, "tr", "auto", "latest"]) {
      const rec = ledger.getTranscript(sha, key);
      assert.ok(rec, `expected cache key ${key} to exist`);
    }
  } finally {
    ledger.close();
  }
});

test("CLI --keyterm (repeatable, comma-separated) reaches the request", () => {
  const wsDir = setupWs("ws_cli_keyterm");
  const env = { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" };
  const run = (args: string[]) => {
    const proc = spawnSync(
      process.execPath,
      [CLI, "speech", "transcribe", ...args, "--verbose", "--dir", wsDir],
      {
        encoding: "utf8",
        env,
      }
    );
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout) as { transcript?: { words?: Array<{ word?: string }> } };
  };
  const wordsOf = (envelope: unknown) =>
    JSON.stringify((envelope as { transcript?: unknown }).transcript ?? envelope);

  const repeated = run([
    "--handle",
    "vid_01",
    "--lang",
    "tr",
    "--provider",
    "ext:echo-asr",
    "--refresh",
    "--keyterm",
    "Alpha",
    "--keyterm",
    "Beta",
  ]);
  assert.ok(wordsOf(repeated).includes("alpha"), "repeated --keyterm Alpha missing");
  assert.ok(wordsOf(repeated).includes("beta"), "repeated --keyterm Beta missing");

  const csv = run([
    "--handle",
    "vid_01",
    "--lang",
    "tr",
    "--provider",
    "ext:echo-asr",
    "--refresh",
    "--keyterm",
    "Gamma,Delta",
  ]);
  assert.ok(wordsOf(csv).includes("gamma"), "comma-separated Gamma missing");
  assert.ok(wordsOf(csv).includes("delta"), "comma-separated Delta missing");
});

test("keyterm-only transcript is what the readers use; plain transcribe still misses", async () => {
  const wsDir = setupWs("ws_keyterm_latest");
  const base = { workspaceDir: wsDir, handle: "vid_01", language: "tr", provider: "ext:echo-asr" } as const;

  // Keyterm run first: there is no plain record at all.
  const scoped = await transcribeLibraryAsset({ ...base, keyterms: ["Zentrix"] });
  assert.equal(scoped.cached, false);
  assert.deepEqual(transcriptWords(scoped.transcript), ["base", "kutay"]);

  // Every reader goes through loadCachedTranscriptForAsset: the newest
  // transcript wins even when it was made with keyterms.
  assert.deepEqual(
    transcriptWords(loadCachedTranscriptForAsset(wsDir, "vid_01", "auto")),
    ["base", "kutay"]
  );
  assert.deepEqual(
    transcriptWords(loadCachedTranscriptForAsset(wsDir, "vid_01", "tr")),
    ["base", "kutay"]
  );

  // A plain request must miss (provider called again): the only cached
  // transcript is keyterm-made.
  const plain = await transcribeLibraryAsset({ ...base });
  assert.equal(plain.cached, false);
  assert.deepEqual(transcriptWords(plain.transcript), ["base"]);

  // Now a plain record exists, so plain requests hit again.
  const plainAgain = await transcribeLibraryAsset({ ...base });
  assert.equal(plainAgain.cached, true);
  assert.deepEqual(transcriptWords(plainAgain.transcript), ["base"]);

  // The scoped record is untouched by the plain round-trip.
  const scopedAgain = await transcribeLibraryAsset({ ...base, keyterms: ["Zentrix"] });
  assert.equal(scopedAgain.cached, true);
  assert.deepEqual(transcriptWords(scopedAgain.transcript), ["base", "kutay"]);
});

test("speech cleanup (dry run) finds a keyterm-only transcript", async () => {
  const wsDir = setupWs("ws_keyterm_cleanup");
  const base = { workspaceDir: wsDir, handle: "vid_01", language: "tr", provider: "ext:echo-asr" } as const;
  const scoped = await transcribeLibraryAsset({ ...base, keyterms: ["Zentrix"] });
  // The asset is genuinely keyterm-only: no plain record exists anywhere.
  const ledger = new MediaLedger(path.join(wsDir, ".cuthol", "ledger.sqlite"));
  try {
    assert.ok(!ledger.getTranscript(scoped.sha256, "tr"), "plain tr record must not exist");
    assert.ok(!ledger.getTranscript(scoped.sha256, "auto"), "plain auto record must not exist");
  } finally {
    ledger.close();
  }
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  const dry = cleanupClipDialogue({ workspaceDir: wsDir, allSpine: true, dryRun: true });
  assert.equal(dry.clips_processed, 1);
});

test("explicit-language readers return the newest transcript (plain then keyterm)", async () => {
  const wsDir = setupWs("ws_newest_wins");
  const base = { workspaceDir: wsDir, handle: "vid_01", language: "tr", provider: "ext:echo-asr" } as const;

  // Plain first, then a keyterm fix of the names: the keyterm run is newer.
  const plain = await transcribeLibraryAsset({ ...base });
  assert.deepEqual(transcriptWords(plain.transcript), ["base"]);
  const fixed = await transcribeLibraryAsset({ ...base, keyterms: ["Zentrix"] });
  assert.deepEqual(transcriptWords(fixed.transcript), ["base", "kutay"]);

  // Every explicit-language reader must see the newest transcript, not the
  // older plain record under the same language key.
  assert.deepEqual(transcriptWords(loadCachedTranscriptForAsset(wsDir, "vid_01", "tr")), [
    "base",
    "kutay",
  ]);
  assert.deepEqual(transcriptWords(loadCachedTranscriptForAsset(wsDir, "vid_01", "auto")), [
    "base",
    "kutay",
  ]);

  // A refreshed plain transcription is newest again: readers follow it back.
  const plainNew = await transcribeLibraryAsset({ ...base, refresh: true });
  assert.equal(plainNew.cached, false);
  assert.deepEqual(transcriptWords(plainNew.transcript), ["base"]);
  assert.deepEqual(transcriptWords(loadCachedTranscriptForAsset(wsDir, "vid_01", "tr")), ["base"]);
});

test("speech cleanup (dry run) after plain then keyterm uses the keyterm transcript", async () => {
  const wsDir = setupWs("ws_newest_cleanup");
  const base = { workspaceDir: wsDir, handle: "vid_01", language: "tr", provider: "ext:echo-asr" } as const;

  await transcribeLibraryAsset({ ...base });
  // "yani" is a contextual filler token only when NOT isolated by pauses;
  // back-to-back keyterm words ("yani","sey") leave no gap, so "yani"
  // becomes a review candidate. The plain transcript has no such word.
  await transcribeLibraryAsset({ ...base, keyterms: ["yani", "sey"] });

  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
  const dry = cleanupClipDialogue({ workspaceDir: wsDir, allSpine: true, dryRun: true });
  assert.equal(dry.clips_processed, 1);
  const words = dry.review_candidates.map((c) => c.word);
  assert.ok(words.includes("yani"), `expected a "yani" review candidate, got ${JSON.stringify(words)}`);
});

test("MCP speech.transcribe exposes keyterms and builds --keyterms argv", () => {
  const spec = findActionSpec("speech", "transcribe");
  assert.ok(spec, "speech.transcribe spec missing");
  const param = spec.params.find((p) => p.name === "keyterms");
  assert.ok(param, "keyterms param missing from speech.transcribe");
  assert.equal(param.type, "string_list");

  const argv = buildCliArgv(spec, { handle: "vid_01", keyterms: ["Zentrix", "Cuthol"] }, "/tmp/ws");
  assert.ok(
    argv.includes("--keyterms=Zentrix,Cuthol"),
    `expected --keyterms=Zentrix,Cuthol in ${JSON.stringify(argv)}`
  );
});
