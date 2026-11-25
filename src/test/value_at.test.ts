/**
 * `spine value`: render-free value at t. Placement params through the placement
 * resolver, other envelopes directly, static field or fx param otherwise.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setItemEnvelope } from "../sequence/spine.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { readEnvelopeValueAt } from "../sequence/envelope_points.js";

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-value-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "value", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function setup(wsDir: string): { clipId: string } {
  const media = path.join(wsDir, "media", "a.mp4");
  fs.mkdirSync(path.dirname(media), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    media,
  ]);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
  return { clipId: clip.id };
}

test("envelope value interpolates; static placement falls back", () => {
  withWs((wsDir) => {
    const { clipId } = setup(wsDir);
    setItemEnvelope({
      workspaceDir: wsDir,
      targetId: clipId,
      parameter: "placement.opacity",
      points: [
        { offset_ms: 0, value: 0, easing: "linear" },
        { offset_ms: 4000, value: 1, easing: "linear" },
      ],
    });
    const mid = readEnvelopeValueAt({
      workspaceDir: wsDir, targetId: clipId, parameter: "placement.opacity", localMs: 2000,
    });
    assert.equal(mid.source, "envelope");
    assert.ok(Math.abs(mid.value - 0.5) < 1e-6, `got ${mid.value}`);
    const stat = readEnvelopeValueAt({
      workspaceDir: wsDir, targetId: clipId, parameter: "placement.scale_x", localMs: 2000,
    });
    assert.equal(stat.source, "static");
    const { sequence } = loadSequence(wsDir);
    const clip = sequence.spine.clips.find((c) => c.id === clipId)!;
    assert.equal(stat.value, clip.placement.scale_x);
  });
});

test("gain envelope and static resolve; fx envelope resolves", () => {
  withWs((wsDir) => {
    const { clipId } = setup(wsDir);
    setItemEnvelope({
      workspaceDir: wsDir,
      targetId: clipId,
      parameter: "audio_chain.gain_db",
      points: [
        { offset_ms: 0, value: -6, easing: "linear" },
        { offset_ms: 4000, value: 0, easing: "linear" },
      ],
    });
    const v = readEnvelopeValueAt({
      workspaceDir: wsDir, targetId: clipId, parameter: "audio_chain.gain_db", localMs: 2000,
    });
    assert.equal(v.source, "envelope");
    assert.ok(Math.abs(v.value - -3) < 1e-6, `got ${v.value}`);
    const { fx } = addSpineFx({ workspaceDir: wsDir, clipId, filter: "gblur=sigma=3" });
    assert.throws(
      () => readEnvelopeValueAt({
        workspaceDir: wsDir, targetId: clipId,
        parameter: `fx.${fx.id}.sigma`, localMs: 0,
      }),
      (e: unknown) => e instanceof CutholError && e.diagnostic.code === "CUTHOL-G176"
    );
  });
});
