// Per-lane filter-graph compilation: HyperFrames composition cues, visual asset cues, and lane typography (split out of compiler.ts).
import path from "node:path";
import { resolveCueStartMs } from "../core/timeline.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { listColorItems } from "../color/blocks.js";
import { compileColorStageFilters } from "../color/compile.js";
import { resolveInputTransform } from "../color/input_transform.js";
import { buildCueOverlayEnableExpr, cueOverlapsWindowMs, singleFrameInstantHitsCue } from "../core/frame_time.js";
import { CutholSequence, getCuePlaybackRate, isStillGraphic, maxSourceDurationMs } from "../core/schema.js";
import {
  probeStandaloneVideoColorMetadata,
  resolveLibraryItemPath,
  resolveSourceColorSpec,
  SourceColorSpec,
} from "../library/probe.js";
import { compileLaneTypography } from "./compile_lane_typography.js";
import { syncCompositionBridgeFiles } from "./bridge_exporter.js";
import {
  isDraftNativeOverlayCapture,
  isOverlayCollectActive,
  isPngSequenceBlobDir,
  renderHyperFramesCompositionToMp4,
  renderHyperFramesSingleFramePng,
} from "./hyperframes_bridge.js";
import {
  StaticStillLayerSpec,
  extractSceneHostBackdropSlice,
  extractStaticBackdropPngSlice,
} from "./compile_backdrop.js";
import { compileSpineClip } from "./compile_spine.js";
import {
  BT709_TO_YUV420P,
  buildSourceScaleFilter,
  BT709_TO_RGBA,
  BT709_TO_YUVA420P,
  BT709_TO_YUV444P10,
  BT709_TO_YUVA444P10,
  BT709_SETPARAMS,
} from "./compile_color.js";
import {
  compilePlacementChannelExpr,
  buildSubpixelScaleOrPanFilters,
  buildSeekableMediaInput,
} from "./compile_filters.js";
import { applySingleFrameEarlyTrim } from "./single_frame_trim.js";
import {
  buildItemFxStage,
  emitFxStageParts,
  fxStageWouldKeepAlpha,
  itemCarriesAlphaAtFx,
  itemFxNeedsCheck,
  pixelFxEntries,
  spineFxReceivedPixFmt,
} from "./compile_fx_stage.js";
import type { DrawnVisualLayer, VideoGraphCompileContext } from "./compiler.js";
import {
  PLACEMENT_CHANNELS,
  placementAnimatesAny,
  placementChannelHasEnvelopeInput,
  placementHasAnyEnvelopeInput,
  placementLayers,
  placementStaticValue,
} from "../sequence/placement_resolve.js";

type LaneSpec = CutholSequence["lanes"][number];
type LaneCueSpec = LaneSpec["cues"][number];

function masterFrameSize(seq: CutholSequence): { width: number; height: number } {
  return {
    width: Math.max(16, Math.round(seq.stage.width / 2) * 2),
    height: Math.max(16, Math.round(seq.stage.height / 2) * 2),
  };
}

function contextAtCanvas(
  ctx: VideoGraphCompileContext,
  width: number,
  height: number
): VideoGraphCompileContext {
  const scratch: VideoGraphCompileContext = {
    ...ctx,
    preset: "master_1080p",
    renderWidth: width,
    renderHeight: height,
    inputArgs: [],
    filterChains: [],
    hyperframesBlobs: [],
    assFilePaths: [],
    drawnVisualLayers: [],
    nextInputIdx: 0,
    currentVideoPad: "[0:v]",
    vStepCounter: 0,
    addInput: (args: string[]) => {
      scratch.inputArgs.push(...args);
      return scratch.nextInputIdx++;
    },
  };
  return scratch;
}

function stillSpecAtCanvas(
  ctx: VideoGraphCompileContext,
  layer: DrawnVisualLayer,
  width: number,
  height: number
): StaticStillLayerSpec | undefined {
  const scratch = contextAtCanvas(ctx, width, height);
  const spineIdx = ctx.seq.spine.clips.findIndex((clip) => clip.id === layer.id);
  if (spineIdx >= 0) {
    compileSpineClip(scratch, spineIdx);
  } else {
    let cue: LaneCueSpec | undefined;
    for (const lane of ctx.seq.lanes) {
      cue = lane.cues.find((item) => item.id === layer.id);
      if (cue) break;
    }
    if (!cue?.asset_handle) return undefined;
    compileAssetLaneCue(
      scratch,
      cue,
      layer.startMs,
      layer.endMs,
      (layer.startMs / 1000).toFixed(3),
      (layer.endMs / 1000).toFixed(3),
      true
    );
  }
  return scratch.drawnVisualLayers.find((item) => item.id === layer.id)?.stillSpec;
}

function stillSpecsAtCanvas(
  ctx: VideoGraphCompileContext,
  layers: DrawnVisualLayer[],
  width: number,
  height: number
): StaticStillLayerSpec[] | undefined {
  const specs: StaticStillLayerSpec[] = [];
  for (const layer of layers) {
    const spec = stillSpecAtCanvas(ctx, layer, width, height);
    if (!spec) return undefined;
    specs.push(spec);
  }
  return specs;
}

