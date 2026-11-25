// Note contact-sheet cells must be the clean picture: the monitor's top
// info strip must not leak into the frames the sheet composites, while the
// default monitor frame keeps its HUD.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSequence } from "../core/workspace.js";
import {
  annotateRgb24BufferToCanvas,
  captureMonitorFrame,
} from "../monitor/preview.js";
import { LIVE_DEMO_DIR, missingLiveDemo } from "./fixtures.js";

const DEMO = LIVE_DEMO_DIR;

function makeProject(): string {
  const dir = path.join(fs.realpathSync(os.tmpdir()), `live_b5_${process.pid}_${Date.now()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(DEMO, dir, { recursive: true });
  return dir;
}

function topPixel(canvas: { pixels: Uint8Array; width: number }): [number, number, number] {
  const i = (4 * canvas.width + Math.floor(canvas.width / 2)) * 4;
  return [canvas.pixels[i], canvas.pixels[i + 1], canvas.pixels[i + 2]];
}

test("clean cell frame carries no monitor info strip", { skip: missingLiveDemo() }, () => {
  const dir = makeProject();
  try {
    const { sequence } = loadSequence(dir);
    const w = 320;
    const h = 180;
    const buf = Buffer.alloc(w * h * 3, 128);
    const ann = annotateRgb24BufferToCanvas(buf, w, h, 2000, sequence, false, dir, false);
    assert.deepEqual(topPixel(ann.canvas), [128, 128, 128]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("default frame still draws its HUD", { skip: missingLiveDemo() }, () => {
  const dir = makeProject();
  try {
    const { sequence } = loadSequence(dir);
    const w = 320;
    const h = 180;
    const buf = Buffer.alloc(w * h * 3, 128);
    const ann = annotateRgb24BufferToCanvas(buf, w, h, 2000, sequence, false, dir);
    assert.notDeepEqual(topPixel(ann.canvas), [128, 128, 128]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("contact-sheet capture path hides the strip, default capture keeps it", { skip: missingLiveDemo() }, () => {
  const dir = makeProject();
  try {
    const cleanOut = path.join(dir, "clean_cell.png");
    const plainOut = path.join(dir, "plain_frame.png");
    const clean = captureMonitorFrame({
      workspaceDir: dir,
      atMs: 2000,
      showBoxes: false,
      hideHud: true,
      outputPath: cleanOut,
    });
    const plain = captureMonitorFrame({
      workspaceDir: dir,
      atMs: 2000,
      showBoxes: false,
      outputPath: plainOut,
    });
    assert.equal(clean.ok, true);
    assert.equal(plain.ok, true);
    const cleanHash = crypto.createHash("sha256").update(fs.readFileSync(cleanOut)).digest("hex");
    const plainHash = crypto.createHash("sha256").update(fs.readFileSync(plainOut)).digest("hex");
    assert.notEqual(cleanHash, plainHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
