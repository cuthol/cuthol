/**
 * Project summary shows a non-default spine-join audio fade (`stage.audio_join_fade_ms`),
 * in the same conditional style as `Tempo`: only when it differs from the default.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSequenceBrief } from "../brief/inspector.js";
import { formatWorkspaceOpenSummary, initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";

function makeWorkspace(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-join-fade-summary-"));
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "fade summary", aspect: "16:9", fps: 30 });
  return wsDir;
}

function setFade(wsDir: string, ms: number | undefined): void {
  updateSequenceInPlace(wsDir, (seq) => {
    if (ms === undefined) {
      delete (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms;
    } else {
      (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms = ms;
    }
  });
}

function cleanup(wsDir: string): void {
  fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
}

test("project summary hides the join fade at the default (mutation: suffix always shown)", () => {
  const wsDir = makeWorkspace();
  try {
    setFade(wsDir, undefined);
    const { sequence } = loadSequence(wsDir);
    assert.ok(!renderSequenceBrief(sequence, { lens: "overview" }).includes("Join fade"), "overview must not show Join fade at default");
    assert.ok(!formatWorkspaceOpenSummary(sequence).includes("Join fade"), "open summary must not show Join fade at default");
  } finally {
    cleanup(wsDir);
  }
});

test("project summary shows a zero join fade (mutation: fade suffix dropped)", () => {
  const wsDir = makeWorkspace();
  try {
    setFade(wsDir, 0);
    const { sequence } = loadSequence(wsDir);
    assert.ok(
      renderSequenceBrief(sequence, { lens: "overview" }).includes("| Join fade: `0ms`"),
      "overview must show Join fade 0ms"
    );
    assert.ok(
      formatWorkspaceOpenSummary(sequence).includes("| Join fade: `0ms`"),
      "open summary must show Join fade 0ms"
    );
  } finally {
    cleanup(wsDir);
  }
});

test("project summary shows a raised join fade (mutation: fade suffix dropped)", () => {
  const wsDir = makeWorkspace();
  try {
    setFade(wsDir, 25);
    const { sequence } = loadSequence(wsDir);
    assert.ok(
      renderSequenceBrief(sequence, { lens: "overview" }).includes("| Join fade: `25ms`"),
      "overview must show Join fade 25ms"
    );
    assert.ok(
      formatWorkspaceOpenSummary(sequence).includes("| Join fade: `25ms`"),
      "open summary must show Join fade 25ms"
    );
  } finally {
    cleanup(wsDir);
  }
});
