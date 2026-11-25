// Spine clip stage 1 — source timing: trim, playback rate / speed ramp, output fps and tail padding.
// Called by compile_spine.ts; the returned filters open the clip chain.
import type { CutholSequence } from "../core/schema.js";
import {
  getNormalizedSpeedRampSegments,
  integrateSourceOffsetToClipLocalMs,
} from "../sequence/spine_time.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];

/**
 * Average playback rate of a clip, derived from its source span and its (integrated) timeline duration so that
 * clips with a `speed_ramp` keep the exact duration computed by the sequence layer.
 */
export function computeSpineClipEffectiveRate(clip: SpineClipSpec): number {
  return Math.max(
    0.1,
    Math.min(16.0, (clip.source_out_ms - clip.source_in_ms) / Math.max(1, clip.duration_ms))
  );
}

function formatFfmpegNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(9).replace(/\.?0+$/, "");
  return s === "" || s === "-0" ? "0" : s;
}

/**
 * Compiles a clip's `speed_ramp` into the `setpts` expression body (output seconds over `TB`).
 * Same closed form as `integrateSourceOffsetToClipLocalMs`: constant pieces map `(S-s0)/r`,
 * varying pieces map `(L/D)*ln(r(S)/r0)` with `S=(T-STARTT)` source seconds. The `fps` filter
 * after `setpts` resamples the unevenly spaced frames back to even output spacing.
 */
export function compileSpeedRampToSetptsBody(
  clip: SpineClipSpec,
  options?: { sourceOffsetSec?: number; minusSec?: number }
): string {
  const spanMs = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  const segments = getNormalizedSpeedRampSegments(
    spanMs,
    clip.playback.rate,
    clip.playback.speed_ramp
  );
  // `sourceOffsetSec` shifts the source coordinate the expression reads (the
  // trimmed stream starts that far past the clip start); `minusSec` shifts the
  // output coordinate back so the segment still starts at 0. Both default to 0,
  // which produces the exact string the old single-argument form produced.
  const off = options?.sourceOffsetSec ?? 0;
  const minus = options?.minusSec ?? 0;
  const S = off > 0 ? `((T-STARTT)+${formatFfmpegNumber(off)})` : "(T-STARTT)";
  let cumSec = 0;
  const parts = segments.map((seg) => {
    const part = { s0: seg.u0 / 1000, s1: seg.u1 / 1000, r0: seg.r0, r1: seg.r1, cum: cumSec };
    cumSec += seg.dt / 1000;
    return part;
  });
  let expr = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const { s0, s1, r0, r1, cum } = parts[i];
    const sOff = `(${S}-${formatFfmpegNumber(s0)})`;
    let partial: string;
    if (Math.abs(r1 - r0) < 1e-6) {
      partial = `${sOff}/${formatFfmpegNumber(r0)}`;
    } else {
      const L = formatFfmpegNumber(s1 - s0);
      const D = formatFfmpegNumber(r1 - r0);
      const r0s = formatFfmpegNumber(r0);
      partial = `(${L})/(${D})*log((${r0s}+(${D})*${sOff}/${L})/${r0s})`;
    }
    const branch = cum > 0 ? `${formatFfmpegNumber(cum)}+${partial}` : partial;
    expr =
      i === parts.length - 1
        ? branch
        : `if(lt(${S},${formatFfmpegNumber(s1)}),${branch},${expr})`;
  }
  if (minus > 0) return `(((${expr})-(${formatFfmpegNumber(minus)})))/TB`;
  return `(${expr})/TB`;
}

/**
 * Leading-gap fill (seconds) when the video stream starts after the requested
 * clip start: the first available frame is held over [srcIn, videoStart) so
 * output t shows source (container) time `srcIn + t·rate`. Neither `tpad`
 * (shifts the originals) nor `fps` (drops the gap and re-anchors) can do this
 * linearly, so the gap branch splits the input: the first frame is looped for
 * the held output duration, the main segment keeps its exact mapping from the
 * first available frame, and `concat` joins them. Returns 0 (no filter change)
 * when the probed start is unknown, zero, or at most 1 ms after the requested
 * start.
 */
export function videoLeadingGapSec(
  containerSrcInSec: number,
  videoStartSec?: number | null
): number {
  if (videoStartSec === undefined || videoStartSec === null) return 0;
  const gap = videoStartSec - containerSrcInSec;
  return gap > 0.001 ? gap : 0;
}

