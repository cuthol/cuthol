// Applying motion presets: one fx entry plus explicit envelope points,
// written as one journal revision through `commitVerifiedMutation` so the
// write-time fx checks run. Recomputing from the provenance record (shared
// by `verify` and `--reapply`) never reads the preset definition again.
import { randomBytes } from "node:crypto";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type {
  ClipFxSpec,
  CutholSequence,
  EffectParamValue,
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpineClip,
} from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import { listEffectDefinitions } from "./effect_registry.js";
import {
  MOTION_EFFECT_DEFINITION,
  MOTION_FX_KIND,
  PLACEMENT_CHANNELS,
  placementLayerIdentity,
  type EffectDefinition,
  type PresetPointRecord,
  type PresetProvenance,
} from "./effect_types.js";
import { beatToLocalMs } from "../sequence/envelope_points.js";
import { allocateFxId, probeEntryOrThrow } from "../sequence/spine_fx.js";
import { commitVerifiedMutation, type VerificationReport } from "../verify/gates.js";
import { resolveExtension } from "../extensions/manager.js";
import { parseExtensionEffectRef } from "../extensions/ext_effects.js";
import {
  generatePresetPoints,
  gridHash,
  type ExtensionPresetSpec,
} from "../extensions/presets.js";
import { MediaLedger } from "../library/ledger.js";
import type { BeatAnalysisResult } from "../library/beats.js";

const PRESET_REF_RE = /^ext:([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_-]*)$/;

export function parsePresetRef(raw: string): { extension: string; name: string } {
  const m = PRESET_REF_RE.exec((raw ?? "").trim());
  if (!m) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(raw, `preset ref must be 'ext:<extension>/<name>' (e.g. 'ext:studio/punch_out').`)
    );
  }
  return { extension: m[1], name: m[2] };
}

export interface ResolvedPreset {
  ref: string;
  extDir: string;
  version: string;
  spec: ExtensionPresetSpec;
}

/** Load the preset spec from its (enabled) extension. ERROR names the preset. */
export function resolvePresetSpec(
  workspaceDir: string,
  seq: CutholSequence,
  presetRef: string
): ResolvedPreset {
  const { extension, name } = parsePresetRef(presetRef);
  const ref = `ext:${extension}/${name}`;
  const enabled = seq.extensions?.some((e) => e.name === extension) ?? false;
  let ext: ReturnType<typeof resolveExtension> | null = null;
  let loadError: unknown = null;
  try {
    ext = resolveExtension(extension, workspaceDir);
  } catch (err) {
    loadError = err;
  }
  if (!ext) {
    const msg = loadError instanceof CutholError ? loadError.diagnostic.what : String(loadError ?? "not found");
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(ref, `extension '${extension}' ${enabled ? `is enabled but could not be loaded: ${msg}` : `is not enabled in this project: ${msg}`} Run 'cuthol extension enable ${extension}'.`)
    );
  }
  if (!enabled) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(ref, `extension '${extension}' is present but not enabled: run 'cuthol extension enable ${extension}'.`)
    );
  }
  const spec = ext.manifest.presets?.[name];
  if (!spec) {
    const names = Object.keys(ext.manifest.presets ?? {});
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(
        ref,
        names.length > 0
          ? `unknown preset '${name}' in extension '${extension}'; available: ${names.map((n) => `ext:${extension}/${n}`).join(", ")}.`
          : `extension '${extension}' defines no presets.`
      )
    );
  }
  return { ref, extDir: ext.dir, version: ext.version, spec };
}

export interface PresetTargetDef {
  kind: string;
  def: EffectDefinition;
  /** channel -> envelope param name. */
  channelParams: Record<string, string>;
}

