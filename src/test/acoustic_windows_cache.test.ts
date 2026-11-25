/**
 * Acoustic window profile cache: `measureAssetAcousticWindows` persists its
 * profile in the project ledger (keyed by library digest, versioned), so a
 * fresh process serves the second `verify` with zero source decodes; a changed
 * source digest decodes again; a corrupt row falls back to measuring silently.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import {
  acousticWindowsCacheKey,
  measureAssetAcousticWindows,
} from "../library/waveform.js";
import { MediaLedger } from "../library/ledger.js";

const PROBE = path.resolve(process.cwd(), "dist/test/acoustic_windows_cache_probe.js");

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function makeToneMedia(tmp: string, name: string, freq: number): string {
  const media = path.join(tmp, name);
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:d=3",
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:d=3`,
    "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    media,
  ]);
  return media;
}

const NARRATION_FIXTURE = path.resolve(process.cwd(), "test-workspace/fixtures/trial-media/narration.mp3");

function makeSpeechLikeMedia(tmp: string, name: string): string {
  const media = path.join(tmp, name);
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:d=10",
    "-i", NARRATION_FIXTURE,
    "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-map", "0:v:0", "-map", "1:a:0", "-shortest",
    media,
  ]);
  return media;
}

function decodeWindowsB64(b64: string): Float64Array {
  const bytes = Buffer.from(b64, "base64");
  assert.equal(bytes.length % 8, 0, "window bytes must be whole Float64 values");
  const out = new Float64Array(bytes.length / 8);
  Buffer.from(out.buffer).set(bytes);
  return out;
}

function probeFreshProcess(wsDir: string, handle: string): Record<string, number | boolean | string | null> {
  const proc = spawnSync(process.execPath, [PROBE, wsDir, handle], { encoding: "utf8" });
  assert.equal(proc.status, 0, `probe failed: ${proc.stderr ?? ""}`.slice(0, 2000));
  return JSON.parse(String(proc.stdout).trim().split("\n").pop() as string);
}

function ledgerRowCount(wsDir: string, key: string): number {
  const { paths } = loadSequence(wsDir);
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    const row = ledger.getAcousticWindows<unknown>(key);
    return row ? 1 : 0;
  } finally {
    ledger.close();
  }
}

test("acoustic profile is served from the ledger with zero decodes in a fresh process", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-acoustic-cache-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "acoustic cache", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [makeSpeechLikeMedia(tmp, "speech.mp4")] });

    const first = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" });
    assert.ok(first, "first measurement must return a profile");
    assert.ok(first!.window_dbfs.length > 50, "speech-like asset must yield many windows");
    const { paths, sequence } = loadSequence(wsDir);
    const digest = sequence.library.find((x) => x.handle === "vid_01")!.digest_sha256;
    assert.equal(ledgerRowCount(wsDir, acousticWindowsCacheKey(digest)), 1, "ledger must hold one cached row");

    // Hide the ingested source: a fresh process that returns the profile proves zero decodes.
    const absFile = resolveLibraryItemPath(paths.rootDir, sequence.library.find((x) => x.handle === "vid_01")!);
    const hidden = `${absFile}.hidden`;
    fs.renameSync(absFile, hidden);
    try {
      const cached = probeFreshProcess(wsDir, "vid_01");
      assert.equal(cached.ok, true, "fresh process must serve the profile from the ledger without the file");
    } finally {
      fs.renameSync(hidden, absFile);
    }

    // Bit-exact round trip: every window value === and the floor ===.
    const second = probeFreshProcess(wsDir, "vid_01");
    assert.equal(second.ok, true);
    assert.equal(second.floor, first!.silence_floor_dbfs, "floor must round-trip bit-exactly");
    assert.equal(second.flags, first!.has_silence_variation, "flags must round-trip exactly");
    assert.equal(second.windows, first!.window_dbfs.length, "window count must round-trip exactly");
    const cachedWins = decodeWindowsB64(second.windows_b64 as string);
    assert.equal(cachedWins.length, first!.window_dbfs.length, "decoded window count must match");
    for (let i = 0; i < first!.window_dbfs.length; i++) {
      assert.equal(cachedWins[i], first!.window_dbfs[i], `window ${i} must round-trip bit-exactly`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("acoustic profile recomputes for a changed source digest", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-acoustic-redigest-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "acoustic redigest", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [makeToneMedia(tmp, "tone.mp4", 440)] });
    const first = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" });
    assert.ok(first);

    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [makeToneMedia(tmp, "tone2.mp4", 880)] });
    const { sequence } = loadSequence(wsDir);
    const secondItem = sequence.library.find((x) => x.uri.includes("tone2")) ?? sequence.library[sequence.library.length - 1];
    assert.notEqual(secondItem.digest_sha256, sequence.library[0].digest_sha256, "different media must have a different digest");
    const before = ledgerRowCount(wsDir, acousticWindowsCacheKey(secondItem.digest_sha256));
    const second = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: secondItem.handle });
    assert.ok(second, "changed digest must recompute a profile");
    assert.equal(before, 0, "no cache row may exist before measuring the new digest");
    assert.equal(ledgerRowCount(wsDir, acousticWindowsCacheKey(secondItem.digest_sha256)), 1, "new digest must be cached after measuring");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("acoustic profile falls back to measuring on a corrupt cache row", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-acoustic-corrupt-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "acoustic corrupt", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [makeToneMedia(tmp, "tone.mp4", 440)] });
    const first = measureAssetAcousticWindows({ workspaceDir: wsDir, handle: "vid_01" });
    assert.ok(first);

    const { paths, sequence } = loadSequence(wsDir);
    const digest = sequence.library.find((x) => x.handle === "vid_01")!.digest_sha256;
    const ledger = new MediaLedger(paths.ledgerFile);
    try {
      (ledger as unknown as { db: { exec: (sql: string) => void } }).db.exec(
        `UPDATE acoustic_windows_cache SET metrics_json = 'not-json{{{' WHERE cache_key = '${acousticWindowsCacheKey(digest)}'`
      );
    } finally {
      ledger.close();
    }
    // Fresh process: corrupt row is swallowed, profile is recomputed from the file, no throw.
    const recomputed = probeFreshProcess(wsDir, "vid_01");
    assert.equal(recomputed.ok, true, "corrupt row must fall back to measuring without error");
    assert.equal(recomputed.floor, first!.silence_floor_dbfs, "recomputed floor must match");
    assert.equal(recomputed.windows, first!.window_dbfs.length, "recomputed window count must match");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
