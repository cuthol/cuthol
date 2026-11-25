// Manifest `presets` section: keyframe templates anchored to the clip.
// A preset names one motion entry (`kind: "motion"` or an extension motion
// kind declaring `spine.channels`) and key points per channel whose `at` is
// relative: "start", "start+<ms>", "end", "end-<ms>", "<n>%" or absolute ms.
// `value` is a number or a small expression over the preset params
// (numbers, param names, `rand(i)`, parentheses and + - * / only; no eval).
// Optional `repeat` restarts the key pattern on every beat of the grid given
// at apply time, or every N ms, inside the clip.
import { createHash } from "node:crypto";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { EasingKind } from "../core/schema.js";
import { MOTION_FX_KIND, PLACEMENT_CHANNELS, type PresetPointRecord } from "../effects/effect_types.js";
import { EFFECT_NAME_RE } from "./ext_fx.js";
import { validateParamsMap, type ExtensionParamDef } from "./ext_manifest.js";

export type PresetAt = string;

export interface ExtensionPresetPointSpec {
  at: PresetAt;
  value: number | string;
  easing?: EasingKind;
  bezier?: [number, number, number, number];
}

export interface ExtensionPresetEntrySpec {
  kind: string;
  keys: Record<string, ExtensionPresetPointSpec[]>;
}

export interface ExtensionPresetRepeatSpec {
  every: string;
  pattern_ms: number;
}

export interface ExtensionPresetSpec {
  description?: string;
  params?: Record<string, ExtensionParamDef>;
  entries: ExtensionPresetEntrySpec[];
  repeat?: ExtensionPresetRepeatSpec;
}

const ALLOWED_PRESET_KEYS = new Set(["description", "params", "entries", "repeat"]);
const ALLOWED_PRESET_ENTRY_KEYS = new Set(["kind", "keys"]);
const ALLOWED_PRESET_POINT_KEYS = new Set(["at", "value", "easing", "bezier"]);
const ALLOWED_EASING: ReadonlySet<string> = new Set([
  "linear",
  "ease_in",
  "ease_out",
  "ease_in_out",
  "cubic_bezier",
  "hold",
]);

const ANCHOR_START_RE = /^start(?:\+(\d+(?:\.\d+)?)ms)?$/;
const ANCHOR_END_RE = /^end(?:-(\d+(?:\.\d+)?)ms)?$/;
const ANCHOR_RATIO_RE = /^(\d+(?:\.\d+)?)%$/;
const ANCHOR_ABS_RE = /^(\d+(?:\.\d+)?)ms$/;

export type ParsedAnchor =
  | { kind: "start"; offsetMs: number }
  | { kind: "end"; offsetMs: number }
  | { kind: "ratio"; ratio: number }
  | { kind: "absolute"; offsetMs: number };

export function parseAnchor(raw: unknown, preset: string, where: string): ParsedAnchor {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.at' must be "start", "start+<ms>", "end", "end-<ms>", "<n>%" or ms.`)
    );
  }
  const at = raw.trim();
  let m = ANCHOR_START_RE.exec(at);
  if (m) return { kind: "start", offsetMs: m[1] === undefined ? 0 : Number(m[1]) };
  m = ANCHOR_END_RE.exec(at);
  if (m) return { kind: "end", offsetMs: m[1] === undefined ? 0 : Number(m[1]) };
  m = ANCHOR_RATIO_RE.exec(at);
  if (m) {
    const ratio = Number(m[1]);
    if (ratio < 0 || ratio > 100) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.at' ratio ${ratio} is outside 0..100.`)
      );
    }
    return { kind: "ratio", ratio };
  }
  m = ANCHOR_ABS_RE.exec(at);
  if (m) return { kind: "absolute", offsetMs: Number(m[1]) };
  if (/^\d+(?:\.\d+)?$/.test(at)) return { kind: "absolute", offsetMs: Number(at) };
  throw new CutholError(
    DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.at' value '${at}' is not an anchor ("start", "start+<ms>", "end", "end-<ms>", "<n>%" or ms).`)
  );
}

