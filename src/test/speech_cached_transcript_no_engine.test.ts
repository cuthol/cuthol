/**
 * Engine resolution must not block cached transcripts.
 *
 * Parakeet installed, Whisper not, Turkish transcript cached -> served from
 * the cache without resolving (and throwing on) the engine. Same setup
 * without a cached transcript -> the specific G237 failure naming the
 * language, the installed engine and the Whisper setup command.
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
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { TranscriptDocument } from "../speech/providers.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_cached_no_engine");

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

/** Parakeet installed, Whisper missing: fake HyperFrames CLI + empty data dir. */
function parakeetOnlyEnv(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cached-tx-"));
  const bin = path.join(dir, "hyperframes.mjs");
  fs.writeFileSync(
    bin,
    `console.log(JSON.stringify({ models: [{ engine: "parakeet", installed: true }] }));\n`,
    "utf8"
  );
  const emptyData = path.join(dir, "data");
  fs.mkdirSync(emptyData, { recursive: true });
  const savedBin = process.env.CUTHOL_HYPERFRAMES_BIN;
  const savedData = process.env.CUTHOL_DATA_DIR;
  const savedAsrCmd = process.env.CUTHOL_LOCAL_ASR_CMD;
  process.env.CUTHOL_HYPERFRAMES_BIN = bin;
  process.env.CUTHOL_DATA_DIR = emptyData;
  delete process.env.CUTHOL_LOCAL_ASR_CMD;
  return {
    dir,
    restore: () => {
      if (savedBin === undefined) delete process.env.CUTHOL_HYPERFRAMES_BIN;
      else process.env.CUTHOL_HYPERFRAMES_BIN = savedBin;
      if (savedData === undefined) delete process.env.CUTHOL_DATA_DIR;
      else process.env.CUTHOL_DATA_DIR = savedData;
      if (savedAsrCmd === undefined) delete process.env.CUTHOL_LOCAL_ASR_CMD;
      else process.env.CUTHOL_LOCAL_ASR_CMD = savedAsrCmd;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function setupMedia(name: string): { wsDir: string; digest: string; handle: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 3);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  const { sequence } = loadSequence(wsDir);
  const item = sequence.library[0];
  return { wsDir, digest: item.digest_sha256, handle: item.handle };
}

function seedTurkish(digest: string, wsDir: string, stamped: boolean): void {
  const { paths } = loadSequence(wsDir);
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    const doc = {
      provider: "local",
      model: "parakeet-tdt-0.6b-v3",
      engine: "parakeet",
      language: "tr",
      duration_ms: 3000,
      text: "Merhaba dünya",
      words: [
        { word: "Merhaba", punctuated_word: "Merhaba", source_start_ms: 100, source_end_ms: 500, confidence: 0.99 },
        { word: "dünya", punctuated_word: "dünya", source_start_ms: 600, source_end_ms: 1000, confidence: 0.99 },
      ],
      disfluencies: [],
      ...(stamped ? { keyterms: [] } : {}),
    } as unknown as TranscriptDocument;
    ledger.setTranscript(digest, "local:tr", doc);
  } finally {
    ledger.close();
  }
}

test("cached Turkish transcript is served with Parakeet-only install", async () => {
  const env = parakeetOnlyEnv();
  try {
    for (const variant of ["stamped", "legacy"] as const) {
      const { wsDir, digest, handle } = setupMedia(`cached_${variant}`);
      seedTurkish(digest, wsDir, variant === "stamped");
      const res = await transcribeLibraryAsset({
        workspaceDir: wsDir,
        handle,
        language: "tr",
        provider: "local",
      });
      assert.equal(res.cached, true, `${variant}: expected a cache hit, not a run`);
      assert.equal(res.transcript.text, "Merhaba dünya");
    }
  } finally {
    env.restore();
  }
});

test("no cache with Parakeet-only install fails with the specific diagnostic", async () => {
  const env = parakeetOnlyEnv();
  try {
    const { wsDir, handle } = setupMedia("nocache");
    await assert.rejects(
      transcribeLibraryAsset({ workspaceDir: wsDir, handle, language: "tr", provider: "local" }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          msg.includes("CUTHOL-G237") &&
          msg.includes("tr") &&
          msg.includes("Parakeet") &&
          msg.includes("cuthol setup --local-speech --engine whisper --apply")
        );
      },
      "expected the specific G237 failure naming language, engine and setup command"
    );
  } finally {
    env.restore();
  }
});
