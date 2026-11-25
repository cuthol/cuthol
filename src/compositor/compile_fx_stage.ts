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
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/** One emitted piece of the fx stage: plain filters, filters with the alpha held aside, or a pre-pass cut marker. */
export type FxStagePart =
  | { type: "chain"; filters: string[] }
  | { type: "alpha_keep"; filters: string[]; pinPixFmt: string }
  | { type: "cut"; cutAfterEntry: number }
  | { type: "shader_cut"; cut: FxShaderCutSpec };

/**
 * One step of the shader run inside a shader pre-pass, in written order: a
 * shader entry (its file plus per-frame uniform values) or the ffmpeg filters
 * of entries written between two shader entries.
 */
export type FxShaderRunStep =
  | {
      kind: "shader";
      entryId: string;
      /** Absolute path of the `.glsl` file. */
      file: string;
      /** sha256 (16 hex chars) of the file, part of the pre-pass cache key. */
      hash: string;
      /** Static uniform values (numbers and booleans from the entry params). */
      uniforms: Record<string, number | boolean>;
      /** Per-param envelopes, evaluated per frame at the item-local time. */
      envelopes: Record<string, ParameterEnvelope>;
      /**
       * Item-local frame index the pre-pass output starts at (windowed
       * pre-passes only; absent means 0). The worker adds it to each decoded
       * frame index before evaluating uniforms, so windowed frames shade
       * exactly like the same frames of a full-clip pre-pass.
       */
      frameOffset?: number;
    }
  | { kind: "ffmpeg"; filters: string[] };

/**
 * The automatic cut a shader entry (or run of shader entries) creates: the
 * prefix runs in the pre-pass, the ordered steps run in the worker, the main
 * graph continues after the last shader entry.
 */
export interface FxShaderCutSpec {
  /** Pixel-entry index of the first shader entry (prefix = entries before it). */
  firstPixelEntry: number;
  /** Pixel-entry index of the last shader entry (suffix = entries after it). */
  lastPixelEntry: number;
  steps: FxShaderRunStep[];
  /** Intermediate pixel format: `rgba` (8-bit input) or `rgba64le` (> 8-bit). */
  pixFmt: "rgba" | "rgba64le";
}

/**
 * Filters of every part that does pixel work, in order. A `cut` part is a
 * compile-time marker only: it contributes no filters, so the flattened chain
 * with a cut equals the flattened chain without it. Every call site that
 * flattens the stage for checking (probe, frozen probe, gates) uses this, so
 * both sides of a cut are always checked.
 */
export function flattenFxStageParts(parts: FxStagePart[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "cut" || p.type === "shader_cut") continue;
    out.push(...p.filters);
  }
  return out;
}

/**
 * Intermediate pixel format of a shader pre-pass: `rgba64le` when the chain
 * carries more than 8 bits into the stage, `rgba` otherwise.
 */
export function shaderPassPixFmt(receivedPixFmt: string | null): "rgba" | "rgba64le" {
  const fmt = (receivedPixFmt ?? "").toLowerCase();
  if (/(64|48|10|12|16|p010|p016|p210|p410)/.test(fmt)) return "rgba64le";
  return "rgba";
}

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
 * Entry bridge for a YUV-only filter on an RGB input: the stage receives
 * RGBA, but the filter only takes YUV, so ffmpeg would absorb a
 * default-precision RGB→YUV conversion into the bare entry converter (and pick
 * a full-range format there, measured ~53 dB against the no-fx render on a
 * neutral `eq`). Converting explicitly to limited-range `yuv444p` with the
 * same accuracy keeps luma bit-exact and chroma at the 8-bit round-trip floor.
 */
export const SPINE_FX_YUV444_ENTRY = `${SPINE_FX_ENTRY_CONVERTER}:out_range=tv,format=yuv444p`;

/** RGB input families that need the `SPINE_FX_YUV444_ENTRY` bridge before a YUV-only filter. */
const RGB_FAMILY_RE = /^(rgba|argb|bgra|abgr|rgb0|bgr0|0rgb|0bgr|rgb24|bgr24|gbrp|gbrap)$/i;