// --- value expression language (tokenizer + recursive-descent parser, no eval) ---

type ExprNode =
  | { t: "num"; v: number }
  | { t: "param"; name: string }
  | { t: "index" }
  | { t: "rand"; arg: ExprNode }
  | { t: "neg"; x: ExprNode }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; l: ExprNode; r: ExprNode };

type Token =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(.))/y;

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < expr.length) {
    const m = TOKEN_RE.exec(expr);
    if (!m) break;
    if (m[1] !== undefined) {
      out.push({ t: "num", v: Number(m[1]) });
    } else if (m[2] !== undefined) {
      out.push({ t: "name", v: m[2] });
    } else {
      const ch = m[3];
      if (ch === "(") out.push({ t: "(" });
      else if (ch === ")") out.push({ t: ")" });
      else if (ch === ",") out.push({ t: "," });
      else if (ch === "+" || ch === "-" || ch === "*" || ch === "/") out.push({ t: "op", v: ch });
      else throw new Error(`unexpected '${ch}'`);
    }
  }
  return out;
}

class ExprParser {
  private pos = 0;
  constructor(private tokens: Token[]) {}
  parse(): ExprNode {
    const n = this.parseAdd();
    if (this.pos !== this.tokens.length) throw new Error("trailing input");
    return n;
  }
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private parseAdd(): ExprNode {
    let n = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        this.pos++;
        n = { t: "bin", op: t.v, l: n, r: this.parseMul() };
      } else return n;
    }
  }
  private parseMul(): ExprNode {
    let n = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        this.pos++;
        n = { t: "bin", op: t.v, l: n, r: this.parseUnary() };
      } else return n;
    }
  }
  private parseUnary(): ExprNode {
    const t = this.peek();
    if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
      this.pos++;
      const x = this.parseUnary();
      return t.v === "-" ? { t: "neg", x } : x;
    }
    return this.parsePrimary();
  }
  private parsePrimary(): ExprNode {
    const t = this.peek();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") {
      this.pos++;
      return { t: "num", v: t.v };
    }
    if (t.t === "name") {
      this.pos++;
      if (t.v === "i") return { t: "index" };
      const next = this.peek();
      if (t.v === "rand") {
        if (!next || next.t !== "(") throw new Error("'rand' needs '(i)'");
        this.pos++;
        const arg = this.parseAdd();
        const close = this.peek();
        if (!close || close.t !== ")") throw new Error("unclosed 'rand('");
        this.pos++;
        return { t: "rand", arg };
      }
      return { t: "param", name: t.v };
    }
    if (t.t === "(") {
      this.pos++;
      const n = this.parseAdd();
      const close = this.peek();
      if (!close || close.t !== ")") throw new Error("unclosed '('");
      this.pos++;
      return n;
    }
    throw new Error(`unexpected '${t.t === "op" ? t.v : t.t}'`);
  }
}

/** Compile a preset `value` expression; throws with the preset diag on anything else. */
export function parseValueExpression(expr: string, preset: string, where: string): ExprNode {
  try {
    if (!expr.trim()) throw new Error("empty expression");
    return new ExprParser(tokenize(expr)).parse();
  } catch (e) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_BAD_EXPRESSION(preset, `${where}: '${expr}' (${e instanceof Error ? e.message : "invalid"})`)
    );
  }
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `rand(i)`: the i-th draw (0-based) of a generator seeded by preset name +
 * point index, so the same preset always computes the same values.
 */
export function deterministicRand(seedText: string, i: number): number {
  const next = mulberry32(fnv1a(seedText));
  let v = 0;
  const n = Math.max(0, Math.floor(i));
  for (let k = 0; k <= n; k++) v = next();
  return v;
}

