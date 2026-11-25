/**
 * Cue-sheet `--file` resolution: outputs under `--dir`, inputs with fallback
 * (`src/test/cue_sheet_paths.test.ts`).
 *
 * Documented rule: outputs resolve against the project folder (`--dir`),
 * inputs resolve against the working directory first, then under `--dir`;
 * when neither exists the CLI raises a Cuthol diagnostic (CUTHOL-G770)
 * naming both paths tried instead of a raw ENOENT.
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { resolveCueSheetReadPath, resolveCueSheetWritePath } from "../cli_cmd_composition.js";

function makeDirs(): { root: string; ws: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cue-paths-"));
  const ws = path.join(root, "proj");
  const cwd = path.join(root, "elsewhere");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { root, ws, cwd };
}

test("1. Export (write) resolves a relative path under the workspace", () => {
  const { root, ws } = makeDirs();
  try {
    assert.equal(resolveCueSheetWritePath("x.cues.json", ws), path.join(ws, "x.cues.json"));
    assert.equal(
      resolveCueSheetWritePath(path.join("sub", "x.cues.json"), ws),
      path.join(ws, "sub", "x.cues.json")
    );
    const abs = path.join(root, "abs.cues.json");
    assert.equal(resolveCueSheetWritePath(abs, ws), abs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("2. Read prefers the working directory, then the workspace", () => {
  const { root, ws, cwd } = makeDirs();
  try {
    const inWs = path.join(ws, "x.cues.json");
    fs.writeFileSync(inWs, "{}", "utf8");
    // Neither exists yet in cwd: resolves under the workspace.
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      assert.equal(resolveCueSheetReadPath("x.cues.json", ws), inWs);
      // A file in the working directory wins over the workspace copy.
      const inCwd = path.join(cwd, "x.cues.json");
      fs.writeFileSync(inCwd, "{}", "utf8");
      assert.equal(resolveCueSheetReadPath("x.cues.json", ws), inCwd);
    } finally {
      process.chdir(prev);
    }
    // Absolute path unchanged.
    assert.equal(resolveCueSheetReadPath(inWs, ws), inWs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3. Read of a missing file raises CUTHOL-G770 naming both paths", () => {
  const { root, ws, cwd } = makeDirs();
  try {
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      assert.throws(
        () => resolveCueSheetReadPath("missing.cues.json", ws),
        (err: unknown) => {
          assert.ok(err instanceof CutholError);
          assert.equal(err.diagnostic.code, "CUTHOL-G770");
          const msg = `${err.diagnostic.what} ${err.diagnostic.suggestion ?? ""}`;
          assert.ok(msg.includes(path.resolve("missing.cues.json")), "names the cwd path");
          assert.ok(msg.includes(path.join(ws, "missing.cues.json")), "names the workspace path");
          assert.ok(!/ENOENT/.test(err.diagnostic.what), "no raw ENOENT in the message");
          return true;
        }
      );
    } finally {
      process.chdir(prev);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
