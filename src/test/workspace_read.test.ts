/**
 * The lightweight reader module (`core/workspace_read.js`) serves the envelope
 * header without loading the heavy commit path (`core/workspace.js` pulls the
 * compositor, verify gates and speech chain at import time). Reading commands
 * import the header from the light module; both copies must stay identical.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptySequence } from "../core/schema.js";
import { buildWorkspaceEnvelopeHeader as buildHeaderLight } from "../core/workspace_read.js";
import { buildWorkspaceEnvelopeHeader as buildHeaderHeavy } from "../core/workspace.js";

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-wsread-"));
  const sequence = createEmptySequence({ projectId: "probe", title: "probe" }) as unknown as Record<string, unknown>;
  sequence.markers = [];
  fs.writeFileSync(path.join(dir, "cuthol.sequence.json"), JSON.stringify(sequence, null, 2));
  const journalDir = path.join(dir, ".cuthol", "journal");
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".cuthol", "journal.json"),
    JSON.stringify({
      cursor_revision: 1,
      entries: [
        {
          revision: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          operation: "workspace.init",
          tag: "initial",
          snapshot_file: "rev_0001.json",
        },
      ],
    })
  );
  return dir;
}

function readSequence(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8"));
}

function writeSequence(dir: string, seq: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "cuthol.sequence.json"), JSON.stringify(seq, null, 2));
}

test("envelope header from the light module matches the workspace module", () => {
  const dir = makeProject();
  try {
    assert.deepEqual(buildHeaderLight(dir), buildHeaderHeavy(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editing the sequence file changes the header (no stale cache)", () => {
  const dir = makeProject();
  try {
    const before = buildHeaderLight(dir).state.state_hash;
    const seq = readSequence(dir);
    (seq.markers as unknown[]).push({ id: "probe-marker", at_ms: 1000 });
    writeSequence(dir, seq);
    const after = buildHeaderLight(dir).state.state_hash;
    assert.notEqual(after, before);
    assert.deepEqual(buildHeaderLight(dir), buildHeaderHeavy(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editing the journal changes delta and history (no stale cache)", () => {
  const dir = makeProject();
  try {
    const before = buildHeaderLight(dir);
    assert.equal(before.delta?.summary, "workspace.init");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, ".cuthol", "journal.json"), "utf8")
    );
    manifest.entries.push({
      revision: 2,
      timestamp: "2026-01-02T00:00:00.000Z",
      operation: "spine.trim",
      tag: null,
      snapshot_file: "rev_0002.json",
      delta_summary: "spine.trim: ~sp_01",
      affected_ids: ["sp_01"],
    });
    manifest.cursor_revision = 2;
    fs.writeFileSync(path.join(dir, ".cuthol", "journal.json"), JSON.stringify(manifest));
    const after = buildHeaderLight(dir);
    assert.equal(after.delta?.summary, "spine.trim: ~sp_01");
    assert.deepEqual(after.delta?.affected_ids, ["sp_01"]);
    assert.equal(after.history.undo_depth, 1);
    assert.deepEqual(after, buildHeaderHeavy(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
