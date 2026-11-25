/**
 * `incoming_scale` really scales per frame (dynamic-scale path, not a no-op).
 *
 * Textured media: testsrc2 clips with different hues (same geometry, different
 * colours). For a transition frame at incoming factor f, the centre f*W x f*H
 * block must match the no-transition reference frame scaled to f; the start
 * frame must differ from the no-transition frame (no-op killer); the frame
 * after the window must equal the no-transition frame. Fails on the old crop
 * no-op (start frame equals the no-transition frame, centre never matches a
 * shrunken reference).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { commitSequenceMutation, initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { appendSpineClip, setSpineTransition } from "../sequence/spine.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; env: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(String(proc.stdout ?? ""));
  } catch {
    try {
      env = JSON.parse(String(proc.stderr ?? ""));
    } catch {
      // keep raw
    }
  }
  return { ok: Boolean(env?.ok), env, raw: raw.slice(0, 4000) };
}

/** testsrc2 clip, optionally hue-rotated so clips differ in colour but not geometry. */
function makeClip(dir: string, name: string, hueDeg: number): string {
  const out = path.join(dir, name);
  const args = [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=3",
    ...(hueDeg ? ["-vf", `hue=h=${hueDeg}`] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ];
  const r = spawnSync("ffmpeg", args);
  assert.equal(r.status, 0, `ffmpeg ${name}: ${r.stderr?.toString() ?? ""}`);
  return out;
}

function frameSize(mp4: string): { w: number; h: number } {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4], { encoding: "utf8" });
  const [w, h] = String(probe.stdout).trim().split(",").map(Number);
  assert.ok(w > 0 && h > 0, `no dimensions for ${mp4}`);
  return { w, h };
}

function decodeRgbFrame(mp4: string, atSec: number, w: number, h: number): Buffer {
  const dec = spawnSync("ffmpeg", ["-v", "error", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 128 * 1024 * 1024 });
  assert.equal(dec.status, 0, `decode ${mp4}@${atSec}s`);
  const b = dec.stdout as Buffer;
  assert.equal(b.length, w * h * 3, `short decode ${mp4}@${atSec}s`);
  return b;
}

/** ffmpeg-resized copy of a frame (bilinear, like the render path's linear). */
function scaleFrame(frame: Buffer, w: number, h: number, sw: number, sh: number): Buffer {
  const p = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "pipe:0", "-vf", `scale=${sw}:${sh}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: frame, maxBuffer: 128 * 1024 * 1024 });
  assert.equal(p.status, 0, "scale frame");
  return p.stdout as Buffer;
}

/** Centre cw x ch block of a frame. */
function centreCrop(frame: Buffer, w: number, h: number, cw: number, ch: number): Buffer {
  const x0 = Math.floor((w - cw) / 2), y0 = Math.floor((h - ch) / 2);
  const out = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) frame.copy(out, y * cw * 3, ((y0 + y) * w + x0) * 3, ((y0 + y) * w + x0 + cw) * 3);
  return out;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, "length mismatch");
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

test("incoming_scale renders a growing centred picture, not a full-frame no-op", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-inscale-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "inscale-", aspect: "16:9", fps: 30 });
    const c0 = makeClip(wsDir, "c0.mp4", 0);
    const c1 = makeClip(wsDir, "c1.mp4", 180);
    const items = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [c0, c1] });
    for (const it of items) appendSpineClip({ workspaceDir: wsDir, assetHandle: it.handle, sourceInMs: 0, sourceOutMs: 2000 });

    const extDir = path.join(wsDir, ".cuthol", "extensions", "scdemo");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, "cuthol-extension.json"),
      JSON.stringify({ name: "scdemo", version: "1.0.0", description: "scale proof", transitions: { zum: { incoming_scale: "0.5+0.5*{{p}}" } } }, null, 2)
    );
    enableExtensionInWorkspace({ workspaceDir: wsDir, name: "scdemo" });
    setSpineTransition({ workspaceDir: wsDir, clipId: "sp_01", transition: { kind: "ext:scdemo/zum", duration_ms: 500, easing: "linear" } });

    const scaled = cli(["render", "--preset", "draft_480p", "--encoder", "libx264", "--out", "output/scaled.mp4", "--dir", wsDir]);
    assert.ok(scaled.ok, scaled.raw);
    commitSequenceMutation(wsDir, "drop transition for reference", (seq) => {
      seq.spine.clips[0].transition_out = null;
    });
    const plain = cli(["render", "--preset", "draft_480p", "--encoder", "libx264", "--out", "output/plain.mp4", "--dir", wsDir]);
    assert.ok(plain.ok, plain.raw);

    const mp4 = path.join(wsDir, "output", "scaled.mp4");
    const refMp4 = path.join(wsDir, "output", "plain.mp4");
    const { w: W, h: H } = frameSize(mp4);
    // Timeline with the 500 ms hold: clip1 starts at 2.0 s; incoming media m = T - 2.0.
    const samples = [
      { t: 2.05, f: 0.55 },
      { t: 2.25, f: 0.75 },
      { t: 2.45, f: 0.95 },
    ];
    for (const s of samples) {
      const m = s.t - 2.0;
      const frame = decodeRgbFrame(mp4, s.t, W, H);
      const refIn = decodeRgbFrame(refMp4, 2.0 + m, W, H);
      const cw = Math.round(W * s.f), ch = Math.round(H * s.f);
      const dShrunk = meanAbsDiff(centreCrop(frame, W, H, cw, ch), scaleFrame(refIn, W, H, cw, ch));
      const dFull = meanAbsDiff(frame, refIn);
      console.log(`t=${s.t}s f~${s.f} centre-vs-shrunk=${dShrunk.toFixed(2)} full-vs-plain=${dFull.toFixed(2)}`);
      assert.ok(dShrunk < 15, `centre does not match shrunken incoming (d=${dShrunk}) at t=${s.t}`);
      if (s.t === 2.05) assert.ok(dFull > 4, `start frame equals no-transition frame (d=${dFull})`);
    }
    // After the window the frame equals the no-transition frame.
    const dAfter = meanAbsDiff(decodeRgbFrame(mp4, 2.7, W, H), decodeRgbFrame(refMp4, 2.7, W, H));
    console.log(`after-window diff=${dAfter.toFixed(2)}`);
    assert.ok(dAfter < 6, `frame after transition differs from no-transition (d=${dAfter})`);
  } finally {
    rmRetrySync(tmp);
  }
});