/** Resolve the entry kind to a motion definition. ERROR names the preset. */
export function resolvePresetTarget(
  seq: CutholSequence,
  workspaceDir: string,
  presetRef: string,
  kind: string
): PresetTargetDef {
  if (kind === MOTION_FX_KIND) {
    const channelParams: Record<string, string> = {};
    for (const c of PLACEMENT_CHANNELS) channelParams[c] = c;
    return { kind, def: MOTION_EFFECT_DEFINITION, channelParams };
  }
  const ref = parseExtensionEffectRef(kind);
  if (!ref) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(presetRef, `entry kind '${kind}' is not "motion" or an extension motion kind.`));
  }
  const def = listEffectDefinitions(seq, { rootDir: workspaceDir }).find((d) => d.kind === kind);
  if (!def || def.role !== "motion" || !def.spine?.channels || def.backend !== "spine") {
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(presetRef, `entry kind '${kind}' is not a motion kind declaring 'spine.channels' in this project.`)
    );
  }
  const channelParams: Record<string, string> = {};
  for (const [channel, param] of Object.entries(def.spine.channels)) {
    if (param) channelParams[channel] = param;
  }
  return { kind, def, channelParams };
}

/** Merge preset param defaults with `--param` overrides. ERROR names the preset. */
export function resolvePresetArgs(
  presetRef: string,
  spec: ExtensionPresetSpec,
  rawArgs: Record<string, unknown>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, pDef] of Object.entries(spec.params ?? {})) {
    if (typeof pDef.default === "number") out[name] = pDef.default;
    else if (typeof pDef.min === "number") out[name] = pDef.min;
    else out[name] = 0;
  }
  for (const [name, raw] of Object.entries(rawArgs)) {
    const pDef = spec.params?.[name];
    if (!pDef) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_PARAM(presetRef, `unknown param '${name}'.`));
    }
    const v = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(v)) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_PARAM(presetRef, `param '${name}' value '${String(raw)}' is not a number.`));
    }
    if (typeof pDef.min === "number" && v < pDef.min) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_PARAM(presetRef, `param '${name}' value ${v} is below min ${pDef.min}.`));
    }
    if (typeof pDef.max === "number" && v > pDef.max) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_PARAM(presetRef, `param '${name}' value ${v} is above max ${pDef.max}.`));
    }
    out[name] = v;
  }
  for (const [name, v] of Object.entries(out)) {
    const pDef = spec.params?.[name];
    if (pDef && typeof pDef.min === "number" && v < pDef.min) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_PARAM(presetRef, `param '${name}' default ${v} is below min ${pDef.min}.`));
    }
    if (pDef && typeof pDef.max === "number" && v > pDef.max) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_PARAM(presetRef, `param '${name}' default ${v} is above max ${pDef.max}.`));
    }
  }
  return out;
}

export interface BeatGridLocal {
  handle: string;
  gridMs: number[];
  localMs: number[];
  hash: string;
}

/** Load the beat grid of `--beats <aud_XX>` converted to item-local ms. */
export function loadBeatGridLocal(
  workspaceDir: string,
  seq: CutholSequence,
  targetId: string,
  beatsHandle: string,
  presetRef: string
): BeatGridLocal {
  const { paths } = loadSequence(workspaceDir);
  const item = seq.library.find((x) => x.handle === beatsHandle);
  if (!item) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(beatsHandle));
  const ledger = new MediaLedger(paths.ledgerFile);
  let cached: BeatAnalysisResult | null;
  try {
    cached = ledger.getBeats<BeatAnalysisResult>(item.digest_sha256, 1.35);
  } finally {
    ledger.close();
  }
  const gridMs = cached?.grid_ms ?? null;
  if (!gridMs || gridMs.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.PRESET_UNKNOWN(presetRef, `asset '${beatsHandle}' has no beat grid: run 'library beats' for it first.`)
    );
  }
  const localMs = gridMs.map((_, i) =>
    beatToLocalMs({ seq, targetId, beat: i + 1, beatsOf: beatsHandle, gridMs })
  );
  return { handle: beatsHandle, gridMs, localMs, hash: gridHash(gridMs) };
}

