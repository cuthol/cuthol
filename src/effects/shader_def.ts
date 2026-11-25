// Shader effect definitions: GLSL uniform parsing for `fx` entries with `"backend": "shader"`.
//
// A shader effect's params come from the `.glsl` file only. Each animatable
// numeric param is a scalar uniform with its default in a trailing comment:
//
//   // @range(0, 1)
//   uniform float amount; // = 0.5
//
// Supported uniforms: `float` (also `int` and `bool`, exposed as numbers)
// and `vec2`/`vec3`/`vec4` (also `ivec*`, rounded), exposed as per-component
// params `<name>_x`, `<name>_y` (`_z`, `_w`) with the vector default split
// across them, e.g. `uniform vec2 center; // = (0.5, 0.5)`. Reserved host
// uniforms (`time`, `ratio`, `progress`) and the entry points (`effect`,
// `getInput`) are never params.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { assertStayInsideDir } from "../extensions/ext_manifest.js";
import type { ExtensionParamDef } from "../extensions/ext_manifest.js";

export const SHADER_ENTRY_FN_RE = /vec4\s+effect\s*\(\s*vec2\s+[A-Za-z_][A-Za-z0-9_]*\s*\)/;
export const SHADER_GET_INPUT_RE = /getInput\s*\(\s*vec2|getInput\s*\(/;

/** Host-provided uniforms: set by the runner every frame, never params. */
const SHADER_RESERVED_UNIFORMS = new Set(["time", "ratio", "progress"]);

/** `uniform <type> <name>; // = <default>` with an optional `// @range(lo, hi)` line above. */
const SHADER_UNIFORM_RE = /uniform\s+(float|int|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*(?:\/\/\s*=\s*([^\r\n]*))?/;
const SHADER_VEC_COMPS: Record<string, string[]> = {
  vec2: ["x", "y"],
  vec3: ["x", "y", "z"],
  vec4: ["x", "y", "z", "w"],
  ivec2: ["x", "y"],
  ivec3: ["x", "y", "z"],
  ivec4: ["x", "y", "z", "w"],
};

/** Parse a vector default like `(0.5, 0.5)`, `vec2(0.5, 0.5)` or `0.5, 0.5` into components. */
function parseShaderVecDefault(raw: string | undefined, count: number): (number | undefined)[] {
  const text = (raw ?? "").trim();
  if (!text) return Array(count).fill(undefined);
  const inner = /^vec\d\s*\((.*)\)$/.exec(text)?.[1] ?? text.replace(/^\(|\)$/g, "");
  const parts = inner.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length !== count) return Array(count).fill(undefined);
  return parts.map((p) => {
    const n = Number(p);
    return Number.isFinite(n) ? n : undefined;
  });
}
const SHADER_RANGE_RE = /\/\/\s*@range\(\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*\)/;

export interface ParsedShaderUniforms {
  /** Params exposed to `spine fx` (scalar uniforms only). */
  params: Record<string, ExtensionParamDef>;
  /** Every numeric param accepts an envelope (uniforms are set per frame). */
  animatable: string[];
}

export interface ShaderStaticError {
  line: number;
  detail: string;
}

const shaderStaticCache = new Map<string, ShaderStaticError | null>();

/**
 * Cheap static GLSL check (no browser): unbalanced braces/parens and
 * uniform declarations missing their `;`, each reported with a 1-based
 * line. Comments are stripped before scanning so `// {` never counts.
 * Cached by content hash, so enable, verify and `check --kind` share it.
 */
export function checkShaderSourceStatic(source: string): ShaderStaticError | null {
  const key = createHash("sha256").update(source).digest("hex");
  const hit = shaderStaticCache.get(key);
  if (hit !== undefined) return hit;
  const err = scanShaderSource(source);
  shaderStaticCache.set(key, err);
  return err;
}

function scanShaderSource(source: string): ShaderStaticError | null {
  const lines = source.split(/\r?\n/);
  const stripped = lines.map((ln) => ln.replace(/\/\/.*$/, ""));
  const stack: Array<{ ch: string; line: number }> = [];
  for (let i = 0; i < stripped.length; i++) {
    const ln = stripped[i];
    // A `uniform` declaration spanning this line must end in `;`
    // (unless it continues on the next line, which we do not support).
    if (/^\s*uniform\s+\w+\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(ln)) {
      const err = { line: i + 1, detail: `uniform declaration is missing its terminating ';' (${ln.trim()}).` };
      return err;
    }
    for (const ch of ln) {
      if (ch === "{" || ch === "(") stack.push({ ch, line: i + 1 });
      else if (ch === "}" || ch === ")") {
        const open = stack.pop();
        const want = ch === "}" ? "{" : "(";
        if (!open || open.ch !== want) {
          return { line: i + 1, detail: `unmatched '${ch}' (no opening '${want}').` };
        }
      }
    }
  }
  if (stack.length > 0) {
    const first = stack[stack.length - 1];
    return { line: first.line, detail: `unclosed '${first.ch}' (opened on line ${first.line}).` };
  }
  return null;
}

function parseShaderDefault(raw: string | undefined, type: string, extName: string, fxName: string, uniform: string): number | boolean | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  if (type === "bool") {
    if (/^true$/i.test(text)) return true;
    if (/^false$/i.test(text)) return false;
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' uniform '${uniform}' default ('${text}') must be true/false.`
      )
    );
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' uniform '${uniform}' default ('${text}') must be a finite number.`
      )
    );
  }
  if (type === "int" && !Number.isInteger(n)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' uniform '${uniform}' is an int uniform but defaults to ${text}.`
      )
    );
  }
  return n;
}

