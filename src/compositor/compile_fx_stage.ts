// One fx stage shared by spine clips and lane cues (`clip.fx`, `cue.fx`).
// Runs after the colour stage (or right after fit scale and mirrors when there is no colour
// stage) and hands back the format it received. The source asset is never replaced, so transcript
// bindings (words → clip) stay intact. Only two kinds exist: the built-in raw chain
// (`kind: "ffmpeg"`, `params.filter`) and extension effects (`kind: "ext:<extension>/<name>"`,
// template + params from the manifest `fx` section). Anything else is G118, envelopes on
// non-animatable params are G119. An enabled fx is never dropped silently.
//
// Alpha: entries whose definition is `keep` hold the item's alpha aside and merge it back
// (`alpha_keep` parts, only when the item carries alpha); `process` entries run on the alpha
// too. Call sites place the parts with `emitFxStageParts`; when every part is a plain chain
// the filters inline into the same single chain.
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { ClipFxSpec, CutholSequence, EffectParamValue, ParameterEnvelope } from "../core/schema.js";
import { MOTION_FX_KIND } from "../effects/effect_types.js";
import { MOTION_EFFECT_DEFINITION } from "../effects/effect_types.js";
import { limitedRangePixFmt, type resolveSourceColorSpec } from "../library/probe.js";
import type { VideoGraphCompileContext } from "./compiler.js";
import { compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
import type { ExtensionParamDef } from "../extensions/ext_manifest.js";
import { checkBuiltinFxFilterChain as checkBuiltinFxChain, splitTopLevel } from "../extensions/ext_fx.js";
import {
  getSequenceEffectRegistry,
  isExtensionEffectRef,
  parseExtensionEffectRef,
} from "../extensions/ext_effects.js";
import type { ResolvedEffectDef } from "../extensions/ext_effects.js";
import type { ExtensionFxSpec } from "../extensions/ext_fx.js";

/** Anything that can own an fx chain: a spine clip or a lane cue. The stage only reads these. */
export interface FxStageOwner {
  id: string;
  fx?: ClipFxSpec[];
  envelopes: ParameterEnvelope[];
}

export type FxStageOwnerSpec = Pick<FxStageOwner, "id" | "fx" | "envelopes">;

/** One emitted piece of the fx stage: plain filters, or filters with the alpha held aside. */
export type FxStagePart =
  | { type: "chain"; filters: string[] }
  | { type: "alpha_keep"; filters: string[]; pinPixFmt: string };

/**
 * Converter placed before every fx entry. It has no size and no target format, so it converts
 * only when the next filter cannot take the incoming format (an RGB-only filter on a YUV clip),
 * and passes the frame through otherwise. ffmpeg's own auto-inserted converter uses swscale's
 * default (inexact) YUV→RGB path, which alone costs up to ~10 dB of luma on detailed footage;
 * `accurate_rnd` + `full_chroma_int` make the round trip near-lossless (measured: luma exact,
 * chroma ≥ 67 dB on 8-bit 4:2:0 sources).
 */
export const SPINE_FX_ENTRY_CONVERTER = "scale=in_color_matrix=bt709:out_color_matrix=bt709:flags=bicubic+accurate_rnd+full_chroma_int";

/**
 * Exit converter used when every stage after fx works on RGBA (mask, opacity, rotation,
 * transitions…): going back to the received YUV and then to RGBA would resample chroma twice,
 * so the fx stage hands over RGBA directly, converted with the same accuracy as the tail's
 * own YUV→RGBA step.
 */
export const SPINE_FX_RGBA_EXIT = `${SPINE_FX_ENTRY_CONVERTER},format=rgba`;

/**
 * Converter after the last fx entry: back to the format the fx stage received, with the same
 * accuracy, so everything downstream (mask, alpha, tail conversions) sees what it would see with
 * no fx at all. When the received format is not known at compile time (`null`: a colour stage
 * whose filters negotiate their own format), the exit only converts accurately and leaves the
 * format to the next stage, as it would be without fx.
 */
function fxExitConverter(receivedPixFmt: string | null): string {
  if (receivedPixFmt === null) return SPINE_FX_ENTRY_CONVERTER;
  if (receivedPixFmt === "rgba") return SPINE_FX_RGBA_EXIT;
  if (!receivedPixFmt.startsWith("yuv")) return `${SPINE_FX_ENTRY_CONVERTER},format=${receivedPixFmt}`;
  return `${SPINE_FX_ENTRY_CONVERTER}:out_range=tv,format=${receivedPixFmt}`;
}

/** The only built-in fx kind (effects themselves live in extensions, so no other built-in is added). */
export const BUILTIN_FX_KIND = "ffmpeg";

/**
 * Active entries that do pixel work. Motion entries (`kind: "motion"`, backend "spine") never
 * enter the pixel stage: they are placement layers, not filters. This predicate never looks up
 * any registry and never throws (an unknown kind stays a pixel entry and fails where it fails
 * today, with the same diagnostic in the same order).
 */
export function pixelFxEntries(owner: FxStageOwnerSpec): ClipFxSpec[] {
  return (owner.fx ?? []).filter((f) => f.enabled !== false && f.kind !== MOTION_FX_KIND);
}

/** Re-exported so existing importers keep working; the implementation lives in `extensions/ext_fx`. */
export const checkBuiltinFxFilterChain = checkBuiltinFxChain;

/**
 * Validates supplied fx params against the manifest `ExtensionParamDef` map (type, min/max, enum, required,
 * default). Every failure throws through `fail` so callers attach their own G118 context.
 */
export function resolveFxParams(
  defs: Record<string, ExtensionParamDef> | undefined,
  supplied: Record<string, EffectParamValue> | undefined,
  fail: (detail: string) => CutholError
): Record<string, EffectParamValue> {
  const schema = defs ?? {};
  const raw: Record<string, unknown> = supplied ?? {};
  const out: Record<string, EffectParamValue> = {};
  const names = Object.keys(schema);
  if (names.length > 0) {
    for (const k of Object.keys(raw)) {
      if (!(k in schema)) {
        throw fail(`unknown parameter '${k}' (valid parameters: ${names.join(", ")}).`);
      }
    }
  }
  for (const [k, def] of Object.entries(schema)) {
    const val: unknown = raw[k] !== undefined ? raw[k] : def.default;
    if (val === undefined || val === null) {
      if (def.required) {
        throw fail(`required parameter '${k}' is missing.`);
      }
      continue;
    }
    if (def.type === "number") {
      const n =
        typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
      if (!Number.isFinite(n)) {
        throw fail(`'${k}' must be a number (given: ${JSON.stringify(val)}).`);
      }
      if (def.min !== undefined && n < def.min) {
        throw fail(`'${k}' (${n}) is below the minimum (${def.min}).`);
      }
      if (def.max !== undefined && n > def.max) {
        throw fail(`'${k}' (${n}) is above the maximum (${def.max}).`);
      }
      out[k] = n;
    } else if (def.type === "boolean") {
      if (typeof val === "boolean") {
        out[k] = val;
      } else if (typeof val === "string") {
        const t = val.trim().toLowerCase();
        if (t === "true" || t === "1") out[k] = true;
        else if (t === "false" || t === "0") out[k] = false;
        else throw fail(`'${k}' must be true/false (given: ${JSON.stringify(val)}).`);
      } else {
        throw fail(`'${k}' must be true/false (given: ${JSON.stringify(val)}).`);
      }
    } else {
      if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
        throw fail(`'${k}' must be text (given: ${JSON.stringify(val)}).`);
      }
      out[k] = typeof val === "string" ? val : String(val);
    }
    if (def.enum && !def.enum.includes(out[k] as string | number)) {
      throw fail(`'${k}' must be one of: ${def.enum.join(", ")}.`);
    }
  }
  if (names.length === 0) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Formats a static param value for ffmpeg filtergraph syntax. Null = unserializable (control chars). */
export function formatFxParamValue(value: EffectParamValue): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return null;
  return value.replace(/[\\':,[\];]/g, (ch) => `\\${ch}`);
}

const FX_TEMPLATE_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/** Substitutes `{{param}}` with animated expressions (already quoted) or escaped static values. */
function substituteFxTemplate(
  template: string,
  values: Record<string, EffectParamValue>,
  animated: Map<string, string>,
  fail: (detail: string) => CutholError
): string {
  const out = template.replace(FX_TEMPLATE_PLACEHOLDER_RE, (_m, name: string) => {
    const expr = animated.get(name);
    if (expr !== undefined) return expr;
    if (!(name in values)) {
      throw fail(`no value for the '${name}' parameter (define a default or pass '--param ${name}=<value>').`);
    }
    const formatted = formatFxParamValue(values[name]);
    if (formatted === null) {
      throw fail(`'${name}' parameter value cannot be written into the filter (it contains a control character).`);
    }
    return formatted;
  });
  if (out.includes("{{") || out.includes("}}")) {
    throw fail(`template contains an unresolvable placeholder ('${out.slice(0, 80)}').`);
  }
  return out;
}

const FX_ENVELOPE_RE = /^fx\.([^.]+)\.([^.]+)$/;

/** Groups `fx.<id>.<param>` envelopes by fx id. Fx ids and param names never contain dots. */
function collectFxEnvelopes(owner: FxStageOwnerSpec): Map<string, Map<string, ParameterEnvelope>> {
  const byFx = new Map<string, Map<string, ParameterEnvelope>>();
  for (const env of owner.envelopes) {
    const m = FX_ENVELOPE_RE.exec(env.parameter);
    if (!m) continue;
    let inner = byFx.get(m[1]);
    if (!inner) {
      inner = new Map();
      byFx.set(m[1], inner);
    }
    inner.set(m[2], env);
  }
  return byFx;
}

/** Resolves an `ext:<extension>/<name>` kind through the sequence effect registry, or throws G118. */
function lookupExtensionFx(
  kind: string,
  seq: CutholSequence,
  rootDir: string | undefined,
  fail: (detail: string, suggestion?: string) => CutholError
): ResolvedEffectDef<ExtensionFxSpec> {
  if (!isExtensionEffectRef(kind)) {
    throw fail(
      `unknown kind '${kind}' (built-in kinds are 'ffmpeg' and 'motion'; extension kinds are in 'ext:<extension>/<name>' form).`
    );
  }
  if (!rootDir) {
    throw fail(`effect record '${kind}' could not be resolved without a project directory.`);
  }
  const reg = getSequenceEffectRegistry(seq, rootDir);
  const found = reg.fx.get(kind);
  if (found) return found;
  const ref = parseExtensionEffectRef(kind) ?? { extension: kind, name: kind };
  const loadErr = reg.load_errors.get(ref.extension);
  if (loadErr !== undefined) {
    throw fail(
      `extension '${ref.extension}' failed to load: ${loadErr}`,
      `check the manifest with 'cuthol extension show --name ${ref.extension}'.`
    );
  }
  const enabled = (seq.extensions ?? []).some((e) => e.name === ref.extension);
  if (!enabled) {
    throw fail(
      `extension '${ref.extension}' is not enabled in this project.`,
      `enable it with 'cuthol extension enable --name ${ref.extension}' or remove the effect.`
    );
  }
  throw fail(
    `extension '${ref.extension}' has no effect named '${ref.name}'.`,
    `list the available effects with 'cuthol extension show --name ${ref.extension}'.`
  );
}

/** Pixel formats that carry a live alpha plane into the fx stage. */
const ALPHA_PIX_FMT_RE = /^(rgba|argb|bgra|abgr|gbrap|yuva|ya)/;

/**
 * Temporal video-blender filters: they mix neighbouring frames, so on a single-frame
 * compile (one looped PNG) they see the same frame repeated. Kept in one place.
 */
export const TEMPORAL_FX_FILTER_RE = /(?:^|,)(?:tmix|lagfun|tblend)(?:=|,|$)/;

/** True when any filter text of the stage uses a temporal video blender (see above). */
export function fxStageHasTemporalFilter(filters: string[]): boolean {
  return filters.some((f) => TEMPORAL_FX_FILTER_RE.test(f));
}

/**
 * Rule: the item carries a live alpha plane at the fx point
 * when the received format names an alpha plane (RGBA, YUVA, …), or the source itself
 * is RGB (png / still image: `format=rgba` right after the input), or the asset probe
 * reports an alpha pixel format (alpha mov). A YUV source without alpha has none, so
 * `keep` entries stay a plain chain there.
 */
export function itemCarriesAlphaAtFx(
  receivedPixFmt: string | null,
  colorSpec: { isRgb: boolean },
  asset: { probe: { pix_fmt?: string | null } }
): boolean {
  if (receivedPixFmt && ALPHA_PIX_FMT_RE.test(receivedPixFmt)) return true;
  if (colorSpec.isRgb) return true;
  const probeFmt = (asset.probe.pix_fmt ?? "").toLowerCase().trim();
  return ALPHA_PIX_FMT_RE.test(probeFmt);
}

/**
 * True when the owner's fx stage would contain an `alpha_keep` part once compiled with
 * a live alpha plane: any active entry whose alpha class is `keep` (the built-in raw
 * chain is `keep`; extension entries read their manifest). Lookup failures return true
 * (conservative: the stage build throws G118 for those anyway, so never bake them).
 */
export function fxStageWouldKeepAlpha(
  seq: CutholSequence,
  rootDir: string | undefined,
  owner: FxStageOwnerSpec
): boolean {
  const active = pixelFxEntries(owner);
  if (active.length === 0) return false;
  for (const fx of active) {
    if (fx.kind === BUILTIN_FX_KIND) return true;
    try {
      const fail = (detail: string, suggestion?: string) =>
        new CutholError(DIAGNOSTICS.SPINE_FX_INVALID(owner.id, fx.id, fx.kind, detail, suggestion));
      const def = lookupExtensionFx(fx.kind, seq, rootDir, fail);
      if ((def.spec.alpha ?? "keep") === "keep") return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Format pinned right before an `alpha_keep` split. The received format when it carries
 * alpha (so the wrapper never depends on what precedes the stage: a `scale`/`crop` after
 * `format=rgba` leaves the format open and the two branches cannot agree); `rgba` otherwise,
 * which also covers a YUV clip compiled with a live alpha: there is no plane to keep, so the
 * wrapper converts up front and runs on an opaque alpha instead of failing negotiation.
 */
function alphaKeepPinPixFmt(receivedPixFmt: string | null): string {
  if (receivedPixFmt && ALPHA_PIX_FMT_RE.test(receivedPixFmt)) return receivedPixFmt;
  return "rgba";
}

/**
 * Builds the one fx stage of an item (spine clip or lane cue). Every active entry becomes its
 * filter list; an entry whose definition is `keep` becomes (part of) an `alpha_keep` part only
 * when `itemHasAlpha` is true; consecutive `keep` entries share one part. `process` entries,
 * and every entry when `itemHasAlpha` is false, are plain `chain` parts. In this wave every
 * call site passes `itemHasAlpha: false`, so the output is one chain (or nothing).
 */
export function buildItemFxStage(
  ctx: VideoGraphCompileContext,
  params: {
    owner: FxStageOwnerSpec;
    /** Pixel format the chain carries into the fx stage (see `spineFxReceivedPixFmt`). */
    receivedPixFmt: string | null;
    /** True when the item carries a live alpha plane into the stage. */
    itemHasAlpha: boolean;
  }
): FxStagePart[] {
  const { owner } = params;
  const all = owner.fx ?? [];
  const active = all.filter((f) => f.enabled !== false);
  if (active.length === 0) return [];
  const byFx = collectFxEnvelopes(owner);
  const seenIds = new Set(active.map((f) => f.id));
  const disabledIds = new Set(all.filter((f) => f.enabled === false).map((f) => f.id));
  const motionIds = new Set(active.filter((f) => f.kind === MOTION_FX_KIND).map((f) => f.id));
  const seq = ctx.seq;
  const rootDir = ctx.paths?.rootDir as string | undefined;
  // Per-entry filter lists with their alpha class, in order. The class lookup also validates
  // the entry (unknown kind or bad params throw G118 here, as before).
  const entries: { alpha: "keep" | "process"; filters: string[] }[] = [];
  for (const fx of active) {
    const fail = (detail: string, suggestion?: string) =>
      new CutholError(DIAGNOSTICS.SPINE_FX_INVALID(owner.id, fx.id, fx.kind, detail, suggestion));
    const envFail = (parameter: string, reason: string) =>
      new CutholError(DIAGNOSTICS.SPINE_FX_ENVELOPE_UNSUPPORTED(owner.id, parameter, reason));
    const ownEnvelopes = byFx.get(fx.id) ?? new Map<string, ParameterEnvelope>();
    if (fx.kind === MOTION_FX_KIND) {
      // A motion entry is a placement layer, not pixel work: validate its params and envelopes
      // against the built-in `motion` definition, then emit no filters.
      resolveFxParams(MOTION_EFFECT_DEFINITION.params, fx.params as Record<string, EffectParamValue>, fail);
      const animatable = new Set(MOTION_EFFECT_DEFINITION.animatable);
      for (const [param, env] of ownEnvelopes) {
        const declared = MOTION_EFFECT_DEFINITION.params[param];
        if (!declared) {
          throw envFail(`fx.${fx.id}.${param}`, `effect '${fx.kind}' has no parameter named '${param}'.`);
        }
        if (!animatable.has(param)) {
          throw envFail(
            `fx.${fx.id}.${param}`,
            `'${param}' is not envelopable (the effect did not declare it in the 'animatable' list).`
          );
        }
        void env;
      }
      continue;
    }
    if (fx.kind === BUILTIN_FX_KIND) {
      if (ownEnvelopes.size > 0) {
        const first = [...ownEnvelopes.keys()][0];
        throw envFail(
          `fx.${fx.id}.${first}`,
          `parameters of the built-in 'ffmpeg' chain cannot be enveloped (the chain is a single text).`
        );
      }
      const supplied: Record<string, unknown> = (fx.params ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(supplied)) {
        if (k !== "filter") {
          throw fail(`unknown parameter '${k}' (the built-in kind only takes 'filter').`);
        }
      }
      const problem = checkBuiltinFxFilterChain(supplied.filter);
      if (problem) throw fail(problem);
      const filters: string[] = [];
      for (const segment of splitTopLevel((supplied.filter as string).trim(), ",")) {
        filters.push(SPINE_FX_ENTRY_CONVERTER, segment.trim());
      }
      entries.push({ alpha: "keep", filters });
      continue;
    }
    const def = lookupExtensionFx(fx.kind, seq, rootDir, fail);
    const values = resolveFxParams(def.spec.params, fx.params as Record<string, EffectParamValue>, fail);
    const animatable = new Set(def.spec.animatable ?? []);
    const animated = new Map<string, string>();
    for (const [param, env] of ownEnvelopes) {
      const declared = (def.spec.params ?? {})[param];
      if (!declared) {
        throw envFail(`fx.${fx.id}.${param}`, `effect '${fx.kind}' has no parameter named '${param}'.`);
      }
      if (!animatable.has(param)) {
        throw envFail(
          `fx.${fx.id}.${param}`,
          `'${param}' is not envelopable (the extension did not declare it in the 'animatable' list).`
        );
      }
      const expr = compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: 0, mode: "raw" });
      if (expr === null) continue; // point-less envelope: no animation, the static value is used
      animated.set(param, `'${expr}'`);
    }
    entries.push({
      alpha: def.spec.alpha ?? "keep",
      filters: [SPINE_FX_ENTRY_CONVERTER, substituteFxTemplate(def.spec.video_filter, values, animated, fail)],
    });
  }
  for (const [fxId, inner] of byFx) {
    if (seenIds.has(fxId) || disabledIds.has(fxId)) continue; // a disabled effect's envelope is dormant, not G119
    const first = [...inner.keys()][0];
    throw new CutholError(
      DIAGNOSTICS.SPINE_FX_ENVELOPE_UNSUPPORTED(owner.id, `fx.${fxId}.${first}`, `no effect with id '${fxId}' exists on '${owner.id}'.`)
    );
  }
  if (entries.length === 0) return [];
  const exit: FxStagePart = { type: "chain", filters: [fxExitConverter(params.receivedPixFmt)] };
  if (!params.itemHasAlpha) {
    return [{ type: "chain", filters: [...entries.flatMap((e) => e.filters), ...exit.filters] }];
  }
  const parts: FxStagePart[] = [];
  const pinPixFmt = alphaKeepPinPixFmt(params.receivedPixFmt);
  for (const e of entries) {
    const last = parts[parts.length - 1];
    if (e.alpha === "keep" && last?.type === "alpha_keep") last.filters.push(...e.filters);
    else if (e.alpha === "keep") parts.push({ type: "alpha_keep", filters: [...e.filters], pinPixFmt });
    else parts.push({ type: "chain", filters: [...e.filters] });
  }
  parts.push(exit);
  return parts;
}

/**
 * Places the fx stage parts between the filters before and after the stage. When every part is
 * a plain chain the filters inline into the same single chain. An `alpha_keep` part splits the
 * chain: the alpha plane travels on a side branch (`alphaextract`) while the effect runs on the
 * other branch, then `alphamerge` restores it. Pad labels come from the context counter, so every
 * placement is unique. Returns the index of the stage's exit converter in `vFilters`
 * (or -1 without fx), for call sites that edit the chain after the stage.
 */
export function emitFxStageParts(
  ctx: VideoGraphCompileContext,
  vFilters: string[],
  parts: FxStagePart[]
): { exitFilterIdx: number } {
  if (parts.length === 0) return { exitFilterIdx: -1 };
  if (parts.every((p) => p.type === "chain")) {
    for (const p of parts) vFilters.push(...p.filters);
    return { exitFilterIdx: vFilters.length - 1 };
  }
  for (const p of parts) {
    if (p.type === "chain") {
      vFilters.push(...p.filters);
      continue;
    }
    // The effect branch may leave any format (an effect can drop the alpha plane, e.g.
    // `vignette` outputs `rgb24`); convert it back to RGBA with the accurate converter before
    // the merge, so ffmpeg never auto-inserts its default converter inside the wrapper.
    // The format is pinned right before the split, so the two branches agree no matter what
    // precedes the stage. The shared exit converter after the merge hands back the received format.
    const tag = `fxk${++ctx.vStepCounter}`;
    vFilters.push(
      `format=${p.pinPixFmt},split[${tag}a][${tag}b]`,
      `[${tag}a]alphaextract[${tag}alpha]`,
      `[${tag}b]${p.filters.join(",")},${SPINE_FX_RGBA_EXIT}[${tag}v]`,
      `[${tag}v][${tag}alpha]alphamerge`
    );
  }
  return { exitFilterIdx: vFilters.length - 1 };
}

/** True when the item carries anything the fx gate must look at (entries or fx envelopes). */
export function itemFxNeedsCheck(owner: FxStageOwnerSpec): boolean {
  return (owner.fx ?? []).length > 0 || owner.envelopes.some((e) => e.parameter.startsWith("fx."));
}

/**
 * Pixel format a spine clip carries into the fx stage when no fx is present, which is the format
 * the fx stage must hand back, or `null` when it is not known at compile time. A colour stage that
 * ends on an explicit `format=` sets it; any other colour stage lets its filters negotiate (`null`;
 * e.g. `colortemperature` takes 10-bit YUV over to RGB); RGB sources are RGBA from the start;
 * otherwise the fit scale keeps the source's own format (full-range
 * `yuvj*` pinned to its limited-range twin, see `SourceColorSpec.fitPixFmt`).
 */
export function spineFxReceivedPixFmt(
  colorSpec: ReturnType<typeof resolveSourceColorSpec>,
  asset: CutholSequence["library"][number],
  colorFilters: string[]
): string | null {
  if (colorFilters.length > 0) {
    const m = /(?:^|,)format=([a-z0-9]+)\s*$/.exec(colorFilters[colorFilters.length - 1]);
    return m ? m[1] : null;
  }
  if (colorSpec.isRgb) return "rgba";
  const pix = limitedRangePixFmt((asset.probe.pix_fmt ?? "").toLowerCase().trim());
  return pix.startsWith("yuv") ? pix : "yuv420p";
}

/** True when the clip carries anything the fx gate must look at (entries or fx envelopes). */
export function spineClipNeedsFxCheck(clip: FxStageOwnerSpec): boolean {
  return itemFxNeedsCheck(clip);
}

/**
 * Old spine-only entry point, kept for existing importers: builds the stage with no live alpha,
 * so the result is the same single filter list as before.
 */
export function buildSpineClipFxFilters(
  ctx: VideoGraphCompileContext,
  params: {
    clip: FxStageOwnerSpec;
    asset: CutholSequence["library"][number];
    absAssetPath: string;
    clipColorSpec: ReturnType<typeof resolveSourceColorSpec>;
    /** Output size of the clip chain at this point (after fit/scale), pixels. */
    targetW: number;
    targetH: number;
    /** Pixel format the chain carries into the fx stage (see `spineFxReceivedPixFmt`). */
    receivedPixFmt: string | null;
  }
): string[] {
  const parts = buildItemFxStage(ctx, {
    owner: params.clip,
    receivedPixFmt: params.receivedPixFmt,
    itemHasAlpha: false,
  });
  return parts.flatMap((p) => p.filters);
}
