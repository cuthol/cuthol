/**
 * Video follows the container clock when the video stream starts after the
 * file start (mirror of `audio_offset_start.test.ts` for the picture).
 *
 * A file whose video stream starts late (built here with `-itsoffset 0.3` on
 * the video input, like a phone recording that starts video late) must still
 * satisfy: output time t of a clip/cue shows source (container) time
 * `srcIn + t·rate`. The old `trim + setpts=PTS-STARTPTS` chain rebased to the
 * first available frame, moving the whole clip early by the stream offset.
 * The fixed chain holds the first available frame over the leading gap
 * (split + looped first frame + concat) and keeps the exact old mapping after
 * it; clips without a gap compile byte-identical to before.
 *
 * Media is generated in a temp dir: solid-colour 0.2 s segments (6 frames at
 * 30 fps, cycling red/green/blue/yellow/magenta/cyan) with the video stream
 * starting 0.3 s after the audio. Position is asserted on decoded RGB (mean
 * colour of the frame centre), never by comparing two extractions. A 0.3 s
 * shift is 1.5 segments, so old (shifted) output always lands in a different
 * segment.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import {
  detachAudioFromLibraryAsset,
  ingestAssetsIntoWorkspace,
} from "../library/probe.js";
import { extractMono16kPcm } from "../library/waveform.js";
import { renderSingleCompositeFrameRgb24 } from "../render/renderer.js";
import { renderSequenceToMp4 } from "../render/render_main.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip, setSpineSpeed } from "../sequence/spine.js";
import {
  integrateSourceOffsetToClipLocalMs,
  invertClipLocalMsToSourceOffset,
} from "../sequence/spine_time.js";

const SEG_S = 0.2;

const OFFSET_S = 0.3;
const PALETTE: Array<[number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
];
const SEG_COUNT = 30;

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

/** Solid-colour video (segments of SEG_S cycling the palette) with the video stream starting 0.3 s after the audio. */
function offsetVideoMedia(outPath: string): void {
  const dir = path.dirname(outPath);
  const segInputs: string[] = [];
  for (let i = 0; i < SEG_COUNT; i++) {
    const [r, g, b] = PALETTE[i % PALETTE.length];
    segInputs.push(
      "-f", "lavfi", "-i",
      `color=c=0x${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}:s=320x180:r=30:d=${SEG_S}`
    );
  }
  const tmpV = path.join(dir, "segs.mkv");
  const filter = Array.from({ length: SEG_COUNT }, (_, i) => `[${i}:v]`).join("") + `concat=n=${SEG_COUNT}:v=1:a=0`;
  runFfmpeg([...segInputs, "-filter_complex", filter, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", tmpV]);
  runFfmpeg([
    "-itsoffset", String(OFFSET_S), "-i", tmpV,
    "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${SEG_COUNT * SEG_S + OFFSET_S + 0.5}`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "pcm_s16le",
    "-shortest", outPath,
  ]);
  fs.rmSync(tmpV, { force: true });
  const aStart = probeStartTime(outPath, "a");
  const vStart = probeStartTime(outPath, "v");
  assert.ok(
    vStart - aStart > 0.25 && vStart - aStart < 0.35,
    `video must start ~0.3 s after audio, got a=${aStart} v=${vStart}`
  );
}

function segIndexAt(fileSec: number): number {
  // +1ms epsilon: exact segment boundaries belong to the segment they open.
  return Math.floor((fileSec + 0.001) / SEG_S) % PALETTE.length;
}

function decodeFrameRgb24(file: string, atSec: number): { data: Buffer; width: number; height: number } {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(atSec), "-i", file, "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 280_000, windowsHide: true }
  );
  assert.equal(proc.status, 0, "frame decode failed");
  return { data: proc.stdout as Buffer, width: 854, height: 480 };
}

function meanCenterColor(frame: { data: Buffer; width: number; height: number }): [number, number, number] {
  const { data, width, height } = frame;
  const x0 = Math.floor(width / 2) - 50;
  const y0 = Math.floor(height / 2) - 50;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y0 + 100; y++) {
    for (let x = x0; x < x0 + 100; x++) {
      const o = (y * width + x) * 3;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

function nearestPalette(color: [number, number, number]): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const d =
      Math.abs(color[0] - PALETTE[i][0]) +
      Math.abs(color[1] - PALETTE[i][1]) +
      Math.abs(color[2] - PALETTE[i][2]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  assert.ok(bestDist < 200, `frame colour [${color.map((c) => c.toFixed(0)).join(",")}] matches no palette entry`);
  return best;
}

function renderPlanMp4(wsDir: string, outMedia: string): void {
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
  runFfmpeg([
    ...plan.inputArgs,
    "-filter_complex", plan.filterComplex,
    "-map", plan.videoOutPad, "-map", plan.audioOutPad,
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    outMedia,
  ]);
}

function buildProject(tmp: string, name: string, media: string): string {
  const wsDir = path.join(tmp, name);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  return wsDir;
}

function assertOutputShowsContainer(outMedia: string, atSec: number, containerSec: number, label: string): void {
  const got = nearestPalette(meanCenterColor(decodeFrameRgb24(outMedia, atSec)));
  // The video stream starts OFFSET_S after the container start, so container
  // time c shows the file frame at c - OFFSET_S (segment 0 is held where the
  // container has no video yet). The old build shows segIndexAt(c) instead.
  const want = containerSec < OFFSET_S ? 0 : segIndexAt(containerSec - OFFSET_S);
  assert.equal(got, want, `${label}: output ${atSec}s shows segment ${got}, expected ${want} (container ${containerSec}s)`);
  console.log(`${label}: output ${atSec}s -> segment ${got} (container ${containerSec}s)`);
}

test("video offset start: clip at in 0 holds the first frame over the gap", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-0-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
    assert.ok(plan.filterComplex.includes("vgap_"), "gap clip must take the hold branch");
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanMp4(wsDir, outMedia);
    assertOutputShowsContainer(outMedia, 0.1, 0.1, "in0");
    assertOutputShowsContainer(outMedia, 0.5, 0.5, "in0");
    assertOutputShowsContainer(outMedia, 1.0, 1.0, "in0");
    assertOutputShowsContainer(outMedia, 2.0, 2.0, "in0");
  } finally {
    rmRetrySync(tmp);
  }
});

test("video offset start: clip at in 0.2 (partial gap) and in 1.0 (no gap, unchanged chain)", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-partial-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 200, sourceOutMs: 3200 });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanMp4(wsDir, outMedia);
    assertOutputShowsContainer(outMedia, 0.05, 0.2, "in0.2 held");
    assertOutputShowsContainer(outMedia, 0.5, 0.7, "in0.2");
    const wsDir2 = buildProject(tmp, "proj2", media);
    appendSpineClip({ workspaceDir: wsDir2, assetHandle: "vid_01", sourceInMs: 1000, sourceOutMs: 4000 });
    const seq2 = loadSequence(wsDir2);
    const plan2 = compileSequenceRenderPlan(seq2.sequence, seq2.paths, "draft_480p", {});
    assert.ok(!plan2.filterComplex.includes("vgap_"), "no-gap clip must keep the old chain");
    const outMedia2 = path.join(tmp, "out2.mkv");
    renderPlanMp4(wsDir2, outMedia2);
    assertOutputShowsContainer(outMedia2, 0.5, 1.5, "in1.0");
  } finally {
    rmRetrySync(tmp);
  }
});

