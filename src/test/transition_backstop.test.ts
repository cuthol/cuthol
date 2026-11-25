/**
 * Encoder-free backstop for extension transitions (`src/verify/gates_transitions.ts`).
 *
 * For every `ext:` transition in the sequence, verify compiles the real windowed plan
 * over the transition and runs it with `-f null`: a non-zero exit (including a crash)
 * is CUTHOL-G331 naming the clip, the kind and the field when stderr tells it. `spine
 * transition` runs the same check at write time for `ext:` kinds: a G331 rejects and
 * nothing is written. Sequences without `ext:` transitions verify with zero added
 * diagnostics and without touching ffmpeg.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import type { CutholDiagnostic } from "../core/diagnostics.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";
import { checkExtTransitionBackstop, verifyTransitionBackstop } from "../verify/gates_transitions.js";

function makeSolidMp4(dir: string, name: string, color: string, sec: number): string {
  const out = path.join(dir, name);
  const r = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30:d=${sec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:d=${sec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ]);
  assert.equal(r.status, 0, `ffmpeg ${name}: ${r.stderr?.toString() ?? ""}`);
  return out;
}

const TRANSITIONS: Record<string, unknown> = {
  push: {
    description: "incoming slides in from the right while outgoing slides out left",
    incoming_x: "if(lt(t,{{t1}}),{{W}}-{{W}}*{{p}},{{x}})",
    outgoing_x: "if(lt(t,{{t1}}),{{x}}-{{W}}*{{p}},{{x}}-{{W}})",
  },
  brokenopt: {
    description: "compiles fine but ffmpeg has no such option",
    outgoing_filter: "eq=bogusoptionxyz=1",
  },
};

/** Two 2 s clips (sp_01 red, sp_02 blue) with `trback` enabled. Caller owns `tmp`. */
function setupProject(): { wsDir: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-trback-"));
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "trback-", aspect: "16:9", fps: 30 });
  const dir = path.join(wsDir, ".cuthol", "extensions", "trback");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify({ name: "trback", version: "1.0.0", description: "backstop fixture.", transitions: TRANSITIONS }, null, 2),
    "utf8"
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "trback" });
  const red = makeSolidMp4(wsDir, "red.mp4", "red", 3);
  const blue = makeSolidMp4(wsDir, "blue.mp4", "blue", 3);
  const [redItem, blueItem] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [red, blue] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: redItem.handle, sourceInMs: 0, sourceOutMs: 2000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: blueItem.handle, sourceInMs: 0, sourceOutMs: 2000 });
  return { wsDir, tmp };
}

test("backstop passes a good push with no G331/G332", () => {
  const { wsDir, tmp } = setupProject();
  try {
    setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:trback/push", duration_ms: 500, easing: "linear" } });
    const good = loadSequence(wsDir);
    assert.equal(checkExtTransitionBackstop(good.sequence, good.paths, 0).status, "ok");
    const goodReport = verifySequence(good.sequence, good.paths);
    assert.ok(!goodReport.diagnostics.some((d) => d.code === "CUTHOL-G331" || d.code === "CUTHOL-G332"), JSON.stringify(goodReport.diagnostics));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("backstop fails a broken filter with clip, kind and field (verify + write time)", () => {
  const { wsDir, tmp } = setupProject();
  try {
    setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:trback/push", duration_ms: 500, easing: "linear" } });
    // Write time: a G331 rejects and nothing is written (previous transition untouched).
    assert.throws(
      () => setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:trback/brokenopt", duration_ms: 500, easing: "linear" } }),
      (err: unknown) => {
        const msg = String((err as Error).message);
        return /CUTHOL-G331/.test(msg) && msg.includes("sp_01") && msg.includes("ext:trback/brokenopt") && msg.includes("outgoing_filter");
      }
    );
    assert.equal(loadSequence(wsDir).sequence.spine.clips[0].transition_out?.kind, "ext:trback/push");
    // Verify path on a planted broken transition: cached second run still fails.
    commitSequenceMutation(wsDir, "test plant broken", (seq) => {
      seq.spine.clips[0].transition_out = { kind: "ext:trback/brokenopt", duration_ms: 500, easing: "linear" };
    });
    const bad = loadSequence(wsDir);
    const first = checkExtTransitionBackstop(bad.sequence, bad.paths, 0);
    assert.equal(first.status, "error");
    assert.match(String(first.diagnostic?.code), /CUTHOL-G331/);
    const report = verifySequence(bad.sequence, bad.paths);
    const g331 = report.diagnostics.filter((d) => d.code === "CUTHOL-G331");
    assert.equal(g331.length, 1, JSON.stringify(report.diagnostics));
    assert.equal(g331[0].subject_id, "sp_01");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("no ext: transitions means zero added diagnostics", () => {
  const { wsDir, tmp } = setupProject();
  try {
    setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "dissolve", duration_ms: 500, easing: "linear" } });
    const { sequence, paths } = loadSequence(wsDir);
    const before = verifySequence(sequence, paths).diagnostics.length;
    const extra: CutholDiagnostic[] = [];
    verifyTransitionBackstop(sequence, paths, extra);
    assert.equal(extra.length, 0);
    assert.equal(verifySequence(sequence, paths).diagnostics.length, before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
