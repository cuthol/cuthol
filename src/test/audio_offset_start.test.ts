/**
 * Audio must follow the container clock when the stream starts late.
 *
 * A file whose audio stream starts after the file start (e.g. a phone
 * recording whose audio stream starts 0.176 s after the video) must still
 * satisfy: output time t of a clip/cue
 * plays source time (srcIn + t). The old `atrim + asetpts=PTS-STARTPTS`
 * pattern rebased to the first available sample, moving the whole clip early
 * by the stream offset. The fixed chain rebases to the requested trim start
 * and backfills the leading gap with silence.
 *
 * Media is generated in a temp dir: video from 0, audio stream starting
 * ~0.2 s after the video (`-itsoffset`), carrying short bursts at known
 * container times. Position is asserted on the decoded PCM (absolute onset,
 * +/- 1 ms), never by comparing two extractions.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setSpineSpeed } from "../sequence/spine.js";
import { sourceMsToClipLocalMs } from "../sequence/spine_time.js";

const SR = 48000;
const OFFSET_S = 0.2;

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8", timeout: 280_000, windowsHide: true });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.error ?? proc.stderr ?? ""}`.slice(0, 2000));
}

function probeStartTime(file: string, kind: "v" | "a"): number {
  const proc = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", `${kind}:0`, "-show_entries", "stream=start_time", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, "ffprobe failed");
  return Number((proc.stdout ?? "").trim());
}

/**
 * Build a video whose audio stream starts OFFSET_S after the video.
 * audioExpr is evaluated in audio-file time; container time = file time + OFFSET_S.
 */
