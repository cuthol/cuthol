// Manifest `fx` section: per-clip effects an extension contributes to `spine fx`.
// Each entry is `{ description?, params?, video_filter, animatable? }`; `video_filter` is
// an ffmpeg video filter template with `{{param}}` placeholders, applied on the clip in the render graph
// (compositor/compile_spine_fx.ts). The gate may add keys to ALLOWED_FX_KEYS (closed schema: unknown keys fail).
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { fxTemplateQuoteState } from "../compositor/compile_fx_stage.js";
import { parseShaderFileRef } from "../effects/shader_def.js";
import { ExtensionParamDef, validateParamsMap } from "./ext_manifest.js";

export interface ExtensionFxSpec {
  description?: string;
  params?: Record<string, ExtensionParamDef>;
  /**
   * ffmpeg video filter template, e.g. `"gblur=sigma={{sigma}}"`. Always set
   * for backend "ffmpeg"; unset at runtime for backend "shader" (branch on
   * `backend` first, never read this for a shader entry).
   */
  video_filter: string;
  /**
   * Realisation backend: `"ffmpeg"` (default, `video_filter` template) or
   * `"shader"` (a `.glsl` file run through the shader pre-pass).
   */
  backend?: "ffmpeg" | "shader";
  /**
   * GLSL source path for backend "shader", relative to the extension folder
   * (e.g. `"shaders/blur.glsl"`). Params come from the file's uniforms.
   */
  shader?: string;
  /**
   * Per-param neutral values, e.g. `{ brightness: 0 }`: setting every param to
   * its neutral must render (near-)identically to no fx (Y PSNR >= 60 dB).
   * Declared per param in the manifest (`params.<name>.neutral`).
   */
  neutral?: Record<string, number>;
  /**
   * True when the effect changes duration or frame count on purpose
   * (e.g. `tpad`, `fade` with history). The full check does not flag
   * frame-count changes for these.
   */
  temporal?: boolean;
  /**
   * Measured per-frame cost class at 1080p: `light` / `medium` / `heavy`.
   * The full check warns when the manifest value contradicts measurement.
   */
  cost_class?: "light" | "medium" | "heavy";
  /**
   * Alpha class of the effect: `keep` (default) leaves the item's alpha plane untouched,
   * `process` runs the effect on the alpha too. Nothing reads it yet.
   */
  alpha?: "keep" | "process";
  /**
   * Names of number params whose filter option accepts a per-frame expression, so an envelope
   * `fx.<id>.<param>` may animate them. Any other envelope on this effect is G119 (never silent).
   */
  animatable?: string[];
}

export const ALLOWED_FX_KEYS = new Set(["description", "params", "video_filter", "backend", "shader", "animatable", "alpha", "temporal", "cost_class"]);

export const EFFECT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const FX_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/**
 * Filters rejected inside a built-in (`kind: "ffmpeg"`) chain, with rationale:
 * - `movie` / `amovie` read arbitrary files or URLs as new graph inputs. The fx stage compiles into one
 *   hermetic chain fed by the clip's own input; an outside source breaks that assumption and turns a sequence
 *   field into a file/URL read primitive.
 * - `sendcmd` executes filter commands from a file at render time (a second program hidden in data).
 * - `zmq` / `azmq` open network sockets for live remote control of the filter graph.
 */
const BANNED_BUILTIN_FX_FILTERS = new Set(["movie", "amovie", "sendcmd", "zmq", "azmq"]);

/**
 * Filter options that read external files (e.g. `lut3d=file=...`, `subtitles=filename=...`). Rejecting the
 * option key keeps file-backed effects where they belong: in extensions (sandboxed, hash-pinned), never in a
 * raw user chain. Residual: positional filename args (`subtitles=/x`) are not detected; document, don't chase.
 */
const FILE_READING_FX_OPTIONS = new Set(["file", "filename", "path"]);

