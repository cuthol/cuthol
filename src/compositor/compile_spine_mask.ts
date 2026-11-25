// Spine clip stage 4b — mask and motion blur (`treatments.mask`, `treatments.motion_blur`).
//
// Runs on spine clips only, after the fx chain (Stage 4) and before the alpha stage (Stage 5),
// in the clip's own frame (before placement), so the mask moves with the clip.
//
// Mask: multiplies the clip's alpha by a procedural mask, so the layer below shows through.
// The chain may still be planar YUV at this point (opaque-footage RGBA skip), and a mask needs
// an alpha plane: the first emitted filter converts to RGBA (`format=rgba` for RGB sources,
// BT.709 `yuva420p` otherwise — the same decision as Stage 5). `spineClipMaskRequiresRgba`
// disables the Stage 5 RGBA skip for masked clips, mirroring `spineClipEdgeRequiresRgba`.
// Soft edge (`feather_px`) is in pixels at render size, scaled here by `targetW / renderWidth`
// into the clip's own frame. `invert` swaps inside/outside. `split` is a vertical half-plane
// through the mask center: the left side is kept, the right side is cut (or the reverse when
// inverted); there is no angle parameter — a rotated split is a rotated clip with a split mask.
// Mask parameters `center_x_pct`, `center_y_pct`, `width_pct`, `height_pct`, `feather_px` may
// each carry a clip envelope (`treatments.mask.*`, clip-local ms offsets); the per-frame value
// is compiled with the same `t`-based expression builder as placement envelopes and evaluated
// in `geq` time (`T`). `shape` and `invert` are static per clip.
//
// Motion blur: a shutter over source frames. `tmix` blends the current source frame with the
// previous `subframes - 1` source frames; `shutter_deg` (0..360) scales the contribution of the
// past frames from 0 (sharp, past frames ignored) to 1 (uniform blend over the window). The
// blend window therefore spans `subframes - 1` frame intervals at full shutter. The filter is
// inserted right after the timing stage, so it blends source frames before geometry/placement.
// Blur caused only by placement envelopes (a still image panned by keyframes) is NOT covered:
// the source frames are identical there, so a source-frame blend is a no-op; that would need a
// post-placement temporal blend (e.g. `tblend` after the overlay, per output frame), which is
// out of scope.
import type { CutholSequence } from "../core/schema.js";
import { compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
import { BT709_TO_RGBA } from "./compile_color.js";
import type { resolveSourceColorSpec } from "../library/probe.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

/** True when the mask stage needs the clip in RGBA (disables the opaque-footage RGBA skip). */
export function spineClipMaskRequiresRgba(clip: SpineClipSpec): boolean {
  return clip.treatments.mask !== null;
}

/** True when motion blur emits a filter for this clip. */
export function spineClipHasMotionBlur(clip: SpineClipSpec): boolean {
  const mb = clip.treatments.motion_blur;
  return mb.enabled && mb.shutter_deg > 0 && mb.subframes >= 2;
}

function maskChannelExpr(
  clip: SpineClipSpec,
  parameter: string,
  staticValue: number
): string {
  const env = clip.envelopes.find((e) => e.parameter === parameter);
  const expr = compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" });
  if (expr === null) return String(staticValue);
  // geq evaluates per pixel in frame-timestamp space (`T`); envelope builder emits `t`.
  return `(${expr.replace(/\bt\b/g, "T")})`;
}

/**
 * Mask filters for one spine clip at `targetW x targetH` (the clip's own frame before placement).
 * Returns [] when the clip has no mask. The first filter always establishes an alpha plane.
 */
export function buildSpineClipMaskFilters(params: {
  clip: SpineClipSpec;
  clipColorSpec: ReturnType<typeof resolveSourceColorSpec>;
  targetW: number;
  targetH: number;
  renderWidth: number;
}): string[] {
  const { clip, clipColorSpec, targetW, targetH, renderWidth } = params;
  const mask = clip.treatments.mask;
  if (!mask) return [];
  const toRgba = clipColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA;
  // Static (non-enveloped) parameters fold to pixel constants at compile time, so the
  // per-pixel tree stays tiny (a ~1000-node tree costs ~250 s per 10 s of 1080p; the
  // folded form costs ~15 s). Animated parameters stay as clip-local `T` expressions.
  const num = (v: number): string => {
    const r = Math.round(v * 1000) / 1000;
    return String(r);
  };
  // Per-axis pixel expressions: folded numbers when the channel is static, else %→px of W/H.
  const xPct = (parameter: string, staticValue: number, axis: "W" | "H"): string => {
    const axisPx = axis === "W" ? targetW : targetH;
    const env = clip.envelopes.find((e) => e.parameter === parameter);
    if (!env) return num((staticValue / 100) * axisPx);
    return `((${maskChannelExpr(clip, parameter, staticValue)})/100*${axis})`;
  };
  const cxP = xPct("treatments.mask.center_x_pct", mask.center_x_pct, "W");
  const cyP = xPct("treatments.mask.center_y_pct", mask.center_y_pct, "H");
  const wP = xPct("treatments.mask.width_pct", mask.width_pct, "W");
  const hP = xPct("treatments.mask.height_pct", mask.height_pct, "H");
  const featherStatic = !clip.envelopes.some((e) => e.parameter === "treatments.mask.feather_px");
  const scale = targetW / Math.max(1, renderWidth);
  const f = featherStatic ? num(mask.feather_px * scale) : `((${maskChannelExpr(clip, "treatments.mask.feather_px", mask.feather_px)})*${scale.toFixed(4)})`;
  // Fast path: hard rect/split masks are exact with crop+pad (per-frame expressions,
  // no per-pixel math). Requires static sizes (crop w/h evaluate once) and, for rect,
  // no invert (crop keeps the inside; an inverted rect keeps the outside). Centers may
  // animate (crop x/y evaluate per frame in `t` time).
  const centerAnimated = (p: string): boolean => clip.envelopes.some((e) => e.parameter === p);
  const wStatic = !centerAnimated("treatments.mask.width_pct");
  const hStatic = !centerAnimated("treatments.mask.height_pct");
  const cxStatic = !centerAnimated("treatments.mask.center_x_pct");
  if (mask.feather_px === 0 && !centerAnimated("treatments.mask.feather_px")) {
    const inum = (v: number): string => String(Math.round(v));
    if (mask.shape === "rect" && !mask.invert && wStatic && hStatic) {
      const ww = (mask.width_pct / 100) * targetW;
      const hh = (mask.height_pct / 100) * targetH;
      const x0 = (mask.center_x_pct / 100) * targetW - ww / 2;
      const y0 = (mask.center_y_pct / 100) * targetH - hh / 2;
      // The crop window must sit fully inside the frame; otherwise use the geq path.
      const fitsStatic =
        !centerAnimated("treatments.mask.center_x_pct") &&
        !centerAnimated("treatments.mask.center_y_pct") &&
        x0 >= 0 && y0 >= 0 && x0 + ww <= targetW + 1e-6 && y0 + hh <= targetH + 1e-6;
      if (fitsStatic || centerAnimated("treatments.mask.center_x_pct") || centerAnimated("treatments.mask.center_y_pct")) {
        const x = centerAnimated("treatments.mask.center_x_pct")
          ? `floor(clip(((${maskChannelExpr(clip, "treatments.mask.center_x_pct", mask.center_x_pct)})/100*W-${num(ww)}/2),0,W-${num(ww)}))`
          : inum(x0);
        const y = centerAnimated("treatments.mask.center_y_pct")
          ? `floor(clip(((${maskChannelExpr(clip, "treatments.mask.center_y_pct", mask.center_y_pct)})/100*H-${num(hh)}/2),0,H-${num(hh)}))`
          : inum(y0);
        return [toRgba, `crop=w=${inum(ww)}:h=${inum(hh)}:x='${x}':y='${y}'`, `pad=${targetW}:${targetH}:x='-(${x})':y='-(${y})':color=black@0`];
      }
    }
    if (mask.shape === "split" && cxStatic) {
      const cxPx = (mask.center_x_pct / 100) * targetW;
      if (cxPx > 0 && cxPx < targetW) {
        const cxN = inum(cxPx);
        if (!mask.invert) {
          return [toRgba, `crop=w=${cxN}:h=${targetH}:x=0:y=0`, `pad=${targetW}:${targetH}:x=0:y=0:color=black@0`];
        }
        return [toRgba, `crop=w=${inum(targetW - cxPx)}:h=${targetH}:x=${cxN}:y=0`, `pad=${targetW}:${targetH}:x=${cxN}:y=0:color=black@0`];
      }
    }
  }
  // Slow path: soft or shaped masks via one compact per-pixel expression. Branchless
  // (no if/lte): factor=clip(1.5-d/(f+eps),0,1) is 1 inside, 0 outside, ramps over ~f px.
  // d is signed (negative inside): box Chebyshev distance, ellipse (q-1)/2*r, split X-cx.
  const eps = "0.001";
  let d: string;
  if (mask.shape === "split") {
    d = `(X-(${cxP}))`;
  } else if (mask.shape === "ellipse") {
    const hw = `(max((${wP}),1)/2)`;
    const hh = `(max((${hP}),1)/2)`;
    const nx = `((X-(${cxP}))/(${hw}))`;
    const ny = `((Y-(${cyP}))/(${hh}))`;
    const q = `((${nx})*(${nx})+(${ny})*(${ny}))`;
    const rPx = `(max((${wP}),(${hP}))/4)`;
    d = `(((${q})-1)/2*(${rPx}))`;
  } else {
    const dx = `(max(abs(X-(${cxP}))-(${wP})/2,0))`;
    const dy = `(max(abs(Y-(${cyP}))-(${hP})/2,0))`;
    d = `(max(${dx},${dy}))`;
  }
  const dist = mask.invert ? `(-(${d}))` : `(${d})`;
  const factor = `(clip(1.5-(${dist})/max(${f},${eps}),0,1))`;
  return [toRgba, `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*${factor},0,255)'`];
}

/**
 * Motion blur filter for one spine clip (source-frame blend, inserted after timing).
 * Returns [] when disabled. Uniform past-frame weights scaled by the shutter fraction.
 */
export function buildSpineClipMotionBlurFilters(clip: SpineClipSpec): string[] {
  if (!spineClipHasMotionBlur(clip)) return [];
  const mb = clip.treatments.motion_blur;
  const n = Math.max(2, Math.min(16, Math.round(mb.subframes)));
  const s = Math.max(0, Math.min(1, mb.shutter_deg / 360));
  const weights = Array.from({ length: n }, (_, k) => (k === n - 1 ? "1" : s.toFixed(4))).join(" ");
  return [`tmix=frames=${n}:weights='${weights}'`];
}
