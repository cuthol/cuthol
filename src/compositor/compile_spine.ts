// Per-clip spine filter-graph compilation: source input, speed, transforms, envelopes, and transitions (split out of compiler.ts).
//
// Clip chain stage order (each stage lives in its own module):
//   1. timing      compile_spine_timing.ts      trim, rate / speed ramp, fps, tail pad
//   2. geometry    (here)                       crop, fit (contain/cover/fill) scale, mirror
//   3. colour      compile_spine_color.ts       color_grade, colour envelopes, LUT, temperature
//   4. fx          compile_fx_stage.ts          per-clip effect chain (`clip.fx`, built-in or extension)
//   5. alpha       (here)                       chroma cutout or RGBA conversion, rotation, opacity
//   6. transitions compile_spine_transition.ts  outgoing then incoming filters
//   7. edge        compile_spine_edge.ts        `placement.edge` fill before the clip is moved
//   8. scale/pan   compile_filters.ts           sub-pixel scale / pan, output pixel format, timeline offset
// The overlay position is built in overlaySpineClip: base x/y → edge hook (compile_spine_edge.ts) → still-image spec
// → incoming transition position → outgoing transition position (compile_spine_transition.ts).
import { CutholSequence, isStillGraphic, TransitionSpec } from "../core/schema.js";
import { buildCueOverlayEnableExpr } from "../core/frame_time.js";
import { buildSpineClipTimingFilters, computeSpineClipEffectiveRate } from "./compile_spine_timing.js";
import { buildSpineClipColorFilters } from "./compile_spine_color.js";
import { buildItemFxStage, emitFxStageParts, fxStageWouldKeepAlpha, itemCarriesAlphaAtFx, SPINE_FX_ENTRY_CONVERTER, SPINE_FX_RGBA_EXIT, spineFxReceivedPixFmt } from "./compile_fx_stage.js";
import type { FxShaderCutSpec, FxStagePart } from "./compile_fx_stage.js";
import type { PrePassJob } from "./compiler.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getFfmpegVersionInfo } from "../core/ffmpeg_version.js";
import { resolveCoordsChromePath } from "./coords_extract.js";
import {
  applySpineClipEdgeToOverlay,
  buildSpineClipEdgeFilters,
  spineClipEdgeRequiresRgba,
} from "./compile_spine_edge.js";
import {
  buildSpineClipMaskFilters,
  buildSpineClipMotionBlurFilters,
  spineClipMaskRequiresRgba,
} from "./compile_spine_mask.js";
import {
  applyIncomingTransitionPosition,
  applyOutgoingTransitionPosition,
  buildIncomingTransitionFilters,
  buildOutgoingTransitionFilters,
  extIncomingTransitionScaleFactor,
  incomingTransitionScaleFactor,
  transitionHoldTailMs,
} from "./compile_spine_transition.js";
import { resolveLibraryItemPath, resolveSourceColorSpec } from "../library/probe.js";
import {
  BT709_TO_YUV420P,
  buildSourceScaleFilter,
  BT709_TO_RGBA,
  BT709_TO_YUVA420P,
  BT709_SETPARAMS,
} from "./compile_color.js";
import {
  compilePlacementChannelExpr,
  buildSubpixelScaleOrPanFilters,
  buildSeekableMediaInput,
} from "./compile_filters.js";
import { applySingleFrameEarlyTrim } from "./single_frame_trim.js";
import {
  PLACEMENT_CHANNELS,
  placementAnimatesAny,
  placementChannelHasEnvelopeInput,
  placementHasAnyEnvelopeInput,
  placementLayers,
  placementStaticValue,
} from "../sequence/placement_resolve.js";
import type { DrawnVisualLayer, VideoGraphCompileContext } from "./compiler.js";

type SpineClipSpec = CutholSequence["spine"]["clips"][number];
type EnvelopeSpec = SpineClipSpec["envelopes"][number];

/**
 * Registers the pre-pass job for a cut spine clip chain and returns the
 * intermediate file path. The job's graph is the chain prefix (source input
 * through the fx-stage cut) with no conversion appended, so the intermediate
 * keeps the prefix's own pixel format. The key hashes the complete pre-pass
 * arguments (input args including any `-ss`/`-t`, the full prefix graph, the
 * fx entry format), the plan window (a short-windowed pre-pass is never
 * mistaken for the full-length one), and the ffmpeg version.
 */
export function emitFxPrePass(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    clipInputArgs: string[];
    receivedPixFmt: string | null;
    fxCutAfterEntry: number;
    prefixFilters: string[];
  }
): string {
  const ffmpegToken = getFfmpegVersionInfo().ffmpeg?.token ?? "unknown";
  const key = JSON.stringify({
    inputArgs: params.clipInputArgs,
    prefixGraph: params.prefixFilters.join(","),
    receivedPixFmt: params.receivedPixFmt,
    cutAfterEntry: params.fxCutAfterEntry,
    win: ctx.compileOptions?.activeWindowMs ?? null,
    single: ctx.compileOptions?.singleFrameAtMs ?? null,
    ffmpeg: ffmpegToken,
  });
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const outPath = path.join(ctx.paths.blobsDir, `sh_fxpre_${hash}.nut`);
  const prefixGraph = params.prefixFilters.join(",");
  const job: PrePassJob = {
    id: `fxpre_${params.clip.id}_${hash}`,
    inputArgs: [...params.clipInputArgs],
    filterComplex: `sws_flags=accurate_rnd+full_chroma_int;[0:v]${prefixGraph}[preout]`,
    outPath,
    pixFmt: params.receivedPixFmt ?? "unknown",
  };
  if (!ctx.prePasses.some((j) => j.outPath === outPath)) ctx.prePasses.push(job);
  return outPath;
}

