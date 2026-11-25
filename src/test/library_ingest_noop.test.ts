/**
 * Re-ingesting an unchanged file is a no-op: same handle, no journal revision.
 * A changed file (same path, new content) or a different file still ingests.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { initWorkspace } from "../core/workspace.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

function revisionOf(wsDir: string): number {
  return loadSequence(wsDir).sequence.meta.revision;
}

function makeTone(outPath: string, freq: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:duration=1:sample_rate=48000`,
      "-c:a",
      "pcm_s16le",
      outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

test("re-ingesting an unchanged file keeps the revision and handle", () => {
  const wsDir = path.join(TEST_ROOT, "library_ingest_noop");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "ingest noop", aspect: "16:9", fps: 30 });
  const tone = path.join(wsDir, "tone.wav");
  makeTone(tone, 440);

  const first = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [tone] });
  assert.equal(first.length, 1);
  const revAfterFirst = revisionOf(wsDir);

  const second = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [tone] });
  assert.equal(second.length, 1);
  assert.equal(second[0].handle, first[0].handle, "second ingest must name the existing handle");
  assert.equal(revisionOf(wsDir), revAfterFirst, "second ingest of the same file must not write a revision");

  // Same content under a different path: same sha, still a no-op.
  const copy = path.join(wsDir, "tone_copy.wav");
  fs.copyFileSync(tone, copy);
  const third = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [copy] });
  assert.equal(third[0].handle, first[0].handle);
  assert.equal(revisionOf(wsDir), revAfterFirst);
});

test("a changed file and a different file still ingest", () => {
  const wsDir = path.join(TEST_ROOT, "library_ingest_noop_changed");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "ingest changed", aspect: "16:9", fps: 30 });
  const tone = path.join(wsDir, "tone.wav");
  makeTone(tone, 440);
  const first = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [tone] });
  const revAfterFirst = revisionOf(wsDir);

  // Same path, new content (and mtime): must update, not no-op.
  makeTone(tone, 880);
  const updated = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [tone] });
  assert.equal(updated.length, 1);
  assert.ok(revisionOf(wsDir) > revAfterFirst, "changed file must write a revision");

  // A genuinely different file gets a new handle.
  const other = path.join(wsDir, "other.wav");
  makeTone(other, 660);
  const revBeforeOther = revisionOf(wsDir);
  const added = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [other] });
  assert.equal(added.length, 1);
  assert.notEqual(added[0].handle, first[0].handle);
  assert.ok(revisionOf(wsDir) > revBeforeOther);
});
