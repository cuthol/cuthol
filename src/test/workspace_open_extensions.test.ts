/**
 * `workspace open` lists installed extensions (`src/test/workspace_open_extensions.test.ts`).
 *
 * Verifies `openWorkspaceSummary` reports every installed extension with its
 * enabled-for-this-project state and one-line description (the same data
 * `extension list` reports), in both the structured `extensions` field and
 * the `summary_text` line — compact single line when none are installed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, openWorkspaceSummary } from "../core/workspace.js";
import { createExtension, enableExtensionInWorkspace } from "../extensions/manager.js";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-wsopen-ext-"));
}

function safeRm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("workspace open lists one enabled and one disabled extension", () => {
  const tmpRoot = makeTmpRoot();
  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  // Isolate persistent extensions so only project-local ones are listed.
  process.env.CUTHOL_EXTENSIONS_DIR = path.join(tmpRoot, "persistent_extensions");
  process.env.CUTHOL_CACHE_DIR = path.join(tmpRoot, "shared_cache");
  try {
    const projDir = path.join(tmpRoot, "proj");
    initWorkspace({ dir: projDir });

    createExtension({
      name: "alpha",
      workspaceDir: projDir,
      scope: "project",
      template: "helper",
      description: "Alpha helper",
      version: "1.0.0",
    });
    createExtension({
      name: "beta",
      workspaceDir: projDir,
      scope: "project",
      template: "helper",
      description: "Beta helper",
      version: "2.0.0",
    });
    enableExtensionInWorkspace({ workspaceDir: projDir, name: "alpha" });

    const compact = openWorkspaceSummary(projDir, {});
    assert.deepEqual(
      compact.extensions.map((e) => `${e.name}:${e.enabled}:${e.description}`).sort(),
      ["alpha:true:Alpha helper", "beta:false:Beta helper"]
    );
    assert.match(compact.summary_text, /- Extensions \(2 installed\):/);
    assert.ok(compact.summary_text.includes("`alpha` (enabled — Alpha helper)"));
    assert.ok(compact.summary_text.includes("`beta` (disabled — Beta helper)"));

    const verbose = openWorkspaceSummary(projDir, { verbose: true });
    assert.deepEqual(
      verbose.extensions.map((e) => `${e.name}:${e.enabled}`).sort(),
      ["alpha:true", "beta:false"]
    );
    assert.ok(verbose.summary_text.includes("`alpha` (enabled — Alpha helper)"));
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    safeRm(tmpRoot);
  }
});

test("workspace open with no extensions is a single compact line", () => {
  const tmpRoot = makeTmpRoot();
  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = path.join(tmpRoot, "persistent_extensions");
  process.env.CUTHOL_CACHE_DIR = path.join(tmpRoot, "shared_cache");
  try {
    const projDir = path.join(tmpRoot, "proj");
    initWorkspace({ dir: projDir });

    const res = openWorkspaceSummary(projDir, {});
    assert.deepEqual(res.extensions, []);
    const extLines = res.summary_text.split("\n").filter((l) => l.includes("Extensions"));
    assert.equal(extLines.length, 1);
    assert.equal(extLines[0], "- Extensions (0 installed): _(none)_");
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    safeRm(tmpRoot);
  }
});
