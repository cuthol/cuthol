// `cuthol spine mask` and `cuthol spine motion-blur`: set a spine clip's mask and motion blur
// treatments (dispatched from cli_cmd_spine.ts).
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import { CliCommandContext, CliCommandResult, emitEnvelopeJson } from "./cli_output.js";
import { setSpineMask, setSpineMotionBlur, MaskShape } from "./sequence/spine_treatments.js";

export function runSpineTreatmentCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "mask") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    if (boolFlag(flags, "clear", false)) {
      const res = setSpineMask({ workspaceDir, clipId, clear: true });
      emitEnvelopeJson(workspaceDir, "spine.mask.clear", { action: "spine.mask.clear", ...res });
      return;
    }
    const shapeRaw = strFlag(flags, "shape");
    let shape: MaskShape | undefined;
    if (shapeRaw !== undefined) {
      if (shapeRaw !== "rect" && shapeRaw !== "ellipse" && shapeRaw !== "split") {
        throw new Error(`--shape must be rect|ellipse|split, got '${shapeRaw}'.`);
      }
      shape = shapeRaw;
    }
    const invert = boolFlag(flags, "invert", undefined) ?? (flags["no-invert"] !== undefined ? false : undefined);
    const res = setSpineMask({
      workspaceDir,
      clipId,
      shape,
      centerXPct: numFlag(flags, "center-x"),
      centerYPct: numFlag(flags, "center-y"),
      widthPct: numFlag(flags, "width"),
      heightPct: numFlag(flags, "height"),
      featherPx: numFlag(flags, "feather"),
      invert,
    });
    emitEnvelopeJson(workspaceDir, "spine.mask", { action: "spine.mask", ...res });
    return;
  }
  if (action === "motion-blur") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    if (boolFlag(flags, "off", false)) {
      const res = setSpineMotionBlur({ workspaceDir, clipId, off: true });
      emitEnvelopeJson(workspaceDir, "spine.motion-blur.off", { action: "spine.motion-blur.off", ...res });
      return;
    }
    const res = setSpineMotionBlur({
      workspaceDir,
      clipId,
      shutterDeg: numFlag(flags, "shutter"),
      subframes: numFlag(flags, "subframes"),
    });
    emitEnvelopeJson(workspaceDir, "spine.motion-blur", { action: "spine.motion-blur", ...res });
    return;
  }
  throw new Error(`'spine ${action ?? ""}' is not available yet.`);
}
