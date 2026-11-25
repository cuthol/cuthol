// Instance check for one item's fx stage (compiled stage probe + frozen triple-render).
// Runs the compiled filter text on a generated lavfi card (testsrc2, 480p, 2 frames)
// with a sentinel filter after it, so template errors are readable. Cache lives in
// `.cuthol/fx_check_cache.json` (outside the sequence and journal).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { substituteFxTemplateValues } from "../compositor/compile_fx_stage.js";
import { checkShaderSourceStatic, lookupShaderCompileResult } from "./shader_def.js";
import type { EffectParamValue } from "../core/schema.js";

export interface FxCheckFinding {
  severity: "ERROR" | "WARN";
  code: string;
  message: string;
  /** Raw ffmpeg detail without the `fx instance check failed on …` header (for wrapping diagnostics). */
  detail?: string;
  filter?: string;
  template?: string;
}

export interface FxCheckOptions {
  projectDir?: string;
  timeoutMs?: number;
  alpha?: boolean;
  cacheKey?: string;
}

const CACHE_NAME = "fx_check_cache.json";
const TIMEOUT_MS = 10_000;

function cachePath(projectDir?: string): string | null {
  if (!projectDir) return null;
  try {
    const dir = join(projectDir, ".cuthol");
    mkdirSync(dir, { recursive: true });
    return join(dir, CACHE_NAME);
  } catch {
    return null;
  }
}

function readCache(path: string | null): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeCache(path: string | null, data: Record<string, string>): void {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {
    // cache failures never block
  }
}

let versionCache: string | null | undefined;
/**
 * A filter graph passed from a file (`-/vf <file>`), never on the command
 * line: long envelope expressions would otherwise exceed the Windows command
 * line limit (ENAMETOOLONG). The caller runs the returned args, then cleanup.
 */
function vfFileArgs(graph: string): { args: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cuthol-fxgraph-"));
  const file = join(dir, "filter.txt");
  writeFileSync(file, graph, "utf8");
  return {
    args: ["-/vf", file],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/** ffmpeg version string for cache invalidation; null when ffmpeg is missing (memoised per process). */
export function ffmpegVersion(): string | null {
  if (versionCache !== undefined) return versionCache;
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (r.error || r.status !== 0) {
    versionCache = null;
    return null;
  }
  const first = String(r.stdout ?? "").split("\n")[0] ?? "";
  versionCache = first.slice(0, 120);
  return versionCache;
}

/**
 * Rule hints for G322. Maps ffmpeg stderr + template text to a
 * rule sentence; the suggestion text lives here (error mapping only).
 * The nested-quote hint needs both sides: a single-quoted template region
 * holding a placeholder, and chain/stderr evidence of a quote landing
 * right before or after the substituted expression.
 */
export function fxTemplateRuleHint(stderr: string, template?: string, chain?: string): string | undefined {
  const tpl = template ?? "";
  if (/No option name near/.test(stderr) && /=[^,]*,/.test(tpl)) {
    return "options of one filter are separated by ':'; ',' starts a new filter (replace the ',' between options with ':').";
  }
  const quotedPlaceholder = /'[^']*\{\{[^}]+\}\}[^']*'/.test(tpl);
  if (!quotedPlaceholder) return undefined;
  const text = `${chain ?? ""}\n${stderr}`;
  const quoteAdjacent = /''/.test(text) || /'if\(/.test(text) || /\('"/.test(text) || /"\)'/.test(text);
  const namesQuotedOption = /Option '[^']+'/.test(stderr);
  if (quoteAdjacent || namesQuotedOption) {
    return "the envelope expression carries its own quotes inside an already-quoted template region (nested quotes); put the placeholder inside the quotes on its own, without adding quotes around it.";
  }
  return undefined;
}

/** First filter of the fx entry's own template (or raw `--filter` text); the built stage chain starts with an entry converter, so it must never be read for the name. */
export function fxEntryFilterName(template: string | undefined, chain: string): string {
  const m = /^([a-zA-Z0-9_]+)=/.exec((template ?? chain).trim());
  return m ? m[1] : "?";
}