export function evalValueExpression(
  node: ExprNode,
  params: Record<string, number>,
  pointIndex: number,
  seedText: string,
  preset: string,
  where: string
): number {
  const run = (n: ExprNode): number => {
    switch (n.t) {
      case "num":
        return n.v;
      case "param": {
        const v = params[n.name];
        if (v === undefined) {
          throw new CutholError(
            DIAGNOSTICS.PRESET_BAD_EXPRESSION(preset, `${where}: unknown name '${n.name}' (declared params only).`)
          );
        }
        return v;
      }
      case "index":
        return pointIndex;
      case "rand": {
        const arg = run(n.arg);
        if (!Number.isFinite(arg) || arg < 0 || Math.floor(arg) !== arg || arg > 100000) {
          throw new CutholError(
            DIAGNOSTICS.PRESET_BAD_EXPRESSION(preset, `${where}: 'rand(i)' needs a non-negative integer index.`)
          );
        }
        return deterministicRand(seedText, arg);
      }
      case "neg":
        return -run(n.x);
      case "bin": {
        const l = run(n.l);
        const r = run(n.r);
        switch (n.op) {
          case "+":
            return l + r;
          case "-":
            return l - r;
          case "*":
            return l * r;
          case "/":
            return l / r;
        }
      }
    }
  };
  const v = run(node);
  if (!Number.isFinite(v)) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_BAD_EXPRESSION(preset, `${where}: expression does not evaluate to a finite number.`)
    );
  }
  return v;
}

export function gridHash(gridMs: number[]): string {
  return createHash("sha256").update(JSON.stringify(gridMs.map((v) => Math.round(v)))).digest("hex").slice(0, 16);
}

function parsePresetPoint(raw: unknown, preset: string, where: string): ExtensionPresetPointSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}' must be an object ({ at, value }).`));
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_PRESET_POINT_KEYS.has(k)) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}' has an unknown field '${k}' (allowed: at, value, easing, bezier).`)
      );
    }
  }
  const anchor = parseAnchor(obj.at, preset, where);
  void anchor;
  if (typeof obj.value !== "number" && typeof obj.value !== "string") {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.value' must be a number or an expression string.`));
  }
  if (typeof obj.value === "string") parseValueExpression(obj.value, preset, where);
  let easing: EasingKind | undefined;
  if (obj.easing !== undefined) {
    if (typeof obj.easing !== "string" || !ALLOWED_EASING.has(obj.easing)) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.easing' must be one of ${[...ALLOWED_EASING].join(", ")}.`)
      );
    }
    easing = obj.easing as EasingKind;
  }
  let bezier: [number, number, number, number] | undefined;
  if (obj.bezier !== undefined) {
    if (
      !Array.isArray(obj.bezier) ||
      obj.bezier.length !== 4 ||
      obj.bezier.some((v) => typeof v !== "number" || !Number.isFinite(v))
    ) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.bezier' must be four finite numbers.`)
      );
    }
    bezier = [...(obj.bezier as number[])] as [number, number, number, number];
    if (easing !== undefined && easing !== "cubic_bezier") {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}' sets 'bezier' without easing 'cubic_bezier'.`)
      );
    }
    easing = "cubic_bezier";
  }
  return {
    at: (obj.at as string).trim(),
    value: obj.value,
    ...(easing !== undefined ? { easing } : {}),
    ...(bezier !== undefined ? { bezier } : {}),
  };
}