export interface GeneratedPresetEnvelope {
  parameter: `fx.${string}.${string}`;
  points: ParameterEnvelopePoint[];
}

function buildEnvelopes(
  fxId: string,
  target: PresetTargetDef,
  channels: Record<string, Array<{ offsetMs: number; value: number; easing?: ParameterEnvelopePoint["easing"]; bezier?: ParameterEnvelopePoint["bezier"] }>>,
  presetRef: string
): GeneratedPresetEnvelope[] {
  const out: GeneratedPresetEnvelope[] = [];
  for (const [channel, pts] of Object.entries(channels)) {
    const param = target.channelParams[channel];
    if (!param) {
      throw new CutholError(DIAGNOSTICS.PRESET_BAD_CHANNEL(presetRef, channel));
    }
    if (!target.def.animatable.includes(param)) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_BAD_CHANNEL(presetRef, `${channel} (param '${param}' of kind '${target.kind}' is not animatable)`)
      );
    }
    const pDef = target.def.params[param];
    const seen = new Map<number, ParameterEnvelopePoint>();
    for (const p of pts) {
      const v = p.value;
      if (typeof pDef?.min === "number" && v < pDef.min - 1e-9) {
        throw new CutholError(DIAGNOSTICS.PRESET_VALUE_OUT_OF_RANGE(presetRef, channel, v));
      }
      if (typeof pDef?.max === "number" && v > pDef.max + 1e-9) {
        throw new CutholError(DIAGNOSTICS.PRESET_VALUE_OUT_OF_RANGE(presetRef, channel, v));
      }
      seen.set(p.offsetMs, {
        offset_ms: p.offsetMs,
        value: v,
        easing: p.easing ?? "linear",
        ...(p.bezier ? { bezier: [...p.bezier] as [number, number, number, number] } : {}),
      });
    }
    const points = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, pt]) => pt);
    out.push({ parameter: `fx.${fxId}.${param}`, points });
  }
  out.sort((a, b) => (a.parameter < b.parameter ? -1 : 1));
  return out;
}

function defaultEntryParams(target: PresetTargetDef): Record<string, EffectParamValue> {
  const out: Record<string, EffectParamValue> = {};
  for (const [name, pDef] of Object.entries(target.def.params)) {
    if (typeof pDef.default === "number" || typeof pDef.default === "string" || typeof pDef.default === "boolean") {
      out[name] = pDef.default;
    }
  }
  return out;
}

/** Estimated extra render text for the >150-point WARN (draft_480p slope, two channels). */
export function estimatePresetCostExtra(maxPointsPerChannel: number, durationMs: number): string {
  const extraSec = 0.16 * maxPointsPerChannel * (durationMs / 60000);
  if (extraSec < 60) return `~${Math.max(1, Math.round(extraSec))} s`;
  return `~${Math.round(extraSec / 60)} min`;
}

export interface ApplyPresetResult {
  fx: ClipFxSpec;
  item: string;
  revision: number;
  verification: VerificationReport;
  warnings: Array<{ code: string; what: string; suggestion: string }>;
  pointsPerChannel: Record<string, number>;
}

