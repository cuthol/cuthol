/**
 * Live preview captions match the renderer (`src/test/live_caption_ass_match.test.ts`).
 *
 * The renderer (`src/compositor/ass_generator.ts`) draws captions with libass:
 * ASS `Fontsize` is a line height in script pixels and libass draws it at
 * ~8/9 of a same-number browser `font-size` (ffmpeg `ass` filter vs headless
 * Chrome on "Caption size test": ASS 100 -> 657 px, CSS 100px -> 739 px
 * regular / 795 px bold vs ASS bold 706 px; same ratio at size 44).
 * `Bold` is only a `font_weight >= 600` threshold, and without a box the
 * renderer always draws `Outline = max(1, stroke)` plus `Shadow = 2`.
 * Live (`src/live/live_captions.ts` + `src/live/ui/preview.js`) must use the
 * same effective size, weight and outline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileTypographyAssFile } from "../compositor/ass_generator.js";
import * as liveCaptions from "../live/live_captions.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import type { ParallelLane, TypographySpec } from "../core/schema.js";

const TEXT = "Caption size test";

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "../..",
);

/** Pre-fix Live mapping (master `src/live/ui/preview.js` caption block). */
function oldLiveMapping(typo: Record<string, unknown>, s: number): { fontSizePx: number; fontWeight: number; strokePx: number; shadowPx: number } {
  return {
    fontSizePx: Math.max(8, Math.round((Number(typo.font_size_px ?? 42)) * s)),
    fontWeight: Number(typo.font_weight ?? 700),
    strokePx: Number(typo.stroke_width_px ?? 0) * s,
    shadowPx: 0,
  };
}

function liveMapping(typo: Record<string, unknown>, s: number): { fontSizePx: number; fontWeight: number; strokePx: number; shadowPx: number } {
  const fn = (liveCaptions as Record<string, unknown>)["resolveLiveCaptionCss"];
  if (typeof fn === "function") {
    const r = (fn as (t: unknown, d: number) => { fontSizePx: number; fontWeight: number; strokePx: number; shadowPx: number })(typo, s);
    return { fontSizePx: r.fontSizePx, fontWeight: r.fontWeight, strokePx: r.strokePx, shadowPx: r.shadowPx };
  }
  return oldLiveMapping(typo, s);
}

function parseStyle(content: string, cueId: string): Record<string, string> {
  const line = content.split(/\r?\n/).find((l) => l.startsWith(`Style: Style_${cueId},`));
  assert.ok(line, `expected Style line for ${cueId}`);
  const fields = line.slice("Style: ".length).split(",");
  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,
  // OutlineColour, BackColour, Bold, Italic, ..., BorderStyle, Outline, Shadow, ...
  return {
    fontname: fields[1],
    fontsize: fields[2],
    bold: fields[7],
    borderStyle: fields[15],
    outline: fields[16],
    shadow: fields[17],
  };
}

