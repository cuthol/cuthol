/**
 * Motion blur across a render segment boundary: a segment split that falls
 * inside a motion-blurred spine clip must produce frames identical to the
 * one-pass render. The clip input is not cut at the boundary (the window
 * trim comes after tmix in the clip chain), so the blur history is intact.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence, updateSequenceInPlace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { computeRenderTimeSegments } from "../render/render_segments.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine_edit.js";

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

test("motion blur: frames around an in-clip segment boundary match the one-pass render", { timeout: 300_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-motion-blur-seg-"));
  try {
    const media = path.join(tmp, "src.mp4");
    runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:d=14",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=14",
      "-t", "14",
      "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      media,
    ]);
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "motion blur segment", aspect: "16:9", fps: 30 });
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 12000 });
    updateSequenceInPlace(wsDir, (seq) => {
      seq.spine.clips[0].treatments.motion_blur = { enabled: true, shutter_deg: 180, subframes: 8 };
    });
    for (const at of [2000, 4000, 6000, 8000, 10000]) {
      addLaneCue({
        workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: "vid_01",
        atMs: at, durationMs: 500, sourceInMs: 0, sourceOutMs: 500,
      });
    }
    const { sequence, paths } = loadSequence(wsDir);
    const maxItems = 2;
    const segs = computeRenderTimeSegments(sequence, 12000, maxItems);
    assert.ok(segs.length > 1, `expected a segment split, got ${JSON.stringify(segs)}`);
    const clip = sequence.spine.clips[0];
    const inner = segs.find(
      (s) => s.startMs > clip.timeline_in_ms + 1 && s.startMs < clip.timeline_in_ms + clip.duration_ms - 1
    );
    assert.ok(inner, `no boundary inside the blurred clip: ${JSON.stringify(segs.map((s) => [s.startFrame, s.endFrame]))}`);
    const leadFrames = Math.round((inner.startMs - clip.timeline_in_ms) / (1000 / sequence.stage.fps));
    assert.ok(leadFrames >= 10, `boundary only ${leadFrames} frames into the clip, need >= 10`);

    const full = compileSequenceRenderPlan(sequence, paths, "draft_480p", { includeAudio: false });
    assert.match(full.filterComplex, /tmix=frames=8:/);
    const W = full.renderWidth, H = full.renderHeight;
    const ySize = W * H, frameSize = (ySize * 3) / 2;
    const fullOut = path.join(tmp, "full.yuv");
    runFfmpeg([
      ...full.inputArgs, "-filter_complex", full.filterComplex,
      "-map", full.videoOutPad, "-frames:v", "360",
      "-f", "rawvideo", "-pix_fmt", "yuv420p", fullOut,
    ]);
    const fullBuf = fs.readFileSync(fullOut);

    for (const seg of segs) {
      const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
        activeWindowMs: [seg.startMs, seg.endMs], includeAudio: false, workers: 4,
      });
      const out = path.join(tmp, `seg${seg.index}.yuv`);
      runFfmpeg([
        ...plan.inputArgs, "-filter_complex", plan.filterComplex,
        "-map", plan.videoOutPad, "-frames:v", String(seg.frameCount),
        "-f", "rawvideo", "-pix_fmt", "yuv420p", out,
      ]);
      const buf = fs.readFileSync(out);
      assert.equal(buf.length, seg.frameCount * frameSize, `seg${seg.index} frame count`);
      const hi = Math.min(seg.startFrame + 10, seg.endFrame);
      for (let f = seg.startFrame; f < hi; f++) {
        const a = fullBuf.subarray(f * frameSize, f * frameSize + ySize);
        const b = buf.subarray((f - seg.startFrame) * frameSize, (f - seg.startFrame) * frameSize + ySize);
        assert.ok(a.equals(b), `global frame ${f} (seg${seg.index}+${f - seg.startFrame}) differs from one-pass Y plane`);
      }
      // The 2 frames before the boundary come from the previous segment.
      if (seg.index > 0) {
        const prev = fs.readFileSync(path.join(tmp, `seg${seg.index - 1}.yuv`));
        const prevSeg = segs[seg.index - 1];
        for (const f of [seg.startFrame - 2, seg.startFrame - 1]) {
          const a = fullBuf.subarray(f * frameSize, f * frameSize + ySize);
          const b = prev.subarray((f - prevSeg.startFrame) * frameSize, (f - prevSeg.startFrame) * frameSize + ySize);
          assert.ok(a.equals(b), `global frame ${f} (seg${prevSeg.index}+${f - prevSeg.startFrame}) differs from one-pass Y plane`);
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
