// Agent effect catalog: one EffectDefinition per available effect kind.
import type { CutholSequence } from "../core/schema.js";
import type { EffectDefinition } from "./effect_types.js";
import { MOTION_EFFECT_DEFINITION } from "./effect_types.js";

export { MOTION_EFFECT_DEFINITION };
import { BUILTIN_FX_KIND } from "../compositor/compile_spine_fx.js";
import type { BuiltinTransitionKind } from "../core/schema.js";
import { getSequenceEffectRegistry } from "../extensions/ext_effects.js";
import type { ExtensionParamDef } from "../extensions/ext_manifest.js";

export const BUILTIN_TRANSITIONS: BuiltinTransitionKind[] = [
  "dissolve",
  "fade",
  "wipe_left",
  "wipe_right",
  "slide_up",
  "zoom_in",
];

const NATIVE_TRANSITIONS: ReadonlySet<string> = new Set(["dissolve", "fade"]);

function describeParams(params: Record<string, ExtensionParamDef>): Record<string, ExtensionParamDef> {
  return params;
}

export function listEffectDefinitions(
  seq: CutholSequence,
  paths?: { rootDir?: string }
): EffectDefinition[] {
  const out: EffectDefinition[] = [];
  for (const kind of BUILTIN_TRANSITIONS) {
    out.push({
      kind,
      role: "transition",
      backend: "ffmpeg",
      description: `Built-in transition '${kind}'.`,
      params: {},
      animatable: [],
      live: NATIVE_TRANSITIONS.has(kind) ? "native" : "server",
    });
  }
  out.push({
    kind: BUILTIN_FX_KIND,
    role: "clip",
    backend: "ffmpeg",
    description: "Raw ffmpeg filter chain (params.filter).",
    params: {
      filter: { type: "string", required: true, description: "ffmpeg filter chain." },
    },
    animatable: [],
    live: "server",
  });
  out.push(MOTION_EFFECT_DEFINITION);
  const rootDir = paths?.rootDir;
  if (rootDir && (seq.extensions ?? []).length > 0) {
    const reg = getSequenceEffectRegistry(seq, rootDir);
    for (const [ref, def] of reg.fx) {
      out.push({
        kind: ref,
        role: "clip",
        backend: "ffmpeg",
        alpha: def.spec.alpha ?? "keep",
        description: def.spec.description,
        params: describeParams(def.spec.params ?? {}),
        animatable: [...(def.spec.animatable ?? [])],
        live: "server",
        ffmpeg: { video_filter: def.spec.video_filter },
      });
    }
    for (const [ref, def] of reg.transitions) {
      out.push({
        kind: ref,
        role: "transition",
        backend: "ffmpeg",
        description: def.spec.description,
        params: describeParams(def.spec.params ?? {}),
        animatable: [],
        live: "server",
      });
    }
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind));
  return out;
}

export function getEffectDefinition(
  seq: CutholSequence,
  kind: string,
  paths?: { rootDir?: string }
): EffectDefinition | null {
  return listEffectDefinitions(seq, paths).find((d) => d.kind === kind) ?? null;
}