export function applyPresetSpineFx(options: {
  workspaceDir: string;
  item: string;
  preset: string;
  params?: Record<string, unknown>;
  beats?: string;
}): ApplyPresetResult {
  const { workspaceDir, item: targetId, preset: presetRef } = options;
  const { sequence: preSeq } = loadSequence(workspaceDir);
  const isCue = preSeq.lanes.some((l) => l.cues.some((c) => c.id === targetId));
  if (isCue) throw new CutholError(DIAGNOSTICS.PRESET_LANE_CUE(targetId));
  const clip = preSeq.spine.clips.find((c) => c.id === targetId);
  if (!clip) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(targetId));

  const { spec, version } = resolvePresetSpec(workspaceDir, preSeq, presetRef);
  const entry = spec.entries[0];
  const target = resolvePresetTarget(preSeq, workspaceDir, presetRef, entry.kind);
  const args = resolvePresetArgs(presetRef, spec, options.params ?? {});
  const durationMs = clip.duration_ms;
  let beats: BeatGridLocal | null = null;
  if (spec.repeat?.every === "beat") {
    if (!options.beats) throw new CutholError(DIAGNOSTICS.PRESET_BEATS_MISSING(presetRef));
    beats = loadBeatGridLocal(workspaceDir, preSeq, targetId, options.beats, presetRef);
  }
  const generated = generatePresetPoints({
    preset: presetRef,
    spec,
    args,
    durationMs,
    beatsLocalMs: beats?.localMs ?? null,
    beatsAsset: beats?.handle,
    beatsGridHash: beats ? gridHash(beats.gridMs) : undefined,
  });
  const fxId = allocateFxId(clip.fx);
  const envelopes = buildEnvelopes(fxId, target, generated.channels, presetRef);

  probeEntryOrThrow(preSeq, workspaceDir, targetId, {
    id: fxId,
    kind: target.kind,
    params: defaultEntryParams(target),
  } as ClipFxSpec, envelopes.map((e) => ({ parameter: e.parameter, points: e.points.map((p) => ({ value: p.value })) })));

  const maxPoints = Math.max(0, ...envelopes.map((e) => e.points.length));
  const warnings: ApplyPresetResult["warnings"] = [];
  if (maxPoints > 150) {
    const extra = estimatePresetCostExtra(maxPoints, durationMs);
    const diag = DIAGNOSTICS.PRESET_TOO_MANY_POINTS(presetRef, maxPoints, extra);
    warnings.push({ code: "CUTHOL-G368", what: diag.what, suggestion: diag.suggestion });
  }

  const applyId = `ap_${randomBytes(8).toString("hex")}`;
  const records: PresetPointRecord[] = generated.records;
  const provenance: PresetProvenance = {
    preset: presetRef,
    version,
    args,
    apply_id: applyId,
    points: records,
    ...(generated.beats || beats ? { beats: generated.beats ?? { asset_handle: beats!.handle, grid_hash: beats!.hash } } : {}),
  };

  const { result, revision, verification } = commitVerifiedMutation(
    workspaceDir,
    `spine.fx.preset(${targetId},${presetRef})`,
    (seq) => {
      const target2 = seq.spine.clips.find((c) => c.id === targetId);
      if (!target2) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(targetId));
      const newEntry: ClipFxSpec = {
        id: fxId,
        kind: target.kind,
        params: defaultEntryParams(target),
        preset: provenance,
      };
      target2.fx = [...(target2.fx ?? []), newEntry];
      const ownerEnvelopes = target2.envelopes ?? [];
      for (const env of envelopes) {
        const idx = ownerEnvelopes.findIndex((e) => e.parameter === env.parameter);
        const stored: ParameterEnvelope = {
          parameter: env.parameter as ParameterEnvelope["parameter"],
          points: env.points,
        };
        if (idx === -1) ownerEnvelopes.push(stored);
        else ownerEnvelopes[idx] = stored;
      }
      target2.envelopes = ownerEnvelopes;
      return structuredClone(newEntry);
    }
  );
  const pointsPerChannel: Record<string, number> = {};
  for (const e of envelopes) pointsPerChannel[e.parameter] = e.points.length;
  return { fx: result, item: targetId, revision, verification, warnings, pointsPerChannel };
}

// --- recompute + reapply (record only, never the preset definition) ---

export interface ExpectedPresetPoint {
  channel: string;
  param: string;
  offsetMs: number;
  value: number;
  easing?: ParameterEnvelopePoint["easing"];
  bezier?: [number, number, number, number];
}

/**
 * Expected envelope points for one preset entry with the item's current
 * duration (and the current beat grid). Throws PRESET_UNKNOWN when a needed
 * beat grid is missing; returns null when the entry's target kind no longer
 * resolves (caller treats it as silent).
 */
