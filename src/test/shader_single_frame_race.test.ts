/**
 * Single-frame shader intermediates: `ensurePlanPrePasses` prunes
 * superseded files but never touches a file younger than 30 s. Tested
 * through APIs that exist in the old build too, so a failure there is
 * behavioural (a surviving stale file), not a missing export.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ensurePlanPrePasses } from "../render/pre_pass.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadrace-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test("aged superseded single-frame files are pruned, fresh ones survive", () => {
  const wsDir = path.join(TMP, "raceage");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "raceage", aspect: "16:9", fps: 30 });
  const { paths } = loadSequence(wsDir);
  const blobs = paths.blobsDir as string;
  fs.mkdirSync(blobs, { recursive: true });
  const keeper = path.join(blobs, "sh_fxshad1_c1_bbbbbbbbbbbbbbbb.nut");
  const young = path.join(blobs, "sh_fxshad1_c1_aaaaaaaaaaaaaaaa.nut");
  const oldVictim = path.join(blobs, "sh_fxshad1_c1_dddddddddddddddd.nut");
  for (const f of [keeper, young, oldVictim]) fs.writeFileSync(f, "x");
  const old = new Date(Date.now() - 120_000);
  for (const f of [keeper, oldVictim]) fs.utimesSync(f, old, old);
  ensurePlanPrePasses(
    {
      prePasses: [
        {
          id: "fxshad_c1_bbbbbbbbbbbbbbbb",
          inputArgs: ["-i", "x"],
          filterComplex: "null",
          outPath: keeper,
          pixFmt: "rgba",
          kind: "shader",
          shader: { steps: [], fps: 30, pixFmt: "rgba" },
        },
      ],
    } as never,
    { cwd: paths.rootDir as string, step: "test race age" }
  );
  assert.ok(!fs.existsSync(oldVictim), "old superseded file is pruned");
  assert.ok(fs.existsSync(young), "fresh same-clip file survives the prune");
  assert.ok(fs.existsSync(keeper), "keeper untouched");
});
