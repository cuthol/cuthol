/**
 * Sequence tempo through the real render: every output frame must show the
 * sequence frame nearest to its instant, whether the render runs as one graph or
 * as several segments, the frame count must be exact, the audio must stay on the
 * output clock, and the post-render audio check must pass (and must fail on a file
 * that was not retimed).
 *
 * The source carries its own frame index as 10 binary bars across the width, so
 * the frame shown can be read back from the delivered file.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tempoOutputSegments } from "../sequence/tempo.js";
import { loadSequence } from "../core/workspace.js";
import { scanRenderedMp4AudioHealth } from "../render/render_audio_health.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const FPS = 30;
const TEMPO = 1.1;

function cli(args: string[], env: Record<string, string> = {}): string {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", ...env },
    timeout: 300_000,
  });
  assert.equal(proc.status, 0, `cuthol ${args.join(" ")} failed:\n${proc.stdout}\n${proc.stderr}`);
  return proc.stdout;
}

/** Sequence frame index shown by each frame of a delivered file. */
function readFrameIndices(mp4: string): number[] {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", mp4, "-vf", "crop=iw:ih/4:0:ih*3/8,scale=10:1:flags=area,format=gray", "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 28 }
  );
  const out: number[] = [];
  for (let k = 0; k < raw.length / 10; k++) {
    let v = 0;
    for (let b = 0; b < 10; b++) if (raw[k * 10 + b] > 128) v |= 1 << b;
    out.push(v);
  }
  return out;
}

/** Onsets (s) of the 1 kHz beeps. */
function beepOnsets(mp4: string): number[] {
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const a = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const onsets: number[] = [];
  let inBeep = false;
  let quiet = 0;
  for (let i = 0; i < a.length; i++) {
    const loud = Math.abs(a[i]) > 0.04;
    if (loud && !inBeep) {
      onsets.push(i / 8000);
      inBeep = true;
      quiet = 0;
    }
    if (!loud && inBeep) {
      quiet++;
      if (quiet > 80) inBeep = false;
    } else if (loud) quiet = 0;
  }
  return onsets;
}

test("tempo segments: whole output frames, counts add up, windows on output-frame instants", () => {
  const segs = tempoOutputSegments(
    [
      { startMs: 0, endMs: 3000 },
      { startMs: 3000, endMs: 6000 },
      { startMs: 6000, endMs: 8000 },
    ],
    TEMPO,
    FPS,
    218
  );
  assert.deepEqual(segs.map((s) => [s.startFrame, s.endFrame]), [[0, 82], [82, 164], [164, 218]]);
  assert.equal(segs.reduce((a, s) => a + s.frameCount, 0), 218);
  assert.ok(Math.abs(segs[1].startMs - (82 * 1000 * TEMPO) / FPS) < 1e-9);
});

const ROOT = path.join(os.tmpdir(), `cuthol-tempo-render-${process.pid}`);

test("tempo render: frame-exact, no drift across segments, audio on the output clock", { timeout: 600_000 }, () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  try {
    const src = path.join(ROOT, "bits.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=8,format=gray,geq=lum='255*mod(floor(N/pow(2\\,floor(X/64)))\\,2)'",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=8,volume='if(lt(mod(t\\,2)\\,0.1)\\,0.8\\,0)':eval=frame",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-g", "30", "-c:a", "aac", "-b:a", "192k", "-shortest", src,
    ]);
    const proj = path.join(ROOT, "proj");
    cli(["workspace", "init", proj, "--aspect", "16:9", "--title", "tempo render"]);
    cli(["library", "ingest", src, "--handle", "bits", "--dir", proj]);
    for (const [a, b] of [[0, 3000], [3000, 6000], [6000, 8000]]) {
      cli(["spine", "append", "--asset", "bits", "--in", `${a}ms`, "--out", `${b}ms`, "--dir", proj]);
    }
    cli(["workspace", "tempo", "--rate", String(TEMPO), "--dir", proj]);

    const expectedFrames = Math.round((8000 / TEMPO / 1000) * FPS); // 218
    for (const [label, env] of [["one graph", {}], ["three segments", { CUTHOL_RENDER_SEGMENT_MAX_CLIPS: "1" }]] as const) {
      const out = path.join(ROOT, `${label.replace(/ /g, "_")}.mp4`);
      cli(["render", "--preset", "draft_480p", "--out", out, "--dir", proj, "--compact"], env);
      const idx = readFrameIndices(out);
      assert.equal(idx.length, expectedFrames, `${label}: frame count`);
      // Frames 0..1 are all-dark by construction (index 0, 1); read from frame 2 on.
      for (let k = 2; k < idx.length; k++) {
        const err = idx[k] - k * TEMPO;
        assert.ok(Math.abs(err) <= 0.5 + 1e-9, `${label}: output frame ${k} shows sequence frame ${idx[k]}, expected ~${(k * TEMPO).toFixed(1)}`);
      }
      // Beeps every 2 s of sequence time land every 2/1.1 s of output time (within one frame).
      const onsets = beepOnsets(out);
      assert.equal(onsets.length, 4, `${label}: beeps ${onsets.join(",")}`);
      onsets.forEach((t, j) => assert.ok(Math.abs(t - (2 * j) / TEMPO) < 1 / FPS, `${label}: beep ${j} at ${t}s`));
      const { paths, sequence } = loadSequence(proj);
      const health = scanRenderedMp4AudioHealth(out, sequence, paths);
      assert.ok(health.checked_points > 0, `${label}: audio check ran`);
      assert.equal(health.issues.length, 0, `${label}: audio issues ${JSON.stringify(health.issues)}`);
    }

    // Counter-check: a delivered file that is not retimed must not pass the audio check.
    const plain = path.join(ROOT, "plain.mp4");
    cli(["workspace", "tempo", "--rate", "1", "--dir", proj]);
    cli(["render", "--preset", "draft_480p", "--out", plain, "--dir", proj, "--compact"]);
    cli(["workspace", "tempo", "--rate", String(TEMPO), "--dir", proj]);
    const { paths, sequence } = loadSequence(proj);
    assert.ok(scanRenderedMp4AudioHealth(plain, sequence, paths).issues.length > 0, "un-retimed file must be flagged");
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