/** Split on a separator, ignoring separators inside single quotes and parens. Brackets are rejected earlier. */
export function splitTopLevel(text: string, sep: "," | ":"): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < text.length) {
        cur += text[i + 1];
        i++;
      } else if (ch === "'") {
        quote = false;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      cur += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === "'") {
      quote = true;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Filter name is the leading identifier of a segment (`scale=w=..` → `scale`). */
function fxSegmentFilterName(segment: string): string {
  const m = /^\s*([A-Za-z][A-Za-z0-9_]*)/.exec(segment);
  return m ? m[1].toLowerCase() : "";
}

/** Option keys of one filter segment (`key=value` pieces of the args after the first `=`). */
function fxSegmentOptionKeys(segment: string): string[] {
  const eq = segment.indexOf("=");
  if (eq === -1) return [];
  const keys: string[] = [];
  for (const piece of splitTopLevel(segment.slice(eq + 1), ":")) {
    const keyEq = piece.indexOf("=");
    if (keyEq === -1) continue;
    keys.push(piece.slice(0, keyEq).trim().toLowerCase());
  }
  return keys;
}

/** Names in `animatable` must be declared number params (envelopes carry numbers). */
function parseFxAnimatable(
  raw: unknown,
  params: Record<string, ExtensionParamDef>,
  extName: string,
  fxName: string
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.animatable' must be an array of strings (envelopable parameter names).`
      )
    );
  }
  const seen = new Set<string>();
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    const def = params[name];
    if (!def) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'${name}' in 'fx.${fxName}.animatable' is not a declared parameter.`
        )
      );
    }
    if (def.type !== "number") {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'${name}' in 'fx.${fxName}.animatable' is not numeric (envelopes carry numbers).`
        )
      );
    }
  }
  return [...seen];
}

/**
 * Validates a built-in (`kind: "ffmpeg"`) raw chain. Returns the English G118 detail, or null when valid.
 * Shared by the compiler and the verify gate so both always agree. Extension `video_filter` templates are
 * checked with the same function at manifest load (placeholders sit in value position, so filter names and
 * option keys read exactly as in a raw chain).
 */
export function checkBuiltinFxFilterChain(chain: unknown): string | null {
  if (typeof chain !== "string" || !chain.trim()) {
    return `'filter' must be a non-empty filter chain (e.g. "gblur=sigma=3").`;
  }
  const trimmed = chain.trim();
  const badChar = trimmed.match(/[[;\]]/);
  if (badChar) {
    return `chain must not contain the graph separator ('${badChar[0]}') (compiled as a single chain).`;
  }
  if (/[\r\n\x00]/.test(trimmed)) {
    return `chain must not contain line breaks.`;
  }
  for (const seg of splitTopLevel(trimmed, ",")) {
    const name = fxSegmentFilterName(seg);
    if (!name) {
      return `unresolvable filter segment ('${seg.trim().slice(0, 40)}').`;
    }
    if (BANNED_BUILTIN_FX_FILTERS.has(name)) {
      return `'${name}' filter is forbidden in a raw chain (it reads files or opens external commands/remote control).`;
    }
    for (const key of fxSegmentOptionKeys(seg)) {
      if (FILE_READING_FX_OPTIONS.has(key)) {
        return `'${key}=' in the '${name}' filter reads a file; effects using files must be defined in an extension.`;
      }
    }
  }
  return null;
}

/**
 * An unterminated single-quoted region in the template is a manifest error naming the fx.
 * Uses the shared quote-state scanner from `compile_fx_stage` (one rule for render and load).
 * Measured against ffmpeg (G340): ffmpeg's graph parser also treats `\` as escaping the next
 * character inside quotes, so `eq=brightness='0.1\':eval=frame` is genuinely unterminated
 * there too (the `\'` does not close the region; ffmpeg then reads `:eval=frame` into the
 * expression). The scanner matches that behaviour.
 */
function assertFxTemplateQuotesClosedManifest(template: string, extName: string, fxName: string): void {
  if (fxTemplateQuoteState(template, template.length)) {
    throw new CutholError(DIAGNOSTICS.FX_TEMPLATE_UNTERMINATED_QUOTE(extName, fxName));
  }
}