/**
 * Parses the uniform list of a shader source. Vector uniforms expand to
 * per-component params; missing defaults are left without one, reserved
 * names are skipped.
 */
export function parseShaderUniforms(
  source: string,
  extName: string,
  fxName: string
): ParsedShaderUniforms {
  if (!SHADER_ENTRY_FN_RE.test(source)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}' shader must declare 'vec4 effect(vec2 uv)'.`
      )
    );
  }
  const params: Record<string, ExtensionParamDef> = {};
  const animatable: string[] = [];
  const lines = source.split(/\r?\n/);
  let pendingRange: { min: number; max: number } | null = null;
  for (const line of lines) {
    const rangeMatch = SHADER_RANGE_RE.exec(line);
    if (rangeMatch) {
      pendingRange = { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
      continue;
    }
    const m = SHADER_UNIFORM_RE.exec(line);
    if (!m) {
      if (line.trim() && !line.trimStart().startsWith("//")) pendingRange = null;
      continue;
    }
    const [, type, name] = m;
    const range = pendingRange;
    pendingRange = null;
    if (SHADER_RESERVED_UNIFORMS.has(name)) continue;
    const vecComps = SHADER_VEC_COMPS[type];
    if (vecComps) {
      // Vector uniforms become per-component scalar params; the host sets
      // the vector uniform from them every frame.
      const defaults = parseShaderVecDefault(m[3], vecComps.length);
      for (let i = 0; i < vecComps.length; i++) {
        const pname = `${name}_${vecComps[i]}`;
        const def: ExtensionParamDef = { type: "number" };
        const d = defaults[i];
        if (d !== undefined) def.default = type.startsWith("ivec") ? Math.round(d) : d;
        if (range) {
          def.min = range.min;
          def.max = range.max;
        }
        params[pname] = def;
        animatable.push(pname);
      }
      continue;
    }
    const def: ExtensionParamDef = { type: type === "bool" ? "boolean" : "number" };
    const fallback = parseShaderDefault(m[3], type, extName, fxName, name);
    if (fallback !== undefined) def.default = fallback;
    if (range && def.type === "number") {
      def.min = range.min;
      def.max = range.max;
    }
    params[name] = def;
    animatable.push(name);
  }
  return { params, animatable };
}

/**
 * Validates the `shader` file reference of a shader-backend fx entry and, when
 * the extension directory is known, parses its uniforms. Pure path checks run
 * without a directory (manifest-only validation); the file read runs at
 * extension load/enable, never on every manifest parse.
 */
export interface ShaderCompileCacheEntry {
  /** Shader file name as written in the manifest (for diagnostics). */
  file: string;
  /** True when the browser compiled the source without errors. */
  ok: boolean;
  /** 1-based GLSL line when `ok` is false. */
  line?: number;
  /** Compiler message (trimmed) when `ok` is false. */
  detail?: string;
  /** ISO timestamp of the compile. */
  compiledAt: string;
}

