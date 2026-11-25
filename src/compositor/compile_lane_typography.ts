// Lane typography compilation (moved unchanged from compile_lane.ts): renders the lane's
// text cues to an ASS subtitle file and overlays it at the lane's `z_index` level.
// A text cue with an active fx chain or a moving placement gets its own transparent layer
// instead: the cue's text alone on a stage-size transparent canvas, through the shared fx
// stage (the item has alpha), overlaid straight with the cue's timing (a moving cue through
// the per-frame footage placement chain). Plain text cues keep the shared direct burn.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CutholSequence } from "../core/schema.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { buildItemFxStage, emitFxStageParts, pixelFxEntries } from "./compile_fx_stage.js";
import {
  PLACEMENT_CHANNELS,
  placementAnimatesAny,
  placementLayers,
  placementStaticValue,
} from "../sequence/placement_resolve.js";
import { buildMovingPlacementChain } from "./compile_lane.js";
import { BT709_TO_YUVA420P, BT709_SETPARAMS } from "./compile_color.js";
import { buildCueOverlayEnableExpr, cueOverlapsWindowMs } from "../core/frame_time.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { escapeFfmpegFilterPath } from "./compile_filters.js";
import { applySingleFrameEarlyTrim } from "./single_frame_trim.js";
import type { VideoGraphCompileContext } from "./compiler.js";
import { compileTypographyAssFile } from "./ass_generator.js";

type LaneSpec = CutholSequence["lanes"][number];
type LaneCueSpec = LaneSpec["cues"][number];

/** True when the cue carries pixel-stage fx (motion layers never send text to its own layer). */
function cueHasActiveFx(cue: LaneCueSpec): boolean {
  return pixelFxEntries(cue).length > 0;
}

/**
 * True when a motion layer carries an envelope with points on the channel. Layers are not
 * combined yet (the resolver returns the base), but a cue that moves on the merged branch
 * already takes the moving path so its placement animates there.
 */
function motionLayerAnimates(cue: LaneCueSpec): boolean {
  for (const layer of placementLayers(cue)) {
    for (const c of PLACEMENT_CHANNELS) {
      const envelope = layer.channels[c]?.envelope;
      if (envelope && envelope.points.length > 0) return true;
    }
  }
  return false;
}

/** True when the cue's placement moves: a base envelope or a motion layer envelope with points. */
function cueHasMovingPlacement(cue: LaneCueSpec): boolean {
  return placementAnimatesAny(cue, PLACEMENT_CHANNELS) || motionLayerAnimates(cue);
}

/** True when the cue needs its own layer: pixel fx, a moving placement, or both. */
function cueNeedsOwnLayer(cue: LaneCueSpec): boolean {
  return cueHasActiveFx(cue) || cueHasMovingPlacement(cue);
}

/** Applies the rotated-text style patch to a written ASS file (same rules as the direct burn). */
function applyRotatedStylePatch(assFilePath: string, lane: LaneSpec): void {
  const rotatedTypoCues = lane.cues.filter(
    (c) => Boolean(c.typography) && Math.abs(placementStaticValue(c, "rotation_deg")) > 0.01
  );
  if (rotatedTypoCues.length === 0 || !fs.existsSync(assFilePath)) return;
  let assContent = fs.readFileSync(assFilePath, "utf8");
  for (const rc of rotatedTypoCues) {
    const assAngle = Number((-placementStaticValue(rc, "rotation_deg")).toFixed(2));
    const stylePrefix = `Style: Style_${rc.id},`;
    assContent = assContent
      .split(/\r?\n/)
      .map((line) => {
        if (line.startsWith(stylePrefix)) {
          const parts = line.split(",");
          if (parts.length >= 14) {
            parts[13] = String(assAngle);
            return parts.join(",");
          }
        }
        if (line.includes(`,Style_${rc.id},`) && line.includes("{\\an5\\pos(")) {
          return line.replace(
            /\{\\an5\\pos\(([^)]+)\)\}/g,
            `{\\an5\\pos($1)\\frz${assAngle}}`
          );
        }
        return line;
      })
      .join("\r\n");
  }
  fs.writeFileSync(assFilePath, assContent, "utf8");
}

