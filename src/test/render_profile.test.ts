/**
 * Opt-in render cost profile (`render --profile`): per composition cue, capture
 * ms per frame and frames captured; without the flag the render result keeps
 * exactly its old shape (no `composition_profile` key, no extra work).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { renderSequenceToMp4 } from "../render/render_main.js";
import { addLaneCue } from "../sequence/lanes.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for the assertion message
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

test("render --profile reports per-composition capture cost; unflagged renders omit it", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-profile-"));
  try {
    initWorkspace({ dir: wsDir, aspect: "16:9", fps: 30, stageExplicit: true });
    const { sequence } = loadSequence(wsDir);
    const compDir = path.join(wsDir, "compositions", "badge");
    scaffoldHyperFramesComposition({
      targetDir: compDir,
      width: sequence.stage.width,
      height: sequence.stage.height,
      fps: sequence.stage.fps,
      durationMs: 3000,
      preset: "counter",
      props: {},
      transparent: false,
    });
    const { cue } = addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 3000,
      explicitDuration: true,
      composition: {
        composition_dir: compDir,
        entry_html: "index.html",
        props: {},
        transparent: false,
      },
    });

    // Cold render with the flag: one composition, real capture numbers.
    const withProfile = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      outputPath: path.join(wsDir, "profile.mp4"),
      profile: true,
    });
    const prof = (withProfile as any).composition_profile;
    assert.ok(prof, "expected composition_profile with profile:true");
    assert.equal(prof.compositions.length, 1, JSON.stringify(prof));
    const cost = prof.compositions[0];
    assert.equal(cost.composition, "badge", JSON.stringify(cost));
    assert.deepEqual(cost.cue_ids, [cue.id], JSON.stringify(cost));
    assert.equal(cost.cached, false, JSON.stringify(cost));
    assert.ok(
      typeof cost.frames_captured === "number" && cost.frames_captured > 0,
      JSON.stringify(cost)
    );
    assert.ok(typeof cost.capture_ms === "number" && cost.capture_ms > 0, JSON.stringify(cost));
    assert.ok(
      typeof cost.ms_per_frame === "number" && cost.ms_per_frame > 0,
      JSON.stringify(cost)
    );
    assert.match(prof.summary, /badge/, JSON.stringify(prof));

    // Warm render without the flag: the old result shape, no profile key.
    const plain = renderSequenceToMp4({
      workspaceDir: wsDir,
      preset: "draft_480p",
      outputPath: path.join(wsDir, "plain.mp4"),
    });
    assert.ok(!("composition_profile" in (plain as any)), JSON.stringify(Object.keys(plain)));

    // The CLI flag itself: warm cache render through the CLI carries the profile.
    const res = cli(["render", "draft_480p", "--out", "cli.mp4", "--profile", "--dir", wsDir]);
    assert.ok(res.ok, res.raw);
    const cliProf = res.result.composition_profile;
    assert.ok(cliProf, `expected composition_profile from CLI --profile: ${res.raw.slice(0, 500)}`);
    assert.equal(cliProf.compositions.length, 1, res.raw.slice(0, 500));
    assert.equal(cliProf.compositions[0].cached, true, res.raw.slice(0, 500));
  } finally {
    try {
      rmRetrySync(wsDir);
    } catch {
      // ignore cleanup error
    }
  }
});
