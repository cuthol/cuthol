/**
 * `monitor sheet` skips the HyperFrames snapshot prefetch when the render
 * overlay cache already serves every cell.
 *
 * 1. With a cached overlay blob (and no `hf_frame_*` single-frame PNGs), a
 *    sheet creates no new `hf_frame_*` files: the old build always ran the
 *    batched `snapshot --at` prefetch here, so this fails there.
 * 2. Counter-check: sheet cells still match `captureMonitorFrame` pixels
 *    bit-for-bit on the warm overlay path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import { loadSequence } from "../core/workspace.js";
import { renderHyperFramesCompositionToMp4 } from "../compositor/hyperframes_bridge.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for assertion messages
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function decodePngRegionRgb24(
  pngPath: string,
  crop?: { x: number; y: number; w: number; h: number }
): Buffer {
  const vfArgs = crop ? ["-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : [];
  const proc = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      pngPath,
      ...vfArgs,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(proc.status, 0, proc.stderr?.toString("utf8") || "ffmpeg decode failed");
  return proc.stdout as Buffer;
}

function meanAbsPixelDiff(bufA: Buffer, bufB: Buffer): number {
  assert.equal(bufA.length, bufB.length, "RGB24 buffer lengths must match");
  let sum = 0;
  for (let i = 0; i < bufA.length; i++) {
    sum += Math.abs(bufA[i] - bufB[i]);
  }
  return sum / bufA.length;
}

test("sheet with a warm overlay cache runs no snapshot prefetch and matches frame pixels", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-sheet-overlay-"));
  const wsDir = path.join(tmpRoot, "ws");
  try {
    assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
    assert.ok(cli(["workspace", "backdrop", "--color", "#FFD23F", "--dir", wsDir]).ok);

    const compDir = path.join(wsDir, "compositions", "main");
    assert.ok(
      cli([
        "composition",
        "scaffold",
        "--comp-dir",
        compDir,
        "--duration",
        "3s",
        "--dir",
        wsDir,
      ]).ok
    );
    assert.ok(
      cli([
        "lane",
        "add-composition",
        "--lane",
        "ln_motion",
        "--comp-dir",
        compDir,
        "--at",
        "0ms",
        "--duration",
        "3000ms",
        "--dir",
        wsDir,
      ]).ok
    );

    const { paths: wsPaths, sequence: wsSeq } = loadSequence(wsDir);
    const blobsDir = path.join(wsDir, ".cuthol", "blobs");
    const fps = Math.max(1, wsSeq.stage.fps);
    const size = 480 / Math.min(wsSeq.stage.width, wsSeq.stage.height);
    const renderWidth = Math.max(16, Math.round((wsSeq.stage.width * size) / 2) * 2);
    const renderHeight = Math.max(16, Math.round((wsSeq.stage.height * size) / 2) * 2);

    // Warm the render overlay cache both ways the frame path may key it
    // (transparent overlay, and baked over the stage backdrop).
    renderHyperFramesCompositionToMp4({
      compositionDir: compDir,
      entryHtml: "index.html",
      blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: 3000,
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    });
    renderHyperFramesCompositionToMp4({
      compositionDir: compDir,
      entryHtml: "index.html",
      blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: 3000,
      props: {},
      transparent: false,
      mode: "overlay_alpha",
      opaqueBackdropColor: wsSeq.stage.backdrop.color,
    });

    // Snapshot-png cache stays cold: the old build's prefetch would fill it.
    for (const f of fs.readdirSync(blobsDir)) {
      if (f.startsWith("hf_frame_") && f.endsWith(".png")) {
        fs.rmSync(path.join(blobsDir, f), { force: true });
      }
    }
    const blobsBefore = new Set(fs.readdirSync(blobsDir));

    const sheetRes = captureMonitorSheet({
      workspaceDir: wsDir,
      startMs: 200,
      endMs: 2800,
      cols: 2,
      rows: 2,
      showBoxes: false,
    });
    assert.equal(sheetRes.ok, true);
    assert.equal(sheetRes.frames.length, 4);

    const blobsAfter = fs.readdirSync(blobsDir);
    const newFramePngs = blobsAfter.filter(
      (f) => !blobsBefore.has(f) && f.startsWith("hf_frame_") && f.endsWith(".png")
    );
    assert.deepEqual(
      newFramePngs,
      [],
      `Expected no snapshot prefetch on a warm overlay cache, created: ${newFramePngs.join(", ")}`
    );

    // Counter-check: warm-path cells match monitor frame pixels bit-for-bit.
    const cellW = renderWidth;
    const cellH = renderHeight;
    const pad = 12;
    const headerH = 44;
    let maxDiff = 0;
    for (let idx = 0; idx < sheetRes.frames.length; idx++) {
      const cellMetrics = sheetRes.frames[idx];
      const frameRes = captureMonitorFrame({
        workspaceDir: wsDir,
        atMs: cellMetrics.timestamp_ms,
        showBoxes: false,
      });
      assert.equal(frameRes.ok, true);
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const cellRgb = decodePngRegionRgb24(sheetRes.png_path, {
        x: pad + col * (cellW + pad) + 1,
        y: headerH + pad + row * (cellH + pad) + 1,
        w: cellW - 2,
        h: cellH - 2,
      });
      const frameRgb = decodePngRegionRgb24(frameRes.png_path, {
        x: 1,
        y: 1,
        w: cellW - 2,
        h: cellH - 2,
      });
      const diff = meanAbsPixelDiff(cellRgb, frameRgb);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.equal(maxDiff, 0, `Expected warm sheet cells to match frame pixels, max diff ${maxDiff}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