/**
 * YUV-only entry rule. A comma-separated segment of the built-in raw chain is
 * YUV-only when its filter name (leading token before `=`/`:`) is in
 * `YUV_ONLY_FILTER_NAMES`: that set is measured from ffmpeg 8.1 negotiation
 * probes (feed 16-bit YUV and planar RGB into the filter, read the
 * auto-inserted scaler target): `eq` forces 8-bit YUV (`yuv444p16le`→`yuv444p`,
 * `gbrp`→`yuv444p`, `yuva420p10le`→`yuva420p`, `gray10le`→`gray`), `hue` forces
 * YUV at up to 10 bit (`yuv444p16le`→`yuv444p10le`, `yuv420p10le` stays,
 * `yuv444p12le`→`yuv444p10le`). Every other probed filter (`colorbalance`,
 * `curves`, `selectivecolor`, `colorchannelmixer`, `vignette`, `unsharp`,
 * `negate`) takes RGB or any format and keeps the bare converter.
 */
const YUV_ONLY_FILTER_NAMES = new Set(["eq", "hue"]);

/** Leading filter name of one raw-chain segment, lower-cased (`""` when none). */
function builtinSegmentFilterName(segment: string): string {
  const m = /^[a-zA-Z0-9_]+/.exec(segment.trim());
  return m ? m[0].toLowerCase() : "";
}

/**
 * Deep planar YUV (or gray) split into plane kind, subsampling and bit depth,
 * or null when the format is 8-bit-or-less or not planar YUV (`rgba`, …).
 * `yuv420p10le` → `{ kind: "yuv", sub: "420", depth: 10 }`.
 */
function splitDeepYuvPixFmt(pixFmt: string): { kind: "yuv" | "yuva" | "gray"; sub: string; depth: number } | null {
  const m = /^(yuva|yuv|gray)(420|422|444|440|411|410)?p(9|10|12|14|16)(le|be)?$/.exec(
    pixFmt.trim().toLowerCase()
  );
  if (!m) return null;
  return { kind: m[1] as "yuv" | "yuva" | "gray", sub: m[2] ?? "", depth: Number(m[3]) };
}

/**
 * Depth bridge without resampling or range change: plain `scale` with the
 * stage's accuracy flags, so the reduction truncates exactly like the
 * auto-inserted converters and the downstream canvas quantizers do. Truncating
 * twice to the same grid composes to the single truncation (opaque 10-bit
 * stays bit-exact), while a rounding bridge would differ from the downstream
 * truncation by ±1 (measured 54.1 dB). Same subsampling/alpha/gray as the
 * input, limited range, bt709 matrix.
 */
function deepDepthBridge(targetPixFmt: string): string {
  return `${SPINE_FX_ENTRY_CONVERTER}:out_range=tv,format=${targetPixFmt}`;
}

/**
 * Precise entry converter for one raw-chain segment, whatever its parameters
 * (no parameter inspection): YUV-only filters get an explicit bridge so ffmpeg
 * never auto-inserts a default-precision conversion, every other filter keeps
 * the historical bare converter bit-exactly. `eq` only takes 8-bit YUV, so a
 * deeper-than-8-bit input converts precisely to its 8-bit twin (same
 * subsampling and alpha, so no resampling, only the unavoidable depth
 * rounding); `hue` keeps up to 10 bit, so only deeper inputs bridge down.
 */
function yuvOnlyEntryConverter(filterName: string, receivedPixFmt: string | null): string {
  if (!YUV_ONLY_FILTER_NAMES.has(filterName)) return SPINE_FX_ENTRY_CONVERTER;
  const rx = (receivedPixFmt ?? "").trim();
  if (RGB_FAMILY_RE.test(rx)) return SPINE_FX_YUV444_ENTRY;
  const deep = splitDeepYuvPixFmt(rx);
  if (!deep) return SPINE_FX_ENTRY_CONVERTER;
  if (filterName === "hue") {
    if (deep.depth <= 10) return SPINE_FX_ENTRY_CONVERTER;
    const sub = deep.kind === "gray" ? "" : deep.sub || "444";
    return deepDepthBridge(`${deep.kind}${sub}p10le`);
  }
  // `eq`: 8-bit twin of the received format (same subsampling/alpha/gray).
  if (deep.kind === "gray") return deepDepthBridge("gray");
  const sub = deep.sub || "444";
  return deepDepthBridge(`${deep.kind}${sub}p`);
}

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

/**
 * True when the offset sits inside a single-quoted region, matching what ffmpeg does:
 * outside quotes `\` escapes the next character, inside quotes it is a plain character
 * and the next `'` still closes the region.
 */
