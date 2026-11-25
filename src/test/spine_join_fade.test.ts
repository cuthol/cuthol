/**
 * Spine-join audio fades: a default short `afade` at every discontinuous
 * spine join (no `acrossfade`, contiguous `split` stays sample-identical).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceAudioPlan } from "../compositor/compiler.js";
import { computeSpineJoinFades } from "../compositor/compile_audio.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { setStageAudioJoinFadeMs } from "../sequence/stage.js";
import { commitVerifiedMutation } from "../verify/gates.js";

const TEST_ROOT = path.resolve("test-workspace/spine_join_fade");

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function decodeAudioF32Mono(file: string, sr = 48000): Float32Array {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:a", "-f", "f32le", "-acodec", "pcm_f32le", "-ar", String(sr), "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "audio decode failed");
  const buf = proc.stdout as Buffer;
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * Project: 250 Hz sine (period 4 ms, peaks at t = 1 + 4k ms).
 * - sp_01: source 0 -> 2001 ms (ends at a +0.9 peak, loud edge)
 * - sp_02: source 5000 -> 7000 ms (starts at a zero crossing: near full-scale step at the join)
 * - sp_03: source 7000 -> 9000 ms (contiguous split of sp_02: no fade allowed)
 */
function joinProject(wsDir: string, media: string): void {
  initWorkspace({ dir: wsDir, title: "spine join fade", aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2001 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 5000, sourceOutMs: 7000 });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 7000, sourceOutMs: 9000 });
}

function makeMedia(tmp: string): string {
  const media = path.join(tmp, "tone.mkv");
  runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
    "-f", "lavfi", "-i", "aevalsrc='0.9*sin(2*PI*250*t)':s=48000:d=12",
    "-t", "12",
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    media,
  ]);
  return media;
}

function countJoinFades(filterComplex: string): number {
  return filterComplex.split(`curve=qsin`).length - 1;
}