/** Map `Parsed_<filter>_<n>` back to a filter name for the diagnostic. */
export function mapParsedFilter(stderr: string): string | undefined {
  const m = /Parsed_([A-Za-z0-9_]+)_(\d+)/.exec(stderr);
  if (m) return m[1];
  const f = /to filter '([A-Za-z0-9_]+)'/.exec(stderr);
  return f ? f[1] : undefined;
}

/**
 * A per-frame probe expression over `t` that equals INIT at t=0. Commas are
 * plain here; `substituteProbeValues` escapes them for `-vf` on insertion.
 */
export function probeEnvelopeExpr(init: number, fin: number): string {
  return `(${init}+(${fin}-(${init}))*pow(sin(2*PI*t),2))`;
}

function runFilterGraph(chain: string, opts: FxCheckOptions): { ok: boolean; stderr: string; timedOut: boolean; missing: boolean } {
  const w = 854;
  const h = 480;
  const pixFmt = opts.alpha ? "rgba" : "yuv420p";
  const src = opts.alpha
    ? `testsrc2=size=${w}x${h}:rate=30,format=${pixFmt}`
    : `testsrc2=size=${w}x${h}:rate=30,format=${pixFmt}`;
  // Sentinel filter after the chain makes template errors readable.
  const vf = `${src},${chain},format=${pixFmt}`;
  const graph = vfFileArgs(chain + ",format=" + pixFmt);
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", src, ...graph.args, "-frames:v", "2", "-f", "null", "-"],
      { encoding: "utf8", timeout: opts.timeoutMs ?? TIMEOUT_MS, windowsHide: true }
    );
  } finally {
    graph.cleanup();
  }
  void vf;
  if (r.error) {
    const msg = String((r.error as Error)?.message ?? r.error);
    if (/ENOENT/i.test(msg)) return { ok: true, stderr: "", timedOut: false, missing: true };
    if (/timed out|ETIMEDOUT/i.test(msg)) return { ok: false, stderr: msg, timedOut: true, missing: false };
    return { ok: false, stderr: msg, timedOut: false, missing: false };
  }
  const stderr = String(r.stderr ?? "");
  if (r.status !== 0) return { ok: false, stderr, timedOut: false, missing: false };
  return { ok: true, stderr, timedOut: false, missing: false };
}

/**
 * Run one compiled fx chain on a generated card. Returns findings:
 * non-zero exit (incl. crash) -> ERROR; timeout or missing ffmpeg -> WARN.
 */
export function checkFxChain(chain: string, opts: FxCheckOptions & { itemId?: string; fxId?: string; kind?: string; template?: string } = {}): FxCheckFinding[] {
  const version = ffmpegVersion();
  if (version === null) {
    return [{ severity: "WARN", code: "CUTHOL-G320", message: "ffmpeg is not on PATH; the fx instance check was skipped." }];
  }
  const keyBase = opts.cacheKey ?? chain;
  const key = createHash("sha256").update(`${keyBase}\u0000${version}`).digest("hex");
  const cPath = cachePath(opts.projectDir);
  const cache = readCache(cPath);
  if (cache[key] === "ok") return [];
  const r = runFilterGraph(chain, opts);
  if (r.missing) {
    return [{ severity: "WARN", code: "CUTHOL-G320", message: "ffmpeg is not on PATH; the fx instance check was skipped." }];
  }
  if (r.timedOut) {
    return [{ severity: "WARN", code: "CUTHOL-G321", message: `fx instance check timed out after ${opts.timeoutMs ?? TIMEOUT_MS}ms for '${opts.itemId ?? "?"}' fx '${opts.fxId ?? "?"}' (${opts.kind ?? "?"}); skipped, never blocking.` }];
  }
  if (!r.ok) {
    // Font-dependent filters (drawtext) cannot be judged on a card: machines
    // without usable fonts fail them at init/parse no matter the template.
    if (/drawtext/i.test(chain)) {
      return [{ severity: "WARN", code: "CUTHOL-G323", detail: "drawtext needs usable fonts", message: `fx instance check skipped a drawtext chain on '${opts.itemId ?? "?"}' fx '${opts.fxId ?? "?"}' (drawtext needs usable fonts; skipped, never blocking).` }];
    }
    const filter = mapParsedFilter(r.stderr);
    const where = `'${opts.itemId ?? "?"}' fx '${opts.fxId ?? "?"}' (${opts.kind ?? "?"})${filter ? ` in filter '${filter}'` : ""}`;
    const detail = r.stderr.split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 600);
    const hint = fxTemplateRuleHint(r.stderr, opts.template, chain);
    return [{
      severity: "ERROR",
      code: "CUTHOL-G322",
      message: `fx instance check failed on ${where}: ${detail}${hint ? ` Rule hint: ${hint}` : ""}`,
      detail: hint ? `${detail} Rule hint: ${hint}` : detail,
      filter,
      template: opts.template,
    }];
  }
  cache[key] = "ok";
  writeCache(cPath, cache);
  return [];
}

