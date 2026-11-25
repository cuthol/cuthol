// Effect system contract: one definition shape for built-in and extension effects.
//
// An effect is stored on a spine clip as a `ClipFxSpec` entry (`kind` names the definition,
// `params` its values, envelopes `fx.<id>.<param>` animate it). The definition says how the
// entry is realised (backend), which params it takes, which of them accept an envelope, and how
// Cuthol Live shows it. This file holds types only; the registry and the compilers come later.
//
// Rules the types encode:
// - Order (pixel backends): entries run in the order written. Consecutive entries on the same
//   backend share one pass; every backend switch adds an intermediate pass, reported by
//   verify/brief. Nothing is reordered silently.
// - Motion (backend "spine"): an entry is a layer on the clip's placement, applied after all
//   pixel entries at the geometry stage, independent of its position in the list. Layers stack:
//   x_pct, y_pct and rotation_deg add; scale_x, scale_y and opacity multiply (see
//   `PLACEMENT_LAYER_COMBINE`). The clip's own placement and its `placement.*` envelopes are the base.
// - Time: stored envelope offsets are clip-local milliseconds only. Beat and sequence times are
//   converted when written (tempo included); value-at-t accepts them as input.
// - Presets: applying a preset writes plain fx entries and points onto the clip and records the
//   preset's provenance on the entry. Render never reads the preset definition again, so a later
//   preset version never changes an existing project.
// - Shader inputs: gamma-encoded BT.709, full-range float RGBA, straight (not premultiplied)
//   alpha; uv in 0..1 with the origin at the bottom left, y up.
//
// Fx stage contract (one stage shared by spine clips and lane cues): an effect receives the
// item's own fitted format (its pixels at its fitted size), or RGBA when a colour stage runs
// before it. Time `t` in animated expressions is item-local seconds; colour is BT.709. Effects
// are classed by `EffectAlphaClass`: `keep` effects leave the item's alpha plane untouched (the
// stage holds it aside and merges it back), `process` effects run on the alpha too (blur,
// shift, distortion).
import type { EffectParamValue } from "../core/schema.js";
import type { ExtensionParamDef } from "../extensions/ext_manifest.js";

/** What the effect is applied to: one clip's pixels, the overlap of two clips, or a clip's placement. */
export type EffectRole = "clip" | "transition" | "motion";

/**
 * How the effect is realised.
 * - `ffmpeg`: a filter template in the render graph (today's extension fx path).
 * - `shader`: a GLSL fragment shader run by Cuthol's own shader pass (render and Live).
 * - `spine`: no pixel work; contributes a placement layer (role "motion" only).
 */
export type EffectBackend = "ffmpeg" | "shader" | "spine";

/**
 * How Cuthol Live shows the effect.
 * - `native`: the window draws it itself (placement layers, colour, shaders).
 * - `server`: the window marks the affected range; the true pixels come from the server's exact frame.
 */
export type EffectLiveVisibility = "native" | "server";

/** The built-in kind for motion-layer fx entries (backend "spine", role "motion"). */
export const MOTION_FX_KIND = "motion";

/** The six placement channels a motion layer can drive. */
export type PlacementChannel = "x_pct" | "y_pct" | "scale_x" | "scale_y" | "rotation_deg" | "opacity";

export const PLACEMENT_CHANNELS: readonly PlacementChannel[] = [
  "x_pct",
  "y_pct",
  "scale_x",
  "scale_y",
  "rotation_deg",
  "opacity",
];

/** How a layer's value combines with the base and with other layers, per channel. */
export const PLACEMENT_LAYER_COMBINE: Readonly<Record<PlacementChannel, "add" | "multiply">> = {
  x_pct: "add",
  y_pct: "add",
  rotation_deg: "add",
  scale_x: "multiply",
  scale_y: "multiply",
  opacity: "multiply",
};

/** Neutral value of a layer on a channel (adds 0, multiplies by 1). */
export function placementLayerIdentity(channel: PlacementChannel): number {
  return PLACEMENT_LAYER_COMBINE[channel] === "add" ? 0 : 1;
}

/**
 * Built-in `motion` effect: a placement layer on the item. Layers stack on the base placement:
 * x_pct, y_pct and rotation_deg add; scale_x, scale_y and opacity multiply.
 */
