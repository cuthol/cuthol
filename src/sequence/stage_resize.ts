/**
 * Journaled stage resize: change the stage size and rescale lane/spine layout.
 *
 * Rule: percentage positions (`placement.x_pct/y_pct`) stay as they are;
 * values stored in stage pixels (caption font sizes, stroke widths) scale by one
 * uniform factor `min(newW/oldW, newH/oldH)` so nothing is stretched.
 * Composition HTML is never rewritten.
 */
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { parseStageSize, resolveAspectDimensions, StageAspect } from "../core/schema.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function resizeStage(options: {
  workspaceDir: string;
  size?: string;
  aspect?: StageAspect;
  fromAsset?: { width: number; height: number };
}): {
  previous: { width: number; height: number; aspect: StageAspect };
  next: { width: number; height: number; aspect: StageAspect };
  moved: { captions: number };
  revision: number;
  verification: VerificationReport;
} {
  let target: { width: number; height: number; aspect: StageAspect };
  if (options.size) {
    const dims = parseStageSize(options.size);
    target = { ...dims, aspect: "custom" };
  } else if (options.fromAsset) {
    const width = Math.max(2, Math.round(options.fromAsset.width / 2) * 2);
    const height = Math.max(2, Math.round(options.fromAsset.height / 2) * 2);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
      throw DIAGNOSTICS.INVALID_STAGE_SIZE(`${options.fromAsset.width}x${options.fromAsset.height}`);
    }
    target = { width, height, aspect: "custom" };
  } else if (options.aspect) {
    const dims = resolveAspectDimensions(options.aspect as Exclude<StageAspect, "custom">);
    target = { ...dims, aspect: options.aspect };
  } else {
    throw DIAGNOSTICS.INVALID_STAGE_SIZE("(missing --size/--aspect/--from)");
  }

  let previous = { width: 0, height: 0, aspect: "9:16" as StageAspect };
  let moved = { captions: 0 };
  const { revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `workspace.stage(${target.width}x${target.height})`,
    (seq) => {
      const oldW = seq.stage.width;
      const oldH = seq.stage.height;
      previous = { width: oldW, height: oldH, aspect: seq.stage.aspect };
      const uniform = Math.min(target.width / oldW, target.height / oldH);
      // Placement scales are relative to the stage fit (cover/contain/fill of the
      // new stage), so a full-frame clip stays full-frame: they are not touched.
      // Only values stored in stage pixels scale, by the uniform factor.
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.typography) {
            cue.typography.font_size_px = Math.max(1, Math.round(cue.typography.font_size_px * uniform));
            cue.typography.stroke_width_px = round2(cue.typography.stroke_width_px * uniform);
            moved.captions += 1;
          }
        }
      }
      seq.stage.width = target.width;
      seq.stage.height = target.height;
      seq.stage.aspect = target.aspect;
      seq.stage.set_explicit = true;
      return { stage: { ...seq.stage } };
    }
  );
  return { previous, next: target, moved, revision, verification };
}