/**
 * Definition-check substitution through the shared quote-aware function.
 * Static probe values go in `values`; the probe envelope goes in
 * `animated` as a bare expression, exactly as render passes one.
 */
function substituteProbeValues(template: string, values: Record<string, unknown>, animated?: Map<string, string>): string {
  const staticValues: Record<string, EffectParamValue> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") staticValues[k] = v;
  }
  const fail = (detail: string) => new Error(`fx definition probe: ${detail}`) as never;
  return substituteFxTemplateValues(template, staticValues, animated ?? new Map(), fail as never);
}

/**
 * Definition-probe substitution that never throws raw: a substitution failure
 * (e.g. a string default holding `'` inside a quoted template region, as with
 * `drawtext=text='{{label}}'`) becomes a G322-style ERROR naming the param,
 * like `spine fx add` reports G118 — never a bare `"error": "fx definition probe: …"`.
 */
function safeProbeSubstitution(
  template: string,
  values: Record<string, unknown>,
  kind: string,
  animated?: Map<string, string>
): { chain: string } | { finding: FxCheckFinding } {
  try {
    return { chain: substituteProbeValues(template, values, animated) };
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^fx definition probe: /, "") : String(err);
    return {
      finding: {
        severity: "ERROR",
        code: "CUTHOL-G322",
        message: `fx instance check failed on 'definition' fx '${kind}': ${detail}`,
        detail,
        template,
      },
    };
  }
}

function probeAnimated(param: string, expr: string): Map<string, string> {
  return new Map([[param, expr]]);
}

/**
 * Definition check (`spine fx check --kind`): every param at
 * min / default / max, every animatable param with a min→max envelope probe,
 * both alpha variants for `process` entries. Returns findings (ERROR blocks).
 */