test("video offset start: 1.5x speed clip from in 0 maps source time / rate", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-15-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", rate: 1.5 });
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanMp4(wsDir, outMedia);
    assertOutputShowsContainer(outMedia, 0.1, 0.1, "1.5x held");
    assertOutputShowsContainer(outMedia, 1.0, 1.5, "1.5x");
  } finally {
    rmRetrySync(tmp);
  }
});

test("video offset start: speed-ramped clip from in 0 follows the ramp integral", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-ramp-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const ramp = [
      { source_offset_ms: 0, rate: 1 },
      { source_offset_ms: 4000, rate: 3 },
    ];
    setSpineSpeed({ workspaceDir: wsDir, clipId: "sp_01", speedRamp: ramp });
    const { sequence } = loadSequence(wsDir);
    const clip = sequence.spine.clips[0];
    const holdOutMs = integrateSourceOffsetToClipLocalMs(clip, OFFSET_S * 1000);
    assert.ok(holdOutMs > 1 && holdOutMs < 1000, `held prefix must be sane, got ${holdOutMs} ms`);
    // Sample where the expected file position is mid-segment (margin from
    // boundaries), so fps quantization cannot flip the asserted segment.
    let sampleT = -1;
    let sampleContainer = -1;
    for (let k = 36; k <= 63; k++) {
      const t = k / 30;
      const c = invertClipLocalMsToSourceOffset(clip, t * 1000) / 1000;
      const frac = ((c - OFFSET_S) / SEG_S) % 1;
      if (frac > 0.35 && frac < 0.65) {
        sampleT = t;
        sampleContainer = c;
        break;
      }
    }
    assert.ok(sampleT > 0, "no mid-segment sample instant found");
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanMp4(wsDir, outMedia);
    assertOutputShowsContainer(outMedia, 0.1, 0.1, "ramp held");
    assertOutputShowsContainer(outMedia, sampleT, sampleContainer, "ramp");
    console.log(`ramp: hold ${holdOutMs.toFixed(1)} ms, output ${sampleT.toFixed(3)}s shows container ${sampleContainer.toFixed(3)}s`);
  } finally {
    rmRetrySync(tmp);
  }
});

