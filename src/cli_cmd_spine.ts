// CLI 'spine' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  CutholSequence,
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpatialPlacement,
  SpeedRampPoint,
  TransitionSpec,
} from "./core/schema.js";
import { getSequenceEffectRegistry, parseExtensionEffectRef } from "./extensions/ext_effects.js";
import { resolveExtension } from "./extensions/manager.js";
import { parseEasingFlag } from "./core/easing.js";
import { parseTimeMs } from "./core/time.js";
import {
  appendSpineClip,
  exciseSpineRanges,
  removeSpineClips,
  reorderSpineClip,
  setItemEnvelope,
  setSpineMute,
  setSpineSpeed,
  setSpineTransition,
  splitSpineClip,
  transformSpineClip,
  trimSpineClip,
} from "./sequence/spine_edit.js";
import { addSpineFx, listSpineFx, removeSpineFx, setSpineFx } from "./sequence/spine_fx.js";
import { applyPresetSpineFx, reapplyPresetEntries } from "./effects/preset_apply.js";
import type { VerificationReport } from "./verify/gates.js";
import { listEffectDefinitions } from "./effects/effect_registry.js";
import { loadSequence } from "./core/workspace.js";
import { MediaLedger } from "./library/ledger.js";
import type { BeatAnalysisResult } from "./library/beats.js";
import {
  addEnvelopePoint,
  addEnvelopePointsBulk,
  beatToLocalMs,
  moveEnvelopePoint,
  readEnvelopeValueAt,
  removeEnvelopePoint,
  sequenceTimeToLocalMs,
} from "./sequence/envelope_points.js";
import { boolFlag, jsonFixCommand, numFlag, parseExciseRanges, parseJsonFlag, strFlag } from "./cli_args.js";
import type { RawTranscriptWord } from "./speech/providers.js";
import fs from "node:fs";
import path from "node:path";
import { checkEffectDefinition, checkFxChain } from "./effects/fx_check.js";

function parseSpeedRampFlag(raw: string): SpeedRampPoint[] {
  const fail = (detail: string): never => {
    throw new CutholError(DIAGNOSTICS.INVALID_SPEED_RAMP(detail));
  };
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) fail(`'${raw}' contains no 'offset:rate' pair.`);
  return tokens.map((token) => {
    const sepIdx = token.lastIndexOf(":");
    if (sepIdx <= 0) fail(`'${token}' is not in 'offset:rate' form.`);
    const tStr = token.slice(0, sepIdx).trim();
    const vStr = token
      .slice(sepIdx + 1)
      .trim()
      .replace(/x$/i, "");
    let offsetMs: number;
    try {
      offsetMs = parseTimeMs(tStr);
    } catch {
      fail(`'${tStr}' is not a valid time.`);
    }
    const rate = Number(vStr);
    if (!Number.isFinite(rate)) fail(`rate of '${token}' ('${vStr}') is not a number.`);
    return { source_offset_ms: offsetMs!, rate };
  });
}
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";


function parseFxScalar(raw: string): number | string | boolean {
  const t = raw.trim();
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return raw;
}

function addFxPair(target: Record<string, unknown>, token: string): void {
  for (const piece of token.split(",")) {
    const eq = piece.indexOf("=");
    const name = eq > 0 ? piece.slice(0, eq).trim() : "";
    if (!name) {
      throw new Error(
        `'${piece.trim() || token}' is not a name=value pair; pass it as '--param sigma=4' (repeat the flag for multiple parameters).`
      );
    }
    target[name] = parseFxScalar(piece.slice(eq + 1));
  }
}

/**
 * Collects fx params from `--params '{"k":v}'` (MCP object path) plus every `--param k=v` occurrence.
 * `parseArgv` keeps only the last `--param`, so repeats are re-scanned from the raw argv; a single `--param`
 * may also carry comma-separated pairs.
 */
function collectSpineFxParams(flags: Record<string, string | boolean>, command = "spine fx add"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rawJson = strFlag(flags, "params");
  if (rawJson !== undefined) {
    const item = strFlag(flags, "item") ?? strFlag(flags, "clip");
    Object.assign(
      out,
      parseJsonFlag(rawJson, {
        command,
        flag: "params",
        kind: "object",
        fixCommand: jsonFixCommand(command, "params", item ? `--item ${item}` : "--item sp_01"),
      }) as Record<string, unknown>
    );
  }
  const argv = process.argv.slice(2);
  let sawArgvParam = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--param") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        addFxPair(out, next);
        sawArgvParam = true;
        i++;
      }
    } else if (tok.startsWith("--param=")) {
      addFxPair(out, tok.slice("--param=".length));
      sawArgvParam = true;
    }
  }
  if (!sawArgvParam) {
    const single = strFlag(flags, "param");
    if (single !== undefined) addFxPair(out, single);
  }
  return out;
}

/**
 * `spine fx check` (brief A item 3 + continuation): definition check for one
 * effect kind. Only kinds with an explicit non-ffmpeg backend pass as native;
 * anything else must resolve to a runnable filter template or it is a G326
 * ERROR. An ERROR finding fails the command (exit 1, `ok: false`), like
 * `verify`; WARN-only stays exit 0. Needs no workspace for persistent
 * extensions (`~/.cuthol/extensions/<name>/`) and core kinds.
 */