function prepareCompositionCueInput(
  ctx: VideoGraphCompileContext,
  cue: LaneCueSpec,
  cueStartMs: number,
  cueEndMs: number
): {
  compMode: NonNullable<LaneCueSpec["composition"]>["mode"];
  hfIdx: number;
  frameDurMs: number;
  isFullFrameUnscaled: boolean;
  effectiveTransparent: boolean;
} {
  const { seq, paths, renderWidth, renderHeight, fps, compileOptions } = ctx;
  const composition = cue.composition!;
  // With an active fx chain the cue keeps its own frame: the effect must not hit a baked
  // background, so the opaque-ification below (backdrop or still slice) is skipped.
  const cueHasActiveFx = pixelFxEntries(cue).length > 0;
  try {
    syncCompositionBridgeFiles(seq, cue, paths);
  } catch {
    // non-blocking bridge sync
  }
  const compDir = path.isAbsolute(composition.composition_dir)
    ? composition.composition_dir
    : path.resolve(paths.rootDir, composition.composition_dir);

  const compMode = composition.mode ?? "overlay_alpha";
  let hfIdx: number;
  const frameDurMs = 1000 / Math.max(1, fps);

  const isFullFrameUnscaled =
    Math.abs(placementStaticValue(cue, "scale_x") - 1) < 1e-3 &&
    Math.abs(placementStaticValue(cue, "scale_y") - 1) < 1e-3 &&
    Math.abs(placementStaticValue(cue, "x_pct")) < 1e-3 &&
    Math.abs(placementStaticValue(cue, "y_pct")) < 1e-3 &&
    Math.abs(placementStaticValue(cue, "rotation_deg")) < 1e-3 &&
    placementStaticValue(cue, "opacity") >= 0.999 &&
    !cue.placement.crop &&
    !cue.placement.mirror_x &&
    !cue.placement.mirror_y &&
    !placementHasAnyEnvelopeInput(cue);

  const overlappingUnder = ctx.drawnVisualLayers.filter(
    (l) => l.startMs < cueEndMs && l.endMs > cueStartMs
  );
  const hasMovingUnderneath = overlappingUnder.some((l) => l.kind !== "still_graphic");
  const hasOnlyStaticStillUnderneath =
    overlappingUnder.length > 0 &&
    !hasMovingUnderneath &&
    overlappingUnder.every((l) => l.startMs <= cueStartMs && l.endMs >= cueEndMs);

  let effectiveTransparent = composition.transparent;
  let opaqueBackdropColor: string | undefined;
  let backdropImagePath: string | undefined;
  let bakedUnderneathIds: string[] = [];

  if (
    compileOptions?.singleFrameAtMs !== undefined &&
    compMode !== "scene_host" &&
    singleFrameInstantHitsCue(compileOptions.singleFrameAtMs, cueStartMs, cueEndMs, frameDurMs)
  ) {
    // Preserve exact floating-point `singleFrameAtMs` (without integer ms truncation)
    // so 30fps `frameIdx = 3k + 1` never drifts by 1 frame.
    const localSec = Math.max(0, (compileOptions.singleFrameAtMs - cueStartMs) / 1000);
    const singleFrame = renderHyperFramesSingleFramePng({
      compositionDir: compDir,
      entryHtml: composition.entry_html,
      blobsDir: paths.blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: cue.duration_ms,
      localSec,
      props: composition.props,
      transparent: composition.transparent,
      mode: compMode,
    });
    ctx.hyperframesBlobs.push(singleFrame.pngPath);
    hfIdx = ctx.addInput([
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-t",
      (cue.duration_ms / 1000 + 2 / fps).toFixed(3),
      "-i",
      singleFrame.pngPath,
    ]);
  } else {
    const backdropVideoPath =
      compMode === "scene_host"
        ? extractSceneHostBackdropSlice(
            seq,
            paths,
            cueStartMs,
            cue.duration_ms,
            renderWidth,
            renderHeight,
            fps,
            ctx.inputArgs.length <= 48
              ? {
                  inputArgs: [...ctx.inputArgs],
                  filterChains: [...ctx.filterChains],
                  videoPad: ctx.currentVideoPad,
                }
              : undefined
          )
        : undefined;

    const keepAlpha = ctx.preset === "master_alpha";
    if (compMode !== "scene_host" && isFullFrameUnscaled && !hasMovingUnderneath && !keepAlpha && !cueHasActiveFx) {
      if (overlappingUnder.length === 0) {
        effectiveTransparent = false;
        opaqueBackdropColor = seq.stage.backdrop.color;
      } else if (hasOnlyStaticStillUnderneath) {
        const stillSpecs = overlappingUnder
          .map((l) => l.stillSpec)
          .filter((s): s is StaticStillLayerSpec => Boolean(s));
        let sliceW = renderWidth;
        let sliceH = renderHeight;
        let sliceSpecs = stillSpecs;
        if (stillSpecs.length === overlappingUnder.length && isDraftNativeOverlayCapture()) {
          // The blob key hashes this PNG. Master compiles it at the master frame, so native capture must too.
          const master = masterFrameSize(seq);
          if (master.width !== renderWidth || master.height !== renderHeight) {
            const rebuilt = stillSpecsAtCanvas(ctx, overlappingUnder, master.width, master.height);
            if (rebuilt) {
              sliceW = master.width;
              sliceH = master.height;
              sliceSpecs = rebuilt;
            }
          }
        }
        const stillPng =
          sliceSpecs.length === overlappingUnder.length
            ? extractStaticBackdropPngSlice(seq, paths, sliceW, sliceH, fps, sliceSpecs)
            : undefined;
        if (stillPng) {
          effectiveTransparent = false;
          opaqueBackdropColor = seq.stage.backdrop.color;
          backdropImagePath = stillPng;
          bakedUnderneathIds = overlappingUnder.map((l) => l.id);
        }
      }
    }

    const hfBlob = renderHyperFramesCompositionToMp4({
      compositionDir: compDir,
      entryHtml: composition.entry_html,
      blobsDir: paths.blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: cue.duration_ms,
      props: composition.props,
      transparent: effectiveTransparent,
      mode: compMode,
      backdropVideoPath,
      opaqueBackdropColor,
      backdropImagePath,
      workers: compileOptions?.workers,
      useGpu: compileOptions?.useGpu,
    });
    ctx.hyperframesBlobs.push(hfBlob);
    const isPngSeqBlob = isPngSequenceBlobDir(hfBlob);
    hfIdx = isPngSeqBlob
      ? ctx.addInput([
          "-framerate",
          String(fps),
          "-start_number",
          "1",
          "-i",
          path.join(hfBlob, "frame_%06d.png"),
        ])
      : ctx.addInput(["-i", hfBlob]);

    const blobColorSpec = isPngSeqBlob
      ? ({ isRgb: true, inMatrix: "bt709", inRange: "pc", sourceRule: "rgb" } as const)
      : resolveSourceColorSpec(
          probeStandaloneVideoColorMetadata(hfBlob),
          hfBlob,
          { isHyperFramesBlob: true }
        );

    ctx.drawnVisualLayers.push({
      id: cue.id,
      startMs: cueStartMs,
      endMs: cueEndMs,
      kind:
        !effectiveTransparent &&
        isFullFrameUnscaled &&
        hfBlob.endsWith(".mp4") &&
        !blobColorSpec.isRgb &&
        blobColorSpec.inMatrix === "bt709" &&
        blobColorSpec.inRange === "tv"
          ? "opaque_comp"
          : "moving",
      blobPath: hfBlob,
      bakedUnderneathIds,
    });
  }

  return {
    compMode,
    hfIdx,
    frameDurMs,
    isFullFrameUnscaled,
    effectiveTransparent,
  };
}