test("video offset start: broll lane cue at in 0 shows container time", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-cue-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 2000, sourceOutMs: 5000 });
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_broll",
      kind: "broll",
      explicitId: "cue_b",
      assetHandle: "vid_01",
      atMs: 0,
      durationMs: 1500,
      sourceInMs: 0,
    });
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
    assert.ok(plan.filterComplex.includes("vgap_"), "gap cue must take the hold branch");
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanMp4(wsDir, outMedia);
    assertOutputShowsContainer(outMedia, 0.1, 0.1, "cue held");
    assertOutputShowsContainer(outMedia, 0.5, 0.5, "cue");
    assertOutputShowsContainer(outMedia, 1.0, 1.0, "cue");
  } finally {
    rmRetrySync(tmp);
  }
});

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function rgbMeanOfSingleFrame(wsDir: string, atMs: number): [number, number, number] {
  const { sequence, paths } = loadSequence(wsDir);
  const { rgbBuf, width, height } = renderSingleCompositeFrameRgb24(sequence, paths, atMs, "draft_480p", {});
  const x0 = Math.floor(width / 2) - 50;
  const y0 = Math.floor(height / 2) - 50;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y0 + 100; y++) {
    for (let x = x0; x < x0 + 100; x++) {
      const o = (y * width + x) * 3;
      r += rgbBuf[o];
      g += rgbBuf[o + 1];
      b += rgbBuf[o + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

test("video offset start: 25-clip spine (input-seek branch) aligns the first clip", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-seek-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    for (let i = 0; i < 25; i++) {
      appendSpineClip({
        workspaceDir: wsDir,
        assetHandle: "vid_01",
        sourceInMs: i * 200,
        sourceOutMs: i * 200 + 1000,
      });
    }
    const { sequence, paths } = loadSequence(wsDir);
    assert.ok(sequence.spine.clips.length > 24, "seek branch needs > 24 clips");
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {});
    assert.ok(plan.filterComplex.includes("vgap_"), "first clip must take the hold branch");
    assert.ok(plan.inputArgs.includes("-ss"), "seek branch must use input -ss");
    const outMedia = path.join(tmp, "out.mkv");
    renderPlanMp4(wsDir, outMedia);
    assertOutputShowsContainer(outMedia, 0.5, 0.5, "seek first clip");
    assertOutputShowsContainer(outMedia, 5.5, 1.5, "seek later clip");
  } finally {
    rmRetrySync(tmp);
  }
});