function parsePresetRepeat(raw: unknown, extName: string, presetName: string): ExtensionPresetRepeatSpec {
  const preset = `ext:${extName}/${presetName}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'repeat' must be an object ({ every, pattern_ms }).`));
  }
  const obj = raw as Record<string, unknown>;
  const every = obj.every;
  if (typeof every !== "string" || (every !== "beat" && !/^\d+(?:\.\d+)?ms$/.test(every.trim()))) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(preset, `'repeat.every' must be "beat" or "<ms>" (e.g. "250ms").`)
    );
  }
  if (typeof obj.pattern_ms !== "number" || !Number.isFinite(obj.pattern_ms) || obj.pattern_ms <= 0) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'repeat.pattern_ms' must be a positive number of ms.`));
  }
  return { every: every.trim(), pattern_ms: obj.pattern_ms };
}

export function parseManifestPresetsSection(
  raw: unknown,
  extName: string
): Record<string, ExtensionPresetSpec> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CutholError(DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'presets' must be an object.`));
  }
  const out: Record<string, ExtensionPresetSpec> = {};
  for (const [presetName, rawPreset] of Object.entries(raw as Record<string, unknown>)) {
    if (!EFFECT_NAME_RE.test(presetName)) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'presets.${presetName}' is an invalid name (lowercase, [a-z0-9_-]).`)
      );
    }
    const preset = `ext:${extName}/${presetName}`;
    if (!rawPreset || typeof rawPreset !== "object" || Array.isArray(rawPreset)) {
      throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `preset definition must be an object.`));
    }
    const obj = rawPreset as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!ALLOWED_PRESET_KEYS.has(k)) {
        throw new CutholError(
          DIAGNOSTICS.PRESET_UNKNOWN(preset, `unknown field '${k}' (allowed: description, params, entries, repeat).`)
        );
      }
    }
    const params = validateParamsMap(obj.params, extName, `presets.${presetName}`);
    for (const [pName, pDef] of Object.entries(params)) {
      if ((pDef as ExtensionParamDef).type !== "number") {
        throw new CutholError(
          DIAGNOSTICS.PRESET_UNKNOWN(preset, `param '${pName}' must be a number (preset values are numeric).`)
        );
      }
    }
    if (!Array.isArray(obj.entries) || obj.entries.length !== 1) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(preset, `'entries' must be an array with exactly one entry ({ kind, keys }) in this version.`)
      );
    }
    const entries: ExtensionPresetEntrySpec[] = [];
    for (let i = 0; i < (obj.entries as unknown[]).length; i++) {
      const rawEntry = (obj.entries as unknown[])[i];
      const where = `entries[${i}]`;
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}' must be an object ({ kind, keys }).`));
      }
      const eObj = rawEntry as Record<string, unknown>;
      for (const k of Object.keys(eObj)) {
        if (!ALLOWED_PRESET_ENTRY_KEYS.has(k)) {
          throw new CutholError(
            DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}' has an unknown field '${k}' (allowed: kind, keys).`)
          );
        }
      }
      if (typeof eObj.kind !== "string" || !eObj.kind.trim()) {
        throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.kind' is required ("motion" or an extension motion kind).`));
      }
      const kind = eObj.kind.trim();
      if (kind !== MOTION_FX_KIND && !/^ext:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(kind)) {
        throw new CutholError(
          DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.kind' '${kind}' is not "motion" or an 'ext:<extension>/<name>' motion kind.`)
        );
      }
      if (!eObj.keys || typeof eObj.keys !== "object" || Array.isArray(eObj.keys)) {
        throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.keys' must be an object (channel -> point list).`));
      }
      const keys: Record<string, ExtensionPresetPointSpec[]> = {};
      for (const [channel, rawPoints] of Object.entries(eObj.keys as Record<string, unknown>)) {
        if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
          throw new CutholError(
            DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.keys.${channel}' must be a non-empty point list.`)
          );
        }
        keys[channel] = rawPoints.map((p, pi) => parsePresetPoint(p, preset, `${where}.keys.${channel}[${pi}]`));
      }
      if (Object.keys(keys).length === 0) {
        throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `'${where}.keys' must name at least one channel.`));
      }
      entries.push({ kind, keys });
    }
    out[presetName] = {
      ...(typeof obj.description === "string" ? { description: obj.description } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      entries,
      ...(obj.repeat !== undefined ? { repeat: parsePresetRepeat(obj.repeat, extName, presetName) } : {}),
    };
  }
  return out;
}