function compileCompositionLaneCue(
  ctx: VideoGraphCompileContext,
  cue: LaneCueSpec,
  cueStartMs: number,
  cueEndMs: number,
  cueStartSec: string,
  cueEndSec: string,
  isCueInActiveWindow: boolean
): void {
  if (!isCueInActiveWindow) {
    ctx.drawnVisualLayers.push({
      id: cue.id,
      startMs: cueStartMs,
      endMs: cueEndMs,
      kind: "moving",
    });
    return;
  }

  const {
    renderWidth,
    renderHeight,
    fps,
    compileOptions,
    activeWin,
    winLeadStartMs,
    winEndMs,
    winLeadStartSec,
    winEndPadSec,
  } = ctx;

  const {
    compMode,
    hfIdx,
    frameDurMs,
    isFullFrameUnscaled,
    effectiveTransparent,
  } = prepareCompositionCueInput(ctx, cue, cueStartMs, cueEndMs);

  const hfSxExpr = compilePlacementChannelExpr(cue, "scale_x", { timeBaseOffsetMs: 0, mode: "raw" });
  const hfSyExpr = compilePlacementChannelExpr(cue, "scale_y", { timeBaseOffsetMs: 0, mode: "raw" });
  const hfHasDynScale = Boolean(hfSxExpr || hfSyExpr);
  const hasXEnv = placementChannelHasEnvelopeInput(cue, "x_pct");
  const hasYEnv = placementChannelHasEnvelopeInput(cue, "y_pct");

  const targetW = hfHasDynScale
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(placementStaticValue(cue, "scale_x"))) / 2) * 2);
  const targetH = hfHasDynScale
    ? renderHeight
    : Math.max(8, Math.round((renderHeight * Math.abs(placementStaticValue(cue, "scale_y"))) / 2) * 2);
  const hfRadAbs = (Math.abs(placementStaticValue(cue, "rotation_deg")) * Math.PI) / 180;
  const hfEffW =
    Math.abs(placementStaticValue(cue, "rotation_deg")) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(hfRadAbs)) + targetH * Math.abs(Math.sin(hfRadAbs)))
      : targetW;
  const hfEffH =
    Math.abs(placementStaticValue(cue, "rotation_deg")) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(hfRadAbs)) + targetH * Math.abs(Math.cos(hfRadAbs)))
      : targetH;
  const baseCenterX = Math.round((renderWidth - hfEffW) / 2);
  const baseCenterY = Math.round((renderHeight - hfEffH) / 2);

  const activeHfBlobPath = ctx.hyperframesBlobs[ctx.hyperframesBlobs.length - 1] ?? "";
  const hfColorSpec: SourceColorSpec =
    !activeHfBlobPath ||
    isPngSequenceBlobDir(activeHfBlobPath) ||
    activeHfBlobPath.toLowerCase().endsWith(".png") ||
    activeHfBlobPath.toLowerCase().endsWith(".ffv1.mov")
      ? { isRgb: true, inMatrix: "bt709", inRange: "pc", sourceRule: "rgb" }
      : resolveSourceColorSpec(
          probeStandaloneVideoColorMetadata(activeHfBlobPath),
          activeHfBlobPath,
          { isHyperFramesBlob: true }
        );

  const hfFilters: string[] = [buildSourceScaleFilter(targetW, targetH, hfColorSpec)];
  if (cue.placement.mirror_x) hfFilters.push("hflip");
  if (cue.placement.mirror_y) hfFilters.push("vflip");
  const hfRotExpr = compilePlacementChannelExpr(cue, "rotation_deg", { timeBaseOffsetMs: 0, mode: "raw" });
  const hfOpExpr = compilePlacementChannelExpr(cue, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  // RGB sources (PNG sequence, single-frame PNG, FFV1 BGRA) stay in RGB until converted to BT.709 YUV;
  // YUV overlay blobs (ProRes / MP4) convert to RGBA using their resolved input color matrix.
  hfFilters.push(hfColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA);
  // A composition cue runs fx right after `format=rgba`, on its own frame. In `scene_host`
  // mode that frame is the whole hosted scene (the footage underneath is part of the cue).
  // The cue is RGBA at this point, so `keep` entries always hold the alpha aside.
  // Motion layers skip this stage (only pixel entries run here).
  if (pixelFxEntries(cue).length > 0) {
    emitFxStageParts(
      ctx,
      hfFilters,
      buildItemFxStage(ctx, { owner: cue, receivedPixFmt: "rgba", itemHasAlpha: true })
    );
  }
  if (hfRotExpr) {
    const radExpr = `((${hfRotExpr})*PI/180)`;
    hfFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
  } else if (Math.abs(placementStaticValue(cue, "rotation_deg")) > 0.01) {
    const rad = ((placementStaticValue(cue, "rotation_deg") * Math.PI) / 180).toFixed(4);
    hfFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }
  if (hfOpExpr) {
    const opExprT = hfOpExpr.replace(/\bt\b/g, "T");
    hfFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
  } else if (placementStaticValue(cue, "opacity") < 0.999) {
    hfFilters.push(`colorchannelmixer=aa=${placementStaticValue(cue, "opacity").toFixed(3)}`);
  }
  const isSingleFrameHfPng =
    compileOptions?.singleFrameAtMs !== undefined &&
    compMode !== "scene_host" &&
    singleFrameInstantHitsCue(compileOptions.singleFrameAtMs, cueStartMs, cueEndMs, frameDurMs);
  const hfLocalTimeExpr = isSingleFrameHfPng
    ? Math.max(0, (compileOptions!.singleFrameAtMs! - cueStartMs) / 1000).toFixed(6)
    : `((in-1)/${fps})`;
  const sxPart = hfSxExpr ? `abs(${hfSxExpr})` : String(Math.abs(placementStaticValue(cue, "scale_x")));
  const syPart = hfSyExpr ? `abs(${hfSyExpr})` : String(Math.abs(placementStaticValue(cue, "scale_y")));
  hfFilters.push(
    ...buildSubpixelScaleOrPanFilters({
      hasDynamicScale: hfHasDynScale,
      sxPart,
      syPart,
      owner: cue,
      baseCenterX,
      baseCenterY,
      renderWidth,
      renderHeight,
      localTimeExpr: hfLocalTimeExpr,
    })
  );
  hfFilters.push(
    `tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(3)}`,
    `settb=AVTB`,
    `setpts=PTS-STARTPTS+${cueStartSec}/TB`
  );
  if (
    activeWin &&
    compileOptions?.singleFrameAtMs === undefined &&
    (cueStartMs < winLeadStartMs - 1e-3 || cueEndMs > winEndMs + 1e-3)
  ) {
    hfFilters.push(`trim=start=${winLeadStartSec}:end=${winEndPadSec}`);
  }

  const hfPad = `[v_hf_${cue.id}]`;
  ctx.filterChains.push(`[${hfIdx}:v]${hfFilters.join(",")}${hfPad}`);

  const xExpr = hfHasDynScale
    ? hfRotExpr
      ? `(W-w)/2`
      : String(baseCenterX)
    : compilePlacementChannelExpr(cue, "x_pct", {
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterX,
        canvasDimPx: renderWidth,
      }) ??
      (hfRotExpr
        ? `(W-w)/2+${Math.round((placementStaticValue(cue, "x_pct") / 100) * renderWidth)}`
        : String(Math.round(baseCenterX + (placementStaticValue(cue, "x_pct") / 100) * renderWidth)));

  const yExpr = hfHasDynScale
    ? hfRotExpr
      ? `(H-h)/2`
      : String(baseCenterY)
    : compilePlacementChannelExpr(cue, "y_pct", {
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterY,
        canvasDimPx: renderHeight,
      }) ??
      (hfRotExpr
        ? `(H-h)/2+${Math.round((placementStaticValue(cue, "y_pct") / 100) * renderHeight)}`
        : String(Math.round(baseCenterY + (placementStaticValue(cue, "y_pct") / 100) * renderHeight)));

  const alphaPreset = ctx.preset === "master_alpha";
  if (!effectiveTransparent && isFullFrameUnscaled && compileOptions?.singleFrameAtMs === undefined && !alphaPreset) {
    const ovYuvPad = `[vc_oyuv_${++ctx.vStepCounter}]`;
    const nextPad = `[vc_${ctx.vStepCounter}]`;
    ctx.filterChains.push(
      `${hfPad}${BT709_TO_YUVA420P}${ovYuvPad}`,
      `${ctx.currentVideoPad}${ovYuvPad}overlay=x='${xExpr}':y='${yExpr}':eval=frame:enable='${buildCueOverlayEnableExpr(cueStartSec, cueEndSec)}':eof_action=pass:repeatlast=0,${BT709_TO_YUV420P}${nextPad}`
    );
    ctx.currentVideoPad = nextPad;
  } else {
    const base10Pad = `[vc_b10_${++ctx.vStepCounter}]`;
    const ov10Pad = `[vc_o10_${ctx.vStepCounter}]`;
    const nextPad = `[vc_${ctx.vStepCounter}]`;
    const baseConv = alphaPreset ? BT709_TO_YUVA444P10 : BT709_TO_YUV444P10;
    const overlayFormat = alphaPreset ? "auto" : "yuv444p10";
    const tailConv = alphaPreset ? BT709_TO_YUVA420P : BT709_TO_YUV420P;
    ctx.filterChains.push(
      `${ctx.currentVideoPad}${baseConv}${base10Pad}`,
      `${hfPad}${BT709_TO_YUVA444P10}${ov10Pad}`,
      `${base10Pad}${ov10Pad}overlay=x='${xExpr}':y='${yExpr}':format=${overlayFormat}:alpha=straight:eval=frame:enable='${buildCueOverlayEnableExpr(cueStartSec, cueEndSec)}':eof_action=pass:repeatlast=0,${tailConv}${nextPad}`
    );
    ctx.currentVideoPad = nextPad;
  }
}