test("video offset start: monitor frame and segmented render match the plain render", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-monseg-");
  try {
    const media = path.join(tmp, "off.mkv");
    offsetVideoMedia(media);
    const wsDir = buildProject(tmp, "proj", media);
    for (let i = 0; i < 3; i++) {
      appendSpineClip({
        workspaceDir: wsDir,
        assetHandle: "vid_01",
        sourceInMs: i * 100,
        sourceOutMs: i * 100 + 2000,
      });
    }
    for (const atMs of [100, 500, 1000]) {
      const got = nearestPalette(rgbMeanOfSingleFrame(wsDir, atMs));
      const timelineSec = atMs / 1000;
      const clipIdx = Math.min(2, Math.floor(timelineSec / 2));
      const containerSec = clipIdx * 0.1 + timelineSec - clipIdx * 2;
      const want = containerSec < OFFSET_S ? 0 : segIndexAt(containerSec - OFFSET_S);
      assert.equal(got, want, `monitor frame at ${atMs}ms shows segment ${got}, expected ${want}`);
      console.log(`monitor ${atMs}ms -> segment ${got}`);
    }
    const plain = withEnv({ CUTHOL_RENDER_SEGMENT_MAX_CLIPS: "24" }, () =>
      renderSequenceToMp4({ workspaceDir: wsDir, preset: "draft_480p", encoder: "libx264", outputPath: "output/plain.mp4" })
    );
    const seg = withEnv({ CUTHOL_RENDER_SEGMENT_MAX_CLIPS: "1" }, () =>
      renderSequenceToMp4({ workspaceDir: wsDir, preset: "draft_480p", encoder: "libx264", outputPath: "output/seg.mp4" })
    );
    for (const atSec of [0.1, 0.5, 1.0, 2.0, 4.0]) {
      const a = nearestPalette(meanCenterColor(decodeFrameRgb24(plain.output_path, atSec)));
      const b = nearestPalette(meanCenterColor(decodeFrameRgb24(seg.output_path, atSec)));
      assert.equal(a, b, `segmented render differs at ${atSec}s: ${a} vs ${b}`);
    }
    console.log("segmented render matches the plain render on all sampled instants");
  } finally {
    rmRetrySync(tmp);
  }
});

test("video offset start: detach-audio pads the leading gap to container time", { timeout: 290_000 }, async () => {
  const tmp = makeTempRoot("cuthol-video-offset-detach-");
  try {
    const talkSrc = path.resolve("test-workspace/fixtures/trial-media/talk.mp4");
    const wsDir = buildProject(tmp, "proj", talkSrc);
    const { paths } = loadSequence(wsDir);
    const detached = detachAudioFromLibraryAsset({ workspaceDir: wsDir, sourceHandle: "vid_01" });
    const wavPath = path.join(paths.blobsDir, path.basename(detached.uri));
    assert.ok(fs.existsSync(wavPath), `detached wav must exist at ${detached.uri}`);
    const padded = extractMono16kPcm(talkSrc);
    const wavProc = spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", wavPath, "-map", "0:a", "-ac", "1", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, timeout: 280_000, windowsHide: true }
    );
    assert.equal(wavProc.status, 0, "detached wav decode failed");
    const rawWav = wavProc.stdout as Buffer;
    const alignedWav = new Uint8Array(rawWav.length);
    rawWav.copy(alignedWav);
    const got = new Int16Array(alignedWav.buffer);
    assert.ok(
      Math.abs(got.length - padded.length) <= 2,
      `detached length ${got.length} must match padded extraction ${padded.length}`
    );
    const gapSamples = Math.floor(0.176 * 16000);
    let peak = 0;
    for (let i = 0; i < gapSamples; i++) peak = Math.max(peak, Math.abs(got[i]));
    assert.ok(peak < 500, `first 176 ms must be silent, peak ${peak}`);
    let bestLag = 0;
    let bestCorr = -Infinity;
    for (let lag = -48; lag <= 48; lag++) {
      let corr = 0;
      const n = Math.min(16000, got.length, padded.length);
      for (let i = 0; i < n; i++) {
        const j = i + lag;
        if (j < 0 || j >= got.length) continue;
        corr += padded[i] * got[j];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    assert.equal(bestLag, 0, `cross-correlation lag must be 0, got ${bestLag}`);
    console.log(`detach: len ${got.length} vs padded ${padded.length}, head peak ${peak}, lag ${bestLag}`);
  } finally {
    rmRetrySync(tmp);
  }
});
