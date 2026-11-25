// Spine clip mask and motion blur edits (`cuthol spine mask` / `cuthol spine motion-blur`).
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";

export type MaskShape = "rect" | "ellipse" | "split";

export function setSpineMask(options: {
  workspaceDir: string;
  clipId: string;
  clear?: boolean;
  shape?: MaskShape;
  centerXPct?: number;
  centerYPct?: number;
  widthPct?: number;
  heightPct?: number;
  featherPx?: number;
  invert?: boolean;
}): { mask: CutholSequence["spine"]["clips"][number]["treatments"]["mask"]; revision: number; verification: VerificationReport } {
  const o = options;
  if (!o.clear) {
    if (o.shape !== undefined && o.shape !== "rect" && o.shape !== "ellipse" && o.shape !== "split") {
      throw new CutholError(DIAGNOSTICS.INVALID_MASK_SPEC(o.clipId, `shape must be rect|ellipse|split, got '${o.shape}'.`));
    }
    for (const [name, v, lo, hi] of [
      ["center-x", o.centerXPct, -100, 200],
      ["center-y", o.centerYPct, -100, 200],
      ["width", o.widthPct, 1, 200],
      ["height", o.heightPct, 1, 200],
    ] as Array<[string, number | undefined, number, number]>) {
      if (v !== undefined && (!Number.isFinite(v) || v < lo || v > hi)) {
        throw new CutholError(DIAGNOSTICS.INVALID_MASK_SPEC(o.clipId, `${name} must be within ${lo}..${hi}, got '${v}'.`));
      }
    }
    if (o.featherPx !== undefined && (!Number.isFinite(o.featherPx) || o.featherPx < 0 || o.featherPx > 400)) {
      throw new CutholError(DIAGNOSTICS.INVALID_MASK_SPEC(o.clipId, `feather must be within 0..400 px, got '${o.featherPx}'.`));
    }
  }
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    o.clear ? `spine.mask.clear(${o.clipId})` : `spine.mask(${o.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === o.clipId);
      if (!clip) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(o.clipId));
      if (o.clear) {
        clip.treatments.mask = null;
      } else {
        const prev = clip.treatments.mask;
        clip.treatments.mask = {
          shape: o.shape ?? prev?.shape ?? "rect",
          center_x_pct: o.centerXPct ?? prev?.center_x_pct ?? 50,
          center_y_pct: o.centerYPct ?? prev?.center_y_pct ?? 50,
          width_pct: o.widthPct ?? prev?.width_pct ?? 50,
          height_pct: o.heightPct ?? prev?.height_pct ?? 50,
          feather_px: o.featherPx ?? prev?.feather_px ?? 0,
          invert: o.invert ?? prev?.invert ?? false,
        };
      }
      return clip.treatments.mask;
    }
  );
  return { mask: result, revision, verification };
}

export function setSpineMotionBlur(options: {
  workspaceDir: string;
  clipId: string;
  off?: boolean;
  shutterDeg?: number;
  subframes?: number;
}): { motion_blur: CutholSequence["spine"]["clips"][number]["treatments"]["motion_blur"]; revision: number; verification: VerificationReport } {
  const o = options;
  if (!o.off) {
    if (o.shutterDeg !== undefined && (!Number.isFinite(o.shutterDeg) || o.shutterDeg < 0 || o.shutterDeg > 360)) {
      throw new CutholError(DIAGNOSTICS.INVALID_MOTION_BLUR_SPEC(o.clipId, `shutter must be within 0..360 deg, got '${o.shutterDeg}'.`));
    }
    if (o.subframes !== undefined && (!Number.isInteger(o.subframes) || o.subframes < 2 || o.subframes > 16)) {
      throw new CutholError(DIAGNOSTICS.INVALID_MOTION_BLUR_SPEC(o.clipId, `subframes must be an integer within 2..16, got '${o.subframes}'.`));
    }
  }
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    o.off ? `spine.motion-blur.off(${o.clipId})` : `spine.motion-blur(${o.clipId})`,
    (seq) => {
      const clip = seq.spine.clips.find((c) => c.id === o.clipId);
      if (!clip) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(o.clipId));
      if (o.off) {
        clip.treatments.motion_blur.enabled = false;
      } else {
        clip.treatments.motion_blur.enabled = true;
        if (o.shutterDeg !== undefined) clip.treatments.motion_blur.shutter_deg = o.shutterDeg;
        if (o.subframes !== undefined) clip.treatments.motion_blur.subframes = o.subframes;
      }
      return clip.treatments.motion_blur;
    }
  );
  return { motion_blur: result, revision, verification };
}