let cachedShaderChromeToken: string | null = null;

/**
 * Chrome identity for the shader pre-pass cache key: path, size and mtime
 * (a browser update changes the binary). Cached per process; falls back to a
 * constant when Chrome cannot be resolved, so planning never fails on it.
 */
function shaderChromeToken(): string {
  if (cachedShaderChromeToken) return cachedShaderChromeToken;
  try {
    const exe = resolveCoordsChromePath();
    const st = fs.statSync(exe);
    cachedShaderChromeToken = `${exe}|${st.size}|${st.mtimeMs}`;
  } catch {
    cachedShaderChromeToken = "unknown-chrome";
  }
  return cachedShaderChromeToken;
}

/**
 * Registers the pre-pass job for an automatic shader cut and returns the
 * intermediate file path. The job's graph is the chain prefix (source input
 * through the `format=rgba` / `rgba64le` exit); the worker runs the ordered
 * shader/ffmpeg steps between decode and the FFV1 encode. The key hashes the
 * complete pre-pass arguments plus shader file hashes, uniform values,
 * envelopes, Chrome identity and GL mode (SwiftShader), the plan window, and
 * the ffmpeg version.
 */
export interface ShaderNarrowWindow {
  /** Item-local index of the first shaded frame. */
  firstFrame: number;
  /** Shaded frame count. */
  frameCount: number;
}

/**
 * Item-local frame window a shader pre-pass must shade for a windowed compile.
 * `null` means the full clip: no window, no shader cut, or the window covers
 * the whole clip (then the full-clip key/file is shared). Bounds come from the
 * main graph's window (`winLeadStartMs` carries its temporal-filter lead-in),
 * so the suffix trim of the finished chain stays valid unchanged.
 */
export function computeShaderNarrowWindow(args: {
  activeWindowMs: [number, number] | undefined;
  singleFrameAtMs: number | undefined;
  hasShaderCut: boolean;
  clipStartMs: number;
  clipDurationMs: number;
  winLeadStartMs: number;
  winEndMs: number;
  fps: number;
}): ShaderNarrowWindow | null {
  if (args.activeWindowMs === undefined && args.singleFrameAtMs === undefined) return null;
  if (!args.hasShaderCut) return null;
  const fps = Math.max(1, args.fps);
  const total = Math.max(1, Math.round((args.clipDurationMs * fps) / 1000));
  const first = Math.max(0, Math.min(total, Math.floor(((args.winLeadStartMs - args.clipStartMs) * fps) / 1000)));
  const last = Math.max(
    first + 1,
    Math.min(total, Math.ceil((((args.winEndMs + 2000 / fps) - args.clipStartMs) * fps) / 1000))
  );
  if (first <= 0 && last >= total) return null;
  return { firstFrame: first, frameCount: last - first };
}

/** Clip ids are sequence-local (`c1`, `sp_01`); keep the file mapping filesystem-safe. */
function safeClipFileToken(clipId: string): string {
  return clipId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "clip";
}

export function emitShaderPrePass(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    clipInputArgs: string[];
    prefixFilters: string[];
    cut: FxShaderCutSpec;
    /** Windowed shade range, or null for the full clip (shared full-clip file). */
    narrow: ShaderNarrowWindow | null;
  }
): { outPath: string; narrowed: boolean } {
  const ffmpegToken = getFfmpegVersionInfo().ffmpeg?.token ?? "unknown";
  const win = params.narrow ? (ctx.compileOptions?.activeWindowMs ?? null) : null;
  const single = params.narrow ? (ctx.compileOptions?.singleFrameAtMs ?? null) : null;
  const steps = params.narrow
    ? params.cut.steps.map((s) => (s.kind === "shader" ? { ...s, frameOffset: params.narrow!.firstFrame } : s))
    : params.cut.steps;
  const key = JSON.stringify({
    inputArgs: params.clipInputArgs,
    prefixGraph: params.prefixFilters.join(","),
    steps,
    pixFmt: params.cut.pixFmt,
    fps: ctx.fps,
    win,
    single,
    ffmpeg: ffmpegToken,
    chrome: shaderChromeToken(),
    gl: "swiftshader",
    shaderWorker: 2,
  });
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  // A finished full-clip intermediate (same job without window, trim or frame
  // offset) already shades every frame the window needs: reuse it (no new
  // pre-pass runs) instead of shading a narrowed one.
  if (params.narrow) {
    const fullKey = JSON.stringify({
      inputArgs: params.clipInputArgs,
      prefixGraph: params.prefixFilters.join(","),
      steps: params.cut.steps,
      pixFmt: params.cut.pixFmt,
      fps: ctx.fps,
      win: null,
      single: null,
      ffmpeg: ffmpegToken,
      chrome: shaderChromeToken(),
      gl: "swiftshader",
      shaderWorker: 2,
    });
    const fullHash = createHash("sha256").update(fullKey).digest("hex").slice(0, 16);
    const fullOutPath = path.join(ctx.paths.blobsDir, `sh_fxshad_${fullHash}.nut`);
    if (fs.existsSync(fullOutPath)) {
      return { outPath: fullOutPath, narrowed: false };
    }
  }
  const isSingle = params.narrow !== null && ctx.compileOptions?.singleFrameAtMs !== undefined;
  const outPath = params.narrow
    ? isSingle
      ? path.join(ctx.paths.blobsDir, `sh_fxshad1_${safeClipFileToken(params.clip.id)}_${hash}.nut`)
      : path.join(ctx.paths.blobsDir, `sh_fxshad_${hash}.nut`)
    : path.join(ctx.paths.blobsDir, `sh_fxshad_${hash}.nut`);
  // The trailing `setpts` restarts timestamps at zero: the worker decodes to
  // rawvideo, whose CFR fill would otherwise duplicate the first window frame
  // back to zero (a 6-frame window at frame 57 decoded as 63 frames).
  const prefixGraph = params.narrow
    ? `${params.prefixFilters.join(",")},trim=start_frame=${params.narrow.firstFrame}:end_frame=${params.narrow.firstFrame + params.narrow.frameCount},setpts=PTS-STARTPTS`
    : params.prefixFilters.join(",");
  const job: PrePassJob = {
    id: `fxshad_${params.clip.id}_${hash}`,
    inputArgs: [...params.clipInputArgs],
    filterComplex: `sws_flags=accurate_rnd+full_chroma_int;[0:v]${prefixGraph}[preout]`,
    outPath,
    pixFmt: params.cut.pixFmt,
    kind: "shader",
    shader: { steps, fps: ctx.fps, pixFmt: params.cut.pixFmt },
  };
  if (!ctx.prePasses.some((j) => j.outPath === outPath)) ctx.prePasses.push(job);
  return { outPath, narrowed: params.narrow !== null };
}

