/**
 * The one definition of cue visibility on the frame grid.
 *
 * A lane cue covers the half-open interval `[start_ms, end_ms)`: output frame
 * `n` (frame time `n / fps` seconds) shows the cue iff
 * `start_ms <= n * 1000 / fps < end_ms`. Render, draft, `monitor frame` /
 * `monitor sheet`, the blank-frame detector and the duration helpers all share
 * these predicates so the cue end boundary never disagrees between paths.
 */

/**
 * Overlap epsilon in milliseconds. Cue edges are integer milliseconds and
 * window edges sit on the frame grid, so a true overlap is either exactly
 * zero or at least ~0.33 ms (the closest a 24/25/30/60 fps frame grid comes
 * to an integer millisecond without touching it); anything below one
 * microsecond is floating-point dust. Same convention as the render segment
 * overlap test.
 */
export const CUE_WINDOW_EPSILON_MS = 1e-3;

/** True when frame time `tMs` shows a cue running `[startMs, endMs)`. */
export function cueCoversTimeMs(startMs: number, endMs: number, tMs: number): boolean {
  return tMs >= startMs && tMs < endMs;
}

/**
 * True when the half-open cue interval `[startMs, endMs)` overlaps the
 * half-open window `[windowStartMs, windowEndMs)`. An exact-boundary touch
 * (cue end == window start) is not an overlap: no frame of the window shows
 * the cue.
 */
export function cueOverlapsWindowMs(
  startMs: number,
  endMs: number,
  windowStartMs: number,
  windowEndMs: number
): boolean {
  return (
    startMs < windowEndMs - CUE_WINDOW_EPSILON_MS &&
    endMs > windowStartMs + CUE_WINDOW_EPSILON_MS
  );
}

/**
 * FFmpeg `overlay:enable` expression showing exactly the frames with
 * `startSec <= t < endSec`. (`between(t, a, b)` is closed on both ends and
 * would wrongly include the frame at the end instant.)
 */
export function buildCueOverlayEnableExpr(startSec: string, endSec: string): string {
  return `gte(t,${startSec})*lt(t,${endSec})`;
}

/**
 * ASS subtitle times have centisecond (10 ms) resolution while output frames
 * sit on the `n * 1000 / fps` grid, so naive rounding can show a caption one
 * frame early or hide its last frame. These helpers snap a cue edge to a
 * centisecond value that covers exactly the frames `cueCoversTimeMs` gives:
 * the start snaps to a centisecond in `(previous frame time, first shown
 * frame time]`, the end to one in `(last shown frame time, next frame time]`.
 * Such a multiple of 10 always exists at 24/25/30/60 fps (the frame interval
 * exceeds 10 ms). Cue times are integer milliseconds in practice.
 */
export function snapAssStartMs(startMs: number, fps: number): number {
  const s = Math.max(0, Math.round(startMs));
  const rate = Math.max(1, Math.round(fps));
  const firstIdx = Math.max(0, Math.ceil((s * rate) / 1000 - 1e-9));
  const firstTime = (firstIdx * 1000) / rate;
  return Math.floor(firstTime / 10 + 1e-9) * 10;
}

/** Centisecond snap for a cue end edge; see `snapAssStartMs`. */
export function snapAssEndMs(endMs: number, fps: number): number {
  const e = Math.max(0, Math.round(endMs));
  const rate = Math.max(1, Math.round(fps));
  const nextIdx = Math.max(0, Math.ceil((e * rate) / 1000 - 1e-9));
  const nextTime = (nextIdx * 1000) / rate;
  return Math.floor(nextTime / 10 + 1e-9) * 10;
}

/**
 * True when the single-frame fast path applies at `singleFrameAtMs`: the
 * instant is inside `[cueStartMs, cueEndMs)`, with one frame of pre-roll
 * tolerance before the start (served from the cue's first frame and hidden
 * by the overlay enable outside `[start, end)`).
 */
export function singleFrameInstantHitsCue(
  singleFrameAtMs: number,
  cueStartMs: number,
  cueEndMs: number,
  frameDurMs: number
): boolean {
  return singleFrameAtMs + frameDurMs >= cueStartMs && singleFrameAtMs < cueEndMs;
}