/**
 * Per-frame placement chain shared by footage cues and moving text cues: rotation and
 * opacity (envelope expressions in cue-local time, else the static value), dynamic
 * scale/pan, and the timeline-time overlay position. The caller scales its layer to
 * `targetW`x`targetH` first and converts it out of RGBA afterwards.
 */
export interface MovingPlacementChainOptions {
  renderWidth: number;
  renderHeight: number;
  fps: number;
  targetW: number;
  targetH: number;
  /** Cue-local seconds inside the layer chain (for example `((in-1)/30)`). */
  localTimeExpr: string;
  /** Timeline start of the cue in ms: the overlay position evaluates in timeline time. */
  cueStartMs: number;
}

export interface MovingPlacementChain {
  /** Rotation, opacity and dynamic scale/pan filters (cue-local time). */
  vFilters: string[];
  /** Timeline-time overlay position expressions. */
  xExpr: string;
  yExpr: string;
  baseCenterX: number;
  baseCenterY: number;
}

export function buildMovingPlacementChain(
  cue: LaneCueSpec,
  opts: MovingPlacementChainOptions
): MovingPlacementChain {
  const { renderWidth, renderHeight, targetW, targetH, cueStartMs } = opts;
  const radAbs = (Math.abs(placementStaticValue(cue, "rotation_deg")) * Math.PI) / 180;
  const effW =
    Math.abs(placementStaticValue(cue, "rotation_deg")) > 0.01
      ? Math.round(targetW * Math.abs(Math.cos(radAbs)) + targetH * Math.abs(Math.sin(radAbs)))
      : targetW;
  const effH =
    Math.abs(placementStaticValue(cue, "rotation_deg")) > 0.01
      ? Math.round(targetW * Math.abs(Math.sin(radAbs)) + targetH * Math.abs(Math.cos(radAbs)))
      : targetH;
  const baseCenterX = Math.round((renderWidth - effW) / 2);
  const baseCenterY = Math.round((renderHeight - effH) / 2);

  const vFilters: string[] = [];
  const rotExpr = compilePlacementChannelExpr(cue, "rotation_deg", { timeBaseOffsetMs: 0, mode: "raw" });
  if (rotExpr) {
    const radExpr = `((${rotExpr})*PI/180)`;
    vFilters.push(`rotate=a='${radExpr}':ow='rotw(${radExpr})':oh='roth(${radExpr})':c=none`);
  } else if (Math.abs(placementStaticValue(cue, "rotation_deg")) > 0.01) {
    const rad = ((placementStaticValue(cue, "rotation_deg") * Math.PI) / 180).toFixed(4);
    vFilters.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`);
  }
  const opExpr = compilePlacementChannelExpr(cue, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  if (opExpr) {
    const opExprT = opExpr.replace(/\bt\b/g, "T");
    vFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(${opExprT}),0,255)'`);
  } else if (placementStaticValue(cue, "opacity") < 0.999) {
    vFilters.push(`colorchannelmixer=aa=${placementStaticValue(cue, "opacity").toFixed(3)}`);
  }
  const sxExpr = compilePlacementChannelExpr(cue, "scale_x", { timeBaseOffsetMs: 0, mode: "raw" });
  const syExpr = compilePlacementChannelExpr(cue, "scale_y", { timeBaseOffsetMs: 0, mode: "raw" });
  const hasDynamicScale = Boolean(sxExpr || syExpr);
  const sxPart = sxExpr ? `abs(${sxExpr})` : String(Math.abs(placementStaticValue(cue, "scale_x")));
  const syPart = syExpr ? `abs(${syExpr})` : String(Math.abs(placementStaticValue(cue, "scale_y")));
  vFilters.push(
    ...buildSubpixelScaleOrPanFilters({
      hasDynamicScale,
      sxPart,
      syPart,
      owner: cue,
      baseCenterX,
      baseCenterY,
      renderWidth,
      renderHeight,
      localTimeExpr: opts.localTimeExpr,
    })
  );

  const rotActive = Boolean(rotExpr);
  const xExpr = hasDynamicScale
    ? rotActive
      ? `(W-w)/2`
      : String(baseCenterX)
    : compilePlacementChannelExpr(cue, "x_pct", {
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterX,
        canvasDimPx: renderWidth,
      }) ??
      (rotActive
        ? `(W-w)/2+${Math.round((placementStaticValue(cue, "x_pct") / 100) * renderWidth)}`
        : String(Math.round(baseCenterX + (placementStaticValue(cue, "x_pct") / 100) * renderWidth)));

  const yExpr = hasDynamicScale
    ? rotActive
      ? `(H-h)/2`
      : String(baseCenterY)
    : compilePlacementChannelExpr(cue, "y_pct", {
        timeBaseOffsetMs: cueStartMs,
        mode: "pixel_offset",
        baseCenterPx: baseCenterY,
        canvasDimPx: renderHeight,
      }) ??
      (rotActive
        ? `(H-h)/2+${Math.round((placementStaticValue(cue, "y_pct") / 100) * renderHeight)}`
        : String(Math.round(baseCenterY + (placementStaticValue(cue, "y_pct") / 100) * renderHeight)));

  return { vFilters, xExpr, yExpr, baseCenterX, baseCenterY };
}