export interface ShaderCompileResult extends ShaderCompileCacheEntry {
  /** Content hash this result was stored under. */
  hash: string;
  /** True when the result came from the cache (no browser ran for it). */
  cached: boolean;
  /** Extension that asked for this compile (the caller's own, even on a cache hit). */
  ext?: string;
}

const SHADER_COMPILE_CACHE_NAME = "shader-compile-cache.json";

/** Content hash of a shader source: the compile cache is keyed by this. */
export function shaderSourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function shaderCompileCachePath(rootDir: string): string | null {
  try {
    const dir = path.join(rootDir, ".cuthol");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, SHADER_COMPILE_CACHE_NAME);
  } catch {
    return null;
  }
}

/** Reads the browser compile cache (`{contentHash: entry}`); corrupt or missing reads as empty. */
export function readShaderCompileCache(rootDir: string): Record<string, ShaderCompileCacheEntry> {
  const p = shaderCompileCachePath(rootDir);
  if (!p || !fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, ShaderCompileCacheEntry>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

/** Cached browser compile result for a shader source, or null when it was never compiled. */
export function lookupShaderCompileResult(
  rootDir: string | undefined,
  source: string
): ShaderCompileCacheEntry | null {
  if (!rootDir) return null;
  return readShaderCompileCache(rootDir)[shaderSourceHash(source)] ?? null;
}

/**
 * Compiles shader sources in one short-lived browser (shared by the whole
 * call): each source is programmed into the shader page at 64x64 and the
 * page's own compiler error (with its `line=` suffix) becomes the result.
 * The browser always closes in `finally`.
 */
export async function compileShaderSourcesInBrowser(
  sources: Array<{ file: string; source: string; ext?: string }>
): Promise<ShaderCompileResult[]> {
  const { SHADER_PAGE_HTML } = await import("../render/shader_page.js");
  const { launchScriptProbeBrowser } = await import("../compositor/coords_extract.js");
  const browser = (await launchScriptProbeBrowser()) as unknown as {
    close(): Promise<void>;
    newPage(): Promise<{
      setContent(html: string): Promise<void>;
      evaluate(fn: (...a: never[]) => unknown, ...a: unknown[]): Promise<unknown>;
      close(): Promise<void>;
    }>;
  };
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(SHADER_PAGE_HTML);
      const out: ShaderCompileResult[] = [];
      for (const s of sources) {
        const hash = shaderSourceHash(s.source);
        try {
          await page.evaluate(
            ((src: string, progHash: string) =>
              (window as unknown as { __programShader: (s: string, w: number, h: number, b: boolean, h2?: string) => unknown }).__programShader(src, 64, 64, false, progHash)
            ) as (...a: never[]) => unknown,
            s.source as never,
            hash as never
          );
          out.push({ file: s.file, hash, ok: true, compiledAt: new Date().toISOString(), cached: false, ...(s.ext !== undefined ? { ext: s.ext } : {}) });
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const line = Number(/line=(\d+)/.exec(raw)?.[1] ?? 0) || 0;
          out.push({
            file: s.file, hash, ok: false,
            line, detail: raw.replace(/\s*line=\d+\s*$/, "").slice(0, 300),
            compiledAt: new Date().toISOString(), cached: false,
            ...(s.ext !== undefined ? { ext: s.ext } : {}),
          });
        }
      }
      return out;
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Compiles every not-yet-cached shader source in one browser and stores each
 * result under its content hash. Returns per-file results (cached entries are
 * marked `cached`); never throws for a compile failure — the caller decides
 * (the `extension enable` hook throws naming file and line).
 */
export async function ensureShaderCompileCache(opts: {
  rootDir: string;
  shaders: Array<{ file: string; source: string; ext?: string }>;
  /** Report fresh results without writing them (the `extension enable --dry-run` path). */
  dryRun?: boolean;
}): Promise<ShaderCompileResult[]> {
  const cachePath = shaderCompileCachePath(opts.rootDir);
  const cache = opts.rootDir ? readShaderCompileCache(opts.rootDir) : {};
  const results: ShaderCompileResult[] = [];
  const missing = new Map<string, { file: string; source: string; ext?: string }>();
  for (const s of opts.shaders) {
    const hash = shaderSourceHash(s.source);
    const hit = cache[hash];
    if (hit) {
      // The cache is keyed by content hash, so the stored file name belongs
      // to whichever extension compiled first: report the caller's own file
      // (and extension) on every result, cached or fresh.
      results.push({
        ...hit,
        file: s.file,
        hash,
        cached: true,
        ...(s.ext !== undefined ? { ext: s.ext } : {}),
      });
    } else if (!missing.has(hash)) {
      missing.set(hash, s);
    }
  }
  if (missing.size > 0) {
    const fresh = await compileShaderSourcesInBrowser([...missing.values()]);
    if (!opts.dryRun) {
      for (const r of fresh) {
        const { cached: _dropped, hash: _h, ext: _e, ...entry } = r;
        cache[r.hash] = entry;
      }
      if (cachePath) {
        try {
          const tmp = `${cachePath}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
          fs.renameSync(tmp, cachePath);
        } catch {
          // cache failures never block
        }
      }
    }
    for (const r of fresh) results.push(r);
  }
  return results;
}

/**
 * `.glsl` files a shader-backend `fx` entry names, in manifest order. Pure
 * manifest read plus existence check: no browser, never throws (a missing or
 * unreadable manifest means no shader fx).
 */
export function listShaderFxFiles(extDir: string): string[] {
  let fx: Record<string, { backend?: string; shader?: string }> = {};
  try {
    fx = (JSON.parse(fs.readFileSync(path.join(extDir, "cuthol-extension.json"), "utf8")) as { fx?: typeof fx }).fx ?? {};
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of Object.values(fx)) {
    if (entry?.backend === "shader" && typeof entry.shader === "string") {
      const abs = path.resolve(extDir, entry.shader);
      if (abs.startsWith(path.resolve(extDir)) && fs.existsSync(abs)) out.push(entry.shader);
    }
  }
  return out;
}

/**
 * The `extension enable` hook (call from `enableExtensionInWorkspace`, after
 * `resolveExtension`): compiles every `.glsl` of the extension in one
 * short-lived browser, stores each result by content hash, and throws naming
 * file and line on the first failure — so a bad shader blocks the enable
 * instead of failing mid-render. (Lives here because `ext_fx.ts` already
 * depends on this module; importing it back would cycle.)
 */
export async function compileShaderExtensionAtEnable(opts: {
  workspaceDir: string;
  extName: string;
  extDir: string;
  /** Compile without writing the cache (the `extension enable --dry-run` path). */
  dryRun?: boolean;
}): Promise<ShaderCompileResult[]> {
  const shaders: Array<{ file: string; source: string; ext: string }> = [];
  for (const file of listShaderFxFiles(opts.extDir)) {
    const abs = path.resolve(opts.extDir, file);
    shaders.push({ file, source: fs.readFileSync(abs, "utf8"), ext: opts.extName });
  }
  const results = await ensureShaderCompileCache({ rootDir: opts.workspaceDir, shaders, dryRun: opts.dryRun });
  const bad = results.find((r) => !r.ok);
  if (bad) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        opts.extName,
        `'fx' shader ('${bad.file}') failed to compile (line ${bad.line ?? 0}): ${bad.detail ?? "unknown error"}`
      )
    );
  }
  return results;
}

export function parseShaderFileRef(
  raw: unknown,
  extName: string,
  fxName: string,
  extDir?: string
): { file: string; parsed?: ParsedShaderUniforms } {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.shader' is required for backend "shader" (a '.glsl' file inside the extension folder).`
      )
    );
  }
  const rel = raw.trim();
  if (!rel.endsWith(".glsl")) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.shader' ('${rel}') must be a '.glsl' file inside the extension folder.`
      )
    );
  }
  if (rel.includes("..")) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.shader' ('${rel}') must stay inside the extension folder (no '..').`
      )
    );
  }
  if (path.isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.shader' ('${rel}') must be a relative path inside the extension folder.`
      )
    );
  }
  if (!extDir) return { file: rel };
  const abs = assertStayInsideDir(path.resolve(extDir), rel, extName);
  if (!fs.existsSync(abs)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.shader' file ('${rel}') not found in the extension folder.`
      )
    );
  }
  const source = fs.readFileSync(abs, "utf8");
  const staticErr = checkShaderSourceStatic(source);
  if (staticErr) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(
        extName,
        `'fx.${fxName}.shader' ('${rel}') failed to compile (line ${staticErr.line}): ${staticErr.detail}`
      )
    );
  }
  return { file: rel, parsed: parseShaderUniforms(source, extName, fxName) };
}