export function runSpineFxCheck(
  workspaceDir: string,
  args: { kind?: string; item?: string; filter?: string }
): void {
  const kind = args.kind;
  if (!kind) throw new Error("Provide --kind <kind>.");
  const item = args.item ?? null;

  const finish = (payload: Record<string, unknown>): void => {
    const findings = (payload.findings as Array<{ severity?: string }> | undefined) ?? [];
    const failed = findings.some((f) => f?.severity === "ERROR");
    emitEnvelopeJson(workspaceDir, "spine.fx.check", {
      action: "spine.fx.check",
      kind,
      item,
      ...payload,
      ok: !failed,
      result: failed ? "fail" : (payload.result ?? "pass"),
    });
    if (failed) process.exitCode = 1;
  };

  // Raw ffmpeg chain: no definition needed, no workspace needed.
  if (kind === "ffmpeg") {
    finish({
      findings: checkFxChain(args.filter ?? "", { itemId: item ?? undefined, kind }),
    });
    return;
  }

  // Positive native list: only the built-in kinds with a non-ffmpeg backend.
  // Anything unknown must NOT fall through here.
  if (kind === "motion") {
    finish({ result: "pass", note: "native backend: validated by placement-layer geometry checks." });
    return;
  }

  // A workspace, when there is one (SYS01 outside a workspace is not an error here).
  let sequence: CutholSequence | null = null;
  let seqRoot: string | undefined;
  try {
    sequence = loadSequence(workspaceDir).sequence;
    seqRoot = workspaceDir;
  } catch (err) {
    if (!(err instanceof CutholError) || (err.diagnostic as { code?: string } | undefined)?.code !== "CUTHOL-SYS01") throw err;
  }

  if (sequence) {
    const def = listEffectDefinitions(sequence, { rootDir: seqRoot }).find((d) => d.kind === kind);
    if (def) {
      if (def.backend === "shader") {
        finish({
          findings: checkEffectDefinition(
            { ...def, shaderFile: readRegistryShaderFile(sequence, seqRoot, kind) },
            { projectDir: seqRoot, cacheKeyPrefix: "def" }
          ),
        });
        return;
      }
      if (def.backend !== "ffmpeg") {
        const via = def.backend === "spine"
          ? "placement-layer geometry checks"
          : "core colour diagnostics";
        finish({ result: "pass", note: `native backend: validated by ${via}.` });
        return;
      }
      if (def.ffmpeg?.video_filter) {
        finish({
          findings: checkEffectDefinition(def, { projectDir: seqRoot, cacheKeyPrefix: "def" }),
        });
        return;
      }
      throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
        kind,
        `kind '${kind}' is a transition, not a clip effect; 'spine fx check' probes clip effects ('ffmpeg', 'motion' or 'ext:<extension>/<name>').`
      ));
    }
  }

  // No registered definition: resolve `ext:<extension>/<name>` explicitly so the
  // error names the kind and says what exists.
  const ref = parseExtensionEffectRef(kind);
  if (!ref) {
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      `unknown kind '${kind}' (built-in kinds are 'ffmpeg' and 'motion'; extension kinds are in 'ext:<extension>/<name>' form).`
    ));
  }

  const enabled = sequence?.extensions?.some((e) => e.name === ref.extension) ?? false;
  let ext: ReturnType<typeof resolveExtension> | null = null;
  let loadError: unknown = null;
  try {
    // Outside a workspace only persistent extensions resolve; inside, project-local wins.
    ext = resolveExtension(ref.extension, sequence ? workspaceDir : null);
  } catch (err) {
    loadError = err;
  }
  if (!ext) {
    const msg = loadError instanceof CutholError ? loadError.diagnostic.what : String(loadError ?? "not found");
    if (!sequence) {
      throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
        kind,
        `kind '${kind}' could not be resolved without a workspace (extension '${ref.extension}' is not among the persistent extensions): ${msg} Run inside the project workspace to check project-local extensions.`
      ));
    }
    if (enabled) {
      throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
        kind,
        `extension '${ref.extension}' is enabled in this project but could not be loaded: ${msg}`
      ));
    }
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      `extension '${ref.extension}' is not enabled in this project: ${msg} Run \`cuthol extension enable ${ref.extension}\`.`
    ));
  }
  if (sequence && !enabled) {
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      `extension '${ref.extension}' is present but not enabled: run \`cuthol extension enable ${ref.extension}\`.`,
      `Enable it with 'cuthol extension enable ${ref.extension}', then re-run 'cuthol spine fx check --kind ${kind}'.`
    ));
  }
  const spec = ext.manifest.fx?.[ref.name];
  if (!spec) {
    const names = Object.keys(ext.manifest.fx ?? {});
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      names.length > 0
        ? `unknown fx '${ref.name}' in extension '${ref.extension}' (kind '${kind}'); available: ${names.map((n) => `ext:${ref.extension}/${n}`).join(", ")}.`
        : `unknown fx '${ref.name}' in extension '${ref.extension}' (kind '${kind}'); extension '${ref.extension}' defines no fx.`
    ));
  }
  finish({
    findings: checkEffectDefinition(
      {
        kind,
        params: spec.params ?? {},
        animatable: [...(spec.animatable ?? [])],
        alpha: spec.alpha,
        backend: spec.backend,
        ...(spec.backend === "shader"
          ? (readExtShaderFile(ext.dir, spec.shader) ? { shaderFile: readExtShaderFile(ext.dir, spec.shader) } : {})
          : { ffmpeg: { video_filter: spec.video_filter ?? "" } }),
      },
      { projectDir: seqRoot, cacheKeyPrefix: "def" }
    ),
  });
}

/** Read a registry shader entry's `.glsl` for the static compile check (best effort: omit when unreadable). */
function readRegistryShaderFile(sequence: CutholSequence, rootDir: string | undefined, kind: string): { file: string; source: string } | undefined {
  try {
    if (!rootDir) return undefined;
    const reg = getSequenceEffectRegistry(sequence, rootDir);
    const def = reg.fx.get(kind as never);
    const rel = def?.spec.shader;
    if (!def || typeof rel !== "string" || !rel) return undefined;
    const abs = path.resolve(def.dir, rel);
    return { file: rel, source: fs.readFileSync(abs, "utf8") };
  } catch {
    return undefined;
  }
}

/** Read an explicit extension's shader file for the static compile check (best effort). */
function readExtShaderFile(extDir: string, rel: unknown): { file: string; source: string } | undefined {
  try {
    if (typeof rel !== "string" || !rel) return undefined;
    return { file: rel, source: fs.readFileSync(path.resolve(extDir, rel), "utf8") };
  } catch {
    return undefined;
  }
}

/**
 * `spine fx preset --item <sp_XX> --preset ext:<ext>/<name> [--param k=v ...]
 * [--beats <aud_XX>]` applies a keyframe template anchored to the clip, or
 * with `--reapply --fx <fx_XX>` / `--reapply --all` regenerates preset
 * entries from their records with the current duration and beat grid.
 */