function buildVisualAssetCueFilterChain(
  ctx: VideoGraphCompileContext,
  params: {
    cue: LaneCueSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    isStill: boolean;
    cueRate: number;
    srcInMs: number;
    srcOutMs: number;
    srcInSec: string;
    srcOutSec: string;
    cueStartMs: number;
    cueEndMs: number;
    cueStartSec: string;
  }
): {
  vFilters: string[];
  cueSpatialFilters: string[];
  xExpr: string;
  yExpr: string;
} {
  const {
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
    cue,
    asset,
    absAssetPath,
    isStill,
    cueRate,
    srcInMs,
    srcOutMs,
    srcInSec,
    srcOutSec,
    cueStartMs,
    cueEndMs,
    cueStartSec,
  } = params;

  const cropWRatio = cue.placement.crop
    ? Math.max(0.05, 1 - (cue.placement.crop.left_pct + cue.placement.crop.right_pct) / 100)
    : 1.0;
  const cropHRatio = cue.placement.crop
    ? Math.max(0.05, 1 - (cue.placement.crop.top_pct + cue.placement.crop.bottom_pct) / 100)
    : 1.0;
  const assetAr =
    asset.probe.width > 0 && asset.probe.height > 0
      ? (asset.probe.width * cropWRatio) / (asset.probe.height * cropHRatio)
      : renderWidth / renderHeight;
  const cueSxExpr = compilePlacementChannelExpr(cue, "scale_x", { timeBaseOffsetMs: 0, mode: "raw" });
  const cueSyExpr = compilePlacementChannelExpr(cue, "scale_y", { timeBaseOffsetMs: 0, mode: "raw" });
  const cueHasDynScale = Boolean(cueSxExpr || cueSyExpr);
  const hasXEnv = placementChannelHasEnvelopeInput(cue, "x_pct");
  const hasYEnv = placementChannelHasEnvelopeInput(cue, "y_pct");

  // Compute targetH from cropped assetAr * scale_y
  const targetW = cueHasDynScale
    ? renderWidth
    : Math.max(8, Math.round((renderWidth * Math.abs(placementStaticValue(cue, "scale_x"))) / 2) * 2);
  const targetH = cueHasDynScale
    ? Math.max(8, Math.round((renderWidth / assetAr) / 2) * 2)
    : Math.max(8, Math.round(((renderWidth / assetAr) * Math.abs(placementStaticValue(cue, "scale_y"))) / 2) * 2);
  // Per-frame placement (rotation, opacity, dynamic scale/pan, overlay position), shared
  // with moving text cues: the same helper builds the chain from the cue's envelopes.
  const cuePlacement = buildMovingPlacementChain(cue, {
    renderWidth,
    renderHeight,
    fps,
    targetW,
    targetH,
    localTimeExpr: `((in-1)/${fps})`,
    cueStartMs,
  });

  // Reset PTS to 0 right after `trim` (`setpts=PTS-STARTPTS`) so local keyframe
  // envelopes (`rotate`, `geq` opacity, `scale`) evaluate over `t = 0 .. cueDuration` even when `srcInMs > 0`.
  // Frame-exact tail padding ensures non-30fps / VFR sources cover every output frame until `cueEndSec`.
  const cueSrcFps = Math.max(1, asset.probe.fps || fps);
  const cueRawSrcSpanSec = Math.max(0, (srcOutMs - srcInMs) / (1000 * cueRate));
  const cueDurSec = cue.duration_ms / 1000;
  const cueTailPadSec = Math.max(
    0.1,
    Math.max(0, cueDurSec - cueRawSrcSpanSec) + 3 / (cueSrcFps * cueRate) + 2 / fps
  ).toFixed(3);
  const needsPreTrimEofPad =
    !isStill &&
    asset.probe.duration_ms > 0 &&
    srcOutMs >= Math.max(0, asset.probe.duration_ms - 5000);
  const cueStillPadSec = (cueDurSec + 2 / fps).toFixed(3);
  const vFilters: string[] = isStill
    ? [`fps=${fps}:eof_action=pass`, `tpad=stop_mode=clone:stop_duration=${cueStillPadSec}`]
    : [
        `settb=AVTB`,
        ...(needsPreTrimEofPad ? [`tpad=stop_mode=clone:stop_duration=3.000`] : []),
        `trim=start=${srcInSec}:end=${srcOutSec}`,
        cueRate === 1.0
          ? `setpts=PTS-STARTPTS`
          : `setpts=(PTS-STARTPTS)/${cueRate.toFixed(4)}`,
        `fps=${fps}:eof_action=pass`,
        `tpad=stop_mode=clone:stop_duration=${cueTailPadSec}`,
      ];
  const cueSpatialFilterStartIdx = vFilters.length;

  // Colour hook: HDR input transform first (SDR BT.709 before any colour block), then the
  // block-based colour stage after the source lands in RGBA (legacy order is untouched).
  vFilters.push(...laneInputTransformFilters(cue.id, asset));
  const cueColorSpec = resolveSourceColorSpec(asset.probe, absAssetPath);
  if (cueColorSpec.isRgb) {
    vFilters.push("format=rgba");
  }

  if (cue.placement.crop) {
    const cr = cue.placement.crop;
    const wRatio = cropWRatio.toFixed(4);
    const hRatio = cropHRatio.toFixed(4);
    const xRatio = (cr.left_pct / 100).toFixed(4);
    const yRatio = (cr.top_pct / 100).toFixed(4);
    vFilters.push(`crop=w=iw*${wRatio}:h=ih*${hRatio}:x=iw*${xRatio}:y=ih*${yRatio}`);
  }

  if (cue.placement.fit_mode === "contain") {
    vFilters.push(
      buildSourceScaleFilter(targetW, targetH, cueColorSpec, "decrease"),
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    );
  } else {
    vFilters.push(buildSourceScaleFilter(targetW, targetH, cueColorSpec));
  }
  if (cue.placement.mirror_x) vFilters.push("hflip");
  if (cue.placement.mirror_y) vFilters.push("vflip");
  const cueColorStageFilters = laneColorStageFilters(ctx, {
    cue,
    asset,
    envelopes: cue.envelopes,
    durationMs: cue.duration_ms,
  });
  // Motion layers never enter the pixel stage (they only list in `placementLayers`).
  const cueHasActiveFx = pixelFxEntries(cue).length > 0;
  // A cue without a colour stage runs fx right after the fit scale and mirrors, in the
  // source's own format (before the RGBA conversion below). `keep` entries hold the
  // cue's alpha aside when it carries one at this point.
  const cueFxPreReceived = spineFxReceivedPixFmt(cueColorSpec, asset, []);
  const cueFxPreParts =
    cueHasActiveFx && cueColorStageFilters.length === 0
      ? buildItemFxStage(ctx, {
          owner: cue,
          receivedPixFmt: cueFxPreReceived,
          itemHasAlpha: itemCarriesAlphaAtFx(cueFxPreReceived, cueColorSpec, asset),
        })
      : [];
  if (cueFxPreParts.length > 0) {
    emitFxStageParts(ctx, vFilters, cueFxPreParts);
  }
  const cueRgbaIdx = vFilters.length;
  let cueUsesRgba = true;
  vFilters.push(cueColorSpec.isRgb ? "format=rgba" : BT709_TO_RGBA);
  vFilters.push(...cueColorStageFilters);
  // A cue with a colour stage runs fx right after it, in RGBA (order colour, then fx).
  // The colour stage lands in RGBA, so the item always carries alpha at this point.
  if (cueHasActiveFx && cueColorStageFilters.length > 0) {
    emitFxStageParts(
      ctx,
      vFilters,
      buildItemFxStage(ctx, {
        owner: cue,
        receivedPixFmt: spineFxReceivedPixFmt(cueColorSpec, asset, cueColorStageFilters),
        itemHasAlpha: true,
      })
    );
  }

  const cueRotExpr = compilePlacementChannelExpr(cue, "rotation_deg", { timeBaseOffsetMs: 0, mode: "raw" });
  const cueOpExpr = compilePlacementChannelExpr(cue, "opacity", { timeBaseOffsetMs: 0, mode: "raw" });
  vFilters.push(...cuePlacement.vFilters);
  // Opaque, full-frame, untransformed, envelope-less B-roll footage cues skip the RGBA round-trip.
  if (
    process.env.CUTHOL_EXP_NORGBA !== "0" &&
    !isStill &&
    !cueColorSpec.isRgb &&
    asset.kind === "footage" &&
    !/\.(?:png|webp|gif|mov)$/i.test(absAssetPath) &&
    cue.placement.fit_mode !== "contain" &&
    !cueRotExpr &&
    Math.abs(placementStaticValue(cue, "rotation_deg")) <= 0.01 &&
    !cueOpExpr &&
    placementStaticValue(cue, "opacity") >= 0.999 &&
    !cueHasDynScale &&
    !hasXEnv &&
    !hasYEnv &&
    !placementHasAnyEnvelopeInput(cue) &&
    cueColorStageFilters.length === 0 &&
    (!cueHasActiveFx || !cueFxPreParts.some((p) => p.type === "alpha_keep")) &&
    targetW === renderWidth &&
    targetH === renderHeight &&
    Math.abs(placementStaticValue(cue, "scale_x") - 1) < 1e-3 &&
    Math.abs(placementStaticValue(cue, "scale_y") - 1) < 1e-3 &&
    Math.abs(placementStaticValue(cue, "x_pct")) < 0.01 &&
    Math.abs(placementStaticValue(cue, "y_pct")) < 0.01
  ) {
    vFilters.splice(cueRgbaIdx, 1);
    cueUsesRgba = false;
  }
  vFilters.push(
    cueUsesRgba || cueHasDynScale || hasXEnv || hasYEnv || ctx.preset === "master_alpha"
      ? BT709_TO_YUVA420P
      : BT709_TO_YUV420P
  );
  const cueSpatialFilters = vFilters.slice(cueSpatialFilterStartIdx);
  vFilters.push(`settb=AVTB`, `setpts=PTS-STARTPTS+${cueStartSec}/TB`);
  // Early window trim on the finished chain (before the chain's own end-of-chain
  // window trim below, which is never examined or moved). The trailing
  // PTS-anchoring `setpts` rejects the trim: dropping frames before it would
  // shift every later timestamp, so footage/still cues keep today's path.
  if (
    ctx.compileOptions?.singleFrameAtMs !== undefined &&
    ctx.compileOptions?.singleFrameEarlyTrim !== false
  ) {
    const startFrame = Math.max(0, Math.floor(((winLeadStartMs - cueStartMs) * fps) / 1000));
    const winEndPadMs = winEndMs + 2000 / Math.max(1, fps);
    const endFrame = Math.max(startFrame + 1, Math.ceil(((winEndPadMs - cueStartMs) * fps) / 1000));
    const early = applySingleFrameEarlyTrim({
      entries: vFilters,
      timingEndIdx: cueSpatialFilterStartIdx,
      startFrame,
      endFrame,
      fps,
    });
    if (early.applied) {
      vFilters.length = 0;
      vFilters.push(...early.entries);
    }
  }
  if (activeWin && (cueStartMs < winLeadStartMs - 1e-3 || cueEndMs > winEndMs + 1e-3)) {
    vFilters.push(`trim=start=${winLeadStartSec}:end=${winEndPadSec}`);
  }

  const { xExpr, yExpr } = cuePlacement;

  return {
    vFilters,
    cueSpatialFilters,
    xExpr,
    yExpr,
  };
}