/** Every `{{name}}` in the template must be a declared param, otherwise compile would emit it raw. */
function assertFxPlaceholdersDeclared(
  template: string,
  params: Record<string, ExtensionParamDef>,
  extName: string,
  fxName: string
): void {
  FX_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FX_PLACEHOLDER_RE.exec(template)) !== null) {
    if (!(m[1] in params)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'{{${m[1]}}}' in 'fx.${fxName}.video_filter' is not a declared parameter (define it under 'params').`
        )
      );
    }
  }
}

/** fx templates compile into one shared chain, so graph separators would corrupt neighbouring filters. */
function assertFxTemplateSafe(template: string, extName: string, fxName: string): void {
  const bad = template.match(/[[;\]]/);
  if (bad) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.video_filter' must not contain the graph separator ('${bad[0]}') (compiled as a single chain).`
      )
    );
  }
}

/**
 * Optional per-param `neutral` values live inside the shared param schema, which this
 * file must not widen (it is shared with processors/planners/recipes). They are pulled
 * out of the raw param objects here, validated, and returned beside the cleaned params.
 */
function extractFxNeutral(
  rawParams: unknown,
  extName: string,
  fxName: string
): { cleaned: unknown; neutral: Record<string, number> | undefined } {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return { cleaned: rawParams, neutral: undefined };
  }
  const neutral: Record<string, number> = {};
  let found = false;
  const cleaned: Record<string, unknown> = {};
  for (const [pName, pVal] of Object.entries(rawParams as Record<string, unknown>)) {
    if (!pVal || typeof pVal !== "object" || Array.isArray(pVal)) {
      cleaned[pName] = pVal;
      continue;
    }
    const pObj = pVal as Record<string, unknown>;
    if (!("neutral" in pObj)) {
      cleaned[pName] = pVal;
      continue;
    }
    const n = (pObj as Record<string, unknown>).neutral;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'fx.${fxName}.params.${pName}.neutral' must be a finite number (the value that renders like no fx).`
        )
      );
    }
    const { neutral: _dropped, ...rest } = pObj as Record<string, unknown>;
    void _dropped;
    cleaned[pName] = rest;
    neutral[pName] = n;
    found = true;
  }
  return { cleaned, neutral: found ? neutral : undefined };
}

/** `temporal` is a boolean flag (default false); anything else is a manifest error. */
function parseFxTemporal(raw: unknown, extName: string, fxName: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.temporal' must be a boolean (true when the effect changes duration or frame count on purpose).`
      )
    );
  }
  return raw;
}

/** `cost_class` is `light` / `medium` / `heavy`; anything else is a manifest error. */
function parseFxCostClass(raw: unknown, extName: string, fxName: string): "light" | "medium" | "heavy" | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "light" && raw !== "medium" && raw !== "heavy") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.cost_class' must be "light", "medium" or "heavy" (given: ${JSON.stringify(raw)}).`
      )
    );
  }
  return raw;
}

/** `alpha` is `"keep"` (default) or `"process"`; anything else is a manifest error. */
function parseFxAlpha(raw: unknown, extName: string, fxName: string): "keep" | "process" | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "keep" && raw !== "process") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.alpha' must be "keep" or "process" (given: ${JSON.stringify(raw)}).`
      )
    );
  }
  return raw;
}

/** `backend` is `"ffmpeg"` (default) or `"shader"`; anything else is a manifest error. */
function parseFxBackend(raw: unknown, extName: string, fxName: string): "ffmpeg" | "shader" {
  if (raw === undefined) return "ffmpeg";
  if (raw !== "ffmpeg" && raw !== "shader") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.backend' must be "ffmpeg" or "shader" (given: ${JSON.stringify(raw)}).`
      )
    );
  }
  return raw;
}

/**
 * Parses a shader-backend fx entry. Params come from the `.glsl` file only:
 * a manifest `params` map beside a shader entry is rejected (the file is the
 * single source of truth), and so is `video_filter`, `animatable` and
 * `neutral` (every numeric uniform is animatable; neutrals do not apply).
 */