export function buildSpineClipTimingFilters(params: {
  clip: SpineClipSpec;
  asset: CutholSequence["library"][number];
  isStill: boolean;
  fps: number;
  /** Trim points in the (possibly seeked) input's local time, seconds as fixed strings. */
  srcInSec: string;
  srcOutSec: string;
  effectiveRate: number;
  /** Requested clip start on the container clock (seconds); defaults to the trim start. */
  containerSrcInSec?: number;
  /** Probed container-clock start of the video stream (seconds); unknown = no change. */
  videoStartSec?: number | null;
  /** First available video frame in the (possibly seeked) input's local time. */
  localVideoStartSec?: number;
}): string[] {
  const { clip, asset, isStill, fps, srcInSec, srcOutSec, effectiveRate } = params;
  const containerSrcInSec = params.containerSrcInSec ?? Number(srcInSec);
  const leadGapSec = isStill
    ? 0
    : videoLeadingGapSec(containerSrcInSec, params.videoStartSec);
  const ramp = clip.playback.speed_ramp;
  const hasRamp = !!ramp && ramp.length >= 2;
  const srcFps = Math.max(1, asset.probe.fps || fps);
  const rawSrcSpanSec = Math.max(0, (clip.source_out_ms - clip.source_in_ms) / 1000);
  const scaledSrcSpanSec = rawSrcSpanSec / effectiveRate;
  const clipDurSec = clip.duration_ms / 1000;
  // When a ramped clip ends slowly, the gap between the last source frame and the range end
  // grows in the output; compute the tail padding at the slowest rate so the last frame is not lost.
  // In an unramped clip tailRate === effectiveRate, so the output stays byte-identical.
  let tailRate = effectiveRate;
  if (hasRamp && !isStill) {
    const spanMs = Math.max(1, clip.source_out_ms - clip.source_in_ms);
    let slowest = Infinity;
    for (const seg of getNormalizedSpeedRampSegments(spanMs, clip.playback.rate, ramp)) {
      slowest = Math.min(slowest, seg.r0, seg.r1);
    }
    if (Number.isFinite(slowest) && slowest > 0) tailRate = slowest;
  }
  const tailPadSec = isStill
    ? (clipDurSec + 2 / fps).toFixed(3)
    : Math.max(
        0.1,
        Math.max(0, clipDurSec - scaledSrcSpanSec) + 3 / (srcFps * tailRate) + 2 / fps
      ).toFixed(3);

  const needsPreTrimEofPad =
    !isStill &&
    asset.probe.duration_ms > 0 &&
    clip.source_out_ms >= Math.max(0, asset.probe.duration_ms - 5000);
  const setptsFilter = hasRamp
    ? `setpts='${compileSpeedRampToSetptsBody(clip)}'`
    : `setpts=(PTS-STARTPTS)/${effectiveRate.toFixed(4)}`;
  if (leadGapSec <= 0) {
    return [
      `settb=AVTB`,
      ...(needsPreTrimEofPad ? [`tpad=stop_mode=clone:stop_duration=3.000`] : []),
      `trim=start=${srcInSec}:end=${srcOutSec}`,
      setptsFilter,
      `fps=${fps}:eof_action=pass`,
      `tpad=stop_mode=clone:stop_duration=${tailPadSec}`,
    ];
  }
  // Container-clock rebase for a leading stream-start gap: the main segment
  // starts at the first available frame (local time `localV`) with its exact
  // old mapping, and a looped first frame covers the held output prefix.
  // Output t of the joined stream shows container time `srcIn + t·rate`.
  const localV = params.localVideoStartSec ?? containerSrcInSec + leadGapSec;
  const localVStr = formatFfmpegNumber(Math.max(0, localV));
  const holdOutSec = hasRamp
    ? integrateSourceOffsetToClipLocalMs(clip, leadGapSec * 1000) / 1000
    : leadGapSec / effectiveRate;
  const holdStr = formatFfmpegNumber(Math.max(1 / fps, holdOutSec));
  // `trim` end is inclusive on frame timestamps, so the looped hold can yield
  // one frame too many: pin the exact frame count after `fps`. The main
  // segment is shifted back by the *actual* held prefix (holdFrames/fps), so
  // the joined output follows the ideal map exactly, not the rounded one.
  const holdFrames = Math.max(1, Math.round(holdOutSec * fps));
  const holdActualSec = holdFrames / fps;
  const mainSetpts = hasRamp
    ? `setpts='${compileSpeedRampToSetptsBody(clip, { sourceOffsetSec: leadGapSec, minusSec: holdActualSec })}'`
    : setptsFilter;
  return [
    `settb=AVTB`,
    ...(needsPreTrimEofPad ? [`tpad=stop_mode=clone:stop_duration=3.000`] : []),
    `split=2[vgap_h][vgap_m];` +
      `[vgap_h]trim=start=${localVStr}:end=${formatFfmpegNumber(Math.max(0, localV) + 1)}` +
      `,setpts=PTS-STARTPTS,loop=loop=-1:size=1,trim=start=0:end=${holdStr}` +
      `,fps=${fps}:eof_action=pass,trim=start_frame=0:end_frame=${holdFrames},settb=AVTB[vgap_he];` +
      `[vgap_m]trim=start=${localVStr}:end=${srcOutSec},${mainSetpts}` +
      `,fps=${fps}:eof_action=pass,settb=AVTB[vgap_me];` +
      `[vgap_he][vgap_me]concat=n=2:v=1:a=0` +
      // Re-stamp to the exact frame grid: `concat` accumulates per-frame
      // durations (+1µs drift), and the downstream `overlay` then picks the
      // previous secondary frame for every output frame. `N`-based stamps
      // match the composition grid exactly, like the `fps` output below.
      `,setpts=N/${fps}/TB`,
    `tpad=stop_mode=clone:stop_duration=${tailPadSec}`,
  ];
}