/** HDR input transform of a visual lane cue; [] for SDR. Throws G443 when unavailable. */
function laneInputTransformFilters(
  cueId: string,
  asset: CutholSequence["library"][number]
): string[] {
  const resolved = resolveInputTransform(asset);
  if (resolved.kind === "none") return [];
  if (!resolved.available) {
    throw new CutholError(DIAGNOSTICS.COLOR_INPUT_TRANSFORM_UNAVAILABLE(cueId, resolved.kind));
  }
  return resolved.filters;
}

/**
 * Block-based colour stage of a visual lane cue (`color` + project Looks + colour envelopes).
 * Runs in RGBA right after the source lands there; [] when the cue has no effective stage.
 */
function laneColorStageFilters(
  ctx: VideoGraphCompileContext,
  params: {
    cue: LaneCueSpec;
    asset: CutholSequence["library"][number];
    envelopes: LaneCueSpec["envelopes"];
    durationMs: number;
  }
): string[] {
  if (!ctx.seq) return [];
  const item = listColorItems(ctx.seq).find((c) => c.id === params.cue.id);
  if (!item) return [];
  return compileColorStageFilters(
    ctx.seq,
    { rootDir: ctx.paths.rootDir, addInput: (args: string[]) => ctx.addInput(args) },
    {
      item,
      asset: params.asset,
      envelopes: params.envelopes,
      fps: ctx.fps,
      durationMs: params.durationMs,
      isRgb: true,
      backFormat: "rgba",
      srcRange: "pc",
    }
  );
}

