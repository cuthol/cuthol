/**
 * CUTHOL-G790 floor: quiet but non-zero output is not digital silence.
 * Solo tones at -40 and -50 dB render ok (no G790; G508 WARN may appear).
 * Fails on the old build: the post-render scan's -60 dB quiet floor flagged
 * a solo -40 dB tone (~-61 dB RMS after AAC) as digital silence and the
 * render failed with CUTHOL-G790.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitSequenceMutation, initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip } from "../sequence/spine.js";

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function codes(diagnostics: Array<{ code: string }>): string[] {
  return diagnostics.map((d) => d.code);
}

function renderQuietSoloTone(gainDb: number): { ok: boolean; diagnostics: Array<{ code: string; severity: string }> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-g790-quiet-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "g790 quiet", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "tone.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=3",
      "-t", "3",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: "vid_01",
      sourceInMs: 0,
      sourceOutMs: 3000,
    });
    commitSequenceMutation(wsDir, `test: quiet solo tone ${gainDb} dB`, (seq) => {
      seq.spine.clips[0].audio_chain.gain_db = gainDb;
    });
    const out = path.join(wsDir, "output", `quiet${Math.abs(gainDb)}.mp4`);
    const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
    assert.equal(res.ok, true, JSON.stringify(res.verification?.diagnostics));
    return { ok: res.ok, diagnostics: (res.audio_health?.diagnostics ?? []) as Array<{ code: string; severity: string }> };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

for (const gainDb of [-40, -50]) {
  test(`solo ${gainDb} dB tone renders ok with no G790`, { timeout: 300_000 }, () => {
    const res = renderQuietSoloTone(gainDb);
    assert.equal(res.ok, true);
    assert.ok(!codes(res.diagnostics).includes("CUTHOL-G790"), `solo ${gainDb} dB tone must not raise G790`);
  });
}