function offsetMedia(outPath: string, durS: number, audioExpr: string): void {
  const tmpV = path.join(path.dirname(outPath), "v_tmp.mkv");
  const tmpA = path.join(path.dirname(outPath), "a_tmp.wav");
  runFfmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:d=${durS}`,
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    tmpV,
  ]);
  runFfmpeg([
    "-f", "lavfi", "-i", `aevalsrc='${audioExpr}':s=${SR}:d=${durS}`,
    "-c:a", "pcm_s16le",
    tmpA,
  ]);
  runFfmpeg([
    "-i", tmpV,
    "-itsoffset", String(OFFSET_S), "-i", tmpA,
    "-map", "0:v", "-map", "1:a",
    "-c", "copy",
    outPath,
  ]);
  fs.rmSync(tmpV, { force: true });
  fs.rmSync(tmpA, { force: true });
  const aStart = probeStartTime(outPath, "a");
  const vStart = probeStartTime(outPath, "v");
  assert.ok(
    aStart - vStart > 0.15 && aStart - vStart < 0.25,
    `audio must start ~0.2 s after video, got a=${aStart} v=${vStart}`
  );
}

function decodeAudioF32Mono(file: string): Float32Array {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:a", "-f", "f32le", "-acodec", "pcm_f32le", "-ar", String(SR), "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, timeout: 280_000, windowsHide: true }
  );
  assert.equal(proc.status, 0, "audio decode failed");
  const buf = proc.stdout as Buffer;
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** First abrupt-onset sample index: |x| > 0.2 with sustained energy after. */
function findOnset(x: Float32Array, fromSample: number): number {
  for (let i = fromSample; i + 96 < x.length; i++) {
    if (Math.abs(x[i]) < 0.2) continue;
    let sum = 0;
    for (let k = 1; k <= 96; k++) sum += Math.abs(x[i + k]);
    if (sum / 96 > 0.1) return i;
  }
  return -1;
}

function renderPlanPcm(wsDir: string, outMedia: string): void {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
  runFfmpeg([
    ...plan.inputArgs,
    "-filter_complex", plan.filterComplex,
    "-map", plan.videoOutPad, "-map", plan.audioOutPad,
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", String(SR), "-ac", "2",
    outMedia,
  ]);
}

function buildProject(tmp: string, name: string, media: string): string {
  const wsDir = path.join(tmp, name);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  return wsDir;
}

const BEEP_880 = "gte(t,0.8)*lt(t,0.9)*0.5*sin(2*PI*880*t)";

test("audio offset start: clip at in 0 plays source time (beep at container 1.0 s)", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-0-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetMedia(media, 6, BEEP_880);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    const onset = findOnset(audio, 0);
    assert.ok(onset >= 0, "beep not found in rendered output");
    const atMs = (onset / SR) * 1000;
    assert.ok(Math.abs(atMs - 1000) <= 1, `beep at ${atMs.toFixed(2)} ms, expected 1000 ms`);
    let sumSq = 0;
    const head = Math.floor(0.15 * SR);
    for (let i = 0; i < head; i++) sumSq += audio[i] * audio[i];
    assert.ok(Math.sqrt(sumSq / head) < 0.01, "first 150 ms must be silence (source has no audio there)");
    console.log(`in0 beep at ${atMs.toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("audio offset start: clip at in 0.5 plays source time (beep at 0.5 s)", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-05-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetMedia(media, 6, BEEP_880);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 500, sourceOutMs: 3500 });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    const onset = findOnset(audio, 0);
    assert.ok(onset >= 0, "beep not found in rendered output");
    const atMs = (onset / SR) * 1000;
    assert.ok(Math.abs(atMs - 500) <= 1, `beep at ${atMs.toFixed(2)} ms, expected 500 ms`);
    console.log(`in0.5 beep at ${atMs.toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("audio offset start: 1.5x speed clip from in 0 maps source time / rate", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-15-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetMedia(media, 6, BEEP_880);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.5 });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    const onset = findOnset(audio, 0);
    assert.ok(onset >= 0, "beep not found in rendered output");
    const atMs = (onset / SR) * 1000;
    const expected = 1000 / 1.5;
    // atempo (WSOLA) has its own pre-existing mapping error (~10-16 ms early
    // at 1.5x, measured identical on zero-offset media with the old and the
    // new chain), so the abrupt-beep onset cannot hit +/-1 ms here. The
    // offset fix itself is exact: without it the beep lands ~117 ms
    // (= 176.08/1.5) earlier still. Tolerance covers only atempo's own error.
    assert.ok(Math.abs(atMs - expected) <= 20, `beep at ${atMs.toFixed(2)} ms, expected ${expected.toFixed(2)} ms`);
    console.log(`1.5x beep at ${atMs.toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("audio offset start: 1.5x asetrate (preserve_pitch=false) clip from in 0", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-ar-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetMedia(media, 6, BEEP_880);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.5 });
    commitSequenceMutation(wsDir, "test: preserve_pitch false", (seq) => {
      seq.spine.clips[0].playback.preserve_pitch = false;
    });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    const onset = findOnset(audio, 0);
    assert.ok(onset >= 0, "beep not found in rendered output");
    const atMs = (onset / SR) * 1000;
    const expected = 1000 / 1.5;
    assert.ok(Math.abs(atMs - expected) <= 1, `beep at ${atMs.toFixed(2)} ms, expected ${expected.toFixed(2)} ms`);
    console.log(`1.5x asetrate beep at ${atMs.toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("audio offset start: lane music cue on offset media plays source time", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-cue-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetMedia(media, 6, BEEP_880);
    const wsDir = buildProject(tmp, "proj", media);
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_music",
      kind: "music",
      explicitId: "cue_m",
      assetHandle: "vid_01",
      atMs: 0,
      durationMs: 3000,
    });
    commitSequenceMutation(wsDir, "test: mute spine", (seq) => {
      seq.spine.clips = [];
    });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    const onset = findOnset(audio, 0);
    assert.ok(onset >= 0, "beep not found in rendered output");
    const atMs = (onset / SR) * 1000;
    assert.ok(Math.abs(atMs - 1000) <= 1, `cue beep at ${atMs.toFixed(2)} ms, expected 1000 ms`);
    console.log(`cue beep at ${atMs.toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("audio offset start: speed-ramped clip on offset media follows the ramp integral", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-ramp-");
  try {
    // Beep at file time 0.1 s = source (container) 0.3 s: inside the first
    // ramp slice (source 0..0.48 s, the only slice the stream offset can
    // corrupt) and after the stream start (0.2 s); ramp 1.0 -> 3.0 over
    // source 0..3000 ms.
    const media = path.join(tmp, "off.mkv");
    offsetMedia(media, 10, "gte(t,0.1)*lt(t,0.2)*0.5*sin(2*PI*880*t)");
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    setSpineSpeed({
      workspaceDir: wsDir,
      clipId: "sp_01",
      speedRamp: [
        { source_offset_ms: 0, rate: 1.0 },
        { source_offset_ms: 3000, rate: 3.0 },
      ],
    });
    const { sequence } = loadSequence(wsDir);
    const expected = sourceMsToClipLocalMs(sequence.spine.clips[0], 300) / 1000;
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    const onset = findOnset(audio, 0);
    assert.ok(onset >= 0, "beep not found in rendered output");
    const atMs = (onset / SR) * 1000;
    // WSOLA ramp slices cannot hit +/-1 ms on an abrupt onset; one frame like the tick tests.
    assert.ok(Math.abs(atMs - expected * 1000) <= 1000 / 30, `ramp beep at ${atMs.toFixed(2)} ms, expected ${(expected * 1000).toFixed(2)} ms`);
    console.log(`ramp beep at ${atMs.toFixed(2)} ms, expected ${(expected * 1000).toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("audio offset start: >24-clip spine (input-seek branch) keeps first clip aligned", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-audio-offset-25-");
  try {
    // Ticks at container 0.5, 1.5, ... (file times 0.3, 1.3, ...).
    const media = path.join(tmp, "ticks.mkv");
    offsetMedia(media, 100, "if(lt(mod(t+0.7,1.0),0.1),0.5*sin(2*PI*660*t),0)");
    const wsDir = buildProject(tmp, "proj", media);
    for (let k = 0; k < 25; k++) {
      appendSpineClip({
        workspaceDir: wsDir,
        assetHandle: "vid_01",
        sourceInMs: k === 0 ? 0 : k * 4000,
        sourceOutMs: (k === 0 ? 0 : k * 4000) + 1000,
      });
    }
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanPcm(wsDir, outMedia);
    const audio = decodeAudioF32Mono(outMedia);
    // First clip (in 0): tick at output 0.5 s.
    const onset0 = findOnset(audio, 0);
    assert.ok(onset0 >= 0, "tick not found");
    assert.ok(Math.abs((onset0 / SR) * 1000 - 500) <= 1, `first tick at ${((onset0 / SR) * 1000).toFixed(2)} ms`);
    // A seek-branch clip (in 20000, -ss on input): tick at output 20.5 s.
    const onset20 = findOnset(audio, Math.floor(20 * SR));
    assert.ok(onset20 >= 0, "seek-branch tick not found");
    assert.ok(
      Math.abs((onset20 / SR) * 1000 - 20500) <= 1,
      `seek-branch tick at ${((onset20 / SR) * 1000).toFixed(2)} ms, expected 20500 ms`
    );
    console.log(`25-clip: first tick ${((onset0 / SR) * 1000).toFixed(2)} ms, seek tick ${((onset20 / SR) * 1000).toFixed(2)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