export interface RecomputedPresetPoints {
  points: ExpectedPresetPoint[];
  /** Set when the current grid no longer resolves a recorded beat (gate warns, reapply refuses). */
  unresolvable: string | null;
}

export function recomputePresetPoints(options: {
  workspaceDir: string;
  seq: CutholSequence;
  clip: SpineClip;
  entry: ClipFxSpec;
}): RecomputedPresetPoints | null {
  const { workspaceDir, seq, clip, entry } = options;
  const prov = entry.preset;
  if (!prov) return null;
  let target: PresetTargetDef | null = null;
  try {
    target = resolvePresetTarget(seq, workspaceDir, prov.preset, entry.kind);
  } catch {
    return null;
  }
  let beatsLocal: number[] | null = null;
  if (prov.points.some((p) => p.anchor === "beat")) {
    if (!prov.beats) return null;
    try {
      const grid = loadBeatGridLocal(workspaceDir, seq, clip.id, prov.beats.asset_handle, prov.preset);
      beatsLocal = grid.localMs;
    } catch {
      return null;
    }
  }
  const out: ExpectedPresetPoint[] = [];
  for (const rec of prov.points) {
    const param = target.channelParams[rec.channel];
    if (!param) return null;
    let offsetMs: number;
    if (rec.anchor === "start") offsetMs = rec.offset_ms ?? 0;
    else if (rec.anchor === "end") offsetMs = clip.duration_ms - (rec.offset_ms ?? 0);
    else if (rec.anchor === "ratio") offsetMs = (clip.duration_ms * (rec.ratio ?? 0)) / 100;
    else {
      if (!beatsLocal || rec.beat_index === undefined || rec.beat_index < 1) return null;
      if (rec.beat_index > beatsLocal.length) {
        return {
          points: [],
          unresolvable: `beat ${rec.beat_index} of '${prov.beats?.asset_handle}' no longer resolves (grid now has ${beatsLocal.length} beats)`,
        };
      }
      offsetMs = beatsLocal[rec.beat_index - 1] + (rec.offset_ms ?? 0);
    }
    offsetMs = Math.round(offsetMs);
    // Same skip rule as generation: repetition points that fall outside the
    // clip are dropped, so a moved cue reads as drift, not as silence.
    if (offsetMs < 0 || offsetMs > clip.duration_ms) continue;
    out.push({
      channel: rec.channel,
      param,
      offsetMs,
      value: rec.value,
      ...(rec.easing !== undefined ? { easing: rec.easing as ParameterEnvelopePoint["easing"] } : {}),
      ...(rec.bezier !== undefined ? { bezier: [...rec.bezier] } : {}),
    });
  }
  return { points: out, unresolvable: null };
}

