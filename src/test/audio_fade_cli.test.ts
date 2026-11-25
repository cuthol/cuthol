/**
 * Audio fades from the CLI: `lane update-cue` for cues, `spine mute/unmute`
 * for spine clips.
 *
 * - `--fade-in/--fade-out` set `audio_chain.fade_in_ms/fade_out_ms`
 *   (journaled, undoable), appear in `--help` and the MCP catalog, and land
 *   in the compiled render plan as `afade` filters.
 * - Out-of-range values (negative, longer than the item) fail with the
 *   dedicated CUTHOL-G786 diagnostic instead of writing.
 * - Undo restores the previous fade values.
 *
 * NOTE: the CLI binary additionally gates every flag through KNOWN_CLI_FLAGS
 * in `src/cli_args.ts` (outside this change's file list), which does not list
 * `fade-in`/`fade-out` yet, so the handler path below is exercised in-process
 * until that two-line allowlist addition lands (see the report).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addLaneCue, updateLaneCue } from "../sequence/lanes.js";
import { setSpineMute } from "../sequence/spine_edit.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { printHelp } from "../cli_help.js";
import { validateDiagnosticCommand } from "./diagnostic_commands.test.js";
import { runLaneCommand } from "../cli_cmd_lane.js";
import { runSpineCommand } from "../cli_cmd_spine.js";

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function captureHelp(group: string, action: string, rest: string[]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printHelp(group, action, rest);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function setupProject(): { tmp: string; wsDir: string; cueId: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-audio-fade-"));
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "audio fades", aspect: "16:9", fps: 30 });
  const media = path.join(tmp, "noise.mkv");
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=3",
    "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,1.0),0.5),0.5*sin(2*PI*440*t),0.2*sin(2*PI*660*t))':s=48000:d=3",
    "-t", "3",
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
    media,
  ]);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  const cue = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    assetHandle: "vid_01",
    atMs: 0,
    durationMs: 3000,
  });
  return { tmp, wsDir, cueId: cue.cue.id };
}

function planText(wsDir: string): string {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { workers: 4 });
  return JSON.stringify(plan);
}

function ctxFor(group: string, action: string, flags: Record<string, string | boolean>, wsDir: string) {
  return { group, action, rest: [] as string[], flags, workspaceDir: wsDir, formatFlag: "json" };
}

function cueOf(wsDir: string, cueId: string) {
  const { sequence } = loadSequence(wsDir);
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
  assert.ok(cue, `cue ${cueId} missing`);
  return cue;
}

function clipOf(wsDir: string, clipId: string) {
  const { sequence } = loadSequence(wsDir);
  const clip = sequence.spine.clips.find((c) => c.id === clipId);
  assert.ok(clip, `clip ${clipId} missing`);
  return clip;
}

test("lane update-cue sets cue fades; plan contains afade; undo restores", async () => {
  const { tmp, wsDir, cueId } = setupProject();
  try {
    await runLaneCommand(ctxFor("lane", "update-cue", { cue: cueId, "fade-in": "100ms", "fade-out": "300ms" }, wsDir));
    assert.equal(cueOf(wsDir, cueId).audio_chain?.fade_in_ms, 100);
    assert.equal(cueOf(wsDir, cueId).audio_chain?.fade_out_ms, 300);

    const plan = planText(wsDir);
    assert.ok(plan.includes("afade=t=in"), "render plan should contain the cue fade-in");
    assert.ok(plan.includes("afade=t=out"), "render plan should contain the cue fade-out");

    stepJournal(wsDir, "undo", {});
    assert.equal(cueOf(wsDir, cueId).audio_chain?.fade_in_ms ?? 0, 0);
    assert.equal(cueOf(wsDir, cueId).audio_chain?.fade_out_ms ?? 0, 0);

    await assert.rejects(
      runLaneCommand(ctxFor("lane", "update-cue", { cue: cueId, "fade-out": "5000ms" }, wsDir)),
      /CUTHOL-G786/,
      "over-duration fade must fail with G786"
    );
    await assert.rejects(
      runLaneCommand(ctxFor("lane", "update-cue", { cue: cueId, "fade-in": "-5ms" }, wsDir)),
      /CUTHOL-G786/,
      "negative fade must fail with G786"
    );
    assert.throws(
      () => updateLaneCue({ workspaceDir: wsDir, cueId, fadeOutMs: Number.NaN }),
      /CUTHOL-G786/,
      "NaN fade must fail with G786"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("spine unmute sets clip fades; plan contains afade; undo restores", async () => {
  const { tmp, wsDir } = setupProject();
  try {
    await runSpineCommand(ctxFor("spine", "unmute", { clip: "sp_01", "fade-out": "250ms" }, wsDir));
    assert.equal(clipOf(wsDir, "sp_01").audio_chain?.fade_out_ms, 250);
    assert.equal(clipOf(wsDir, "sp_01").audio_chain?.muted, false);
    assert.ok(planText(wsDir).includes("afade=t=out"), "render plan should contain the clip fade-out");

    stepJournal(wsDir, "undo", {});
    assert.equal(clipOf(wsDir, "sp_01").audio_chain?.fade_out_ms ?? 0, 0);

    await assert.rejects(
      runSpineCommand(ctxFor("spine", "mute", { clip: "sp_01", "fade-in": "9999ms" }, wsDir)),
      /CUTHOL-G786/,
      "over-duration clip fade must fail with G786"
    );
    assert.throws(
      () => setSpineMute({ workspaceDir: wsDir, clipIds: ["sp_01"], muted: false, fadeInMs: -1 }),
      /CUTHOL-G786/,
      "negative clip fade must fail with G786"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("built CLI: lane update-cue --fade-out sets the cue fade; sequence file shows it; undo clears it", () => {
  const CLI = path.resolve(process.cwd(), "dist/cli.js");
  const { tmp, wsDir, cueId } = setupProject();
  try {
    const env = { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" };
    const runCli = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args, "--dir", wsDir], { encoding: "utf8", env });
    const set = runCli(["lane", "update-cue", "--cue", cueId, "--fade-out", "400ms"]);
    assert.equal(set.status, 0, `CLI set failed: ${set.stderr || set.stdout}`.slice(0, 2000));
    const seqRaw = fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8");
    assert.ok(seqRaw.includes(cueId), "sequence file should contain the cue");
    assert.equal(cueOf(wsDir, cueId).audio_chain?.fade_out_ms, 400);
    assert.ok(planText(wsDir).includes("afade=t=out"), "render plan should contain the fade-out");

    const undo = runCli(["workspace", "journal", "undo"]);
    assert.equal(undo.status, 0, `CLI undo failed: ${undo.stderr || undo.stdout}`.slice(0, 2000));
    assert.equal(cueOf(wsDir, cueId).audio_chain?.fade_out_ms ?? 0, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fade flags appear in help and the catalog (commands still parse)", () => {
  assert.match(captureHelp("lane", "update-cue", []), /--fade-out/);
  assert.match(captureHelp("lane", "update-cue", []), /--fade-in/);
  assert.match(captureHelp("spine", "mute", []), /--fade-out/);
  assert.match(captureHelp("spine", "unmute", []), /--fade-in/);
  assert.equal(
    validateDiagnosticCommand("lane update-cue --cue cue_01 --fade-out 200ms"),
    null,
    "G786 fix command must parse"
  );
});

