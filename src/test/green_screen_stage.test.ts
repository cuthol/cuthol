import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./test_setup.js";

import { renderHyperFramesSingleFramePng } from "../compositor/hf_frames.js";
import { renderHyperFramesCompositionToMp4 } from "../compositor/hf_render.js";
import { LIVE_DEMO_DIR, missingLiveDemo } from "./fixtures.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function readCornerPixel(pngPath: string): Buffer {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      pngPath,
      "-vf",
      "crop=1:1:0:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { encoding: "buffer", timeout: 30_000 }
  );
  assert.equal(proc.status, 0, `ffmpeg pixel read failed: ${proc.stderr}`);
  assert.ok((proc.stdout as Buffer).length >= 4, "expected at least 4 bytes of pixel data");
  return proc.stdout as Buffer;
}

function stageGreenComposition(): { dir: string; blobs: string } {
  const root = makeTempDir("green-");
  const src = path.join(LIVE_DEMO_DIR, "comps/title");
  const dir = path.join(root, "comp");
  fs.cpSync(src, dir, { recursive: true });
  const entry = path.join(dir, "index.html");
  const html = fs.readFileSync(entry, "utf8");
  assert.ok(html.includes("background: transparent"), "fixture should have a transparent background to swap");
  const green = html.replace("background: transparent", "background: #00ff00");
  assert.ok(/#00ff00/.test(green), "staged composition must contain #00ff00");
  fs.writeFileSync(entry, green, "utf8");
  const blobs = path.join(root, "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  return { dir, blobs };
}

test("green background stays on disk while the captured frame is transparent", { skip: missingLiveDemo() }, () => {
  const { dir, blobs } = stageGreenComposition();
  try {
    const entry = path.join(dir, "index.html");
    const before = sha256File(entry);
    const frame = renderHyperFramesSingleFramePng({
      compositionDir: dir,
      entryHtml: "index.html",
      blobsDir: blobs,
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1000,
      localSec: 0.5,
      props: {},
      transparent: true,
    });
    assert.ok(fs.existsSync(frame.pngPath), "expected a captured frame png");
    const afterFrame = sha256File(entry);
    assert.equal(afterFrame, before, "single-frame capture must not rewrite the entry HTML");

    const blob = renderHyperFramesCompositionToMp4({
      compositionDir: dir,
      entryHtml: "index.html",
      blobsDir: blobs,
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1000,
      props: {},
      transparent: true,
    });
    assert.ok(fs.existsSync(blob), "expected a rendered overlay blob");
    const afterRender = sha256File(entry);
    assert.equal(afterRender, before, "draft render must not rewrite the entry HTML");

    const px = readCornerPixel(frame.pngPath);
    assert.equal(px[3], 0, `corner pixel should stay transparent (alpha 0), got rgba=${px[0]},${px[1]},${px[2]},${px[3]}`);
  } finally {
    safeRm(path.dirname(blobs));
  }
});

test("composition without green background renders as before", { skip: missingLiveDemo() }, () => {
  const root = makeTempDir("nogreen-");
  try {
    const src = path.join(LIVE_DEMO_DIR, "comps/title");
    const dir = path.join(root, "comp");
    fs.cpSync(src, dir, { recursive: true });
    const blobs = path.join(root, "blobs");
    fs.mkdirSync(blobs, { recursive: true });
    const opts = {
      compositionDir: dir,
      entryHtml: "index.html",
      blobsDir: blobs,
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1000,
      props: {},
      transparent: true,
    };
    const first = renderHyperFramesCompositionToMp4(opts);
    const second = renderHyperFramesCompositionToMp4(opts);
    assert.equal(second, first, "second render of the same project must reuse the cached overlay");
    assert.ok(!/hf_stage_|hf_snap_vars_|transparent_build/.test(second), "cache key must not depend on the temp folder path");
  } finally {
    safeRm(root);
  }
});