/** Compare expected points with the entry's actual envelopes. Null = match. */
export function diffPresetPoints(
  clip: SpineClip,
  fxId: string,
  expected: ExpectedPresetPoint[]
): string | null {
  const byParam = new Map<string, ExpectedPresetPoint[]>();
  for (const p of expected) {
    const list = byParam.get(p.param) ?? [];
    list.push(p);
    byParam.set(p.param, list);
  }
  const problems: string[] = [];
  for (const [param, exp] of byParam) {
    const channel = exp[0].channel;
    const env = clip.envelopes?.find((e) => e.parameter === `fx.${fxId}.${param}`);
    const actual = [...(env?.points ?? [])].sort((a, b) => a.offset_ms - b.offset_ms);
    const want = [...exp].sort((a, b) => a.offsetMs - b.offsetMs);
    const seen = new Map<number, ExpectedPresetPoint>();
    for (const w of want) seen.set(w.offsetMs, w);
    const wantDeduped = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
    if (actual.length !== wantDeduped.length) {
      problems.push(
        `${channel}: expected ${wantDeduped.length} points [${wantDeduped.map((w) => w.offsetMs).join(",")}] but found ${actual.length} [${actual.map((p) => p.offset_ms).join(",")}]`
      );
      continue;
    }
    for (let i = 0; i < wantDeduped.length; i++) {
      const w = wantDeduped[i];
      const a = actual[i];
      if (a.offset_ms !== w.offsetMs) {
        problems.push(`${channel}: point ${i} at ${a.offset_ms} ms, anchor expects ${w.offsetMs} ms`);
        break;
      }
      if (Math.abs(a.value - w.value) > 1e-9) {
        problems.push(`${channel}: value at ${a.offset_ms} ms is ${a.value}, anchor expects ${w.value}`);
        break;
      }
      const wantEasing = w.easing ?? "linear";
      if (a.easing !== wantEasing) {
        problems.push(`${channel}: easing at ${a.offset_ms} ms is ${a.easing}, anchor expects ${wantEasing}`);
        break;
      }
      const wb = w.bezier ? JSON.stringify(w.bezier) : "";
      const ab = a.bezier ? JSON.stringify(a.bezier) : "";
      if (wb !== ab) {
        problems.push(`${channel}: bezier at ${a.offset_ms} ms differs from the anchor`);
        break;
      }
    }
    if (problems.length > 2) break;
  }
  if (problems.length === 0) return null;
  return problems.slice(0, 2).join("; ");
}

export interface ReapplyPresetResult {
  item: string;
  fxIds: string[];
  revision: number;
  verification: VerificationReport;
}

export function reapplyPresetEntries(options: {
  workspaceDir: string;
  item: string;
  fxId?: string;
  all?: boolean;
}): ReapplyPresetResult {
  const { workspaceDir, item: targetId } = options;
  if (!options.fxId && !options.all) throw new Error("Provide --fx <fx_XX> or --reapply --all.");
  const { sequence: preSeq } = loadSequence(workspaceDir);
  const clip = preSeq.spine.clips.find((c) => c.id === targetId);
  if (!clip) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(targetId));
  const entries = (clip.fx ?? []).filter((f) => f.preset);
  if (entries.length === 0) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(`--reapply on ${targetId}`, `item '${targetId}' has no preset-written fx entries.`));
  }
  const picked = options.all ? entries : entries.filter((f) => f.id === options.fxId);
  if (picked.length === 0) {
    throw new CutholError(DIAGNOSTICS.PRESET_UNKNOWN(`--reapply on ${targetId}`, `fx '${options.fxId}' on '${targetId}' has no preset record.`));
  }
  const recomputed = new Map<string, ExpectedPresetPoint[]>();
  for (const e of picked) {
    const rec = recomputePresetPoints({ workspaceDir, seq: preSeq, clip, entry: e });
    if (!rec) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(
          e.preset?.preset ?? e.id,
          `fx '${e.id}' cannot be reapplied with the current project state (beat grid or target kind no longer resolves).`
        )
      );
    }
    if (rec.unresolvable) {
      throw new CutholError(
        DIAGNOSTICS.PRESET_UNKNOWN(
          e.preset?.preset ?? e.id,
          `fx '${e.id}' cannot be reapplied: ${rec.unresolvable}.`
        )
      );
    }
    recomputed.set(e.id, rec.points);
  }
  const { revision, verification } = commitVerifiedMutation(
    workspaceDir,
    `spine.fx.preset.reapply(${targetId},${picked.map((e) => e.id).join("+")})`,
    (seq) => {
      const target2 = seq.spine.clips.find((c) => c.id === targetId);
      if (!target2) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(targetId));
      for (const [fxId, exp] of recomputed) {
        const byParam = new Map<string, ExpectedPresetPoint[]>();
        for (const p of exp) {
          const list = byParam.get(p.param) ?? [];
          list.push(p);
          byParam.set(p.param, list);
        }
        for (const [param, pts] of byParam) {
          const seen = new Map<number, ParameterEnvelopePoint>();
          for (const p of pts) {
            seen.set(p.offsetMs, {
              offset_ms: p.offsetMs,
              value: p.value,
              easing: p.easing ?? "linear",
              ...(p.bezier ? { bezier: [...p.bezier] as [number, number, number, number] } : {}),
            });
          }
          const stored: ParameterEnvelope = {
            parameter: `fx.${fxId}.${param}`,
            points: [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, pt]) => pt),
          };
          const envs = target2.envelopes ?? [];
          const idx = envs.findIndex((e) => e.parameter === stored.parameter);
          if (idx === -1) envs.push(stored);
          else envs[idx] = stored;
          target2.envelopes = envs;
        }
      }
    }
  );
  return { item: targetId, fxIds: picked.map((e) => e.id), revision, verification };
}

