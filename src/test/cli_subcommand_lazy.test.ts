/**
 * Per-subcommand lazy loading: project commands load only the modules their
 * own subcommand needs. Each case spawns the real CLI with NODE_DEBUG=esm and
 * asserts the sibling subcommands' heavy modules are absent from the
 * translation log. On the old build (static imports) every case fails.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addLaneCue } from "../sequence/lanes.js";

// Next to the CLI under test: `dist/test/` -> `dist/cli.js` in the repo,
// `test/` -> `cli.js` in a relocated old-build copy (the fails-on-old recipe).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function makeMedia(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr || "ffmpeg failed");
}

function setupProject(): { ws: string; clipId: string; cueId: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-sublazy-"));
  const ws = path.join(tmp, "proj");
  initWorkspace({ dir: ws, title: "sublazy", aspect: "16:9", fps: 30 });
  const media = path.join(ws, "media", "a.mp4");
  makeMedia(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
  const added = addLaneCue({
    workspaceDir: ws,
    laneId: "ln_titles",
    kind: "title",
    atMs: 0,
    durationMs: 1000,
    text: "hi",
  });
  return { ws, clipId: clip.id, cueId: added.cue.id, tmp };
}

function loadedDistModules(args: string[]): { status: number | null; mods: string; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1", NODE_DEBUG: "esm" },
  });
  // Raw translation log: module paths, not URLs, so the check also works in a
  // relocated old-build copy without a `dist/` directory.
  const mods: string[] = [];
  for (const m of (proc.stderr ?? "").matchAll(/Translating \w+ (\S+?) /g)) {
    mods.push(m[1].replace(/^file:\/\/\//, "").replace(/^[A-Za-z]:/, ""));
  }
  return { status: proc.status, mods: mods.join("\n"), stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function checkAbsent(t: string, mods: string, needles: string[]): void {
  for (const needle of needles) {
    assert.ok(!mods.includes(needle), `${t} must not load ${needle}`);
  }
}

test("spine trim skips the fx sandbox, full check and treatment modules", () => {
  const { ws, clipId, tmp } = setupProject();
  try {
    const before = loadSequence(ws).sequence.meta.revision;
    const r = loadedDistModules(["spine", "trim", "--clip", clipId, "--out", "2000ms", "--dir", ws]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    checkAbsent("spine trim", r.mods, [
      "effects/fx_try.js",
      "effects/fx_sandbox.js",
      "effects/fx_check_full.js",
      "cli_cmd_spine_treatments.js",
      "sequence/spine_treatments.js",
    ]);
    // Counter-test: the edit really happened (no caching hides a real change).
    const after = loadSequence(ws).sequence;
    assert.ok(after.meta.revision > before, "trim must bump the revision");
    const clip = after.spine.clips.find((c) => c.id === clipId)!;
    assert.equal(Math.round(clip.source_out_ms), 2000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("lane update-cue skips the composition and probe modules", () => {
  const { ws, cueId, tmp } = setupProject();
  try {
    const r = loadedDistModules(["lane", "update-cue", "--cue", cueId, "--at", "100ms", "--dir", ws]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    checkAbsent("lane update-cue", r.mods, [
      "cli_cmd_composition.js",
      "compositor/composition_preview.js",
      "compositor/coords_query.js",
      "compositor/scaffold_guard.js",
    ]);
    // Counter-test: the cue really moved.
    const cue = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId)!;
    assert.equal(Math.round(cue.at_ms), 100);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("workspace open skips the stage modules", () => {
  const { ws, tmp } = setupProject();
  try {
    const r = loadedDistModules(["workspace", "open", "--dir", ws]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    checkAbsent("workspace open", r.mods, [
      "sequence/stage.js",
      "sequence/stage_resize.js",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("extension list skips the fx skeleton module", () => {
  const { ws, tmp } = setupProject();
  try {
    const r = loadedDistModules(["extension", "list", "--dir", ws]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    checkAbsent("extension list", r.mods, ["extensions/fx_new.js"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("speech providers skips the sibling speech modules", () => {
  const { ws, tmp } = setupProject();
  try {
    const r = loadedDistModules(["speech", "providers", "--dir", ws]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    checkAbsent("speech providers", r.mods, [
      "speech/synthesize.js",
      "speech/cleanup.js",
      "speech/captions.js",
      "library/query.js",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cue export skips the compositor modules", () => {
  const { ws, tmp } = setupProject();
  try {
    const r = loadedDistModules(["cue", "export", "--dir", ws]);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    checkAbsent("cue export", r.mods, [
      "compositor/composition_preview.js",
      "compositor/coords_query.js",
      "compositor/scaffold_guard.js",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
