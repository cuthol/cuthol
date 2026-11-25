// Single frames reuse the render's baked composition overlay blob (B1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./test_setup.js";

import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { renderHyperFramesSingleFramePng } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { renderSingleCompositeFrameRgb24 } from "../render/render_frames.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // ignore cleanup error
  }
}

function createStill(outPath: string): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1A2B3C:s=640x360:r=30:d=1",
      "-vf",
      "drawbox=x=60:y=40:w=200:h=120:color=0xE11D48:t=fill",
      "-frames:v",
      "1",
      outPath,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg still failed: ${proc.stderr}`);
}

function writeComp(wsDir: string): void {
  const compDir = path.join(wsDir, "compositions", "badge");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="assets/gsap.min.js"></script>
    <script src="assets/cuthol-data.js"></script>
    <script src="assets/cuthol-runtime.js"></script>
    <style>html, body, #root { margin:0; width:640px; height:360px; background:transparent !important; overflow:hidden; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="640" data-height="360" data-fps="30" data-duration="3">
      <div id="box" style="position:absolute;left:220px;top:120px;width:200px;height:90px;background:#F8FAFC;border:6px solid #38BDF8;border-radius:18px"></div>
    </div>
    <script>
      const C = window.__cuthol;
      const tl = gsap.timeline({ paused: true });
      tl.set({}, {}, C.duration);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
  fs.writeFileSync(path.join(compDir, "index.html"), html, "utf8");
}

function psnr(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length);
  let s = 0;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d) {
      c++;
      s += d * d;
    }
  }
  if (c === 0) return 99;
  return 10 * Math.log10(65025 / (s / a.length));
}

function decodePlanFrames(
  plan: { inputArgs: string[]; filterComplex: string; videoOutPad: string; renderWidth: number; renderHeight: number },
  cwd: string,
  frames: number[]
): Buffer[] {
  const vi = plan.filterComplex.indexOf(plan.videoOutPad);
  const sel = frames.map((n) => `eq(n,${n})`).join("+");
  const fc = `${plan.filterComplex.slice(0, vi + plan.videoOutPad.length)};${plan.videoOutPad}select='${sel}',scale=in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24[o]`;
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...plan.inputArgs,
      "-filter_complex",
      fc,
      "-map",
      "[o]",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { cwd, maxBuffer: 2 ** 31, timeout: 240_000, windowsHide: true }
  );
  assert.equal(proc.status, 0, `render-plan decode failed: ${String(proc.stderr).slice(0, 300)}`);
  const fsz = plan.renderWidth * plan.renderHeight * 3;
  const out = proc.stdout as Buffer;
  assert.equal(out.length, fsz * frames.length, `decoded ${out.length} bytes, want ${frames.length} frames`);
  return frames.map((_, i) => out.subarray(i * fsz, (i + 1) * fsz));
}

test("single frames reuse the baked render overlay blob", { timeout: 300_000 }, () => {
  const tmpDir = makeTempDir("cuthol-sf-overlay-");
  try {
    const wsDir = path.join(tmpDir, "ws");
    initWorkspace({ dir: wsDir, title: "sf-overlay", aspect: "16:9", fps: 30 });
    const stillPath = path.join(tmpDir, "still.png");
    createStill(stillPath);
    ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [stillPath] });
    const { sequence: seq0 } = loadSequence(wsDir);
    const stillHandle = seq0.library.find((a) => a.kind !== "audio")!.handle;
    appendSpineClip({ workspaceDir: wsDir, assetHandle: stillHandle, sourceInMs: 0, sourceOutMs: 3000 });
    writeComp(wsDir);
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 3000,
      composition: {
        composition_dir: "compositions/badge",
        entry_html: "index.html",
        props: {},
        transparent: true,
      },
    });

    const render = spawnSync(
      process.execPath,
      [CLI, "render", "--preset", "draft_480p", "--workers", "1", "--dir", wsDir],
      {
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CUTHOL_ENCODER: "x264" },
      }
    );
    assert.equal(render.status, 0, render.stdout || render.stderr);
    const envelope = JSON.parse(String(render.stdout)) as {
      ok?: boolean;
      overlays?: { total?: number; rendered?: number; cached?: number };
    };
    assert.equal(envelope.ok, true, render.stdout);
    assert.equal(envelope.overlays?.total, 1, JSON.stringify(envelope.overlays));
    assert.equal(envelope.overlays?.rendered, 1, JSON.stringify(envelope.overlays));

    const { sequence, paths } = loadSequence(wsDir);
    const fps = sequence.stage.fps;
    const instants = [0, 1500, 2967];
    const frames = instants.map((ms) => Math.floor((ms * fps) / 1000 + 1e-6));

    // Every composition instant takes the render-blob path in a single-frame compile.
    const singles: { ms: number; msTotal: number; rgb: Buffer }[] = [];
    for (const ms of instants) {
      const t0 = Date.now();
      const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
        workers: 1,
        activeWindowMs: [ms, ms + 1000 / fps],
        singleFrameAtMs: ms,
        includeAudio: false,
      });
      const overlayInputs = plan.inputArgs.filter((a) => /hf_comp_[0-9a-f]{12,}/.test(a));
      const freshInputs = plan.inputArgs.filter((a) => /hf_frame_/.test(a));
      assert.ok(overlayInputs.length > 0, `ms=${ms}: single-frame compile misses the render blob`);
      assert.equal(freshInputs.length, 0, `ms=${ms}: single-frame compile captures a fresh PNG`);
      const res = renderSingleCompositeFrameRgb24(sequence, paths, ms, "draft_480p", {
        skipGates: ["G2_ASSETS"],
      });
      singles.push({ ms, msTotal: Date.now() - t0, rgb: Buffer.from(res.rgbBuf) });
    }

    // ... and matches the full render plan's frame, not just any capture.
    const fullPlan = compileSequenceRenderPlan(sequence, paths, "draft_480p", { workers: 1 });
    const rendered = decodePlanFrames(fullPlan, paths.rootDir, frames);
    for (let i = 0; i < instants.length; i++) {
      const p = psnr(singles[i].rgb, rendered[i]);
      console.log(`TIMING ms=${instants[i]} psnr=${p.toFixed(2)} singleMs=${singles[i].msTotal}`);
      assert.ok(p >= 40, `ms=${instants[i]}: single frame ${p.toFixed(2)} dB from the render frame`);
    }

    // A cold overlay capture costs a browser start; the blob hit must beat it.
    const compDir = path.join(wsDir, "compositions", "badge");
    const tCold = Date.now();
    renderHyperFramesSingleFramePng({
      compositionDir: compDir,
      entryHtml: "index.html",
      blobsDir: paths.blobsDir,
      width: 854,
      height: 480,
      fps,
      durationMs: 3000,
      localSec: 1.5,
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    });
    const coldMs = Date.now() - tCold;
    const slowest = Math.max(...singles.map((s) => s.msTotal));
    console.log(`TIMING coldCaptureMs=${coldMs} slowestSingleMs=${slowest}`);
    assert.ok(slowest < coldMs, `single frame ${slowest} ms not faster than a cold capture ${coldMs} ms`);
  } finally {
    safeRm(tmpDir);
  }
});