// --- split/excise helper: drop records whose generated points were sliced ---

function recordOriginalOffset(
  rec: PresetPointRecord,
  origDurationMs: number,
  beatLocal: Map<string, number[]>,
  beatsHandle: string | undefined
): number | null {
  if (rec.anchor === "start") return rec.offset_ms ?? 0;
  if (rec.anchor === "end") return origDurationMs - (rec.offset_ms ?? 0);
  if (rec.anchor === "ratio") return (origDurationMs * (rec.ratio ?? 0)) / 100;
  if (beatsHandle === undefined || rec.beat_index === undefined) return null;
  const arr = beatLocal.get(beatsHandle);
  if (!arr || rec.beat_index < 1 || rec.beat_index > arr.length) return null;
  return arr[rec.beat_index - 1] + (rec.offset_ms ?? 0);
}

/**
 * After `sliceEnvelopes` created a sub-clip, drop the `preset` record on
 * entries whose generated points were sliced away; entries keeping every
 * generated point (shifted) keep the record. Trims never call this, so a
 * trim that cuts generated points keeps the record and `verify` warns.
 */
export function dropSlicedPresetRecords(options: {
  workspaceDir: string;
  seq: CutholSequence;
  origClip: SpineClip;
  subClip: SpineClip;
  sliceStartMs: number;
  sliceEndMs: number;
}): void {
  const { workspaceDir, seq, origClip, subClip, sliceStartMs, sliceEndMs } = options;
  const withPreset = (subClip.fx ?? []).filter((f) => f.preset);
  if (withPreset.length === 0) return;
  const origDurationMs = origClip.duration_ms;
  const beatLocal = new Map<string, number[]>();
  const beatHandles = new Set<string>();
  for (const f of withPreset) {
    if (f.preset?.beats) beatHandles.add(f.preset.beats.asset_handle);
  }
  for (const h of beatHandles) {
    try {
      beatLocal.set(h, loadBeatGridLocal(workspaceDir, seq, origClip.id, h, withPreset[0].preset?.preset ?? h).localMs);
    } catch {
      beatLocal.set(h, []);
    }
  }
  for (const entry of withPreset) {
    const prov = entry.preset as PresetProvenance;
    let keep = true;
    for (const rec of prov.points) {
      const orig = recordOriginalOffset(rec, origDurationMs, beatLocal, prov.beats?.asset_handle);
      if (orig === null || orig < sliceStartMs - 0.5 || orig > sliceEndMs + 0.5) {
        keep = false;
        break;
      }
      const want = Math.round(orig - sliceStartMs);
      const hit = (subClip.envelopes ?? []).some(
        (e) =>
          e.parameter.startsWith(`fx.${entry.id}.`) &&
          e.points.some((p) => p.offset_ms === want && Math.abs(p.value - rec.value) < 1e-9)
      );
      if (!hit) {
        keep = false;
        break;
      }
    }
    if (!keep) delete (entry as { preset?: PresetProvenance }).preset;
  }
}

export function presetProvenanceOf(entry: ClipFxSpec): PresetProvenance | undefined {
  return entry.preset;
}

export { PLACEMENT_CHANNELS as PRESET_MOTION_CHANNELS, placementLayerIdentity as presetIdentity };
