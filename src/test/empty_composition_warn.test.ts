import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { isEmptyCompositionSidecar } from "../monitor/preview.js";
import { verifyEmptyCompositions } from "../verify/gates_empty_composition.js";
import { PngCanvas } from "../core/png_canvas.js";
import {
  probeEveryFrameAlphaEmpty,
  recordCompositionAlphaBboxSidecar,
} from "../compositor/hf_frames.js";
import type { CutholSequence } from "../core/schema.js";

function makeSequence(compDir: string): CutholSequence {
  return {
    meta: { schema_version: 1, title: "t", revision: 1 } as never,
    stage: { width: 1280, height: 720, fps: 30 } as never,
    spine: { clips: [] } as never,
    library: [],
    lanes: [
      {
        id: "ln1",
        kind: "overlay",
        muted: false,
        cues: [
          {
            id: "cue_empty",
            kind: "composition",
            duration_ms: 1000,
            composition: { composition_dir: compDir, entry_html: "index.html" },
          },
        ],
      },
    ],
  } as unknown as CutholSequence;
}

test("empty composition diagnostics exist and verify gate warns once per cue", () => {
  assert.match(DIAGNOSTICS.EMPTY_COMPOSITION_RENDER("c").formatted, /CUTHOL-G720/);
  assert.match(DIAGNOSTICS.EMPTY_COMPOSITION_VERIFY("c").formatted, /CUTHOL-G721/);
  assert.match(DIAGNOSTICS.EMPTY_COMPOSITION_FRAME("c", "200ms").formatted, /CUTHOL-G722/);
  assert.match(DIAGNOSTICS.EMPTY_COMPOSITION_SHEET("c").formatted, /CUTHOL-G723/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-empty-comp-"));
  try {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const sidecar = path.join(dir, "assets/cuthol-bbox.json");
    fs.writeFileSync(sidecar, JSON.stringify({ empty: true }));
    const seq = makeSequence(dir);
    const got = verifyEmptyCompositions(seq, { rootDir: dir } as never);
    assert.equal(got.length, 1);
    assert.equal(got[0].code, "CUTHOL-G721");
    // Editing a composition file after the sidecar silences the warning.
    const later = Date.now() + 5000;
    fs.writeFileSync(path.join(dir, "index.html"), "<html>changed</html>");
    fs.utimesSync(path.join(dir, "index.html"), new Date(later), new Date(later));
    const got2 = verifyEmptyCompositions(seq, { rootDir: dir } as never);
    assert.equal(got2.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function writePngSeqFrame(dir: string, idx: number, drawn: boolean): void {
  const canvas = new PngCanvas(64, 36, [0, 0, 0, 0]);
  if (drawn) canvas.fillRect(10, 8, 20, 12, [255, 255, 255, 255]);
  canvas.saveAs(path.join(dir, `frame_${String(idx + 1).padStart(6, "0")}.png`));
}

test("every-frame probe: a short pop is not empty, fully transparent is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-everyframe-"));
  try {
    const seqDir = path.join(dir, "cap.pngseq");
    fs.mkdirSync(seqDir, { recursive: true });
    for (let i = 0; i < 10; i++) writePngSeqFrame(seqDir, i, i === 5);
    const pop = probeEveryFrameAlphaEmpty(seqDir, 10, 1.0);
    assert.ok(pop, "probe returns a result");
    assert.equal(pop.allEmpty, false, "one drawn frame of ten is not empty");
    assert.ok(pop.emptyRanges.length >= 2, "empty head and tail ranges recorded");
    assert.ok(
      !pop.emptyRanges.some(([a, b]) => 0.5 >= a && 0.5 < b),
      "the drawn frame at 0.5 s is not inside an empty range"
    );
    const flatDir = path.join(dir, "flat.pngseq");
    fs.mkdirSync(flatDir, { recursive: true });
    for (let i = 0; i < 10; i++) writePngSeqFrame(flatDir, i, false);
    const flat = probeEveryFrameAlphaEmpty(flatDir, 10, 1.0);
    assert.ok(flat, "probe returns a result");
    assert.equal(flat.allEmpty, true, "all transparent frames are empty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("sheet rule: G723 only when the sidecar says empty:true", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-sheet-rule-"));
  try {
    const root = path.join(dir, "proj");
    const full = path.join(root, "comp-full");
    const partial = path.join(root, "comp-partial");
    const missing = path.join(root, "comp-missing");
    for (const d of [full, partial, missing]) fs.mkdirSync(path.join(d, "assets"), { recursive: true });
    fs.writeFileSync(path.join(full, "assets/cuthol-bbox.json"), JSON.stringify({ empty: true }));
    fs.writeFileSync(
      path.join(partial, "assets/cuthol-bbox.json"),
      JSON.stringify({ left_pct: 0.1, empty_ranges: [[0, 3]] })
    );
    const cueFor = (compDir: string) =>
      ({ id: "c", composition: { composition_dir: compDir } }) as never;
    assert.equal(isEmptyCompositionSidecar(root, cueFor(full)), true);
    assert.equal(isEmptyCompositionSidecar(root, cueFor(partial)), false);
    assert.equal(isEmptyCompositionSidecar(root, cueFor(missing)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("sidecar box equals the middle frame box plus empty_ranges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-midbox-"));
  try {
    const compDir = path.join(dir, "comp");
    fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
    const seqDir = path.join(dir, "cap.pngseq");
    fs.mkdirSync(seqDir, { recursive: true });
    // Middle frame (idx 5 of 10) draws a 20x12 box at (10,8); frame 0 draws
    // elsewhere so a union would differ from the middle box.
    for (let i = 0; i < 10; i++) {
      const canvas = new PngCanvas(64, 36, [0, 0, 0, 0]);
      if (i === 0) canvas.fillRect(40, 24, 8, 6, [255, 255, 255, 255]);
      if (i === 5) canvas.fillRect(10, 8, 20, 12, [255, 255, 255, 255]);
      canvas.saveAs(path.join(seqDir, `frame_${String(i + 1).padStart(6, "0")}.png`));
    }
    const box = recordCompositionAlphaBboxSidecar(compDir, seqDir, undefined, {
      fps: 10,
      durationSec: 1.0,
    });
    assert.ok(box, "middle frame box measured");
    const raw = JSON.parse(
      fs.readFileSync(path.join(compDir, "assets/cuthol-bbox.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(raw.empty, undefined, "a pop is not empty:true");
    assert.ok(Array.isArray(raw.empty_ranges), "empty_ranges stored");
    assert.equal(raw.samples, undefined, "no 5-fraction samples");
    assert.equal(raw.emptyAt, undefined, "no 5-fraction emptyAt");
    for (const k of ["left_pct", "top_pct", "right_pct", "bottom_pct", "width_pct", "height_pct"]) {
      assert.equal(raw[k], (box as unknown as Record<string, unknown>)[k], `${k} matches middle box`);
    }
    // Middle box is the (10,8,20,12) rect scaled to 320x180 probe space, not the union.
    assert.ok(
      Number(raw.left_pct) < 0.3 && Number(raw.width_pct) < 0.4,
      "box is the middle frame, not the union with frame 0"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
