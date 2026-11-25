/**
 * Post-render true-peak warning: the finished output file is measured with
 * ebur128 (peak=true) against the project's master ceiling; a peak above the
 * ceiling appends a WARN diagnostic (CUTHOL-G501) and never fails the render.
 * Fails on the old build: render_main.ts never called
 * truePeakCeilingDiagnosticForRenderedOutput, so no such diagnostic existed.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip } from "../sequence/spine.js";
import { truePeakCeilingDiagnosticForRenderedOutput } from "../verify/gates_stage_signal.js";

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function toneMp4(outPath: string, audioFilter: string): void {
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=2",
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:d=2`,
    "-t", "2",
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-af", audioFilter,
    "-c:a", "aac",
    outPath,
  ]);
}

test("full-scale output exceeds the -1 dBTP ceiling (WARN), quiet output does not", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-truepeak-"));
  try {
    const loud = path.join(tmp, "loud.mp4");
    toneMp4(loud, "volume=24dB");
    const warn = truePeakCeilingDiagnosticForRenderedOutput("render output", loud, -1.0);
    assert.ok(warn, "full-scale output must produce a true-peak warning");
    assert.equal(warn.code, "CUTHOL-G501");
    assert.equal(warn.severity, "WARN");

    const quiet = path.join(tmp, "quiet.mp4");
    toneMp4(quiet, "volume=-30dB");
    const none = truePeakCeilingDiagnosticForRenderedOutput("render output", quiet, -1.0);
    assert.equal(none, null, "quiet output must produce no warning");

    assert.equal(truePeakCeilingDiagnosticForRenderedOutput("render output", path.join(tmp, "missing.mp4"), -1.0), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normal render completes and true-peak measurement costs < 1 s", { timeout: 300_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-truepeak-render-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "truepeak", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "tone.mkv");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=2",
      "-t", "2",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });
    const out = path.join(wsDir, "output", "normal.mp4");
    const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
    assert.equal(res.ok, true, JSON.stringify(res.verification?.diagnostics));

    const t0 = Date.now();
    truePeakCeilingDiagnosticForRenderedOutput("render output", out, -1.0);
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 1000, `true-peak measurement must cost < 1 s (took ${elapsedMs} ms)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
