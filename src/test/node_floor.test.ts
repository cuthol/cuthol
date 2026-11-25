/**
 * Node floor 22.12 (`src/test/node_floor.test.ts`).
 * `src/core/workspace.ts` loads its heavy commit-path modules via
 * `createRequire(import.meta.url)` + `require()` of ES modules, which is
 * unflagged only from Node 22.12 (and 20.19); the declared floor is
 * `>=22.12.0`, so `cuthol doctor` must fail a Node below it, and one editing
 * command must run cleanly in a child process on the running Node (guards the
 * `require()` path end to end).
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkNode } from "../core/doctor.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";

// Next to the CLI under test: `dist/test/` -> `dist/cli.js` in the repo,
// `test/` -> `cli.js` in a relocated old-build copy (the fails-on-old recipe).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("node 22.11 fails against the declared floor, with the install fix", () => {
  // No injected range: the check reads `engines` from package.json.
  const check = checkNode({ nodeVersion: "v22.11.0" });
  assert.equal(check.status, "fail");
  assert.match(check.fix, /Node\.js/);
});

test("node 22.12 satisfies the declared floor", () => {
  const check = checkNode({ nodeVersion: "v22.12.0" });
  assert.equal(check.status, "ok");
});

test("running node satisfies the declared floor", () => {
  const check = checkNode({});
  assert.equal(check.status, "ok", check.found);
});

test("lane add-cue works in a child process on the running node", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-nodefloor-"));
  try {
    const ws = path.join(tmp, "proj");
    initWorkspace({ dir: ws, title: "nodefloor", aspect: "16:9", fps: 30 });
    const before = loadSequence(ws).sequence.meta.revision;
    const proc = spawnSync(
      process.execPath,
      [CLI, "lane", "add-cue", "--lane", "ln_titles", "--kind", "title", "--at", "0ms", "--duration", "1000ms", "--text", "hi", "--dir", ws],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
      }
    );
    try {
      assert.equal(proc.status, 0, (proc.stderr ?? "").slice(-2000));
      const seq = loadSequence(ws).sequence;
      assert.ok(seq.meta.revision > before, "add-cue must bump the revision");
      const lane = seq.lanes.find((l) => l.id === "ln_titles");
      assert.ok(lane && lane.cues.length === 1, "added cue must persist through the commit path");
      assert.equal(Math.round(lane!.cues[0].at_ms), 0);
      assert.equal(Math.round(lane!.cues[0].duration_ms), 1000);
    } finally {
      // Every test that opens a child process closes it in `finally`.
      if (proc.pid !== undefined) {
        try {
          process.kill(proc.pid, 0);
        } catch {
          // exited already: nothing to close
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