function parseShaderFxEntry(
  obj: Record<string, unknown>,
  extName: string,
  fxName: string,
  extDir?: string
): ExtensionFxSpec {
  if (obj.video_filter !== undefined) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' uses backend "shader": drop 'video_filter' (params and code live in the '.glsl' file).`
      )
    );
  }
  if (obj.params !== undefined) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' uses backend "shader": params come from the '.glsl' uniforms only (remove 'params').`
      )
    );
  }
  if (obj.animatable !== undefined) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' uses backend "shader": every numeric uniform is animatable (remove 'animatable').`
      )
    );
  }
  const { file, parsed } = parseShaderFileRef(obj.shader, extName, fxName, extDir);
  const alpha = parseFxAlpha(obj.alpha, extName, fxName);
  const temporal = parseFxTemporal(obj.temporal, extName, fxName);
  const costClass = parseFxCostClass(obj.cost_class, extName, fxName);
  const spec = {
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    backend: "shader" as const,
    shader: file,
    ...(alpha !== undefined ? { alpha } : {}),
    ...(temporal !== undefined ? { temporal } : {}),
    ...(costClass !== undefined ? { cost_class: costClass } : {}),
    // No `video_filter`: shader entries never reach the ffmpeg template path.
    // The field stays required in the type so ffmpeg-only readers keep
    // compiling; every reader branches on `backend` first.
    video_filter: undefined as unknown as string,
  } satisfies ExtensionFxSpec;
  if (parsed) {
    if (Object.keys(parsed.params).length > 0) (spec as { params?: unknown }).params = parsed.params;
    if (parsed.animatable.length > 0) (spec as { animatable?: unknown }).animatable = parsed.animatable;
  }
  return spec;
}

export function parseManifestFxSection(
  raw: unknown,
  extName: string,
  extDir?: string
): Record<string, ExtensionFxSpec> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx' must be an object.`));
  }
  const out: Record<string, ExtensionFxSpec> = {};
  for (const [fxName, rawFx] of Object.entries(raw as Record<string, unknown>)) {
    if (!EFFECT_NAME_RE.test(fxName)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}' is an invalid name (lowercase, [a-z0-9_-]).`)
      );
    }
    if (!rawFx || typeof rawFx !== "object" || Array.isArray(rawFx)) {
      throw new CutholError(DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}' must be an object.`));
    }
    const obj = rawFx as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!ALLOWED_FX_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
            extName,
            `'fx.${fxName}' has an unknown field '${k}' (allowed: ${[...ALLOWED_FX_KEYS].join(", ")}).`
          )
        );
      }
    }
    const backend = parseFxBackend(obj.backend, extName, fxName);
    if (backend === "shader") {
      out[fxName] = parseShaderFxEntry(obj, extName, fxName, extDir);
      continue;
    }
    if (obj.shader !== undefined) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}.shader' needs '"backend": "shader"' (ffmpeg entries use 'video_filter').`)
      );
    }
    if (typeof obj.video_filter !== "string" || !obj.video_filter.trim()) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'fx.${fxName}.video_filter' is required (an ffmpeg filter).`)
      );
    }
    const { cleaned: cleanedParams, neutral } = extractFxNeutral(obj.params, extName, fxName);
    const params = validateParamsMap(cleanedParams, extName, `fx.${fxName}`);
    const videoFilter = (obj.video_filter as string).trim();
    assertFxTemplateSafe(videoFilter, extName, fxName);
    const banned = checkBuiltinFxFilterChain(videoFilter);
    if (banned) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
          extName,
          `'fx.${fxName}.video_filter' uses a forbidden filter or file option (${banned}).`
        )
      );
    }
    assertFxTemplateQuotesClosedManifest(videoFilter, extName, fxName);
    assertFxPlaceholdersDeclared(videoFilter, params, extName, fxName);
    const animatable = parseFxAnimatable(obj.animatable, params, extName, fxName);
    const alpha = parseFxAlpha(obj.alpha, extName, fxName);
    const temporal = parseFxTemporal(obj.temporal, extName, fxName);
    const costClass = parseFxCostClass(obj.cost_class, extName, fxName);
    out[fxName] = {
      ...(typeof obj.description === "string" ? { description: obj.description } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(animatable.length > 0 ? { animatable } : {}),
      ...(alpha !== undefined ? { alpha } : {}),
      ...(temporal !== undefined ? { temporal } : {}),
      ...(costClass !== undefined ? { cost_class: costClass } : {}),
      ...(neutral !== undefined ? { neutral } : {}),
      video_filter: videoFilter,
    };
  }
  return out;
}