export function runSpineFxPreset(
  workspaceDir: string,
  flags: Record<string, string | boolean>
): void {
  const item = strFlag(flags, "item") ?? strFlag(flags, "clip");
  if (!item) throw new Error("Provide --item <sp_XX>.");
  if (boolFlag(flags, "reapply", false) === true) {
    const fxId = strFlag(flags, "fx") ?? strFlag(flags, "id");
    const all = boolFlag(flags, "all", false) === true;
    const res = reapplyPresetEntries({ workspaceDir, item, fxId, all });
    emitEnvelopeJson(workspaceDir, "spine.fx.preset.reapply", {
      action: "spine.fx.preset.reapply",
      ...res,
    });
    return;
  }
  const preset = strFlag(flags, "preset");
  if (!preset) throw new Error("Provide --preset <ext:<extension>/<name]> (or --reapply).");
  const beats = strFlag(flags, "beats");
  const res = applyPresetSpineFx({
    workspaceDir,
    item,
    preset,
    params: collectSpineFxParams(flags, "spine fx preset"),
    ...(beats ? { beats } : {}),
  });
  emitEnvelopeJson(workspaceDir, "spine.fx.preset", {
    action: "spine.fx.preset",
    ...res,
  });
}

/**
 * Bulk envelope points from `--points-file <json>`: a JSON array of
 * `{ at_ms | at, value, easing?, bezier? }`. `at` is a time string in
 * clip-local ms unless `--sequence-time` is passed.
 */