export interface ResolvedPresetPoint {
  channel: string;
  offsetMs: number;
  value: number;
  easing?: EasingKind;
  bezier?: [number, number, number, number];
  record: PresetPointRecord;
}

function resolveAnchorToMs(anchor: ParsedAnchor, durationMs: number): number {
  switch (anchor.kind) {
    case "start":
    case "absolute":
      return anchor.offsetMs;
    case "end":
      return durationMs - anchor.offsetMs;
    case "ratio":
      return (durationMs * anchor.ratio) / 100;
  }
}

/**
 * Generate concrete envelope points for one apply. `beatsLocalMs` is the beat
 * grid already converted to item-local ms (beat 1 is index 0); required when
 * the preset repeats on every beat. Returns per-channel points plus the
 * provenance point records `verify` recomputes from.
 */
export function generatePresetPoints(options: {
  preset: string;
  spec: ExtensionPresetSpec;
  args: Record<string, number>;
  durationMs: number;
  beatsLocalMs?: number[] | null;
  beatsAsset?: string;
  /** Hash of the asset beat grid (placement-independent); when omitted it is hashed from the local beats. */
  beatsGridHash?: string;
}): { channels: Record<string, ResolvedPresetPoint[]>; records: PresetPointRecord[]; beats?: { asset_handle: string; grid_hash: string } } {
  const { preset, spec, args, durationMs, beatsLocalMs, beatsAsset } = options;
  if (!(durationMs > 0)) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(preset, `clip duration ${durationMs} ms cannot host a preset.`));
  }
  const entry = spec.entries[0];
  const channels: Record<string, ResolvedPresetPoint[]> = {};
  const records: PresetPointRecord[] = [];
  if (spec.repeat) {
    if (spec.repeat.every === "beat" && (!beatsLocalMs || beatsLocalMs.length === 0)) {
      throw new CutholError(DIAGNOSTICS.PRESET_BEATS_MISSING(preset));
    }
    const starts: Array<{ repStart: number; beatIndex?: number }> =
      spec.repeat.every === "beat"
        ? (beatsLocalMs as number[]).map((b, i) => ({ repStart: b, beatIndex: i + 1 }))
        : (() => {
            const step = Number(spec.repeat!.every.slice(0, -2));
            const out: Array<{ repStart: number }> = [];
            for (let s = 0; s < durationMs; s += step) out.push({ repStart: s });
            return out;
          })();
    for (const [channel, points] of Object.entries(entry.keys)) {
      const rel = points.map((p) => {
        const anchor = parseAnchor(p.at, preset, `keys.${channel}`);
        if (anchor.kind === "end" || anchor.kind === "ratio") {
          throw new CutholError(
            DIAGNOSTICS.PRESET_UNKNOWN(preset, `repeated point '${p.at}' must be relative to the repetition start ("start[+<ms>]" or ms).`)
          );
        }
        return { spec: p, relMs: anchor.offsetMs };
      });
      const pts: ResolvedPresetPoint[] = [];
      let idx = 0;
      for (const s of starts) {
        if (s.repStart < 0 || s.repStart > durationMs) continue;
        for (const r of rel) {
          const offsetMs = Math.round(s.repStart + r.relMs);
          if (offsetMs < 0 || offsetMs > durationMs) continue;
          const value = evalValue(r.spec.value, args, idx, `${preset}:${channel}:${idx}`, preset, `keys.${channel}`);
          pts.push({
            channel,
            offsetMs,
            value,
            ...(r.spec.easing !== undefined ? { easing: r.spec.easing } : {}),
            ...(r.spec.bezier !== undefined ? { bezier: r.spec.bezier } : {}),
            record: {
              channel,
              anchor: s.beatIndex !== undefined ? "beat" : "start",
              ...(s.beatIndex !== undefined ? { beat_index: s.beatIndex, offset_ms: Math.round(r.relMs) } : { offset_ms: offsetMs }),
              value,
              ...(r.spec.easing !== undefined ? { easing: r.spec.easing } : {}),
              ...(r.spec.bezier !== undefined ? { bezier: [...r.spec.bezier] as [number, number, number, number] } : {}),
            },
          });
          idx++;
        }
      }
      pts.sort((a, b) => a.offsetMs - b.offsetMs);
      channels[channel] = pts;
    }
  } else {
    for (const [channel, points] of Object.entries(entry.keys)) {
      const pts: ResolvedPresetPoint[] = [];
      points.forEach((p, pi) => {
        const anchor = parseAnchor(p.at, preset, `keys.${channel}`);
        const offsetMs = Math.round(resolveAnchorToMs(anchor, durationMs));
        const value = evalValue(p.value, args, pi, `${preset}:${channel}:${pi}`, preset, `keys.${channel}`);
        const record: PresetPointRecord =
          anchor.kind === "ratio"
            ? { channel, anchor: "ratio", ratio: anchor.ratio, value }
            : anchor.kind === "absolute"
              ? { channel, anchor: "start", offset_ms: offsetMs, value }
              : {
                  channel,
                  anchor: anchor.kind,
                  offset_ms: anchor.offsetMs,
                  value,
                };
        if (p.easing !== undefined) record.easing = p.easing;
        if (p.bezier !== undefined) record.bezier = [...p.bezier];
        pts.push({
          channel,
          offsetMs,
          value,
          ...(p.easing !== undefined ? { easing: p.easing } : {}),
          ...(p.bezier !== undefined ? { bezier: p.bezier } : {}),
          record,
        });
      });
      pts.sort((a, b) => a.offsetMs - b.offsetMs);
      channels[channel] = pts;
    }
    const earliestEnd = Math.min(
      ...Object.values(channels)
        .flat()
        .filter((p) => p.record.anchor === "end")
        .map((p) => p.offsetMs),
      Number.POSITIVE_INFINITY
    );
    const latestStart = Math.max(
      ...Object.values(channels)
        .flat()
        .filter((p) => p.record.anchor !== "end")
        .map((p) => p.offsetMs),
      Number.NEGATIVE_INFINITY
    );
    if (earliestEnd !== Number.POSITIVE_INFINITY && latestStart !== Number.NEGATIVE_INFINITY && earliestEnd < latestStart) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_ANCHORS_CROSS(preset, `an end-anchored point at ${earliestEnd} ms lands before a start-anchored point at ${latestStart} ms (duration ${durationMs} ms).`)
      );
    }
  }
  for (const pts of Object.values(channels)) {
    for (const p of pts) records.push(p.record);
    for (const p of pts) {
      if (p.offsetMs < 0 || p.offsetMs > durationMs) {
        throw new CutholError(
          DIAGNOSTICS.PRESET_UNKNOWN(preset, `point on '${p.channel}' lands at ${p.offsetMs} ms, outside the ${durationMs} ms clip.`)
        );
      }
    }
  }
  void PLACEMENT_CHANNELS;
  const usesBeats = records.some((r) => r.anchor === "beat");
  return {
    channels,
    records,
    ...(usesBeats && beatsAsset
      ? {
          beats: {
            asset_handle: beatsAsset,
            grid_hash: options.beatsGridHash ?? gridHash(beatsLocalMs as number[]),
          },
        }
      : {}),
  };
}

function evalValue(
  raw: number | string,
  args: Record<string, number>,
  pointIndex: number,
  seedText: string,
  preset: string,
  where: string
): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_EXPRESSION(preset, `${where}: value is not finite.`));
    }
    return raw;
  }
  return evalValueExpression(parseValueExpression(raw, preset, where), args, pointIndex, seedText, preset, where);
}