export function fxTemplateQuoteState(template: string, offset: number): boolean {
  let inQuote = false;
  for (let i = 0; i < offset && i < template.length; i++) {
    if (inQuote) {
      if (template[i] === "'") inQuote = false;
    } else if (template[i] === "\\") {
      i++;
    } else if (template[i] === "'") {
      inQuote = true;
    }
  }
  return inQuote;
}

/** Throws when the template has an unterminated single-quoted region. Names the fx and column. */
export function assertFxTemplateQuotesClosed(
  template: string,
  fail: (detail: string) => CutholError
): void {
  if (fxTemplateQuoteState(template, template.length)) {
    throw fail(`template has an unterminated single-quoted region (a ' without its closing '); quote every region or remove the stray quote.`);
  }
}

/**
 * Shared placeholder substitution: one rule for render and checks.
 * A placeholder outside quotes: animated -> `'expr'` (quoted), static -> escaped value.
 * Inside a single-quoted region: animated -> bare `expr`; static -> escaped value;
 * a static value containing `'` -> ERROR naming the param. `animated` holds bare expressions.
 */
export function substituteFxTemplateValues(
  template: string,
  values: Record<string, EffectParamValue>,
  animated: Map<string, string>,
  fail: (detail: string) => CutholError
): string {
  assertFxTemplateQuotesClosed(template, fail);
  FX_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
  const out = template.replace(FX_TEMPLATE_PLACEHOLDER_RE, function (_m, name: string) {
    const offset = arguments[arguments.length - 2] as number;
    const inQuote = fxTemplateQuoteState(template, offset);
    const expr = animated.get(name);
    if (expr !== undefined) return inQuote ? expr : `'${expr}'`;
    if (!(name in values)) {
      throw fail(`no value for the '${name}' parameter (define a default or pass '--param ${name}=<value>').`);
    }
    const raw = values[name];
    if (typeof raw === "string" && inQuote && raw.includes("'")) {
      throw fail(`'${name}' parameter value contains a single quote (') and cannot go inside a quoted template region (template: '${template.slice(0, 80)}').`);
    }
    const formatted = formatFxParamValue(raw);
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

/** Substitutes `{{param}}` with animated expressions (already quoted) or escaped static values. */
function substituteFxTemplate(
  template: string,
  values: Record<string, EffectParamValue>,
  animated: Map<string, string>,
  fail: (detail: string) => CutholError
): string {
  return substituteFxTemplateValues(template, values, animated, fail);
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
 * Emits G267 when a composition cue with a temporal fx (tmix, motion blur, frame
 * history) is compiled for a single frame: the single-frame compile feeds one
 * repeated frame, so `monitor frame` differs from `render` there. Spine clips and
 * non-composition cues never warn; full renders (no `singleFrameAtMs`) never warn.
 */
function maybeEmitCompositionTemporalSingleFrameWarning(
  ctx: VideoGraphCompileContext,
  owner: FxStageOwnerSpec,
  filters: string[]
): void {
  if (ctx?.compileOptions?.singleFrameAtMs === undefined) return;
  if (!fxStageHasTemporalFilter(filters)) return;
  let isCompositionCue = false;
  try {
    for (const lane of ctx.seq?.lanes ?? []) {
      for (const cue of lane.cues ?? []) {
        if (cue.id === owner.id && cue.kind === "composition" && cue.composition) {
          isCompositionCue = true;
          break;
        }
      }
      if (isCompositionCue) break;
    }
  } catch {
    return;
  }
  if (!isCompositionCue) return;
  const hit = filters.find((f) => TEMPORAL_FX_FILTER_RE.test(f)) ?? "temporal fx";
  const holder = ctx as unknown as { compileWarnings?: import("../core/diagnostics.js").CutholDiagnostic[] };
  if (!Array.isArray(holder.compileWarnings)) holder.compileWarnings = [];
  if (holder.compileWarnings.some((d) => d.code === "CUTHOL-G267" && d.subject_id === owner.id)) return;
  holder.compileWarnings.push(DIAGNOSTICS.COMPOSITION_TEMPORAL_FX_SINGLEFRAME(owner.id, hit.trim()));
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
    /**
     * Pre-pass cut position: number of pixel entries compiled before the cut
     * (`0` = before the first entry). The cut is a marker part only; the
     * flattened filter chain is unchanged. A cut inside a merged `alpha_keep`
     * run snaps to the end of the run: a wrapper is never split, the
     * shader-side rule is that the entry copies alpha itself.
     */
    cutAfterEntry?: number;
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
  // Shader entries carry their file and per-frame uniforms instead of filters;
  // a shader entry always breaks a merged `alpha_keep` run (it is `process`
  // for assembly: the wrapper never crosses the automatic shader cut).
  type CompiledEntry =
    | { kind: "pixel"; alpha: "keep" | "process"; filters: string[] }
    | {
        kind: "shader";
        entryId: string;
        file: string;
        hash: string;
        uniforms: Record<string, number | boolean>;
        envelopes: Record<string, ParameterEnvelope>;
      };
  const entries: CompiledEntry[] = [];
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
      // The YUV-only entry rule picks the converter per segment (a chain can
      // mix YUV-only and any-format filters), whatever each segment's
      // parameters are: no parameter inspection, the filter is never skipped.
      const filters: string[] = [];
      for (const segment of splitTopLevel((supplied.filter as string).trim(), ",")) {
        const name = builtinSegmentFilterName(segment);
        filters.push(yuvOnlyEntryConverter(name, params.receivedPixFmt), segment.trim());
      }
      entries.push({ kind: "pixel", alpha: "keep", filters });
      continue;
    }
    const def = lookupExtensionFx(fx.kind, seq, rootDir, fail);
    const values = resolveFxParams(def.spec.params, fx.params as Record<string, EffectParamValue>, fail);
    const animatable = new Set(def.spec.animatable ?? []);
    if (def.spec.backend === "shader") {
      const envelopes: Record<string, ParameterEnvelope> = {};
      for (const [param, env] of ownEnvelopes) {
        const declared = (def.spec.params ?? {})[param];
        if (!declared) {
          throw envFail(`fx.${fx.id}.${param}`, `effect '${fx.kind}' has no parameter named '${param}'.`);
        }
        if (!animatable.has(param)) {
          throw envFail(
            `fx.${fx.id}.${param}`,
            `'${param}' is not envelopable (the effect did not declare it in the 'animatable' list).`
          );
        }
        if ((env.points ?? []).length === 0) continue; // point-less envelope: the static value is used
        envelopes[param] = env;
      }
      const uniforms: Record<string, number | boolean> = {};
      for (const [k, v] of Object.entries(values)) {
        if (typeof v !== "number" && typeof v !== "boolean") {
          throw fail(`'${k}' must be a number or boolean for a shader effect (given: ${JSON.stringify(v)}).`);
        }
        uniforms[k] = v;
      }
      const rel = def.spec.shader ?? "";
      const abs = path.resolve(def.dir, rel);
      let source: string;
      try {
        source = fs.readFileSync(abs, "utf8");
      } catch {
        throw fail(`shader file ('${rel}') could not be read (re-enable the extension to re-validate).`);
      }
      entries.push({
        kind: "shader",
        entryId: fx.id,
        file: abs,
        hash: createHash("sha256").update(source).digest("hex").slice(0, 16),
        uniforms,
        envelopes,
      });
      continue;
    }
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
      animated.set(param, expr);
    }
    entries.push({
      kind: "pixel",
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
  const pinPixFmt = alphaKeepPinPixFmt(params.receivedPixFmt);
  // Assembles one side of a cut. A shader entry always ends the running
  // `alpha_keep` merge (it is `process` for assembly): the wrapper never
  // crosses the automatic shader cut, on either side of it.
  const assemble = (side: CompiledEntry[]): FxStagePart[] => {
    const pixels = (seg: CompiledEntry[]): Extract<CompiledEntry, { kind: "pixel" }>[] =>
      seg.filter((e): e is Extract<CompiledEntry, { kind: "pixel" }> => e.kind === "pixel");
    const assemblePixels = (list: Extract<CompiledEntry, { kind: "pixel" }>[]): FxStagePart[] => {
      if (!params.itemHasAlpha) {
        const filters = list.flatMap((e) => e.filters);
        return filters.length > 0 ? [{ type: "chain", filters }] : [];
      }
      const parts: FxStagePart[] = [];
      for (const e of list) {
        const last = parts[parts.length - 1];
        if (e.alpha === "keep" && last?.type === "alpha_keep") last.filters.push(...e.filters);
        else if (e.alpha === "keep") parts.push({ type: "alpha_keep", filters: [...e.filters], pinPixFmt });
        else parts.push({ type: "chain", filters: [...e.filters] });
      }
      return parts;
    };
    if (!side.some((e) => e.kind === "shader")) return assemblePixels(pixels(side));
    const out: FxStagePart[] = [];
    let seg: CompiledEntry[] = [];
    for (const e of side) {
      if (e.kind === "shader") {
        out.push(...assemblePixels(pixels(seg)));
        seg = [];
        continue;
      }
      seg.push(e);
    }
    out.push(...assemblePixels(pixels(seg)));
    return out;
  };
  const entryAlpha = (e: CompiledEntry): "keep" | "process" =>
    e.kind === "shader" ? "process" : e.alpha;
  // A shader entry (or run of them) is an automatic cut: the prefix runs in
  // the pre-pass, the ordered steps run in the worker, the main graph
  // continues after the last shader entry. Ffmpeg entries between two shader
  // entries become an ffmpeg step inside the same pre-pass (written order is
  // kept). The prefix ends with the entry converter + `format=rgba`
  // (8-bit input) or `rgba64le` (> 8-bit), which the worker reads back.
  const firstShader = entries.findIndex((e) => e.kind === "shader");
  if (firstShader >= 0) {
    let lastShader = firstShader;
    for (let k = firstShader + 1; k < entries.length; k++) {
      if (entries[k].kind === "shader") lastShader = k;
    }
    const pixFmt = shaderPassPixFmt(params.receivedPixFmt);
    const steps: FxShaderRunStep[] = [];
    for (let k = firstShader; k <= lastShader; k++) {
      const e = entries[k];
      if (e.kind === "shader") {
        steps.push({ kind: "shader", entryId: e.entryId, file: e.file, hash: e.hash, uniforms: e.uniforms, envelopes: e.envelopes });
      } else {
        steps.push({ kind: "ffmpeg", filters: [...e.filters] });
      }
    }
    const prefixFilters = entries.slice(0, firstShader).flatMap((e) => (e.kind === "pixel" ? e.filters : []));
    const rgbaExit = `${SPINE_FX_ENTRY_CONVERTER},format=${pixFmt}`;
    const prefix: FxStagePart[] =
      prefixFilters.length > 0
        ? [...assemble(entries.slice(0, firstShader)), { type: "chain", filters: [rgbaExit] }]
        : [{ type: "chain", filters: [rgbaExit] }];
    return [
      ...prefix,
      {
        type: "shader_cut",
        cut: { firstPixelEntry: firstShader, lastPixelEntry: lastShader, steps, pixFmt },
      },
      ...assemble(entries.slice(lastShader + 1)),
      exit,
    ];
  }
  // A cut never splits a merged `alpha_keep` part: pixel effects such as `eq`
  // process the alpha plane as well (measured: `eq=brightness` lifts it), so
  // closing the wrapper before the cut and reopening it after is lossy
  // (~44 dB). A cut inside a keep run snaps to the end of the run: the whole
  // wrapper stays on the pre-pass side and the shader-side rule is that the
  // entry copies alpha itself. Outside keep runs the cut is exactly lossless.
  const cut = params.cutAfterEntry;
  let at = cut ?? -1;
  if (at >= 0 && params.itemHasAlpha) {
    let runStart = -1;
    for (let k = 0; k <= entries.length; k++) {
      const keep = k < entries.length && entryAlpha(entries[k]) === "keep";
      if (keep && runStart < 0) runStart = k;
      if (!keep && runStart >= 0) {
        if (runStart < at && at < k) at = k;
        runStart = -1;
      }
    }
  }
  const pixelFilters = entries.flatMap((e) => (e.kind === "pixel" ? e.filters : []));
  maybeEmitCompositionTemporalSingleFrameWarning(ctx, owner, pixelFilters);
  if (cut === undefined) {
    // No cut: keep the exact historical part shape (one merged chain when
    // there is no live alpha, exit converter included).
    if (!params.itemHasAlpha) {
      return entries.length > 0 ? [{ type: "chain", filters: [...pixelFilters, ...exit.filters] }] : [];
    }
    return [...assemble(entries), exit];
  }
  at = Math.max(0, Math.min(at, entries.length));
  return [...assemble(entries.slice(0, at)), { type: "cut", cutAfterEntry: at }, ...assemble(entries.slice(at)), exit];
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
    if (p.type === "cut") continue;
    if (p.type === "shader_cut") {
      const first = p.cut.steps.find((s) => s.kind === "shader");
      throw new CutholError(
        DIAGNOSTICS.SHADER_LANE_REJECTED("lane item", first && first.kind === "shader" ? first.entryId : "shader")
      );
    }
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
  return flattenFxStageParts(parts);
}
