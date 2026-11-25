/**
 * Release-candidate fixes: legacy normalize offset, stalled-encode progress,
 * post-render gap scan parity.
 *
 * 1. A voiceover cue normalized by an older build (target set, no
 *    normalize_gain_db) keeps a manual gain change across a new normalize:
 *    manual +5 dB survives, an untouched legacy chain keeps offset 0, and a
 *    second normalize is a no-op.
 * 2. Aborting a stalled encode stage never prints a completion line
 *    (`encode <total>/<total>`); the stage is dropped silently.
 * 3. The gap scan still flags an injected digital-silence gap (parity with
 *    the pre-change decoder) on a small synthetic project.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  progressAbort,
  progressBegin,
  progressSet,
  setProgressHook,
  CUTHOL_PROGRESS_PREFIX,
} from "../core/progress.js";
import { normalizeSequenceAudio } from "../mix/mix_normalize.js";
import { scanRenderedMp4AudioHealth } from "../render/render_audio_health.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

function decodeAudioS16Mono(file: string, sr = 48000): Int16Array {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:a", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", String(sr), "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "audio decode failed");
  const buf = proc.stdout as Buffer;
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function encodeS16MonoWav(samples: Int16Array, sr: number, outWav: string): void {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  const proc = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "s16le", "-ar", String(sr), "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_s16le", outWav],
    { input: buf, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "wav encode failed");
}

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function toneMedia(outPath: string, seconds: number, freq = 440): void {
  runFfmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:d=${seconds}`,
    "-t", String(seconds),
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
}

function setCueChainDirect(
  wsDir: string,
  cueId: string,
  patch: Record<string, unknown>
): void {
  const { sequence, paths } = loadSequence(wsDir);
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
  assert.ok(cue, `cue ${cueId} missing`);
  assert.ok(cue.audio_chain, "cue must have an audio chain");
  const chain = cue.audio_chain as unknown as Record<string, unknown>;
  Object.assign(chain, patch);
  if (patch.normalize_gain_db === undefined) {
    delete chain.normalize_gain_db;
  }
  sequence.meta.revision += 1;
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");
}

function readCueChain(wsDir: string, cueId: string): { gain_db: number; normalize_gain_db?: number; loudness_target_lufs: number | null } {
  const { sequence } = loadSequence(wsDir);
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
  assert.ok(cue?.audio_chain, "cue chain missing");
  return {
    gain_db: cue.audio_chain!.gain_db,
    normalize_gain_db: cue.audio_chain!.normalize_gain_db ?? undefined,
    loudness_target_lufs: cue.audio_chain!.loudness_target_lufs,
  };
}

function mountVoiceCue(wsDir: string, assetHandle: string): string {
  const res = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_vo",
    kind: "voiceover",
    assetHandle,
    atMs: 0,
    durationMs: 4000,
    sourceInMs: 0,
    sourceOutMs: 4000,
  });
  return res.cue.id;
}

test("legacy normalize chain keeps a manual +5 dB offset; untouched stays 0; rerun stable", () => {
  const tmp = makeTempRoot("cuthol-norm-legacy-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "legacy norm", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "tone.mkv");
    toneMedia(media, 4);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    const cueId = mountVoiceCue(wsDir, "vid_01");

    normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14, truePeakDbtp: -1 });
    const afterFirst = readCueChain(wsDir, cueId);
    assert.ok(afterFirst.normalize_gain_db !== undefined, "new build records normalize_gain_db");
    const baseNorm = afterFirst.normalize_gain_db as number;

    // Simulate an older build: target set, no per-run normalize record.
    setCueChainDirect(wsDir, cueId, { gain_db: baseNorm + 5, normalize_gain_db: undefined });
    normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14, truePeakDbtp: -1 });
    const changed = readCueChain(wsDir, cueId);
    assert.ok(changed.normalize_gain_db !== undefined, "normalize share must be recorded");
    assert.ok(
      Math.abs(changed.gain_db - (changed.normalize_gain_db as number) - 5) < 0.15,
      `manual +5 dB must survive, got gain ${changed.gain_db} vs N=${changed.normalize_gain_db}`
    );

    // Untouched legacy project: gain equals the old normalize output.
    setCueChainDirect(wsDir, cueId, {
      gain_db: changed.normalize_gain_db as number,
      normalize_gain_db: undefined,
    });
    normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14, truePeakDbtp: -1 });
    const untouched = readCueChain(wsDir, cueId);
    assert.ok(
      Math.abs(untouched.gain_db - (untouched.normalize_gain_db as number)) < 0.05,
      `untouched legacy offset must be 0, got gain ${untouched.gain_db} vs N=${untouched.normalize_gain_db}`
    );
    const gainBefore = untouched.gain_db;
    normalizeSequenceAudio({ workspaceDir: wsDir, targetLufs: -14, truePeakDbtp: -1 });
    const rerunGain = readCueChain(wsDir, cueId).gain_db;
    assert.ok(
      Math.abs(rerunGain - gainBefore) < 0.05,
      `second normalize must not move the gain, was ${gainBefore}, now ${rerunGain}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("aborting a stalled encode stage prints no completion line", () => {
  const lines: string[] = [];
  const origWrite = fs.writeSync;
  const events: string[] = [];
  setProgressHook((ev) => {
    events.push(`${ev.type}:${ev.name}:${ev.done}/${ev.total}`);
  });
  (fs as unknown as Record<string, unknown>).writeSync = function patched(fd: unknown, data: unknown, ...rest: unknown[]): number {
    if (fd === 2 && typeof data === "string" && data.startsWith(CUTHOL_PROGRESS_PREFIX)) {
      lines.push(data);
    }
    return (origWrite as (...a: unknown[]) => number)(fd, data, ...rest);
  };
  try {
    progressBegin("encode", 930, { mode: "ffmpeg-frames" });
    progressSet(537);
    progressAbort("encode");
    const completions = lines.filter((l) => /^cuthol:progress encode 930\/930/.test(l));
    assert.equal(completions.length, 0, `stalled encode must not claim completion, got: ${completions.join(" | ")}`);
    assert.ok(
      events.some((e) => e.startsWith("stop:encode")),
      `abort must report stop, got: ${events.join(" | ")}`
    );
    assert.ok(
      !events.some((e) => e.startsWith("finish:encode")),
      `abort must not report finish, got: ${events.join(" | ")}`
    );
  } finally {
    (fs as unknown as Record<string, unknown>).writeSync = origWrite;
    setProgressHook(null);
  }
});

test("gap scan flags injected digital silence (parity after seek change)", { timeout: 300_000 }, async () => {
  const tmp = makeTempRoot("cuthol-gap-scan-");
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "gap parity", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "tone.mkv");
    toneMedia(media, 4);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
    const cleanMp4 = path.join(wsDir, "output", "clean.mp4");
    const clean = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: cleanMp4, preset: "draft_480p" });
    assert.equal(clean.ok, true);

    const sr = 48000;
    const pcm = decodeAudioS16Mono(cleanMp4, sr);
    const gapStart = 2 * sr;
    for (let i = gapStart; i < gapStart + Math.floor(0.01 * sr); i++) pcm[i] = 0;
    const doctoredWav = path.join(tmp, "doctored.wav");
    encodeS16MonoWav(pcm, sr, doctoredWav);
    const doctoredMp4 = path.join(tmp, "doctored.mp4");
    runFfmpeg(["-i", cleanMp4, "-i", doctoredWav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", doctoredMp4]);

    const { sequence, paths } = loadSequence(wsDir);
    const res = scanRenderedMp4AudioHealth(doctoredMp4, sequence, paths);
    const gapIssues = res.issues.filter((iss) => /gap|silence|drop-out/i.test(iss.detail));
    assert.ok(gapIssues.length > 0, `injected 10 ms silence must raise a gap issue, got ${JSON.stringify(res.issues).slice(0, 500)}`);

    const cleanRes = scanRenderedMp4AudioHealth(cleanMp4, sequence, paths);
    const cleanGaps = cleanRes.issues.filter((iss) => /gap|silence|drop-out/i.test(iss.detail));
    assert.equal(cleanGaps.length, 0, `clean render must have no gap issues, got ${JSON.stringify(cleanGaps).slice(0, 500)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