/** Emits the shared direct burn for a run of plain text cues (byte-identical to the old path). */
function burnPlainSegment(
  ctx: VideoGraphCompileContext,
  lane: LaneSpec,
  segmentCues: LaneCueSpec[],
  segmentIndex: number | null
): void {
  const { seq, paths, preset } = ctx;
  // The direct burn ignores fx (active fx cues are excluded from the file, disabled entries
  // are dormant), so the cache key strips `fx` and stays stable when only fx changes.
  // Without fx the stripped lane serializes exactly like the old full lane, keeping today's names.
  const laneForHash = {
    ...lane,
    cues: lane.cues.map(({ fx, ...rest }) => rest),
  };
  const hashInput =
    segmentIndex === null
      ? { stage: seq.stage, spine: seq.spine.clips, lane: laneForHash }
      : {
          stage: seq.stage,
          laneId: lane.id,
          segment: segmentIndex,
          cues: segmentCues.map((c) => c.id),
          cueBodies: segmentCues.map(({ fx, ...rest }) => rest),
        };
  const laneAssHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(hashInput))
    .digest("hex")
    .slice(0, 8);
  const suffix = segmentIndex === null ? laneAssHash : `seg${segmentIndex}_${laneAssHash}`;
  const assOutFile = path.join(
    paths.blobsDir,
    `typography_r${seq.meta.revision}_${lane.id}_${preset}_${suffix}.ass`
  );
  const assResult = compileTypographyAssFile(
    seq,
    assOutFile,
    new Set([lane.id]),
    segmentIndex === null ? undefined : { targetCueIds: new Set(segmentCues.map((c) => c.id)) }
  );
  if (assResult.hasTypographyCues) {
    applyRotatedStylePatch(assResult.filePath, lane);
    ctx.assFilePaths.push(assResult.filePath);
    const relAssPath = path.relative(paths.rootDir, assResult.filePath);
    const escapedAssPath = escapeFfmpegFilterPath(relAssPath);
    const nextPad = `[vc_${++ctx.vStepCounter}]`;
    ctx.filterChains.push(`${ctx.currentVideoPad}ass=filename=${escapedAssPath},${BT709_SETPARAMS}${nextPad}`);
    ctx.currentVideoPad = nextPad;
  }
}

/**
 * Renders one text cue as its own transparent layer through the fx stage: the cue's text
 * alone on a stage-size transparent canvas. A cue with only pixel fx keeps its stored
 * placement in the ASS (static) and overlays at 0,0. A cue whose placement moves is written
 * with neutral placement (stage centre, scale 1, opacity 1) and then placed with the same
 * per-frame placement chain a footage cue uses, so the combined placement drives it like
 * any other item. Order on the layer: text, then pixel fx, then placement.
 */