export function addEnvelopePointsFromFile(options: {
  workspaceDir: string;
  targetId: string;
  parameter: ParameterEnvelope["parameter"];
  pointsFile: string;
  sequenceTime: boolean;
}): { envelope: ParameterEnvelope; revision: number; verification: VerificationReport } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(options.pointsFile, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read points file '${options.pointsFile}': ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Points file '${options.pointsFile}' must be a non-empty JSON array of points.`);
  }
  const { sequence } = loadSequence(options.workspaceDir);
  const points = raw.map((entry, i) => {
    const where = `${options.pointsFile}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${where} must be an object ({ at_ms | at, value, easing?, bezier? }).`);
    }
    const obj = entry as Record<string, unknown>;
    let offsetMs: number;
    if (typeof obj.at_ms === "number") {
      offsetMs = Math.round(obj.at_ms);
    } else if (typeof obj.at === "string") {
      offsetMs = parseTimeMs(obj.at);
    } else {
      throw new Error(`${where} needs 'at_ms' (number) or 'at' (time string).`);
    }
    if (!Number.isFinite(offsetMs)) throw new Error(`${where} has a non-finite time.`);
    if (options.sequenceTime) offsetMs = Math.round(sequenceTimeToLocalMs(sequence, options.targetId, offsetMs));
    const value = obj.value === undefined ? undefined : Number(obj.value);
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`${where} value is not a number.`);
    let easing = parseEasingFlag(typeof obj.easing === "string" ? obj.easing : "linear", {}).easing as ParameterEnvelopePoint["easing"];
    let bezier: ParameterEnvelopePoint["bezier"] | undefined;
    if (obj.bezier !== undefined) {
      if (!Array.isArray(obj.bezier) || obj.bezier.length !== 4 || obj.bezier.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        throw new Error(`${where} bezier must be four finite numbers.`);
      }
      bezier = [...(obj.bezier as number[])] as [number, number, number, number];
      easing = "cubic_bezier";
    }
    return { workspaceDir: options.workspaceDir, targetId: options.targetId, parameter: options.parameter, offsetMs, value, easing, ...(bezier ? { bezier: [...bezier] as [number, number, number, number] } : {}) };
  });
  return addEnvelopePointsBulk({
    workspaceDir: options.workspaceDir,
    targetId: options.targetId,
    parameter: options.parameter,
    points,
  });
}

/**
 * `spine fx check --kind <k> --full`: quick check plus sandbox delivery check
 * (card variants, alpha, neutral, stacked, Bezier envelopes, cost class).
 */
export async function runSpineFxCheckFull(
  workspaceDir: string,
  args: { kind?: string; filter?: string }
): Promise<void> {
  const kind = args.kind;
  if (!kind) throw new Error("Provide --kind <kind>.");
  const { fxFullVerdict, runFxCheckFull } = await import("./effects/fx_check_full.js");
  const fail = (payload: Record<string, unknown>, code = 1): void => {
    const findings = (payload.findings as Array<{ severity?: string }> | undefined) ?? [];
    const rows = (payload.rows as Array<{ ok?: boolean }> | undefined) ?? [];
    const verdict = fxFullVerdict(rows, findings);
    emitEnvelopeJson(workspaceDir, "spine.fx.check", {
      action: "spine.fx.check",
      kind,
      full: true,
      ...payload,
      ok: verdict.ok,
      result: verdict.result,
    });
    if (!verdict.ok) process.exitCode = code;
  };
  if (kind === "motion") {
    fail({ result: "pass", note: "native backend: validated by placement-layer geometry checks.", rows: [] });
    return;
  }
  if (kind === "ffmpeg") {
    if (!args.filter) throw new Error("Provide --filter \"<chain>\" for kind 'ffmpeg'.");
    const res = runFxCheckFull({ kind, filter: args.filter });
    fail({ rows: res.rows, findings: res.findings, cost_ms_per_frame_1080p: res.costMsPerFrame1080p, cost_class: res.costClass });
    return;
  }
  const ref = parseExtensionEffectRef(kind);
  if (!ref) {
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      `unknown kind '${kind}' (built-in kinds are 'ffmpeg' and 'motion'; extension kinds are in 'ext:<extension>/<name>' form).`
    ));
  }
  let sequence: CutholSequence | null = null;
  try {
    sequence = loadSequence(workspaceDir).sequence;
  } catch {
    sequence = null;
  }
  let ext: ReturnType<typeof resolveExtension> | null = null;
  try {
    ext = resolveExtension(ref.extension, sequence ? workspaceDir : null);
  } catch (err) {
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      `extension '${ref.extension}' could not be resolved: ${err instanceof CutholError ? err.diagnostic.what : String(err)}`
    ));
  }
  if (!ext) {
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(kind, `extension '${ref.extension}' was not found.`));
  }
  const spec = ext.manifest.fx?.[ref.name];
  if (!spec) {
    const names = Object.keys(ext.manifest.fx ?? {});
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      names.length > 0
        ? `unknown fx '${ref.name}' in extension '${ref.extension}' (kind '${kind}'); available: ${names.map((n) => `ext:${ref.extension}/${n}`).join(", ")}.`
        : `unknown fx '${ref.name}' in extension '${ref.extension}' (kind '${kind}'); extension '${ref.extension}' defines no fx.`
    ));
  }
  const res = runFxCheckFull({ kind, spec, extDir: { name: ref.extension, dir: ext.dir } });
  fail({ rows: res.rows, findings: res.findings, cost_ms_per_frame_1080p: res.costMsPerFrame1080p, cost_class: res.costClass });
}

/**
 * `spine fx try --kind <k> [--param k=v ...] [--sweep p=a..b[:n]] [--at t1,t2,...]
 * [--on card|<sp_XX>] [--out <png>]`: one PNG grid through the sandbox. Works without
 * a project for `card`; `--on <sp_XX>` needs one and copies only that item's source
 * into the sandbox (the user's project is never written).
 */
export async function runSpineFxTry(
  workspaceDir: string,
  args: { kind?: string; filter?: string; params?: Record<string, unknown>; sweep?: string; at?: string; on?: string; out?: string }
): Promise<void> {
  const kind = args.kind;
  const filter = args.filter;
  if (!kind && !filter) throw new Error("Provide --kind <kind> or --filter \"<chain>\".");
  if (kind && kind !== "ffmpeg" && kind !== "motion" && !parseExtensionEffectRef(kind)) {
    throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
      kind,
      `unknown kind '${kind}' (built-in kinds are 'ffmpeg' and 'motion'; extension kinds are in 'ext:<extension>/<name>' form).`
    ));
  }
  if (kind === "motion") {
    emitEnvelopeJson(workspaceDir, "spine.fx.try", {
      action: "spine.fx.try",
      kind,
      ok: true,
      result: "pass",
      note: "motion is a placement layer, not pixels: nothing to render.",
    });
    return;
  }
  const { parseSweep, runFxTry } = await import("./effects/fx_try.js");
  const sweep = args.sweep !== undefined ? parseSweep(args.sweep) : undefined;
  const at = args.at !== undefined
    ? args.at.split(",").map((s) => {
      const v = Number(s.trim());
      if (!Number.isFinite(v) || v < 0) throw new Error(`--at must be comma-separated seconds >= 0 (given: '${args.at}').`);
      return v;
    })
    : undefined;
  const on = args.on ?? "card";
  let onSourceFile: string | undefined;
  if (on !== "card") {
    let sequence: CutholSequence;
    try {
      sequence = loadSequence(workspaceDir).sequence;
    } catch {
      throw new CutholError(DIAGNOSTICS.FX_TRY_UNKNOWN_ITEM(on));
    }
    const clip = sequence.spine.clips.find((c) => c.id === on);
    if (!clip) throw new CutholError(DIAGNOSTICS.FX_TRY_UNKNOWN_ITEM(on));
    const asset = sequence.library.find((a) => a.handle === (clip as { asset_handle: string }).asset_handle);
    if (!asset) throw new CutholError(DIAGNOSTICS.FX_TRY_UNKNOWN_ITEM(on));
    const { paths } = loadSequence(workspaceDir);
    const root = (paths.rootDir as string) ?? workspaceDir;
    const candidates = [asset.uri, `${root}/${asset.uri}`];
    onSourceFile = candidates.find((c) => {
      try {
        return c ? fs.statSync(c).isFile() : false;
      } catch {
        return false;
      }
    });
    if (!onSourceFile) throw new CutholError(DIAGNOSTICS.FX_TRY_UNKNOWN_ITEM(on));
  }
  let extDir: { name: string; dir: string } | undefined;
  if (kind?.startsWith("ext:")) {
    const ref = parseExtensionEffectRef(kind);
    let sequence: CutholSequence | null = null;
    try {
      sequence = loadSequence(workspaceDir).sequence;
    } catch {
      sequence = null;
    }
    let ext: ReturnType<typeof resolveExtension> | null = null;
    try {
      ext = ref ? resolveExtension(ref.extension, sequence ? workspaceDir : null) : null;
    } catch (err) {
      throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(
        kind,
        `extension '${ref?.extension}' could not be resolved: ${err instanceof CutholError ? err.diagnostic.what : String(err)}`
      ));
    }
    if (!ext || !ref) {
      throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(kind, `extension kind '${kind}' could not be resolved.`));
    }
    if (!ext.manifest.fx?.[ref.name]) {
      throw new CutholError(DIAGNOSTICS.FX_CHECK_UNKNOWN_KIND(kind, `unknown fx '${ref.name}' in extension '${ref.extension}'.`));
    }
    extDir = { name: ref.extension, dir: ext.dir };
  }
  // Like every other `--out`, a relative path resolves against the project
  // folder, never the cwd.
  const out = args.out
    ? path.isAbsolute(args.out)
      ? args.out
      : path.resolve(workspaceDir, args.out)
    : undefined;
  try {
    const res = runFxTry({
      kind,
      filter,
      params: args.params,
      ...(sweep ? { sweep } : {}),
      ...(at ? { at } : {}),
      ...(args.on ? { on } : {}),
      ...(out ? { out } : {}),
      ...(onSourceFile ? { onSourceFile } : {}),
      ...(extDir ? { extDir } : {}),
    });
    emitEnvelopeJson(workspaceDir, "spine.fx.try", {
      action: "spine.fx.try",
      kind: kind ?? "ffmpeg",
      png: res.png,
      layout: { rows: res.rows, cols: res.cols, sweep_param: res.sweepParam },
      cost_ms_per_frame_1080p: res.costMsPerFrame1080p,
      ok: true,
      result: "pass",
    });
  } catch (err) {
    if (err instanceof CutholError) throw err;
    throw new CutholError(DIAGNOSTICS.FX_TRY_FAILED(
      kind ?? "ffmpeg",
      String((err as Error)?.message ?? err).slice(0, 300)
    ));
  }
}

export async function runSpineCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "append") {
    const assetHandle = strFlag(flags, "asset") ?? rest[0];
    if (!assetHandle) throw new Error("Provide --asset <vid_XX>.");
    const inRaw = strFlag(flags, "in");
    const outRaw = strFlag(flags, "out");
    const res = appendSpineClip({
      workspaceDir,
      assetHandle,
      sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
      sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
      explicitId: strFlag(flags, "id"),
    });
    emitEnvelopeJson(workspaceDir, "spine.append", { action: "spine.append", ...res });
    return;
  }

  if (action === "split") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const atRaw = strFlag(flags, "at");
    if (!clipId || !atRaw) throw new Error("Provide --clip <sp_XX> --at <t1,t2>.");
    const pts = atRaw.split(",").map((s) => parseTimeMs(s.trim()));
    const res = splitSpineClip({
      workspaceDir,
      clipId,
      splitPointsMs: pts,
      isSequenceTime: boolFlag(flags, "sequence-time", false),
    });
    emitEnvelopeJson(workspaceDir, "spine.split", { action: "spine.split", ...res });
    return;
  }

  if (action === "trim") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    const inRaw = strFlag(flags, "in");
    const outRaw = strFlag(flags, "out");
    const res = trimSpineClip({
      workspaceDir,
      clipId,
      sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
      sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
    });
    emitEnvelopeJson(workspaceDir, "spine.trim", { action: "spine.trim", ...res });
    return;
  }

  if (action === "excise") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const rangesRaw = strFlag(flags, "ranges");
    if (!clipId || !rangesRaw) throw new Error("Provide --clip <sp_XX> --ranges <a..b,c..d>.");
    const ranges = parseExciseRanges(rangesRaw);
    const coordFlag = strFlag(flags, "coord") as "source" | "sequence" | "clip_local" | undefined;
    const snap = boolFlag(flags, "snap", false);
    let finalRanges = ranges;
    if (snap) {
      // Opt-in: move each range edge to the nearest quiet point (±100 ms),
      // same placement as automatic filler/repetition cuts. Off by default:
      // raw ranges are excised exactly as given.
      const { loadCachedTranscriptForAsset } = await import("./speech/transcribe.js");
      const { measureAssetAcousticWindows } = await import("./library/waveform.js");
      const { snapRangesToQuietEdges } = await import("./speech/cleanup_acoustic.js");
      const { sequence } = loadSequence(workspaceDir);
      const target = sequence.spine.clips.find((c) => c.id === clipId);
      if (!target) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(clipId));
      let transcriptWords: RawTranscriptWord[] = [];
      try {
        transcriptWords = loadCachedTranscriptForAsset(workspaceDir, target.asset_handle)
          .words as RawTranscriptWord[];
      } catch {
        transcriptWords = [];
      }
      let acousticProfile: ReturnType<typeof measureAssetAcousticWindows> = null;
      try {
        acousticProfile = measureAssetAcousticWindows({
          workspaceDir,
          handle: target.asset_handle,
        });
      } catch {
        acousticProfile = null;
      }
      finalRanges = snapRangesToQuietEdges({
        clip: target,
        ranges,
        transcriptWords,
        acousticProfile,
      });
    }
    const res = exciseSpineRanges({
      workspaceDir,
      clipId,
      ranges: finalRanges,
      coordinateSpace: coordFlag,
      isSourceTime: boolFlag(flags, "source-time", false),
    });
    emitEnvelopeJson(workspaceDir, "spine.excise", { action: "spine.excise", ...res });
    return;
  }

  if (action === "remove") {
    const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
    if (!clipsRaw) throw new Error("Provide --clips <sp_01,sp_02>.");
    const clipIds = clipsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const res = removeSpineClips({
      workspaceDir,
      clipIds,
      cascadeAnchoredCues: boolFlag(flags, "cascade-cues", true),
    });
    emitEnvelopeJson(workspaceDir, "spine.remove", { action: "spine.remove", ...res });
    return;
  }

  if (action === "reorder") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    const res = reorderSpineClip({
      workspaceDir,
      clipId,
      beforeClipId: strFlag(flags, "before"),
      afterClipId: strFlag(flags, "after"),
      toIndex: numFlag(flags, "index"),
    });
    emitEnvelopeJson(workspaceDir, "spine.reorder", { action: "spine.reorder", ...res });
    return;
  }

  if (action === "transform") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    const res = transformSpineClip({
      workspaceDir,
      clipId,
      xPct: strFlag(flags, "x"),
      yPct: strFlag(flags, "y"),
      scale: strFlag(flags, "scale"),
      scaleX: strFlag(flags, "scale-x"),
      scaleY: strFlag(flags, "scale-y"),
      rotationDeg: strFlag(flags, "rotation"),
      opacity: strFlag(flags, "opacity"),
      fitMode: strFlag(flags, "fit") as SpatialPlacement["fit_mode"] | undefined,
      mirrorX: boolFlag(flags, "mirror-x"),
      mirrorY: boolFlag(flags, "mirror-y"),
      edge: strFlag(flags, "edge") as SpatialPlacement["edge"] | undefined,
    });
    emitEnvelopeJson(workspaceDir, "spine.transform", { action: "spine.transform", ...res });
    return;
  }

  if (action === "speed") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const rateRaw = strFlag(flags, "rate");
    const rampRaw = strFlag(flags, "ramp");
    if (!clipId || (!rateRaw && rampRaw === undefined)) {
      throw new Error('Provide --clip <sp_XX> --rate <1.5> or --ramp "0s:1,2s:4".');
    }
    const rampIsNone = rampRaw !== undefined && rampRaw.trim().toLowerCase() === "none";
    if (rateRaw && rampRaw !== undefined && !rampIsNone) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_SPEED_RAMP(
          `'--rate ${rateRaw}' and '--ramp ${rampRaw}' were given together; the base rate has no effect while a ramp is set.`
        )
      );
    }
    const rate = rateRaw ? Number(rateRaw.replace(/x$/i, "")) : undefined;
    const speedRamp =
      rampRaw === undefined ? undefined : rampIsNone ? null : parseSpeedRampFlag(rampRaw);
    const res = setSpineSpeed({
      workspaceDir,
      clipId,
      rate,
      speedRamp,
      preservePitch: boolFlag(flags, "preserve-pitch"),
    });
    emitEnvelopeJson(workspaceDir, "spine.speed", { action: "spine.speed", ...res });
    return;
  }

  if (action === "transition") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    const kind = strFlag(flags, "kind", "dissolve")!;
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    const durRaw = strFlag(flags, "duration", "400ms")!;
    const { easing, bezier } = parseEasingFlag(strFlag(flags, "easing", "ease_in_out"), { allowHold: kind === "none", subject: clipId });
    const rawParamsJson = strFlag(flags, "params");
    const rawSingleParam = strFlag(flags, "param");
    let transitionParams: Record<string, string> | undefined;
    if (rawParamsJson) {
      const parsed = parseJsonFlag(rawParamsJson, {
        command: "spine transition",
        flag: "params",
        kind: "object",
        fixCommand: jsonFixCommand("spine transition", "params", `--clip ${clipId}`),
      }) as Record<string, unknown>;
      transitionParams = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") transitionParams[k] = String(v);
        else throw new Error(`Value of '${k}' in --params must be a scalar (number, string or boolean).`);
      }
    }
    if (rawSingleParam) {
      transitionParams = transitionParams ?? {};
      for (const piece of rawSingleParam.split(",")) {
        const eq = piece.indexOf("=");
        const key = (eq >= 0 ? piece.slice(0, eq) : piece).trim();
        const value = eq >= 0 ? piece.slice(eq + 1) : "";
        if (!key || eq < 0) throw new Error(`--param must be name=value (got '${piece.trim()}'). Separate several params with commas: --param direction=left,speed=2.`);
        transitionParams[key] = value;
      }
    }
    const transition: TransitionSpec | null =
      kind === "none"
        ? null
        : {
            kind: kind as TransitionSpec["kind"],
            duration_ms: parseTimeMs(durRaw),
            easing,
            ...(bezier ? { bezier: [...bezier] } : {}),
            ...(transitionParams ? { params: transitionParams } : {}),
          };
    const res = setSpineTransition({ workspaceDir, clipId, transition });
    emitEnvelopeJson(workspaceDir, "spine.transition", { action: "spine.transition", ...res });
    return;
  }

  if (action === "grade") {
    const clipId = strFlag(flags, "clip") ?? rest[0];
    if (!clipId) throw new Error("Provide --clip <sp_XX>.");
    const brightnessRaw = strFlag(flags, "brightness");
    const contrastRaw = strFlag(flags, "contrast");
    const saturationRaw = strFlag(flags, "saturation");
    const temperatureRaw = strFlag(flags, "temperature");
    const lutRaw = strFlag(flags, "lut");
    if (
      brightnessRaw === undefined &&
      contrastRaw === undefined &&
      saturationRaw === undefined &&
      temperatureRaw === undefined &&
      lutRaw === undefined
    ) {
      throw new Error(
        "Provide at least one of --brightness, --contrast, --saturation, --temperature, --lut (use --lut none to clear)."
      );
    }
    const { setSpineGrade } = await import("./sequence/spine_grade.js");
    const res = setSpineGrade({
      workspaceDir,
      clipId,
      brightness: brightnessRaw !== undefined ? Number(brightnessRaw) : undefined,
      contrast: contrastRaw !== undefined ? Number(contrastRaw) : undefined,
      saturation: saturationRaw !== undefined ? Number(saturationRaw) : undefined,
      temperatureK: temperatureRaw !== undefined ? Number(temperatureRaw) : undefined,
      lutUri:
        lutRaw !== undefined
          ? lutRaw.trim().toLowerCase() === "none"
            ? null
            : lutRaw
          : undefined,
    });
    emitEnvelopeJson(workspaceDir, "spine.grade", { action: "spine.grade", ...res });
    return;
  }

  if (action === "envelope" && rest[0] === "point") {
    const sub = rest[1];
    if (sub !== "add" && sub !== "move" && sub !== "remove") {
      throw new Error("Provide a subcommand: spine envelope point [add|move|remove] --clip <sp_XX|cue_XX> ...");
    }
    const targetId =
      strFlag(flags, "clip") ?? strFlag(flags, "id") ?? strFlag(flags, "item") ?? rest[2];
    const parameter = strFlag(flags, "param") as ParameterEnvelope["parameter"] | undefined;
    if (!targetId || !parameter) {
      throw new Error("Provide --clip <sp_XX|cue_XX> --param <name>.");
    }
    const { easing, bezier } = parseEasingFlag(strFlag(flags, "easing", "linear"));
    const resolveLocalMs = (raw: string | undefined, what: string): number => {
      const beatRaw = strFlag(flags, "beat");
      const beatsOf = strFlag(flags, "beats-of");
      if (beatRaw !== undefined || beatsOf !== undefined) {
        if (beatRaw === undefined || beatsOf === undefined) {
          throw new Error("Provide both --beat <n> and --beats-of <aud_XX>.");
        }
        const { sequence, paths } = loadSequence(workspaceDir);
        const item = sequence.library.find((x) => x.handle === beatsOf);
        const ledger = new MediaLedger(paths.ledgerFile);
        const cached = item
          ? ledger.getBeats<BeatAnalysisResult>(item.digest_sha256, 1.35)
          : null;
        const local = beatToLocalMs({
          seq: sequence,
          targetId,
          beat: Number(beatRaw),
          beatsOf,
          gridMs: cached?.grid_ms ?? null,
        });
        void raw;
        return local;
      }
      if (raw === undefined) throw new Error(`Provide ${what}.`);
      const t = parseTimeMs(raw);
      if (boolFlag(flags, "sequence-time", false)) {
        const { sequence } = loadSequence(workspaceDir);
        return Math.round(sequenceTimeToLocalMs(sequence, targetId, t));
      }
      return t;
    };
    if (sub === "add") {
      const pointsFile = strFlag(flags, "points-file");
      if (pointsFile !== undefined) {
        const res = addEnvelopePointsFromFile({
          workspaceDir,
          targetId,
          parameter,
          pointsFile,
          sequenceTime: boolFlag(flags, "sequence-time", false) ?? false,
        });
        emitEnvelopeJson(workspaceDir, "spine.envelope.point.add", {
          action: "spine.envelope.point.add",
          ...res,
        });
        return;
      }
      const localMs = resolveLocalMs(strFlag(flags, "at"), "--at <t>");
      const valueRaw = strFlag(flags, "value");
      const res = addEnvelopePoint({
        workspaceDir,
        targetId,
        parameter,
        offsetMs: localMs,
        value: valueRaw !== undefined ? Number(valueRaw) : undefined,
        easing,
        ...(bezier ? { bezier: [...bezier] } : {}),
      });
      emitEnvelopeJson(workspaceDir, "spine.envelope.point.add", {
        action: "spine.envelope.point.add",
        ...res,
      });
      return;
    }
    if (sub === "move") {
      const fromRaw = strFlag(flags, "at") ?? strFlag(flags, "from");
      const toRaw = strFlag(flags, "to");
      if (fromRaw === undefined || toRaw === undefined) {
        throw new Error("Provide --at <t> (or --from <t>) and --to <t>.");
      }
      const fromMs = (() => {
        const t = parseTimeMs(fromRaw);
        if (boolFlag(flags, "sequence-time", false)) {
          const { sequence } = loadSequence(workspaceDir);
          return Math.round(sequenceTimeToLocalMs(sequence, targetId, t));
        }
        return t;
      })();
      const toMs = (() => {
        const t = parseTimeMs(toRaw);
        if (boolFlag(flags, "sequence-time", false)) {
          const { sequence } = loadSequence(workspaceDir);
          return Math.round(sequenceTimeToLocalMs(sequence, targetId, t));
        }
        return t;
      })();
      const valueRaw = strFlag(flags, "value");
      const res = moveEnvelopePoint({
        workspaceDir,
        targetId,
        parameter,
        fromMs,
        toMs,
        value: valueRaw !== undefined ? Number(valueRaw) : undefined,
        easing,
        ...(bezier ? { bezier: [...bezier] } : {}),
      });
      emitEnvelopeJson(workspaceDir, "spine.envelope.point.move", {
        action: "spine.envelope.point.move",
        ...res,
      });
      return;
    }
    const localMs = resolveLocalMs(strFlag(flags, "at"), "--at <t>");
    const res = removeEnvelopePoint({ workspaceDir, targetId, parameter, offsetMs: localMs });
    emitEnvelopeJson(workspaceDir, "spine.envelope.point.remove", {
      action: "spine.envelope.point.remove",
      ...res,
    });
    return;
  }

  if (action === "value") {
    const targetId =
      strFlag(flags, "item") ?? strFlag(flags, "clip") ?? strFlag(flags, "id") ?? rest[0];
    const parameter = strFlag(flags, "param");
    const atRaw = strFlag(flags, "at");
    if (!targetId || !parameter || !atRaw) {
      throw new Error("Provide --item <sp_XX|cue_XX> --param <name> --at <t>.");
    }
    let localMs = parseTimeMs(atRaw);
    if (boolFlag(flags, "sequence-time", false)) {
      const { sequence } = loadSequence(workspaceDir);
      localMs = Math.round(sequenceTimeToLocalMs(sequence, targetId, localMs));
    }
    const res = readEnvelopeValueAt({ workspaceDir, targetId, parameter, localMs });
    emitEnvelopeJson(workspaceDir, "spine.value", {
      action: "spine.value",
      item: targetId,
      param: parameter,
      at_ms: Math.round(localMs),
      ...res,
    });
    return;
  }

  if (action === "envelope") {
    const targetId = strFlag(flags, "item") ?? strFlag(flags, "clip") ?? strFlag(flags, "id") ?? rest[0];
    const parameter = strFlag(flags, "param") as ParameterEnvelope["parameter"] | undefined;
    const ptsRaw = strFlag(flags, "points");
    if (!targetId || !parameter || !ptsRaw) {
      throw new Error("Provide --clip <sp_XX|cue_XX> --param <name> --points <0ms:1.0,2000ms:1.15>.");
    }
    const { easing: defaultEasing, bezier: defaultBezier } =
      parseEasingFlag(strFlag(flags, "easing", "ease_in_out"));
    const points: ParameterEnvelopePoint[] = ptsRaw.split(",").map((token) => {
      const [tStr, vStr] = token.trim().split(":");
      return {
        offset_ms: parseTimeMs(tStr),
        value: Number(vStr),
        easing: defaultEasing,
        ...(defaultBezier ? { bezier: [...defaultBezier] } : {}),
      };
    });
    const res = setItemEnvelope({ workspaceDir, targetId, parameter, points });
    emitEnvelopeJson(workspaceDir, "spine.envelope", { action: "spine.envelope", ...res });
    return;
  }

  if (action === "reframe") {
    const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
    const clipIds =
      boolFlag(flags, "all-spine", false) || !clipsRaw
        ? undefined
        : clipsRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    const mode = (strFlag(flags, "mode", "subject_track") ?? "subject_track") as
      | "subject_track"
      | "center_lock"
      | "off";
    const ptsRaw = strFlag(flags, "points") ?? strFlag(flags, "focal-points");
    const manualPoints = ptsRaw
      ? ptsRaw.split(",").map((token) => {
          const trimmed = token.trim();
          const sepIdx = trimmed.lastIndexOf(":");
          if (sepIdx <= 0) {
            throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(trimmed));
          }
          const tStr = trimmed.slice(0, sepIdx).trim();
          const vStr = trimmed.slice(sepIdx + 1).trim();
          const val = Number(vStr.replace(/%$/, ""));
          if (!Number.isFinite(val)) {
            throw new CutholError(DIAGNOSTICS.INVALID_TIME_LITERAL(trimmed));
          }
          return {
            offset_ms: parseTimeMs(tStr),
            center_x_pct: val,
          };
        })
      : undefined;
    const fixedXRaw = strFlag(flags, "x");
    const fixedCenterXPct =
      fixedXRaw !== undefined ? Number(fixedXRaw.replace(/%$/, "")) : undefined;
    const { reframeSpineClips } = await import("./sequence/spine_reframe.js");
    const res = reframeSpineClips({
      workspaceDir,
      clipIds,
      mode,
      deadbandPct: numFlag(flags, "deadband"),
      fixedCenterXPct: Number.isFinite(fixedCenterXPct) ? fixedCenterXPct : undefined,
      manualPoints,
      replaceManualPoints: boolFlag(flags, "replace", false),
      sampleFps: numFlag(flags, "fps"),
      dryRun: boolFlag(flags, "dry-run", false),
    });
    emitEnvelopeJson(workspaceDir, "spine.reframe", { action: "spine.reframe", ...res });
    return;
  }

  if (action === "mute" || action === "unmute") {
    const clipsRaw = strFlag(flags, "clips") ?? strFlag(flags, "clip") ?? rest[0];
    const allSpineFlag = boolFlag(flags, "all-spine", false) || !clipsRaw;
    const clipIds = allSpineFlag
      ? undefined
      : clipsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    const mutedVal =
      action === "unmute"
        ? false
        : boolFlag(flags, "muted", true) ?? true;
    const res = setSpineMute({
      workspaceDir,
      clipIds,
      allSpine: allSpineFlag,
      muted: mutedVal,
    });
    const cmdName = mutedVal ? "spine.mute" : "spine.unmute";
    emitEnvelopeJson(workspaceDir, cmdName, { action: cmdName, ...res });
    return;
  }
  if (action === "mask" || action === "motion-blur") {
    const { runSpineTreatmentCommand } = await import("./cli_cmd_spine_treatments.js");
    return runSpineTreatmentCommand(ctx);
  }
  if (action === "fx") {
    const sub = rest[0];
    if (sub === "catalog") {
      const { sequence } = loadSequence(workspaceDir);
      const defs = listEffectDefinitions(sequence, { rootDir: workspaceDir });
      const lines = defs.map((d) => {
        const params = Object.entries(d.params)
          .map(
            ([k, p]) =>
              `${k}:${p.type}${p.min !== undefined || p.max !== undefined ? `[${p.min ?? ""}..${p.max ?? ""}]` : ""}${p.default !== undefined ? `=${String(p.default)}` : ""}`
          )
          .join(",");
        return `${d.kind} role=${d.role} backend=${d.backend} alpha=${d.alpha ?? "keep"} live=${d.live} animatable=[${d.animatable.join(",")}] params={${params}}`;
      });
      // One line per effect by default (agents, MCP); full definitions with --full.
      emitEnvelopeJson(
        workspaceDir,
        "spine.fx.catalog",
        boolFlag(flags, "full", false) === true
          ? { action: "spine.fx.catalog", effects: defs }
          : { action: "spine.fx.catalog", effects: lines }
      );
      return;
    }
    if (sub === "check") {
      if (boolFlag(flags, "full", false) === true) {
        await runSpineFxCheckFull(workspaceDir, {
          kind: strFlag(flags, "kind"),
          filter: strFlag(flags, "filter"),
        });
        return;
      }
      runSpineFxCheck(workspaceDir, {
        kind: strFlag(flags, "kind"),
        item: strFlag(flags, "item") ?? strFlag(flags, "clip"),
        filter: strFlag(flags, "filter"),
      });
      return;
    }
    if (sub === "try") {
      await runSpineFxTry(workspaceDir, {
        kind: strFlag(flags, "kind"),
        filter: strFlag(flags, "filter"),
        params: collectSpineFxParams(flags, "spine fx try"),
        sweep: strFlag(flags, "sweep"),
        at: strFlag(flags, "at"),
        on: strFlag(flags, "on"),
        out: strFlag(flags, "out"),
      });
      return;
    }
    if (sub === "preset") {
      runSpineFxPreset(workspaceDir, flags);
      return;
    }
    if (sub !== "add" && sub !== "set" && sub !== "remove" && sub !== "list") {
      throw new Error("Provide a subcommand: spine fx [catalog|add|set|remove|list|check|try|preset] --item <sp_XX|cue_XX> ...");
    }
    const item = strFlag(flags, "item") ?? strFlag(flags, "clip");
    if (!item) throw new Error("Provide --item <sp_XX|cue_XX>.");
    if (sub === "add") {
      const kind = strFlag(flags, "kind");
      const filter = strFlag(flags, "filter");
      const res = addSpineFx({ workspaceDir, item, kind, filter, params: collectSpineFxParams(flags, "spine fx add") });
      emitEnvelopeJson(workspaceDir, "spine.fx.add", { action: "spine.fx.add", ...res });
      return;
    }
    if (sub === "set") {
      const fxId = strFlag(flags, "fx") ?? strFlag(flags, "id");
      if (!fxId) throw new Error("Provide --fx <fx_XX>.");
      const filter = strFlag(flags, "filter");
      const params = collectSpineFxParams(flags, "spine fx set");
      const enabled = boolFlag(flags, "enabled");
      if (filter === undefined && Object.keys(params).length === 0 && enabled === undefined) {
        throw new Error("Provide --param <name=value>, --filter \"<chain>\" or --enabled <true|false>.");
      }
      const res = setSpineFx({ workspaceDir, item, fxId, params, filter, enabled });
      emitEnvelopeJson(workspaceDir, "spine.fx.set", { action: "spine.fx.set", ...res });
      return;
    }
    if (sub === "remove") {
      const fxId = strFlag(flags, "fx") ?? strFlag(flags, "id");
      if (!fxId) throw new Error("Provide --fx <fx_XX>.");
      const res = removeSpineFx({ workspaceDir, item, fxId });
      emitEnvelopeJson(workspaceDir, "spine.fx.remove", { action: "spine.fx.remove", ...res });
      return;
    }
    const res = listSpineFx({ workspaceDir, item });
    const motionGroup =
      res.motion.length === 0
        ? null
        : [
            "motion layers: applied at the geometry stage, after pixel effects, independent of list position",
            ...res.motion.map((m) => {
              const chans = Object.entries(m.channels)
                .map(([c, v]) => `${c}=${v.value}${v.animated ? " (animated)" : ""}`)
                .join(", ");
              return `- ${m.id}${m.enabled ? "" : " (off)"}: ${chans}`;
            }),
          ].join("\n");
    emitEnvelopeJson(workspaceDir, "spine.fx.list", { action: "spine.fx.list", ...res, motion_group: motionGroup });
    return;
  }
  return CLI_NOT_HANDLED;
}