function compileAssetLaneCue(
  ctx: VideoGraphCompileContext,
  cue: LaneCueSpec,
  cueStartMs: number,
  cueEndMs: number,
  cueStartSec: string,
  cueEndSec: string,
  isCueInActiveWindow: boolean
): void {
  const { seq, paths, fps, compileOptions } = ctx;
  const asset = ctx.libMap.get(cue.asset_handle!);
  if (!asset) return;

  const absAssetPath = resolveLibraryItemPath(paths.rootDir, asset);
  const cueRate = getCuePlaybackRate(cue);
  const srcInMs = cue.source_in_ms ?? 0;
  // Always bound srcOutMs by both asset.probe.duration_ms and srcInMs + cue.duration_ms * cueRate
  const maxOutByDuration =
    cueRate === 1.0
      ? srcInMs + cue.duration_ms
      : srcInMs + Math.round(cue.duration_ms * cueRate);
  const requestedOut = cue.source_out_ms ?? maxOutByDuration;
  const srcOutMs = Math.min(maxSourceDurationMs(asset), requestedOut, maxOutByDuration);

  const isAudioOnlyKind =
    cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover";

  if (
    !isAudioOnlyKind &&
    asset.probe.has_video &&
    (cue.kind === "broll" || asset.kind === "graphic" || asset.kind === "footage")
  ) {
    const isStill = isStillGraphic(asset);
    // A still cue whose fx stage would contain an `alpha_keep` part (labelled split/merge
    // pads) is not baked: `stillSpec.spatialFilters` is a linear list.
    const stillFxKeepsAlpha =
      isStill && fxStageWouldKeepAlpha(seq, ctx.paths?.rootDir as string | undefined, cue);
    // Every envelope counts as today (colour, gain, pixel fx, empty entries) except the
    // `fx.<id>.*` envelopes of motion layers; a motion-animated channel takes the cue out
    // of the bake via the resolver condition below.
    const motionIds = new Set(placementLayers(cue).map((l) => l.id));
    const hasNonMotionEnvelope = cue.envelopes.some((e) => {
      const m = /^fx\.([^.]+)\./.exec(e.parameter);
      return !(m && motionIds.has(m[1]));
    });
    const layerKind: DrawnVisualLayer["kind"] =
      isStill &&
      !hasNonMotionEnvelope &&
      Math.abs(placementStaticValue(cue, "rotation_deg")) < 1e-3 &&
      placementStaticValue(cue, "opacity") >= 0.999 &&
      !stillFxKeepsAlpha &&
      !placementAnimatesAny(cue, PLACEMENT_CHANNELS)
        ? "still_graphic"
        : "moving";
    const drawnCueLayer: DrawnVisualLayer = {
      id: cue.id,
      startMs: cueStartMs,
      endMs: cueEndMs,
      kind: layerKind,
    };
    ctx.drawnVisualLayers.push(drawnCueLayer);
    if (!isCueInActiveWindow) {
      return;
    }

    const allowCueSeek =
      compileOptions?.singleFrameAtMs !== undefined ||
      asset.probe.duration_ms >= 180_000 ||
      seq.spine.clips.length > 24;
    const cueSeek = isStill
      ? null
      : buildSeekableMediaInput(
          absAssetPath,
          srcInMs,
          srcOutMs,
          asset.probe.duration_ms,
          allowCueSeek
        );
    const srcInSec = cueSeek ? cueSeek.localSrcInSec : (srcInMs / 1000).toFixed(3);
    const srcOutSec = cueSeek ? cueSeek.localSrcOutSec : (srcOutMs / 1000).toFixed(3);
    const inIdx = isStill
      ? compileOptions?.singleFrameAtMs !== undefined
        ? ctx.addInput(["-framerate", String(fps), "-i", absAssetPath])
        : ctx.addInput([
            "-loop",
            "1",
            "-framerate",
            String(fps),
            "-t",
            (cue.duration_ms / 1000 + 2 / fps).toFixed(3),
            "-i",
            absAssetPath,
          ])
      : ctx.addInput(cueSeek!.inputArgs);

    const { vFilters, cueSpatialFilters, xExpr, yExpr } = buildVisualAssetCueFilterChain(ctx, {
      cue,
      asset,
      absAssetPath,
      isStill,
      cueRate,
      srcInMs,
      srcOutMs,
      srcInSec,
      srcOutSec,
      cueStartMs,
      cueEndMs,
      cueStartSec,
    });

    const cuePad = `[v_cue_${cue.id}]`;
    ctx.filterChains.push(`[${inIdx}:v]${vFilters.join(",")}${cuePad}`);

    if (layerKind === "still_graphic") {
      drawnCueLayer.stillSpec = {
        id: cue.id,
        assetHandle: asset.handle,
        assetDigest: asset.digest_sha256,
        absAssetPath,
        spatialFilters: cueSpatialFilters,
        xExpr,
        yExpr,
      };
    }

    const nextPad = `[vc_${++ctx.vStepCounter}]`;
    const overlayFmt = ctx.preset === "master_alpha" ? "format=auto:" : "";
    ctx.filterChains.push(
      `${ctx.currentVideoPad}${cuePad}overlay=x='${xExpr}':y='${yExpr}':${overlayFmt}eval=frame:enable='${buildCueOverlayEnableExpr(cueStartSec, cueEndSec)}':eof_action=pass,${BT709_SETPARAMS}${nextPad}`
    );
    ctx.currentVideoPad = nextPad;
  }
}