test("spine join fade: discontinuous join gets the afade pair", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-join-fade-");
  try {
    const wsDir = path.join(tmp, "proj");
    joinProject(wsDir, makeMedia(tmp));
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceAudioPlan(sequence, paths);
    assert.equal(countJoinFades(plan.filterComplex), 2, `one fade-out + one fade-in expected:\n${plan.filterComplex}`);
    assert.ok(
      plan.filterComplex.includes("afade=t=out:st=1.991000:d=0.010000:curve=qsin"),
      `fade-out of the last 10 ms of sp_01 missing:\n${plan.filterComplex}`
    );
    assert.ok(
      plan.filterComplex.includes("afade=t=in:st=0.000000:d=0.010000:curve=qsin"),
      `fade-in of the first 10 ms of sp_02 missing:\n${plan.filterComplex}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("spine join fade: contiguous split gets no fade (mutation: contiguity check removed)", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-join-fade-split-");
  try {
    const wsDir = path.join(tmp, "proj");
    joinProject(wsDir, makeMedia(tmp));
    const { sequence, paths } = loadSequence(wsDir);
    // sp_02 -> sp_03 continues the same source (7000 == 7000): only the two
    // fades of the discontinuous join may exist. Removing the contiguity check
    // would emit 4 and fail this test.
    const plan = compileSequenceAudioPlan(sequence, paths);
    assert.equal(countJoinFades(plan.filterComplex), 2, `split join must stay fade-free:\n${plan.filterComplex}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("spine join fade: setting 0 disables fades; own fade wins; short clip halves", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-join-fade-opt-");
  try {
    const wsDir = path.join(tmp, "proj");
    joinProject(wsDir, makeMedia(tmp));
    const { sequence, paths } = loadSequence(wsDir);
    assert.deepEqual(
      [computeSpineJoinFades(sequence).get(0), computeSpineJoinFades(sequence).get(1)],
      [{ fadeInMs: 0, fadeOutMs: 10 }, { fadeInMs: 10, fadeOutMs: 0 }]
    );

    setStageAudioJoinFadeMs({ workspaceDir: wsDir, ms: 0 });
    const zeroed = loadSequence(wsDir).sequence;
    assert.equal(computeSpineJoinFades(zeroed).size, 0);
    const zeroPlan = compileSequenceAudioPlan(zeroed, paths);
    assert.equal(countJoinFades(zeroPlan.filterComplex), 0, "setting 0 must emit no join fades");
    assert.ok(!zeroPlan.filterComplex.includes("afade"), "no afade at all without explicit fades");

    // Own fade wins over the join fade on that side.
    setStageAudioJoinFadeMs({ workspaceDir: wsDir, ms: 10 });
    commitVerifiedMutation(wsDir, "test", (seq) => {
      seq.spine.clips[1].audio_chain.fade_in_ms = 50;
      return {};
    });
    const ownFade = loadSequence(wsDir).sequence;
    assert.deepEqual(computeSpineJoinFades(ownFade).get(1) ?? { fadeInMs: 0, fadeOutMs: 0 }, { fadeInMs: 0, fadeOutMs: 0 });
    const ownPlan = compileSequenceAudioPlan(ownFade, paths);
    assert.equal(countJoinFades(ownPlan.filterComplex), 1, "only the fade-out side keeps its join fade");
    assert.ok(ownPlan.filterComplex.includes("afade=t=in:st=0.000:d=0.050"), "explicit 50 ms fade-in kept");

    // Clips shorter than 2*N get half the clip, never longer (70 ms clip with
    // N = 40 keeps a 35 ms fade; 70 ms clears the 2-frame minimum gate).
    setStageAudioJoinFadeMs({ workspaceDir: wsDir, ms: 40 });
    commitVerifiedMutation(wsDir, "test", (seq) => {
      seq.spine.clips[1].audio_chain.fade_in_ms = 0;
      seq.spine.clips[0].source_out_ms = 70;
      seq.spine.clips[0].duration_ms = 70;
      seq.spine.clips[1].timeline_in_ms = 70;
      seq.spine.clips[2].timeline_in_ms = 2070;
      return {};
    });
    const short = loadSequence(wsDir).sequence;
    assert.deepEqual(computeSpineJoinFades(short).get(0), { fadeInMs: 0, fadeOutMs: 35 });
    const shortPlan = compileSequenceAudioPlan(short, paths);
    assert.ok(shortPlan.filterComplex.includes("d=0.035000:curve=qsin"), `short clip fade halves:\n${shortPlan.filterComplex}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("spine join fade: muted clip, transition and sequence ends get no fade", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-join-fade-edge-");
  try {
    const wsDir = path.join(tmp, "proj");
    joinProject(wsDir, makeMedia(tmp));
    commitVerifiedMutation(wsDir, "test", (seq) => {
      seq.spine.clips[1].audio_chain.muted = true;
      seq.spine.clips[0].transition_out = { kind: "dissolve", duration_ms: 500, easing: "linear" };
      return {};
    });
    const { sequence, paths } = loadSequence(wsDir);
    // Join 0->1 muted on the incoming side: no fades. First clip has no
    // fade-in (sequence start), last clip no fade-out (sequence end).
    const joins = computeSpineJoinFades(sequence);
    assert.equal(joins.get(0)?.fadeOutMs ?? 0, 0, "transition join keeps old behaviour");
    assert.equal(joins.get(1)?.fadeInMs ?? 0, 0, "muted clip breaks the chain");
    assert.equal(joins.get(0)?.fadeInMs ?? 0, 0, "no fade-in at sequence start");
    assert.equal(joins.get(2)?.fadeOutMs ?? 0, 0, "no fade-out at sequence end");
    const plan = compileSequenceAudioPlan(sequence, paths);
    assert.equal(countJoinFades(plan.filterComplex), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** Peak first-difference within +-2 ms of the join vs the median of the surrounding 100 ms. */
function clickRatio(pcm: Float32Array, sr: number, joinSec: number): number {
  const diff = new Float32Array(pcm.length - 1);
  for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(pcm[i + 1] - pcm[i]);
  const j = Math.round(joinSec * sr);
  const near = diff.slice(Math.max(0, j - 2 * sr / 1000), Math.min(diff.length, j + (2 * sr) / 1000));
  let peak = 0;
  for (const v of near) peak = Math.max(peak, v);
  const ctx: number[] = [];
  const lo = Math.max(0, j - (50 * sr) / 1000);
  const hi = Math.min(diff.length, j + (50 * sr) / 1000);
  for (let i = lo; i < hi; i++) {
    if (Math.abs(i - j) > (2 * sr) / 1000) ctx.push(diff[i]);
  }
  ctx.sort((a, b) => a - b);
  const med = ctx[Math.floor(ctx.length / 2)] || 1e-9;
  return peak / med;
}

test("spine join fade: click metric drops at the join (validates the metric both ways)", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-join-fade-click-");
  try {
    const wsDir = path.join(tmp, "proj");
    joinProject(wsDir, makeMedia(tmp));
    const renderPcm = (ms: number | null, tag: string): Float32Array => {
      if (ms !== null) setStageAudioJoinFadeMs({ workspaceDir: wsDir, ms });
      const { sequence, paths } = loadSequence(wsDir);
      const plan = compileSequenceAudioPlan(sequence, paths);
      const out = path.join(tmp, `${tag}.wav`);
      runFfmpeg([
        ...plan.inputArgs,
        "-filter_complex", plan.filterComplex,
        "-map", plan.audioOutPad,
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
        out,
      ]);
      return decodeAudioF32Mono(out);
    };
    // Join at 2001 ms: clip ends at a +0.9 peak, next starts at a zero crossing.
    const joinSec = 2.001;
    const faded = renderPcm(null, "faded");
    const fadedRatio = clickRatio(faded, 48000, joinSec);
    const raw = renderPcm(0, "raw");
    const rawRatio = clickRatio(raw, 48000, joinSec);
    assert.ok(rawRatio > 5, `metric must fire on the unfaded click, got ${rawRatio}`);
    assert.ok(fadedRatio < 3, `join fade must remove the click, got ${fadedRatio} (raw ${rawRatio})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