export function checkEffectDefinition(
  def: { kind: string; params: Record<string, { type?: string; default?: unknown; min?: number; max?: number }>; animatable: string[]; alpha?: string; ffmpeg?: { video_filter: string }; backend?: string; shaderFile?: { file: string; source: string } },
  opts: FxCheckOptions & { itemId?: string; fxId?: string; cacheKeyPrefix?: string } = {}
): FxCheckFinding[] {
  const template = def.ffmpeg?.video_filter;
  if (!template) {
    if (def.backend === "shader") {
      // Shader quick check: the browser compile cache (written by
      // `extension enable`) names file and line; a hash with no cached
      // result gets the static scan plus a WARN. No browser opens here.
      const src = def.shaderFile?.source;
      if (src !== undefined) {
        const where = def.shaderFile?.file ?? "<shader>";
        const cached = lookupShaderCompileResult(opts.projectDir, src);
        if (cached) {
          if (!cached.ok) {
            return [{
              severity: "ERROR",
              code: "CUTHOL-G710",
              message: `Shader '${where}' failed to compile (line ${cached.line ?? 0}): ${cached.detail ?? "unknown error"}`,
              detail: `line ${cached.line ?? 0}: ${cached.detail ?? "unknown error"}`,
            }];
          }
          return [];
        }
        const err = checkShaderSourceStatic(src);
        if (err) {
          return [{
            severity: "ERROR",
            code: "CUTHOL-G710",
            message: `Shader '${where}' failed to compile (line ${err.line}): ${err.detail}`,
            detail: `line ${err.line}: ${err.detail}`,
          }];
        }
        return [{
          severity: "WARN",
          code: "CUTHOL-G711",
          message: `Shader '${where}' was not compiled in a browser yet (no cached result for its content hash): only the static scan ran. Run 'extension enable' for its extension, then re-run this check.`,
        }];
      }
      return [{ severity: "WARN", code: "CUTHOL-G705", message: `fx definition check passed with a warning on 'definition' fx '${def.kind}': shader effects are not checked by spine fx check yet.` }];
    }
    return [];
  }
  const templateKey = createHash("sha256").update(`${template}\u0000${JSON.stringify(def.params ?? {})}`).digest("hex").slice(0, 16);
  const out: FxCheckFinding[] = [];
  const defaults: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(def.params)) defaults[k] = p.default;
  // The default chain always runs once (effects without params included).
  for (const alpha of def.alpha === "process" ? [false, true] : [false]) {
    const sub = safeProbeSubstitution(template, defaults, def.kind);
    if ("finding" in sub) {
      out.push(sub.finding);
      return out;
    }
    out.push(...checkFxChain(sub.chain, {
      ...opts, alpha, cacheKey: `def:${def.kind}:${templateKey}:defaults:alpha=${alpha ? "rgba" : "yuv"}`,
      itemId: opts.itemId ?? "definition", fxId: opts.fxId ?? def.kind,
      kind: def.kind, template,
    }));
  }
  for (const [k, p] of Object.entries(def.params)) {
    const vals: unknown[] = [];
    if (p.type === "number") {
      if (typeof p.min === "number") vals.push(p.min);
      if (p.default !== undefined) vals.push(p.default);
      if (typeof p.max === "number") vals.push(p.max);
    } else if (p.default !== undefined) {
      vals.push(p.default);
    }
    const candidates = vals.length > 0 ? vals : [p.default];
    for (const v of candidates) {
      const sub = safeProbeSubstitution(template, { ...defaults, [k]: v }, def.kind);
      if ("finding" in sub) {
        out.push(sub.finding);
        continue;
      }
      for (const alpha of def.alpha === "process" ? [false, true] : [false]) {
        out.push(...checkFxChain(sub.chain, {
          ...opts, alpha, cacheKey: `def:${def.kind}:${templateKey}:${k}=${String(v)}:alpha=${alpha ? "rgba" : "yuv"}`,
          itemId: opts.itemId ?? "definition", fxId: opts.fxId ?? def.kind,
          kind: def.kind, template,
        }));
      }
    }
  }
  for (const param of def.animatable) {
    const p = def.params[param];
    if (p?.type !== "number" || typeof p.min !== "number" || typeof p.max !== "number") continue;
    if (p.min === p.max) continue;
    const filterName = fxEntryFilterName(template, "");
    const envSub = safeProbeSubstitution(template, defaults, def.kind, probeAnimated(param, probeEnvelopeExpr(p.min, p.max)));
    if ("finding" in envSub) {
      out.push(envSub.finding);
      continue;
    }
    const envelopeChain = envSub.chain;
    // An envelope expression the filter rejects outright (gblur) is an instance ERROR;
    // the frozen triple only runs when the envelope chain renders.
    const envErrs = checkFxChain(envelopeChain, {
      ...opts, cacheKey: `def:${def.kind}:${templateKey}:${param}=envelope`,
      itemId: opts.itemId ?? "definition", fxId: opts.fxId ?? def.kind,
      kind: def.kind, template,
    }).filter((f) => f.severity === "ERROR");
    out.push(...envErrs);
    if (envErrs.length > 0) continue;
    const initSub = safeProbeSubstitution(template, { ...defaults, [param]: p.min }, def.kind);
    const finSub = safeProbeSubstitution(template, { ...defaults, [param]: p.max }, def.kind);
    if ("finding" in initSub) {
      out.push(initSub.finding);
      continue;
    }
    if ("finding" in finSub) {
      out.push(finSub.finding);
      continue;
    }
    out.push(...checkFrozenParam({
      filterName,
      chainWithInitial: initSub.chain,
      chainWithFinal: finSub.chain,
      chainWithEnvelope: envelopeChain,
      frameIndex: 65,
      envelopeChangesValue: true,
      projectDir: opts.projectDir,
    }));
  }
  return out;
}

