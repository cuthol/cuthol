/**
 * polish-voice must not delay the voice.
 *
 * The `afftdn` denoise filter has a fixed 25 ms latency (1200 samples at
 * 48 kHz, 1102 at 44.1 kHz, measured with a chirp probe). The compiled chain
 * drops that span as a time (`atrim=start=0.025`) right after `afftdn` — no
 * stage before the filter fixes the sample rate, so a sample-count trim
 * would be wrong off 48 kHz — so a polished clip stays aligned with the
 * picture: cross-correlation of the rendered audio against the source must
 * report an offset below 1 ms, and the post-render health check must not
 * raise CUTHOL-G508 for it.
 * On the old build this test fails with a measured offset of +25.0 ms.
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
import { polishVoiceAudio } from "../mix/audio_mix.js";
import { scanRenderedMp4AudioHealth } from "../render/render_audio_health.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip } from "../sequence/spine.js";

function runFfmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`.slice(0, 2000));
}

function noiseMedia(outPath: string, seconds: number, audioRate = 48000): void {
  runFfmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:d=${seconds}`,
    "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=white:r=${audioRate}:a=0.3`,
    "-t", String(seconds),
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", String(audioRate), "-ac", "1",
    outPath,
  ]);
}

function decodeMono48k(file: string): Float32Array {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:a", "-f", "f32le", "-ar", "48000", "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, "audio decode failed");
  const buf = proc.stdout as Buffer;
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Lag in samples of `render` vs `ref` over a 1 s window starting at 1 s. */
function measureOffsetSamples(ref: Float32Array, render: Float32Array, sr: number): { lag: number; similarity: number } {
  const s0 = sr;
  const len = sr;
  const score = (lag: number): number => {
    let v = 0;
    let ss = 0;
    let rr = 0;
    for (let i = 0; i < len; i++) {
      const j = s0 + i + lag;
      if (j < 0 || j >= render.length) continue;
      const x = ref[s0 + i];
      const y = render[j];
      v += x * y;
      ss += x * x;
      rr += y * y;
    }
    return v / Math.sqrt(ss * rr + 1e-12);
  };
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = -sr; lag <= sr; lag += 16) {
    const v = score(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  let fineLag = bestLag;
  let fineBest = -Infinity;
  for (let lag = bestLag - 16; lag <= bestLag + 16; lag++) {
    const v = score(lag);
    if (v > fineBest) {
      fineBest = v;
      fineLag = lag;
    }
  }
  return { lag: fineLag, similarity: fineBest };
}

test("polish-voice keeps rendered audio aligned with the source (< 1 ms, no G508)", { timeout: 300_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-polish-align-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "polish align", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "noise.mkv");
    noiseMedia(media, 3);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    const sourcePcm = decodeMono48k(media);

    const plainMp4 = path.join(tmp, "plain.mp4");
    const plain = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: plainMp4, preset: "draft_480p" });
    assert.equal(plain.ok, true);
    const plainOff = measureOffsetSamples(sourcePcm, decodeMono48k(plainMp4), 48000);
    assert.ok(Math.abs(plainOff.lag) <= 48, `plain render should be aligned, got lag ${plainOff.lag}`);

    const polished = polishVoiceAudio({ workspaceDir: wsDir });
    assert.ok(polished.polished_clips.length > 0, "expected polish-voice to polish the clip");
    const polishedMp4 = path.join(tmp, "polished.mp4");
    const rendered = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: polishedMp4, preset: "draft_480p" });
    assert.equal(rendered.ok, true);
    const off = measureOffsetSamples(sourcePcm, decodeMono48k(polishedMp4), 48000);
    const offsetMs = (off.lag / 48000) * 1000;
    assert.ok(
      Math.abs(off.lag) <= 48,
      `polished voice delayed by ${offsetMs.toFixed(2)} ms (lag ${off.lag} samples, similarity ${off.similarity.toFixed(4)})`
    );

    const { sequence, paths } = loadSequence(wsDir);
    const health = scanRenderedMp4AudioHealth(polishedMp4, sequence, paths);
    const alignIssues = health.issues.filter((iss) => iss.item_id === "sp_01");
    assert.deepEqual(
      alignIssues,
      [],
      `expected no alignment issue for the polished clip, got: ${JSON.stringify(alignIssues)}`
    );
    assert.ok(
      !health.diagnostics.some((d) => d.code === "CUTHOL-G508"),
      `expected no CUTHOL-G508 after polish-voice, got: ${JSON.stringify(health.diagnostics)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("polish-voice keeps a 44.1 kHz source aligned (< 1 ms, no G508)", { timeout: 300_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-polish-align44-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "polish align 44k", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "noise44.mkv");
    noiseMedia(media, 3, 44100);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
    const sourcePcm = decodeMono48k(media);

    const polished = polishVoiceAudio({ workspaceDir: wsDir });
    assert.ok(polished.polished_clips.length > 0, "expected polish-voice to polish the clip");
    const polishedMp4 = path.join(tmp, "polished44.mp4");
    const rendered = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: polishedMp4, preset: "draft_480p" });
    assert.equal(rendered.ok, true);
    const off = measureOffsetSamples(sourcePcm, decodeMono48k(polishedMp4), 48000);
    const offsetMs = (off.lag / 48000) * 1000;
    assert.ok(
      Math.abs(off.lag) <= 48,
      `44.1 kHz polished voice delayed by ${offsetMs.toFixed(2)} ms (lag ${off.lag} samples, similarity ${off.similarity.toFixed(4)})`
    );

    const { sequence, paths } = loadSequence(wsDir);
    const health = scanRenderedMp4AudioHealth(polishedMp4, sequence, paths);
    assert.ok(
      !health.diagnostics.some((d) => d.code === "CUTHOL-G508"),
      `expected no CUTHOL-G508 for the 44.1 kHz polish, got: ${JSON.stringify(health.diagnostics)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
