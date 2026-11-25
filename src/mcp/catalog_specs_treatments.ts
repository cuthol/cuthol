// MCP action specs: spine treatment tool (mask, motion blur); each maps to a `cuthol spine` command.
import type { ActionSpec, ParamSpec } from "./catalog_types.js";

const clip = (desc = "Spine clip id (sp_XX)."): ParamSpec => ({ name: "clip", type: "string", description: desc, required: true });
const s = (name: string, description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ name, type: "string", description, ...extra });
const n = (name: string, description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ name, type: "number", description, ...extra });
const b = (name: string, description: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ name, type: "boolean", description, ...extra });

export const TREATMENT_ACTION_SPECS: ActionSpec[] = [
  {
    tool: "spine",
    action: "mask",
    argv: ["spine", "mask"],
    summary: "Set a spine clip's mask (shape, center, size, feather, invert); multiplies the clip alpha so the layer below shows through. Mask moves with the clip.",
    mutates: true,
    params: [
      clip(),
      s("shape", "Mask shape: rect|ellipse|split (split keeps the left half through the center)."),
      n("center_x", "Center x in percent of the clip frame (50 = middle).", { flag: "center-x" }),
      n("center_y", "Center y in percent of the clip frame (50 = middle).", { flag: "center-y" }),
      n("width", "Mask width in percent of the clip frame."),
      n("height", "Mask height in percent of the clip frame."),
      n("feather", "Soft edge in pixels at render size (0 = hard)."),
      b("invert", "Keep the outside of the mask instead of the inside."),
      b("clear", "Remove the mask."),
    ],
  },
  {
    tool: "spine",
    action: "motion-blur",
    argv: ["spine", "motion-blur"],
    summary: "Set a spine clip's motion blur (shutter over source frames; temporal blend). Does not blur placement-envelope pans of stills.",
    mutates: true,
    params: [
      clip(),
      n("shutter", "Shutter in degrees 0..360 (past-frame contribution; 0 = sharp)."),
      n("subframes", "Sample count 2..16 (blend window spans subframes-1 frame intervals)."),
      b("off", "Disable motion blur."),
    ],
  },
];
