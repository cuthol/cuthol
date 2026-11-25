/**
 * Live caption style helpers (`src/live/live_captions.ts`).
 *
 * Live preview must use the same caption font as the renderer. The renderer's
 * font pick lives in `src/compositor/ass_generator.ts` (do not change the
 * renderer): `(typo.font_family || "Arial")` with commas stripped, trimmed,
 * falling back to `"Arial"`. These helpers mirror that pick for Live, and
 * build a cache key so a revision that changes caption typography re-draws
 * the current frame without a reload.
 */

export const RENDERER_CAPTION_FONT_FALLBACK = "Arial";

/**
 * ASS `Fontsize` is a line height in script pixels, not a CSS `font-size`
 * (em square). libass draws it smaller than a browser draws the same number:
 * measured with the ffmpeg `ass` filter vs headless Chrome on
 * "Caption size test": ASS 100 -> 657 px wide, CSS 100px -> 739 px
 * (regular) and ASS bold -> 706 px vs CSS 700 -> 795 px; the same ratio 0.889
 * at size 44 and for both weights. Multiply ASS sizes by this to get CSS px.
 */
export const ASS_FONT_SIZE_TO_CSS_PX = 8 / 9;

/** Renderer shadow: BackColour `hexToAssColor("#000000", 0.5)` (ass_generator.ts). */
export const RENDERER_CAPTION_SHADOW_CSS = "rgba(0, 0, 0, 0.5)";

/** Renderer opaque-box padding: `Outline = 14` with `BorderStyle = 3` (ass_generator.ts). */
export const RENDERER_CAPTION_BOX_PAD_SCRIPT_PX = 14;

/**
 * CSS `line-height` matching the libass line pitch: two ASS lines
 * ("Caption\\Nsize test", Arial 100, Bold) paint 167 px tall vs 83 px for one
 * line, so the pitch is 0.84 x ASS size = 0.84 / (8/9) x CSS em = 0.945.
 * A single line inks ~0.83 x ASS size, so its CSS line box (0.945 em) matches
 * the painted height within ~1 %.
 */
export const LIVE_CAPTION_LINE_HEIGHT = 0.945;

export interface LiveCaptionCss {
  /** CSS `font-size` px at display scale (ASS size converted the way libass draws it). */
  fontSizePx: number;
  /** 700 when the renderer picks Bold, else 400 (see finding below). */
  fontWeight: 400 | 700;
  /** CSS outline px at display scale (ASS outline in script pixels, no font factor). */
  strokePx: number;
  /** CSS shadow offset px at display scale (ASS `Shadow = 2`, zero for boxes). */
  shadowPx: number;
  /** True when the renderer draws an opaque box (`BorderStyle = 3`). */
  boxed: boolean;
  /** CSS box padding px at display scale (meaningful when `boxed`). */
  boxPadPx: number;
}

/**
 * Mirror of the renderer style line in `src/compositor/ass_generator.ts`
 * (do not change the renderer):
 * - `Fontsize` = `typo.font_size_px`, converted with ASS_FONT_SIZE_TO_CSS_PX.
 * - Finding: the renderer ignores the exact weight value; `Bold` is -1 iff
 *   `typo.font_weight >= 600` (ass_generator.ts `boldFlag`), so weights 600..900
 *   all draw the same bold face. Live matches that with 700/400.
 * - Finding: without a box the renderer always draws `Outline =
 *   max(1, stroke_width_px)` plus `Shadow = 2`, even when `stroke_width_px`
 *   is 0. Live must draw both, with the shadow in the renderer's BackColour.
 */
export function resolveLiveCaptionCss(
  typography: {
    font_size_px?: unknown;
    font_weight?: unknown;
    stroke_width_px?: unknown;
    box_color_hex?: unknown;
    box_opacity?: unknown;
  } | null | undefined,
  displayScale: number,
  placementScaleY = 1
): LiveCaptionCss {
  const t = typography ?? {};
  const size = Number(t.font_size_px);
  const weight = Number(t.font_weight);
  const stroke = Number(t.stroke_width_px);
  const s = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  const psy = Number.isFinite(placementScaleY) && placementScaleY > 0 ? placementScaleY : 1;
  const boxed =
    typeof t.box_color_hex === "string" &&
    t.box_color_hex.trim() !== "" &&
    Number(t.box_opacity) > 0;
  if (boxed) {
    return {
      fontSizePx: (Number.isFinite(size) ? size : 44) * psy * s * ASS_FONT_SIZE_TO_CSS_PX,
      fontWeight: Number.isFinite(weight) && weight >= 600 ? 700 : 400,
      strokePx: 0,
      shadowPx: 0,
      boxed: true,
      boxPadPx: RENDERER_CAPTION_BOX_PAD_SCRIPT_PX * s,
    };
  }
  return {
    fontSizePx: (Number.isFinite(size) ? size : 44) * psy * s * ASS_FONT_SIZE_TO_CSS_PX,
    fontWeight: Number.isFinite(weight) && weight >= 600 ? 700 : 400,
    strokePx: Math.max(1, Number.isFinite(stroke) ? stroke : 0) * s,
    shadowPx: 2 * s,
    boxed: false,
    boxPadPx: 0,
  };
}

/** Mirror of the renderer's font pick in `ass_generator.ts`. */
export function resolveLiveCaptionFontFamily(typography: {
  font_family?: unknown;
} | null | undefined): string {
  const raw = String(typography?.font_family ?? "");
  return raw.replace(/,/g, "").trim() || RENDERER_CAPTION_FONT_FALLBACK;
}

/**
 * Stable signature of every typography field the Live caption layer paints.
 * The preview's caption cache key must include this: otherwise a revision
 * that changes only typography (same cue id, same word index, same stage
 * size) reuses the stale DOM node and the current frame never re-draws.
 */
export function captionStyleKey(
  typography: Record<string, unknown> | null | undefined,
): string {
  const t = typography ?? {};
  return JSON.stringify([
    t["font_family"],
    t["font_size_px"],
    t["font_weight"],
    t["color_hex"],
    t["active_word_color_hex"],
    t["stroke_color_hex"],
    t["stroke_width_px"],
    t["box_color_hex"],
    t["box_opacity"],
    t["align"],
    t["max_width_pct"],
    t["text"],
  ]);
}