function overlayOwnLayerTextCue(ctx: VideoGraphCompileContext, lane: LaneSpec, cue: LaneCueSpec): void {
  const { seq, paths, renderWidth, renderHeight, fps } = ctx;
  const cueStartMs = resolveCueStartMs(seq, cue);
  const cueEndMs = cueStartMs + cue.duration_ms;
  const cueStartSec = (cueStartMs / 1000).toFixed(3);
  const cueEndSec = (cueEndMs / 1000).toFixed(3);
  const isCueInActiveWindow =
    !ctx.activeWin || cueOverlapsWindowMs(cueStartMs, cueEndMs, ctx.winStartMs, ctx.winEndMs);
  if (!isCueInActiveWindow) return;

  const moving = cueHasMovingPlacement(cue);
  const cueHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ stage: seq.stage, laneId: lane.id, cue, moving }))
    .digest("hex")
    .slice(0, 8);
  const assOutFile = path.join(
    paths.blobsDir,
    `typography_r${seq.meta.revision}_${lane.id}_${ctx.preset}_fx_${cue.id}_${cueHash}.ass`
  );
  // Cue-local timestamps: the layer chain resets to t = 0, so the ASS events are written
  // against the cue start and stay frame-exact (same snap rules as the direct burn).
  const assResult = compileTypographyAssFile(seq, assOutFile, new Set([lane.id]), {
    targetCueIds: new Set([cue.id]),
    timeBaseMs: cueStartMs,
    neutralPlacement: moving,
  });
  if (!assResult.hasTypographyCues) {
    throw new CutholError(DIAGNOSTICS.CUE_FX_TEXT_LAYER_EMPTY(cue.id));
  }
  // A moving cue rotates through the placement chain, not through the ASS style.
  if (!moving) applyRotatedStylePatch(assResult.filePath, lane);
  ctx.assFilePaths.push(assResult.filePath);
  const relAssPath = path.relative(paths.rootDir, assResult.filePath);
  const escapedAssPath = escapeFfmpegFilterPath(relAssPath);

  // The `format=rgba` must live inside the lavfi graph: a bare `-f lavfi -i color=…`
  // decodes through a format without alpha and the canvas arrives opaque (the layer would
  // cover the footage with black); inside the graph the transparent alpha survives.
  // Bounded canvas: an unbounded lavfi input never ends and ffmpeg can hang while
  // closing after the last frame. The layer only needs to cover the cue, so the canvas
  // lasts the cue plus two frames (same `+ 2/fps` form as the looped still `-t`).
  const canvasDurSec = (cue.duration_ms / 1000 + 2 / fps).toFixed(3);
  const colorIdx = ctx.addInput([
    "-f",
    "lavfi",
    "-i",
    `color=c=black@0:s=${renderWidth}x${renderHeight}:r=${fps}:d=${canvasDurSec},format=rgba`,
  ]);
  // Straight (non-premultiplied) alpha: transparent canvas, text burned on it, fx on the item
  // (which carries alpha), then placement for a moving cue, then the overlay. Timestamps
  // reset so `t` inside the fx stage and the placement chain is cue-local, then shifted back
  // to timeline time for the overlay.
  const vFilters: string[] = [
    "format=rgba",
    // `alpha=1`: without it the ass filter outputs an opaque frame and the layer would
    // cover the footage with black; with it the canvas stays transparent outside the glyphs.
    `ass=filename=${escapedAssPath}:alpha=1`,
    "setpts=PTS-STARTPTS",
  ];
  emitFxStageParts(
    ctx,
    vFilters,
    buildItemFxStage(ctx, { owner: cue, receivedPixFmt: "rgba", itemHasAlpha: true })
  );
  let overlayX = "0";
  let overlayY = "0";
  if (moving) {
    // The layer canvas is full-stage, so the footage chain targets the full frame: a static
    // scale shrinks the target first, a dynamic scale runs per frame inside the chain.
    const dynScale = placementAnimatesAny(cue, ["scale_x", "scale_y"]);
    const targetW = dynScale
      ? renderWidth
      : Math.max(8, Math.round((renderWidth * Math.abs(placementStaticValue(cue, "scale_x"))) / 2) * 2);
    const targetH = dynScale
      ? renderHeight
      : Math.max(8, Math.round((renderHeight * Math.abs(placementStaticValue(cue, "scale_y"))) / 2) * 2);
    const chain = buildMovingPlacementChain(cue, {
      renderWidth,
      renderHeight,
      fps,
      targetW,
      targetH,
      localTimeExpr: `((in-1)/${fps})`,
      cueStartMs,
    });
    vFilters.push(...chain.vFilters);
    overlayX = chain.xExpr;
    overlayY = chain.yExpr;
  }
  vFilters.push(`setpts=PTS+${cueStartSec}/TB`, BT709_TO_YUVA420P);
  // Early window trim on the finished chain. The trailing `setpts` only shifts
  // by a constant (no STARTPTS anchoring), so it never rejects the trim.
  if (
    ctx.compileOptions?.singleFrameAtMs !== undefined &&
    ctx.compileOptions?.singleFrameEarlyTrim !== false
  ) {
    const startFrame = Math.max(0, Math.floor(((ctx.winLeadStartMs - cueStartMs) * fps) / 1000));
    const winEndPadMs = ctx.winEndMs + 2000 / Math.max(1, fps);
    const endFrame = Math.max(startFrame + 1, Math.ceil(((winEndPadMs - cueStartMs) * fps) / 1000));
    // The trim anchor is the entry right after the cue-local `setpts=PTS-STARTPTS`,
    // derived from the chain so head edits cannot silently move it.
    const timingEndIdx = vFilters.indexOf("setpts=PTS-STARTPTS") + 1;
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
  const layerPad = `[v_txtfx_${cue.id}]`;
  ctx.filterChains.push(`[${colorIdx}:v]${vFilters.join(",")}${layerPad}`);
  const nextPad = `[vc_${++ctx.vStepCounter}]`;
  // A cue without a moving placement keeps the historical unquoted `x=0:y=0` form.
  const overlayPos = moving ? `x='${overlayX}':y='${overlayY}'` : "x=0:y=0";
  ctx.filterChains.push(
    `${ctx.currentVideoPad}${layerPad}overlay=${overlayPos}:eval=frame:enable='${buildCueOverlayEnableExpr(cueStartSec, cueEndSec)}':eof_action=pass,${BT709_SETPARAMS}${nextPad}`
  );
  ctx.currentVideoPad = nextPad;
}

export function compileLaneTypography(ctx: VideoGraphCompileContext, lane: LaneSpec): void {
  const typoCues = lane.cues.filter((c) => c.typography && c.typography.text.trim());
  if (!typoCues.some((c) => cueNeedsOwnLayer(c))) {
    // No fx or moving placement on any text cue of this lane: the shared direct burn,
    // byte for byte as before. (A cue with only disabled fx entries, only stray fx
    // envelopes, or only point-less placement envelopes stays here too.)
    burnPlainSegment(ctx, lane, typoCues, null);
    return;
  }
  // Mixed lane: plain runs keep the shared direct burn, own-layer cues become own layers, in
  // cue order, so stacking against the other text cues of the lane stays what it is today.
  let segment: LaneCueSpec[] = [];
  let segmentIndex = 0;
  const flushSegment = (): void => {
    if (segment.length > 0) {
      burnPlainSegment(ctx, lane, segment, segmentIndex);
      segmentIndex += 1;
      segment = [];
    }
  };
  for (const cue of typoCues) {
    if (cueNeedsOwnLayer(cue)) {
      flushSegment();
      overlayOwnLayerTextCue(ctx, lane, cue);
    } else {
      segment.push(cue);
    }
  }
  flushSegment();
}