function buildSpineClipFilterChain(
  ctx: VideoGraphCompileContext,
  params: {
    i: number;
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    isStill: boolean;
    inIdx: number;
    /** Exact args of the clip's own source input (for the pre-pass job); single `-i`. */
    clipInputArgs: string[];
    /** Forced pre-pass cut position (pixel entries before the cut), or null/undefined. */
    fxCutAfterEntry?: number | null;
    srcInSec: string;
    srcOutSec: string;
    tlInSec: string;
    clipStartMs: number;
    clipEndMs: number;
    effectiveRate: number;
    hasNextClip: boolean;
    outTrans: TransitionSpec | null;
    incomingTransition: TransitionSpec | null;
  }
): {
  clipPad: string;
  spHasDynScale: boolean;
  spRotExpr: string | null;
  xEnv: boolean;
  yEnv: boolean;
  baseCenterX: number;
  baseCenterY: number;
  spSpatialFilters: string[];
} {
  const {
    seq,
    renderWidth,
    renderHeight,
    fps,
    activeWin,
    winLeadStartMs,
    winEndMs,
    winLeadStartSec,
    winEndPadSec,
  } = ctx;
  const {
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    srcInSec,
    srcOutSec,
    tlInSec,
    clipStartMs,
    clipEndMs,
    effectiveRate,
    hasNextClip,
    outTrans,
    incomingTransition,
  } = params;

  const spSxExpr = compilePlacementChannelExpr(clip, "scale_x", { timeBaseOffsetMs: 0, mode: "raw" });
  const spSyExpr = compilePlacementChannelExpr(clip, "scale_y", { timeBaseOffsetMs: 0, mode: "raw" });
  const incomingScaleFactor =
    incomingTransitionScaleFactor(incomingTransition) ??
    (incomingTransition && incomingTransition.kind.startsWith("ext:")
      ? extIncomingTransitionScaleFactor(ctx, clip, incomingTransition)
      : null);
  const spHasDynScale = Boolean(spSxExpr || spSyExpr || incomingScaleFactor);
  const xEnv = placementChannelHasEnvelopeInput(clip, "x_pct");
  const yEnv = placementChannelHasEnvelopeInput(clip, "y_pct");

  const targetW = spHasDynScale
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(placementStaticValue(clip, "scale_x"))) / 2) * 2);
  const targetH = spHasDynScale
    ? renderHeight
    : Math.max(8, Math.round((renderHeight * Math.abs(placementStaticValue(clip, "scale_y"))) / 2) * 2);
  const spRadAbs = (Math.abs(placementStaticValue(clip, "rotation_deg")) * Math.PI) / 180;
  const spEffW =
    Math.abs(placementStaticValue(clip, "rotation_deg")) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(spRadAbs)) + targetH * Math.abs(Math.sin(spRadAbs)))
      : targetW;
  const spEffH =
    Math.abs(placementStaticValue(clip, "rotation_deg")) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(spRadAbs)) + targetH * Math.abs(Math.cos(spRadAbs)))
      : targetH;
  const baseCenterX = Math.round((renderWidth - spEffW) / 2);
  const baseCenterY = Math.round((renderHeight - spEffH) / 2);

  // Stage 1: timing
  const isSingleFrameStill =
    ctx.compileOptions?.singleFrameAtMs !== undefined && isStill;
  const timingFilters: string[] = isSingleFrameStill
    ? [
        `fps=${fps}:eof_action=pass`,
        `tpad=stop_mode=clone:stop_duration=${(clip.duration_ms / 1000 + 2 / fps).toFixed(3)}`,
      ]
    : buildSpineClipTimingFilters({
        clip,
        asset,
        isStill,
        fps,
        srcInSec,
        srcOutSec,
        effectiveRate,
      });
  const vFilters: string[] = [...timingFilters];
  const timingEndIdx = vFilters.length;
  // Stage 1b: motion blur (shutter over source frames, before geometry)
  vFilters.push(...buildSpineClipMotionBlurFilters(clip));
  const spSpatialFilterStartIdx = vFilters.length;
  const clipColorSpec = resolveSourceColorSpec(asset.probe, absAssetPath);
  if (clipColorSpec.isRgb) {
    vFilters.push("format=rgba");
  }

  // Apply crop if configured
  if (clip.placement.crop) {
    const cr = clip.placement.crop;
    const wRatio = Math.max(0.05, 1 - (cr.left_pct + cr.right_pct) / 100).toFixed(4);
    const hRatio = Math.max(0.05, 1 - (cr.top_pct + cr.bottom_pct) / 100).toFixed(4);
    const xRatio = (cr.left_pct / 100).toFixed(4);
    const yRatio = (cr.top_pct / 100).toFixed(4);
    vFilters.push(`crop=w=iw*${wRatio}:h=ih*${hRatio}:x=iw*${xRatio}:y=ih*${yRatio}`);
  }

  if (clip.placement.fit_mode === "contain") {
    vFilters.push(
      buildSourceScaleFilter(targetW, targetH, clipColorSpec, "decrease"),
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    );
  } else if (clip.placement.fit_mode === "cover") {
    vFilters.push(
      buildSourceScaleFilter(targetW, targetH, clipColorSpec, "increase"),
      `crop=${targetW}:${targetH}`
    );
  } else {
    vFilters.push(buildSourceScaleFilter(targetW, targetH, clipColorSpec));
  }

  if (clip.placement.mirror_x) vFilters.push("hflip");
  if (clip.placement.mirror_y) vFilters.push("vflip");

  // Stage 3: colour
  const colorFilters = buildSpineClipColorFilters(ctx, { clip, asset, absAssetPath, clipColorSpec });
  vFilters.push(...colorFilters);
  // Stage 4: per-clip fx chain (one stage shared with lane cues). `keep` entries hold
  // the clip's alpha aside when it carries one at this point (alpha png / alpha mov).
  // A forced pre-pass cut splits the emitted filters here: the prefix runs in a
  // separate ffmpeg pass, the main graph reads the intermediate file back.
  const receivedPixFmt = spineFxReceivedPixFmt(clipColorSpec, asset, colorFilters);
  const itemHasAlpha = itemCarriesAlphaAtFx(receivedPixFmt, clipColorSpec, asset);
  const fxCut = params.fxCutAfterEntry;
  const fxParts = buildItemFxStage(
    ctx,
    fxCut !== null && fxCut !== undefined
      ? { owner: clip, receivedPixFmt, itemHasAlpha, cutAfterEntry: fxCut }
      : { owner: clip, receivedPixFmt, itemHasAlpha }
  );
  const cutPartIdx = fxParts.findIndex((p) => p.type === "cut");
  const shaderCutIdx = fxParts.findIndex((p) => p.type === "shader_cut");
  const splitIdx = shaderCutIdx >= 0 ? shaderCutIdx : cutPartIdx;
  const fxBefore: FxStagePart[] = splitIdx < 0 ? fxParts : fxParts.slice(0, splitIdx);
  const fxAfter: FxStagePart[] = splitIdx < 0 ? [] : fxParts.slice(splitIdx + 1);
  const fxShaderCut = shaderCutIdx >= 0 && fxParts[shaderCutIdx].type === "shader_cut"
    ? (fxParts[shaderCutIdx] as Extract<FxStagePart, { type: "shader_cut" }>).cut
    : null;
  // Index of the fx stage's exit converter; switched to an RGBA exit below when the chain stays RGBA.
  const { exitFilterIdx: fxExitBefore } = emitFxStageParts(ctx, vFilters, fxBefore);
  const fxCutVFilterIdx = splitIdx < 0 ? -1 : vFilters.length;
  const { exitFilterIdx: fxExitAfter } = emitFxStageParts(ctx, vFilters, fxAfter);
  const fxExitIdx = splitIdx < 0 ? fxExitBefore : fxExitAfter;

  // Stage 4b: mask (in the clip's own frame, before placement, so it moves with the clip).
  // The first mask filter establishes the alpha plane when the chain is still planar YUV.
  vFilters.push(
    ...buildSpineClipMaskFilters({ clip, clipColorSpec, targetW, targetH, renderWidth })
  );

  // Stage 5: alpha
  let spRgbaIdx = -1;
  let spUsesRgba = true;
  if (clip.treatments.cutout.mode === "chroma" && clip.treatments.cutout.chroma_key_hex) {
    const keyColor = clip.treatments.cutout.chroma_key_hex.replace(/^#/, "0x");
    const toRgbaStep = clipColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA;
    vFilters.push(
      `${toRgbaStep},colorkey=${keyColor}:${clip.treatments.cutout.similarity.toFixed(2)}:${clip.treatments.cutout.blend.toFixed(2)}`
    );
  } else {
    spRgbaIdx = vFilters.length;
    vFilters.push(clipColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA);
  }

  // Apply rotation_deg / envelopes with dynamic output bounding box
  const spRotExpr = compilePlacementChannelExpr(clip, "rotation_deg", { timeBaseOffsetMs: 0, mode: "raw" });
  if (spRotExpr) {
    const radExpr = `((${spRotExpr})*PI/180)`;
    vFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
  } else if (Math.abs(placementStaticValue(clip, "rotation_deg")) > 0.01) {
    const rad = ((placementStaticValue(clip, "rotation_deg") * Math.PI) / 180).toFixed(4);
    vFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }

  const spOpExpr = compilePlacementChannelExpr(clip, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  if (spOpExpr) {
    const opExprT = spOpExpr.replace(/\bt\b/g, "T");
    vFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
  } else if (placementStaticValue(clip, "opacity") < 0.999) {
    vFilters.push(`colorchannelmixer=aa=${placementStaticValue(clip, "opacity").toFixed(3)}`);
  }

  return appendSpineClipTransitionsAndScale(ctx, {
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    tlInSec,
    clipStartMs,
    clipEndMs,
    hasNextClip,
    outTrans,
    incomingTransition,
    incomingScaleFactor,
    spSxExpr,
    spSyExpr,
    spHasDynScale,
    spRotExpr,
    spOpExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    targetW,
    targetH,
    vFilters,
    timingEndIdx,
    spSpatialFilterStartIdx,
    clipColorSpec,
    spRgbaIdx,
    spUsesRgba,
    fxExitIdx,
    fxCut:
      fxCutVFilterIdx >= 0
        ? {
            vFilterIdx: fxCutVFilterIdx,
            clipInputArgs: params.clipInputArgs,
            receivedPixFmt,
            afterEntry: fxCut ?? 0,
            shader: fxShaderCut,
          }
        : null,
  });
}

function appendSpineClipTransitionsAndScale(
  ctx: VideoGraphCompileContext,
  params: {
    i: number;
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    isStill: boolean;
    inIdx: number;
    tlInSec: string;
    clipStartMs: number;
    clipEndMs: number;
    hasNextClip: boolean;
    outTrans: TransitionSpec | null;
    incomingTransition: TransitionSpec | null;
    incomingScaleFactor: string | null;
    spSxExpr: string | null;
    spSyExpr: string | null;
    spHasDynScale: boolean;
    spRotExpr: string | null;
    spOpExpr: string | null;
    xEnv: boolean;
    yEnv: boolean;
    baseCenterX: number;
    baseCenterY: number;
    targetW: number;
    targetH: number;
    vFilters: string[];
    timingEndIdx: number;
    spSpatialFilterStartIdx: number;
    clipColorSpec: ReturnType<typeof resolveSourceColorSpec>;
    spRgbaIdx: number;
    spUsesRgba: boolean;
    /** Index of the fx stage's exit converter in `vFilters`, or -1 without fx. */
    fxExitIdx: number;
    /**
     * Forced pre-pass cut: vFilters index of the cut plus the source input
     * args and formats the pre-pass job needs, or null without a cut.
     */
    fxCut: {
      vFilterIdx: number;
      clipInputArgs: string[];
      receivedPixFmt: string | null;
      afterEntry: number;
      shader: FxShaderCutSpec | null;
    } | null;
  }
): {
  clipPad: string;
  spHasDynScale: boolean;
  spRotExpr: string | null;
  xEnv: boolean;
  yEnv: boolean;
  baseCenterX: number;
  baseCenterY: number;
  spSpatialFilters: string[];
} {
  const {
    seq,
    renderWidth,
    renderHeight,
    fps,
    activeWin,
    winLeadStartMs,
    winEndMs,
    winLeadStartSec,
    winEndPadSec,
  } = ctx;
  const {
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    tlInSec,
    clipStartMs,
    clipEndMs,
    hasNextClip,
    outTrans,
    incomingTransition,
    incomingScaleFactor,
    spSxExpr,
    spSyExpr,
    spHasDynScale,
    spRotExpr,
    spOpExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    targetW,
    targetH,
    vFilters,
    timingEndIdx,
    spSpatialFilterStartIdx,
    clipColorSpec,
    spRgbaIdx,
    fxExitIdx,
  } = params;
  let { spUsesRgba } = params;

  // Stage 6: transitions (outgoing, then incoming) — without Porter-Duff alpha dip
  vFilters.push(...buildOutgoingTransitionFilters(ctx, { i, clip, hasNextClip, outTrans }));
  vFilters.push(...buildIncomingTransitionFilters(ctx, { clip, incomingTransition }));

  const sxPart = spSxExpr
    ? incomingScaleFactor
      ? `abs(${spSxExpr})*(${incomingScaleFactor})`
      : `abs(${spSxExpr})`
    : incomingScaleFactor
      ? `${Math.abs(placementStaticValue(clip, "scale_x"))}*(${incomingScaleFactor})`
      : String(Math.abs(placementStaticValue(clip, "scale_x")));
  const syPart = spSyExpr
    ? incomingScaleFactor
      ? `abs(${spSyExpr})*(${incomingScaleFactor})`
      : `abs(${spSyExpr})`
    : incomingScaleFactor
      ? `${Math.abs(placementStaticValue(clip, "scale_y"))}*(${incomingScaleFactor})`
      : String(Math.abs(placementStaticValue(clip, "scale_y")));

  // Opaque, full-frame, untransformed, transition-less, envelope-less footage spine clips skip the RGBA round-trip.
  if (
    process.env.CUTHOL_EXP_NORGBA !== "0" &&
    spRgbaIdx >= 0 &&
    !isStill &&
    !clipColorSpec.isRgb &&
    asset.kind === "footage" &&
    !/\.(?:png|webp|gif|mov)$/i.test(absAssetPath) &&
    clip.placement.fit_mode !== "contain" &&
    !spRotExpr &&
    Math.abs(placementStaticValue(clip, "rotation_deg")) <= 0.01 &&
    !spOpExpr &&
    placementStaticValue(clip, "opacity") >= 0.999 &&
    !(outTrans && outTrans.duration_ms > 0) &&
    !(incomingTransition && incomingTransition.duration_ms > 0) &&
    !spHasDynScale &&
    !xEnv &&
    !yEnv &&
    !placementHasAnyEnvelopeInput(clip) &&
    Math.abs(placementStaticValue(clip, "scale_x") - 1) < 1e-3 &&
    Math.abs(placementStaticValue(clip, "scale_y") - 1) < 1e-3 &&
    Math.abs(placementStaticValue(clip, "x_pct")) < 0.01 &&
    Math.abs(placementStaticValue(clip, "y_pct")) < 0.01 &&
    !spineClipEdgeRequiresRgba(clip) &&
    !spineClipMaskRequiresRgba(clip)
  ) {
    vFilters.splice(spRgbaIdx, 1);
    spUsesRgba = false;
  }
  // Every stage after fx works on RGBA: hand RGBA over directly instead of YUV and back.
  if (spUsesRgba && fxExitIdx >= 0) {
    if (!vFilters[fxExitIdx]?.startsWith(SPINE_FX_ENTRY_CONVERTER)) {
      throw new Error(`internal: fx exit converter of ${clip.id} moved before the RGBA decision`);
    }
    vFilters[fxExitIdx] = SPINE_FX_RGBA_EXIT;
  }

  // Stage 7: edge mode
  vFilters.push(
    ...buildSpineClipEdgeFilters(ctx, { clip, targetW, targetH, hasDynamicScale: spHasDynScale })
  );

  // Stage 8: scale / pan
  vFilters.push(
    ...buildSubpixelScaleOrPanFilters({
      hasDynamicScale: spHasDynScale,
      sxPart,
      syPart,
      owner: clip,
      baseCenterX,
      baseCenterY,
      renderWidth,
      renderHeight,
      localTimeExpr: `((in-1)/${fps})`,
    })
  );
  vFilters.push(
    spUsesRgba || spHasDynScale || xEnv || yEnv || ctx.preset === "master_alpha"
      ? BT709_TO_YUVA420P
      : BT709_TO_YUV420P
  );

  const spSpatialFilters = vFilters.slice(spSpatialFilterStartIdx);
  vFilters.push(`settb=AVTB`, `setpts=PTS+${tlInSec}/TB`);
  // Early window trim on the finished chain (before the chain's own end-of-chain
  // window trim below, which is never examined or moved). A downstream
  // PTS-anchoring filter (`setpts` with STARTPTS) rejects the trim: dropping
  // frames before it would shift every later timestamp.
  if (
    ctx.compileOptions?.singleFrameAtMs !== undefined &&
    ctx.compileOptions?.singleFrameEarlyTrim !== false &&
    params.fxCut === null &&
    !(outTrans && outTrans.duration_ms > 0) &&
    !(incomingTransition && incomingTransition.duration_ms > 0)
  ) {
    const startFrame = Math.max(0, Math.floor(((winLeadStartMs - clipStartMs) * fps) / 1000));
    const winEndPadMs = winEndMs + 2000 / Math.max(1, fps);
    const endFrame = Math.max(startFrame + 1, Math.ceil(((winEndPadMs - clipStartMs) * fps) / 1000));
    const early = applySingleFrameEarlyTrim({
      entries: vFilters,
      timingEndIdx,
      startFrame,
      endFrame,
      fps,
    });
    if (early.applied) {
      vFilters.length = 0;
      vFilters.push(...early.entries);
    }
  }
  if (activeWin && (clipStartMs < winLeadStartMs - 1e-3 || clipEndMs > winEndMs + 1e-3)) {
    vFilters.push(`trim=start=${winLeadStartSec}:end=${winEndPadSec}`);
  }

  const clipPad = `[v_sp_${i}]`;
  const fxCut = params.fxCut;
  // Windowed compiles shade only the frames the window needs: the narrowed
  // intermediate starts at item-local `firstFrame`, so its timeline mapping
  // shifts by that offset (microsecond precision: AVTB quantizes identically
  // to the full-clip mapping). Full-file reuse needs no remap.
  const narrowCandidate = computeShaderNarrowWindow({
    activeWindowMs: ctx.compileOptions?.activeWindowMs,
    singleFrameAtMs: ctx.compileOptions?.singleFrameAtMs,
    hasShaderCut: fxCut?.shader != null,
    clipStartMs,
    clipDurationMs: clip.duration_ms,
    winLeadStartMs,
    winEndMs,
    fps,
  });
  if (fxCut !== null) {
    // A cut (forced test split or automatic shader cut): the prefix runs as a
    // pre-pass job, the main chain reads the intermediate file back. `settb=AVTB`
    // right after the new input matches the microsecond timeline the rest of
    // the chain was compiled for.
    let intermediate: string;
    if (fxCut.shader) {
      const emitted = emitShaderPrePass(ctx, {
        clip,
        clipInputArgs: fxCut.clipInputArgs,
        prefixFilters: vFilters.slice(0, fxCut.vFilterIdx),
        cut: fxCut.shader,
        narrow: narrowCandidate,
      });
      intermediate = emitted.outPath;
      if (emitted.narrowed && narrowCandidate) {
        const baseSec = (clip.timeline_in_ms + (narrowCandidate.firstFrame * 1000) / fps) / 1000;
        const setptsIdx = vFilters.findIndex((e) => e === `setpts=PTS+${tlInSec}/TB`);
        if (setptsIdx >= 0) vFilters[setptsIdx] = `setpts=PTS+${baseSec.toFixed(6)}/TB`;
      }
    } else {
      intermediate = emitFxPrePass(ctx, {
        clip,
        clipInputArgs: fxCut.clipInputArgs,
        receivedPixFmt: fxCut.receivedPixFmt,
        fxCutAfterEntry: fxCut.afterEntry,
        prefixFilters: vFilters.slice(0, fxCut.vFilterIdx),
      });
    }
    const preIdx = ctx.addInput(["-i", intermediate]);
    ctx.filterChains.push(`[${preIdx}:v]settb=AVTB,${vFilters.slice(fxCut.vFilterIdx).join(",")}${clipPad}`);
  } else {
    ctx.filterChains.push(`[${inIdx}:v]${vFilters.join(",")}${clipPad}`);
  }

  return {
    clipPad,
    spHasDynScale,
    spRotExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    spSpatialFilters,
  };
}

function overlaySpineClip(
  ctx: VideoGraphCompileContext,
  params: {
    clip: SpineClipSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    tlInSec: string;
    tlOutSec: string;
    hasNextClip: boolean;
    outTrans: TransitionSpec | null;
    incomingTransition: TransitionSpec | null;
    isStaticStillClip: boolean;
    drawnSpineLayer: DrawnVisualLayer;
    clipPad: string;
    spHasDynScale: boolean;
    spRotExpr: string | null;
    xEnv: boolean;
    yEnv: boolean;
    baseCenterX: number;
    baseCenterY: number;
    spSpatialFilters: string[];
  }
): void {
  const { renderWidth, renderHeight } = ctx;
  const {
    clip,
    asset,
    absAssetPath,
    tlInSec,
    tlOutSec,
    hasNextClip,
    outTrans,
    incomingTransition,
    isStaticStillClip,
    drawnSpineLayer,
    clipPad,
    spHasDynScale,
    spRotExpr,
    xEnv,
    yEnv,
    baseCenterX,
    baseCenterY,
    spSpatialFilters,
  } = params;

  let xExpr = spHasDynScale
    ? spRotExpr
      ? `(W-w)/2`
      : String(baseCenterX)
    : compilePlacementChannelExpr(clip, "x_pct", {
        timeBaseOffsetMs: clip.timeline_in_ms,
        mode: "pixel_offset",
        baseCenterPx: baseCenterX,
        canvasDimPx: renderWidth,
      }) ??
      (spRotExpr
        ? `(W-w)/2+${Math.round((placementStaticValue(clip, "x_pct") / 100) * renderWidth)}`
        : String(Math.round(baseCenterX + (placementStaticValue(clip, "x_pct") / 100) * renderWidth)));

  let yExpr = spHasDynScale
    ? spRotExpr
      ? `(H-h)/2`
      : String(baseCenterY)
    : compilePlacementChannelExpr(clip, "y_pct", {
        timeBaseOffsetMs: clip.timeline_in_ms,
        mode: "pixel_offset",
        baseCenterPx: baseCenterY,
        canvasDimPx: renderHeight,
      }) ??
      (spRotExpr
        ? `(H-h)/2+${Math.round((placementStaticValue(clip, "y_pct") / 100) * renderHeight)}`
        : String(Math.round(baseCenterY + (placementStaticValue(clip, "y_pct") / 100) * renderHeight)));

  // Edge mode may change the drawn frame size / content offset
  ({ xExpr, yExpr } = applySpineClipEdgeToOverlay(ctx, { clip, xExpr, yExpr, hasDynamicScale: spHasDynScale }));

  if (isStaticStillClip) {
    drawnSpineLayer.stillSpec = {
      id: clip.id,
      assetHandle: asset.handle,
      assetDigest: asset.digest_sha256,
      absAssetPath,
      spatialFilters: spSpatialFilters,
      xExpr,
      yExpr,
    };
  }

  // Incoming position-based transitions (wipe / slide)
  ({ xExpr, yExpr } = applyIncomingTransitionPosition(ctx, { clip, incomingTransition, xExpr, yExpr }));
  // Outgoing position-based transitions (extension kinds, e.g. a push)
  ({ xExpr, yExpr } = applyOutgoingTransitionPosition(ctx, { clip, hasNextClip, outTrans, xExpr, yExpr }));

  const nextPad = `[vc_${++ctx.vStepCounter}]`;
  const spineOverlayFmt = ctx.preset === "master_alpha" ? "format=auto:" : "";
  ctx.filterChains.push(
    `${ctx.currentVideoPad}${clipPad}overlay=x='${xExpr}':y='${yExpr}':${spineOverlayFmt}eval=frame:enable='${buildCueOverlayEnableExpr(tlInSec, tlOutSec)}':eof_action=pass,${BT709_SETPARAMS}${nextPad}`
  );
  ctx.currentVideoPad = nextPad;
}

export function compileSpineClip(ctx: VideoGraphCompileContext, i: number): void {
  const { seq, paths, fps, compileOptions, activeWin, winStartMs, winEndMs } = ctx;
  const clip = seq.spine.clips[i];
  const prevClip = i > 0 ? seq.spine.clips[i - 1] : null;
  const incomingTransition: TransitionSpec | null = prevClip?.transition_out ?? null;

  const asset = ctx.libMap.get(clip.asset_handle);
  if (!asset || !asset.probe.has_video) return;

  // Forced pre-pass cut for this clip (internal test trigger; lane cues never cut).
  const force = ctx.forceFxSplit;
  const fxCutAfterEntry =
    force && (!force.clip || force.clip === clip.id) ? force.afterEntry : null;
  const fxCutArmed =
    fxCutAfterEntry !== null && (clip.fx ?? []).some((f) => f.enabled !== false);

  // If this clip has a cross-transition (`dissolve`, `wipe_left`, `wipe_right`, `slide_up`, `zoom_in`)
  // into `clips[i+1]`, hold its final frame under `clips[i+1]` during the transition duration so there is ZERO dip to backdrop!
  const hasNextClip = i < seq.spine.clips.length - 1;
  const outTrans = clip.transition_out;
  const holdTailMs = transitionHoldTailMs(clip, hasNextClip);

  const clipStartMs = clip.timeline_in_ms;
  const clipEndMs = clip.timeline_in_ms + clip.duration_ms + holdTailMs;
  // A still clip whose fx stage would contain an `alpha_keep` part (labelled split/merge
  // pads) is not baked: `stillSpec.spatialFilters` is a linear list and cannot carry the
  // wrapper. Plain-chain fx still bakes.
  const stillFxKeepsAlpha =
    isStillGraphic(asset) &&
    fxStageWouldKeepAlpha(seq, paths?.rootDir as string | undefined, clip);
  // Every envelope counts as today (colour, gain, pixel fx, empty entries) except the
  // `fx.<id>.*` envelopes of motion layers; a motion-animated channel takes the clip out
  // of the bake via the resolver condition below.
  const stillMotionIds = new Set(placementLayers(clip).map((l) => l.id));
  const stillHasNonMotionEnvelope = clip.envelopes.some((e) => {
    const m = /^fx\.([^.]+)\./.exec(e.parameter);
    return !(m && stillMotionIds.has(m[1]));
  });
  const isStaticStillClip =
    isStillGraphic(asset) &&
    !fxCutArmed &&
    !stillHasNonMotionEnvelope &&
    (!clip.transition_out || clip.transition_out.duration_ms <= 0) &&
    (!incomingTransition || incomingTransition.duration_ms <= 0) &&
    !stillFxKeepsAlpha &&
    !placementAnimatesAny(clip, PLACEMENT_CHANNELS);
  const drawnSpineLayer: DrawnVisualLayer = {
    id: clip.id,
    startMs: clipStartMs,
    endMs: clipEndMs,
    kind: isStaticStillClip ? "still_graphic" : "moving",
  };
  ctx.drawnVisualLayers.push(drawnSpineLayer);

  if (activeWin && (clipEndMs <= winStartMs - 1e-3 || clipStartMs >= winEndMs + 1e-3)) {
    return;
  }

  const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
  const isStill = isStillGraphic(asset);
  const allowClipSeek =
    compileOptions?.singleFrameAtMs !== undefined ||
    asset.probe.duration_ms >= 180_000 ||
    seq.spine.clips.length > 24;
  const clipSeek = isStill
    ? null
    : buildSeekableMediaInput(
        absAssetPath,
        clip.source_in_ms,
        clip.source_out_ms,
        asset.probe.duration_ms,
        allowClipSeek
      );
  // A still image is a single frame: loop it so it covers the whole source range of the clip.
  // In single-frame compiles the picture is decoded once; `tpad=clone` in the
  // timing block covers the clip (the looped range is identical content).
  const singleFrameStill = compileOptions?.singleFrameAtMs !== undefined && isStill;
  // Exact args of this clip's own source input: a pre-pass job replays them 1:1.
  const clipInputArgs: string[] = isStill
    ? singleFrameStill
      ? ["-framerate", String(fps), "-i", absAssetPath]
      : [
          "-loop",
          "1",
          "-framerate",
          String(fps),
          "-t",
          (clip.source_out_ms / 1000 + 2 / fps).toFixed(3),
          "-i",
          absAssetPath,
        ]
    : [...clipSeek!.inputArgs];
  const inIdx = ctx.addInput(clipInputArgs);

  const srcInSec = clipSeek ? clipSeek.localSrcInSec : (clip.source_in_ms / 1000).toFixed(3);
  const srcOutSec = clipSeek ? clipSeek.localSrcOutSec : (clip.source_out_ms / 1000).toFixed(3);
  const tlInSec = (clip.timeline_in_ms / 1000).toFixed(3);
  const tlOutSec = (clipEndMs / 1000).toFixed(3);

  // Compute effectiveRate from integrated `clip.duration_ms` so speed_ramp durations match exactly
  const effectiveRate = computeSpineClipEffectiveRate(clip);

  const filterResult = buildSpineClipFilterChain(ctx, {
    i,
    clip,
    asset,
    absAssetPath,
    isStill,
    inIdx,
    clipInputArgs,
    fxCutAfterEntry: fxCutArmed ? fxCutAfterEntry : null,
    srcInSec,
    srcOutSec,
    tlInSec,
    clipStartMs,
    clipEndMs,
    effectiveRate,
    hasNextClip,
    outTrans,
    incomingTransition,
  });

  overlaySpineClip(ctx, {
    clip,
    asset,
    absAssetPath,
    tlInSec,
    tlOutSec,
    hasNextClip,
    outTrans,
    incomingTransition,
    isStaticStillClip,
    drawnSpineLayer,
    ...filterResult,
  });
}