export function compileLane(ctx: VideoGraphCompileContext, lane: LaneSpec): void {
  if (lane.muted) return;

  let laneHasTypography = false;
  const orderedCues = lane.cues.some((c) => c.z_index !== undefined)
    ? [...lane.cues].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))
    : lane.cues;

  for (const cue of orderedCues) {
    const cueStartMs = resolveCueStartMs(ctx.seq, cue);
    const cueEndMs = cueStartMs + cue.duration_ms;
    const cueStartSec = (cueStartMs / 1000).toFixed(3);
    const cueEndSec = (cueEndMs / 1000).toFixed(3);
    const isCueInActiveWindow =
      !ctx.activeWin || cueOverlapsWindowMs(cueStartMs, cueEndMs, ctx.winStartMs, ctx.winEndMs);

    // Fx on a cue without a pixel stage is never silently ignored: audio cues have no
    // pixels to run fx on (text cues are checked in `compile_lane_typography.ts`, which the
    // text wave owns).
    if (itemFxNeedsCheck(cue)) {
      if (cue.kind === "music" || cue.kind === "sfx" || cue.kind === "voiceover") {
        throw new CutholError(DIAGNOSTICS.CUE_FX_AUDIO_UNSUPPORTED(cue.id, cue.kind));
      }
      if (!cue.asset_handle && !(cue.kind === "composition" && cue.composition)) {
        // Text cues are owned by compile_lane_typography.ts: active fx becomes a transparent
        // layer, anything else (no fx, only disabled entries) stays on the shared direct burn.
        const isTextCue = cue.typography !== undefined && cue.typography.text.trim() !== "";
        if (!isTextCue) {
          throw new CutholError(DIAGNOSTICS.CUE_FX_KIND_UNSUPPORTED(cue.id, cue.kind));
        }
      }
    }

    if (cue.typography && cue.typography.text.trim()) {
      ctx.drawnVisualLayers.push({
        id: cue.id,
        startMs: cueStartMs,
        endMs: cueEndMs,
        kind: "moving",
      });
      if (isCueInActiveWindow) {
        laneHasTypography = true;
      }
    }

    // 2a. HyperFrames Composition Cue
    if (cue.kind === "composition" && cue.composition) {
      compileCompositionLaneCue(
        ctx,
        cue,
        cueStartMs,
        cueEndMs,
        cueStartSec,
        cueEndSec,
        isCueInActiveWindow
      );
      continue;
    }

    // 2b. Asset-Backed Lane Cue (B-roll, Graphic, Music, SFX, Voiceover)
    if (cue.asset_handle) {
      compileAssetLaneCue(
        ctx,
        cue,
        cueStartMs,
        cueEndMs,
        cueStartSec,
        cueEndSec,
        isCueInActiveWindow
      );
    }
  }

  // Compile and apply typography for this lane right at its `z_index` level,
  // keeping native `seq.stage.width x seq.stage.height` PlayResX/Y so libass scales outlines/margins accurately!
  if (laneHasTypography && !isOverlayCollectActive()) {
    compileLaneTypography(ctx, lane);
  }
}