function makeProject(sizes: number[]): { dir: string; cues: Array<{ id: string; typo: Record<string, unknown> }> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-caption-ass-"));
  initWorkspace({ dir, title: "LiveCaption", aspect: "16:9", fps: 30 });
  const cues: Array<{ id: string; typo: Record<string, unknown> }> = [];
  commitSequenceMutation(dir, "test.add_caption_cues", (seq) => {
    seq.stage.width = 1920;
    seq.stage.height = 1080;
    let lane: ParallelLane | undefined = seq.lanes.find((l) => l.id === "ln_captions");
    if (!lane) {
      lane = { id: "ln_captions", kind: "caption", z_index: 10, muted: false, cues: [] } as unknown as ParallelLane;
      seq.lanes.push(lane);
    }
    sizes.forEach((size, i) => {
      const plain: TypographySpec = {
        text: TEXT,
        font_family: "Arial",
        font_size_px: size,
        font_weight: 700,
        color_hex: "#FFFFFF",
        stroke_color_hex: "#000000",
        stroke_width_px: 2,
        box_color_hex: null,
        box_opacity: 0,
        align: "center",
        max_width_pct: 80,
      };
      const active: TypographySpec = {
        ...plain,
        font_weight: 800,
        stroke_width_px: 4,
        stroke_color_hex: "#0F172A",
        active_word_color_hex: "#FACC15",
        words: [
          { word: "Caption", source_start_ms: 0, source_end_ms: 500, sequence_start_ms: 0, sequence_end_ms: 500 },
          { word: "size", source_start_ms: 500, source_end_ms: 1000, sequence_start_ms: 500, sequence_end_ms: 1000 },
          { word: "test", source_start_ms: 1000, source_end_ms: 1500, sequence_start_ms: 1000, sequence_end_ms: 1500 },
        ],
      };
      for (const [suffix, typo] of [["plain", plain], ["active", active]] as const) {
        const id = `cue_${size}_${suffix}_${i}`;
        lane!.cues.push({
          id,
          kind: "caption",
          anchor: null,
          at_ms: i * 3000,
          duration_ms: 2000,
          placement: { x_pct: 0, y_pct: 26, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
          typography: typo,
          envelopes: [],
        });
        cues.push({ id, typo: typo as unknown as Record<string, unknown> });
      }
    });
  });
  return { dir, cues };
}

test("live caption CSS matches the ASS renderer values", () => {
  const { dir, cues } = makeProject([44, 76, 100]);
  try {
    const { sequence, paths } = loadSequence(dir);
    const assPath = path.join(paths.blobsDir, "live_caption_check.ass");
    const res = compileTypographyAssFile(sequence, assPath);
    assert.equal(res.hasTypographyCues, true);
    const content = fs.readFileSync(assPath, "utf8");

    for (const { id, typo } of cues) {
      const style = parseStyle(content, id);
      // Renderer counter-check: the style line must keep using the raw fields.
      assert.equal(style.fontsize, String(typo.font_size_px), `${id}: ASS Fontsize`);
      const expectBold = Number(typo.font_weight) >= 600 ? "-1" : "0";
      assert.equal(style.bold, expectBold, `${id}: ASS Bold threshold`);
      const expectOutline = typo.box_color_hex ? "14" : String(Math.max(1, Number(typo.stroke_width_px)));
      assert.equal(style.outline, expectOutline, `${id}: ASS Outline`);
      assert.equal(style.shadow, typo.box_color_hex ? "0" : "2", `${id}: ASS Shadow`);

      // Live must draw the same effective glyph size libass draws: 8/9 of the
      // ASS number at the same picture scale (display scale 1 here), ±5 %.
      const live = liveMapping(typo, 1);
      const libassCssPx = Number(style.fontsize) * (8 / 9);
      const sizeErr = Math.abs(live.fontSizePx - libassCssPx) / libassCssPx;
      assert.ok(sizeErr <= 0.05, `${id}: live ${live.fontSizePx}px vs libass-drawn ${libassCssPx}px`);

      // Live weight must follow the renderer's Bold threshold, not the raw value.
      const expectWeight = expectBold === "-1" ? 700 : 400;
      assert.equal(live.fontWeight, expectWeight, `${id}: live weight follows ASS Bold`);

      // Live outline/shadow must exist whenever the renderer draws them.
      if (!typo.box_color_hex) {
        assert.ok(live.strokePx >= 1 - 1e-9, `${id}: live draws the renderer Outline`);
        assert.ok(live.shadowPx > 0, `${id}: live draws the renderer Shadow`);
      }
    }

    // A light cue (weight below threshold, no stroke) still gets the
    // renderer minimum outline + shadow, and a regular Live weight.
    const light = { font_size_px: 76, font_weight: 400, stroke_width_px: 0, box_opacity: 0 };
    const lightLive = liveMapping(light as Record<string, unknown>, 1);
    assert.equal(lightLive.fontWeight, 400);
    assert.ok(lightLive.strokePx >= 1 - 1e-9, "minimum renderer outline is drawn");
    assert.ok(lightLive.shadowPx > 0, "renderer shadow is drawn");

    // Live line-height matches the libass line pitch (0.84 x ASS size):
    // a single line box then agrees with the painted height within ~1 %.
    const ns = liveCaptions as Record<string, unknown>;
    if (typeof ns["LIVE_CAPTION_LINE_HEIGHT"] === "number") {
      const lh = ns["LIVE_CAPTION_LINE_HEIGHT"] as number;
      assert.ok(Math.abs(lh - 0.84 / (8 / 9)) < 0.005, `line-height ${lh} matches libass pitch`);
      const src = fs.readFileSync(path.join(REPO, "src/live/ui/preview.js"), "utf8");
      assert.ok(src.includes(`lineHeight = "${lh}"`), "preview caption sets the libass line-height");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