/** Render one frame of a chain to framemd5 bytes for the frozen-param comparison. */
export function renderFrameHash(chain: string, frameIndex: number): Buffer | null {
  const w = 854;
  const h = 480;
  const src = `testsrc2=size=${w}x${h}:rate=30,format=yuv420p`;
  const graph = vfFileArgs(`${chain},select='eq(n\\,${frameIndex})',format=yuv420p`);
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", src, ...graph.args, "-frames:v", "1", "-f", "framemd5", "-"],
      { encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true }
    );
  } finally {
    graph.cleanup();
  }
  if (r.error || r.status !== 0) return null;
  return Buffer.from(String(r.stdout ?? ""));
}

/**
 * Frozen animatable parameter check: three isolated runs at the same
 * frame index after the envelope's last point. Envelope frame == constant-initial (byte)
 * and != constant-final -> ERROR (filter evaluates the option once; for `eq` add `eval=frame`).
 */
export function checkFrozenParam(args: {
  filterName: string;
  chainWithInitial: string;
  chainWithFinal: string;
  chainWithEnvelope: string;
  frameIndex: number;
  envelopeChangesValue: boolean;
  projectDir?: string;
}): FxCheckFinding[] {
  if (!args.envelopeChangesValue) return [];
  const version = ffmpegVersion();
  const frozenVerdict = (frozen: boolean): FxCheckFinding[] => frozen ? [{
    severity: "ERROR",
    code: "CUTHOL-G324",
    message: `parameter does not change per frame in filter '${args.filterName}' (evaluated once); check whether its options accept per-frame expressions (for 'eq' add 'eval=frame').`,
    filter: args.filterName,
  }] : [];
  if (version !== null) {
    const keyBase = `frozen:${args.chainWithInitial}\u0000${args.chainWithFinal}\u0000${args.chainWithEnvelope}\u0000${args.frameIndex}`;
    const key = createHash("sha256").update(`${keyBase}\u0000${version}`).digest("hex");
    const cPath = cachePath(args.projectDir);
    const cache = readCache(cPath);
    if (cache[key] === "frozen") return frozenVerdict(true);
    if (cache[key] === "ok") return [];
    const verdict = checkFrozenParamUncached(args);
    cache[key] = verdict.some((f) => f.severity === "ERROR") ? "frozen" : "ok";
    writeCache(cPath, cache);
    return verdict;
  }
  return checkFrozenParamUncached(args);
}

function checkFrozenParamUncached(args: {
  filterName: string;
  chainWithInitial: string;
  chainWithFinal: string;
  chainWithEnvelope: string;
  frameIndex: number;
  envelopeChangesValue: boolean;
}): FxCheckFinding[] {
  const a = renderFrameHash(args.chainWithInitial, args.frameIndex);
  const b = renderFrameHash(args.chainWithFinal, args.frameIndex);
  const e = renderFrameHash(args.chainWithEnvelope, args.frameIndex);
  if (!a || !b || !e) {
    return [{ severity: "WARN", code: "CUTHOL-G323", detail: `frame render unavailable`, message: `frozen-param probe for filter '${args.filterName}' could not render frame ${args.frameIndex}; skipped.` }];
  }
  if (a.equals(e) && !a.equals(b)) {
    return [{
      severity: "ERROR",
      code: "CUTHOL-G324",
      message: `parameter does not change per frame in filter '${args.filterName}' (evaluated once); check whether its options accept per-frame expressions (for 'eq' add 'eval=frame').`,
      filter: args.filterName,
    }];
  }
  return [];
}