export const MOTION_EFFECT_DEFINITION: EffectDefinition = {
  kind: MOTION_FX_KIND,
  role: "motion",
  backend: "spine",
  description: "Placement layer: x/y/rotation add, scale/opacity multiply; layers stack in list order.",
  params: {
    x_pct: { type: "number", default: 0, description: "Horizontal offset in percent of stage width.", min: -1000, max: 1000 },
    y_pct: { type: "number", default: 0, description: "Vertical offset in percent of stage height.", min: -1000, max: 1000 },
    rotation_deg: { type: "number", default: 0, description: "Rotation in degrees.", min: -36000, max: 36000 },
    scale_x: { type: "number", default: 1, description: "Horizontal scale multiplier.", min: 0, max: 100 },
    scale_y: { type: "number", default: 1, description: "Vertical scale multiplier.", min: 0, max: 100 },
    opacity: { type: "number", default: 1, description: "Opacity multiplier (combined value clamps to [0, 1]).", min: 0, max: 10 },
  },
  animatable: ["x_pct", "y_pct", "rotation_deg", "scale_x", "scale_y", "opacity"],
  live: "native",
  spine: {
    channels: {
      x_pct: "x_pct",
      y_pct: "y_pct",
      rotation_deg: "rotation_deg",
      scale_x: "scale_x",
      scale_y: "scale_y",
      opacity: "opacity",
    },
  },
};

export interface FfmpegEffectBackendSpec {
  /** ffmpeg video filter template with `{{param}}` placeholders. */
  video_filter: string;
}

export interface ShaderEffectBackendSpec {
  /**
   * GLSL source path, relative to the definition's root. A clip effect defines
   * `vec4 effect(vec2 uv)` and reads `getInput(uv)`; a transition defines
   * `vec4 transition(vec2 uv)` and reads `getFromColor(uv)` / `getToColor(uv)`.
   * Host uniforms: `progress` (0..1, transitions), `time` (seconds), `ratio` (width / height).
   * Params are uniforms with a default in a trailing comment (`uniform float x; // = 1.0`).
   */
  source: string;
}

export interface SpineEffectBackendSpec {
  /**
   * Placement channels this motion effect drives. Each maps to the param whose value
   * (and envelope `fx.<id>.<param>`) is the layer value on that channel.
   */
  channels: Partial<Record<PlacementChannel, string>>;
}

/**
 * How an effect treats the item's alpha plane. `keep` (default) = the stage holds the item's
 * alpha and merges it back after the effect (per-pixel effects: colour, grain, vignette);
 * `process` = the effect runs on the alpha too (blur, shift, distortion).
 */
export type EffectAlphaClass = "keep" | "process";

/** One effect definition, the same shape for built-in effects and extension effects. */
export interface EffectDefinition {
  /** `<name>` for built-ins, `ext:<extension>/<name>` for extension effects. */
  kind: string;
  role: EffectRole;
  backend: EffectBackend;
  /** Alpha class of the effect; absent reads as `keep`. Nothing assigns it yet. */
  alpha?: EffectAlphaClass;
  description?: string;
  params: Record<string, ExtensionParamDef>;
  /** Number params that accept an envelope. Any other envelope on the effect is G119, never silent. */
  animatable: string[];
  live: EffectLiveVisibility;
  ffmpeg?: FfmpegEffectBackendSpec;
  shader?: ShaderEffectBackendSpec;
  spine?: SpineEffectBackendSpec;
}

/**
 * What a preset-generated entry depends on. When the dependency changes (the clip is trimmed,
 * the beat grid is re-analysed) verify reports it and one command regenerates the entry;
 * nothing is rewritten on its own.
 */
export type PresetBinding =
  | { to: "clip_start"; offset_ms: number }
  | { to: "clip_end"; offset_ms: number }
  | { to: "beats"; asset_handle: string; beat_grid_hash: string }
  | { to: "none" };

/** Recorded on an fx entry written by a preset. Informational: render does not read it. */
export interface PresetProvenance {
  preset: string;
  version: string;
  args: Record<string, EffectParamValue>;
  binding: PresetBinding;
}
