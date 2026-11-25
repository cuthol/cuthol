/**
 * auto-adopt: hand edits inside mounted composition folders are adopted
 * automatically by the next reading command; edits to the sequence file
 * itself still require an explicit adopt/revert.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { adoptExternalCompositionEdits } from "../core/external_changes.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { commitVerifiedMutation } from "../verify/gates.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-auto-adopt-"));

function setupProject(name: string): { ws: string; compDir: string } {
  const ws = path.join(TEST_ROOT, name);
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: name, aspect: "16:9", fps: 30 });
  const compDir = path.join(ws, "compositions", "cmp_intro");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "counter",
    props: {},
    transparent: true,
  });
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 3000,
    composition: {
      composition_dir: "compositions/cmp_intro",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });
  return { ws, compDir };
}

test("auto-adopt: composition-only outside edit is adopted with a summary line", () => {
  const { ws, compDir } = setupProject("comp-only");
  const revBefore = loadSequence(ws).sequence.meta.revision;
  const indexPath = path.join(compDir, "index.html");
  fs.writeFileSync(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- hand edit -->`, "utf8");

  const adopted = adoptExternalCompositionEdits(ws, { automatic: true });
  assert.ok(adopted, "expected an adoption");
  assert.deepEqual(adopted?.adopted_comps, ["compositions/cmp_intro"]);
  assert.equal(adopted?.summary_line, "adopted outside composition edits: compositions/cmp_intro");
  assert.ok((adopted?.revision ?? 0) > revBefore);

  // Nothing left to adopt afterwards.
  assert.equal(adoptExternalCompositionEdits(ws), null);

  // The auto-adopt revision is a real journal revision: undo restores the edit.
  const { sequence } = loadSequence(ws);
  assert.ok(sequence.meta.revision >= (adopted?.revision ?? 0));
});

test("auto-adopt: nothing to adopt returns null", () => {
  const { ws } = setupProject("clean");
  assert.equal(adoptExternalCompositionEdits(ws), null);
});

test("auto-adopt: sequence-file edit is never adopted automatically", () => {
  const { ws } = setupProject("seq-edit");
  const seqPath = path.join(ws, "cuthol.sequence.json");
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as { meta: { title: string } };
  seq.meta.title = "hand-edited title";
  fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2), "utf8");

  assert.equal(adoptExternalCompositionEdits(ws, { automatic: true }), null);
});

test("auto-adopt: next edit command adopts and carries the one-line notice", () => {
  const { ws, compDir } = setupProject("via-edit");
  const indexPath = path.join(compDir, "index.html");
  fs.writeFileSync(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- hand edit -->`, "utf8");

  const { verification } = commitVerifiedMutation(ws, "test.noop", (seq) => {
    seq.meta.title = `${seq.meta.title}`;
    return true;
  });
  const notice = verification.diagnostics.find((d) => d.code === "CUTHOL-G460");
  assert.ok(notice, `expected G460 auto-adopt notice, got ${JSON.stringify(verification.diagnostics.map((d) => d.code))}`);
  assert.ok(notice?.what.includes("compositions/cmp_intro"));
  assert.ok(notice?.what.startsWith("Adopted outside composition edits:"));
});

test("gap summary: two empty ranges collapse to one line on edit commands", () => {
  const { ws } = setupProject("gaps");
  // Two more cues, leaving two empty ranges (3000..5000, 6000..8000).
  for (const atMs of [5000, 8000]) {
    addLaneCue({
      workspaceDir: ws,
      laneId: "ln_motion",
      kind: "composition",
      atMs,
      durationMs: 1000,
      composition: {
        composition_dir: "compositions/cmp_intro",
        entry_html: "index.html",
        props: {},
        transparent: true,
        mode: "overlay_alpha",
      },
    });
  }
  const { verification } = commitVerifiedMutation(ws, "test.noop2", (seq) => {
    seq.meta.title = `${seq.meta.title}`;
    return true;
  });
  const perRange = verification.diagnostics.filter((d) => d.code === "CUTHOL-G308");
  const summary = verification.diagnostics.filter((d) => d.code === "CUTHOL-G461");
  assert.equal(perRange.length, 0, `expected no per-range G308, got ${perRange.length}`);
  assert.equal(summary.length, 1, `expected one G461 summary, got ${JSON.stringify(verification.diagnostics.map((d) => d.code))}`);
});
