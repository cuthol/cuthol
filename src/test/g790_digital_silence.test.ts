/**
 * CUTHOL-G790: digital silence in the rendered mix where a source has signal
 * fails the render (ok:false, non-zero exit via CutholError); the output file
 * is kept for inspection. Drift and low-similarity findings stay WARN (G508).
 *
 * - Injected digital silence over a loud source classifies as G790 ERROR.
 * - A fully attenuated cue (-96 dB) fails the render end-to-end with G790.
 * - Muted cues, -40 dB cues, full-length fades and polish-voice must not
 *   produce the digital-silence kind (zero G790).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { CutholError } from "../core/diagnostics.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { polishVoiceAudio } from "../mix/audio_mix.js";
import { scanRenderedMp4AudioHealth } from "../render/render_audio_health.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip } from "../sequence/spine.js";

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

function hasCode(diagnostics: Array<{ code: string }>, code: string): boolean {
  return diagnostics.some((d) => d.code === code);
}

function initToneProject(tmp: string, seconds: number): string {
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "g790", aspect: "16:9", fps: 30 });
  const media = path.join(tmp, "tone.mkv");
  toneMedia(media, seconds);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  appendSpineClip({
    workspaceDir: wsDir,
    assetHandle: "vid_01",
    sourceInMs: 0,
    sourceOutMs: seconds * 1000,
  });
  return wsDir;
}

test("injected 500 ms digital silence over a loud source is G790 ERROR", { timeout: 300_000 }, () => {
  const tmp = makeTempRoot("cuthol-g790-injected-");
  try {
    const wsDir = initToneProject(tmp, 4);
    const cleanMp4 = path.join(wsDir, "output", "clean.mp4");
    const clean = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: cleanMp4, preset: "draft_480p" });
    assert.equal(clean.ok, true);
    const { sequence, paths } = loadSequence(wsDir);
    const cleanHealth = scanRenderedMp4AudioHealth(cleanMp4, sequence, paths);
    assert.ok(!hasCode(cleanHealth.diagnostics, "CUTHOL-G790"), "clean render must not raise G790");

    // Silence 2.0..2.5 s (source is a loud tone there).
    const proc = spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", cleanMp4, "-map", "0:a", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "1", "-"],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
    );
    assert.equal(proc.status, 0);
    const buf = Buffer.from(proc.stdout as Buffer);
    const n = Math.floor(buf.length / 2);
    for (let i = 2 * 48000; i < Math.min(n, Math.floor(2.5 * 48000)); i++) buf.writeInt16LE(0, i * 2);
    const wavPath = path.join(tmp, "doctored.wav");
    const enc = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_s16le", wavPath],
      { input: buf, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }
    );
    assert.equal(enc.status, 0);
    const doctoredMp4 = path.join(tmp, "doctored.mp4");
    runFfmpeg(["-i", cleanMp4, "-i", wavPath, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", doctoredMp4]);

    const res = scanRenderedMp4AudioHealth(doctoredMp4, sequence, paths);
    const g790 = res.diagnostics.filter((d) => d.code === "CUTHOL-G790");
    assert.equal(g790.length, 1, `expected one G790, got: ${JSON.stringify(res.diagnostics.map((d) => d.code))}`);
    assert.equal(g790[0].severity, "ERROR");
    assert.match(g790[0].what, /digital silence/);
    assert.match(g790[0].what, /kept at/);
    assert.match(g790[0].what, /doctored\.mp4/);
    assert.match(g790[0].suggestion ?? "", /cuthol explain G790/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("render with a fully attenuated cue (-96 dB) fails with G790 and keeps the output", { timeout: 300_000 }, () => {
  const tmp = makeTempRoot("cuthol-g790-attenuated-");
  try {
    const wsDir = initToneProject(tmp, 4);
    commitSequenceMutation(wsDir, "test: attenuate cue", (seq) => {
      seq.spine.clips[0].audio_chain.gain_db = -96;
    });
    const outMp4 = path.join(wsDir, "output", "silent.mp4");
    assert.throws(
      () => renderSequenceToMp4({ workspaceDir: wsDir, outputPath: outMp4, preset: "draft_480p" }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError, `expected CutholError, got ${err}`);
        assert.equal(err.diagnostic.code, "CUTHOL-G790");
        assert.equal(err.diagnostic.severity, "ERROR");
        assert.match(err.diagnostic.what, /kept at/);
        return true;
      },
      "expected the render to fail with CUTHOL-G790"
    );
    assert.ok(fs.existsSync(outMp4), "G790 output file must be kept for inspection");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("muted cue, -40 dB cue, full-length fades and polish-voice produce zero G790", { timeout: 300_000 }, () => {
  const tmp = makeTempRoot("cuthol-g790-counter-");
  try {
    // Muted cue.
    {
      const wsDir = initToneProject(path.join(tmp, "m1"), 4);
      commitSequenceMutation(wsDir, "test: mute cue", (seq) => {
        seq.spine.clips[0].audio_chain.muted = true;
      });
      const out = path.join(wsDir, "output", "muted.mp4");
      const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
      assert.equal(res.ok, true);
      assert.ok(!hasCode(res.audio_health?.diagnostics ?? [], "CUTHOL-G790"), "muted cue must not raise G790");
    }
    // -40 dB cue over an audible bed (the mix stays loud; the quiet cue is masked,
    // never digital silence). NOTE: a solo -40 dB tone measures ~-61 dB RMS after
    // AAC and does trip G790; the counter-case here is the mixed context.
    {
      const wsDir = path.join(tmp, "m2", "proj");
      initWorkspace({ dir: wsDir, title: "g790 bed", aspect: "16:9", fps: 30 });
      const bed = path.join(tmp, "m2", "bed.mkv");
      toneMedia(bed, 4, 220);
      const voice = path.join(tmp, "m2", "voice.mkv");
      toneMedia(voice, 4, 440);
      const mixed = path.join(tmp, "m2", "mixed.mkv");
      runFfmpeg([
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=4",
        "-i", bed,
        "-i", voice,
        "-filter_complex", "[1:a]volume=1.0[b];[2:a]volume=-40dB[v];[b][v]amix=inputs=2:duration=first:dropout_transition=0[m]",
        "-map", "0:v", "-map", "[m]",
        "-t", "4",
        "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
        "-c:a", "pcm_s16le",
        mixed,
      ]);
      ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mixed] });
      appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 4000 });
      const out = path.join(wsDir, "output", "bed.mp4");
      const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
      assert.equal(res.ok, true, JSON.stringify(res.verification?.diagnostics));
      assert.ok(!hasCode(res.audio_health?.diagnostics ?? [], "CUTHOL-G790"), "-40 dB cue over a bed must not raise G790");
    }
    // Fade in + out over the whole cue.
    {
      const wsDir = initToneProject(path.join(tmp, "m3"), 4);
      commitSequenceMutation(wsDir, "test: full fade", (seq) => {
        seq.spine.clips[0].audio_chain.fade_in_ms = 4000;
        seq.spine.clips[0].audio_chain.fade_out_ms = 4000;
      });
      const out = path.join(wsDir, "output", "faded.mp4");
      const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
      assert.equal(res.ok, true, JSON.stringify(res.verification?.diagnostics));
      assert.ok(!hasCode(res.audio_health?.diagnostics ?? [], "CUTHOL-G790"), "full-length fades must not raise G790");
    }
    // polish-voice mix (the denoise filter adds a small delay).
    {
      const wsDir = path.join(tmp, "m4", "proj");
      initWorkspace({ dir: wsDir, title: "g790 polish", aspect: "16:9", fps: 30 });
      const media = path.join(tmp, "m4", "noise.mkv");
      runFfmpeg([
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:d=3",
        "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:r=48000:a=0.3",
        "-t", "3",
        "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
        media,
      ]);
      ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
      appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
      const polished = polishVoiceAudio({ workspaceDir: wsDir });
      assert.ok(polished.polished_clips.length > 0);
      const out = path.join(wsDir, "output", "polished.mp4");
      const res = renderSequenceToMp4({ workspaceDir: wsDir, outputPath: out, preset: "draft_480p" });
      assert.equal(res.ok, true, JSON.stringify(res.verification?.diagnostics));
      assert.ok(!hasCode(res.audio_health?.diagnostics ?? [], "CUTHOL-G790"), "polish-voice must not raise G790");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
