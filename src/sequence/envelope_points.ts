// Single-keyframe edits on spine and cue envelopes (split out of spine_edit.ts).
// add|move|remove one point at a time; journaled and undoable like envelope.set.
// All stored offsets are clip-local milliseconds; other clocks convert on write.
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type {
  CutholSequence,
  LaneCue,
  ParameterEnvelope,
  ParameterEnvelopePoint,
  SpineClip,
} from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import type { VerificationReport } from "../verify/gates.js";
import { commitVerifiedMutation } from "../verify/gates.js";
import { probeEntryOrThrow } from "./spine_fx.js";
import { buildItemFxStage, flattenFxStageParts } from "../compositor/compile_fx_stage.js";
import { checkFrozenParam, fxEntryFilterName } from "../effects/fx_check.js";
import { listEffectDefinitions } from "../effects/effect_registry.js";
import { isKnownEnvelopeParameter, suggestEnvelopeParameter } from "./envelope_params.js";

// [fxcheck:A G320–G329] pre-write frozen/instance probe for fx.* envelope edits.
// Throws CUTHOL-G322/G324 on ERROR before the caller writes anything.
function fxEnvelopePreCheck(
  workspaceDir: string, targetId: string, parameter: string,
  wouldBePoints: { offset_ms: number; value: number }[]
): void {
  const m = /^fx\.([^.]+)\.(.+)$/.exec(parameter);
  if (!m) return;
  const { sequence } = loadSequence(workspaceDir);
  assertFxEnvelopeWritable(sequence, workspaceDir, targetId, parameter);
  const clip = sequence.spine.clips.find((c) => c.id === targetId);
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === targetId);
  const owner = clip ?? cue;
  const fx = owner?.fx?.find((f) => f.id === m[1]);
  if (!owner || !fx) return;
  const envelopes = (owner.envelopes ?? [])
    .filter((e) => e.parameter !== parameter)
    .concat([{ parameter, points: wouldBePoints as never[] }] as never);
  probeEntryOrThrow(sequence, workspaceDir, targetId, fx, envelopes as never);
}

/**
 * [ed G380–G381] write-time guard for `fx.<id>.<param>` envelopes: rejects
 * orphan envelopes (no fx with that id on the item) and envelopes on params
 * the fx did not declare envelopable, with a suggestion naming the item's fx
 * ids and that fx's animatable params. Uses the same definition source the
 * stage compiler reads (extension registry / motion definition / builtin
 * chain rule). A disabled fx's envelope stays dormant (accepted, like the
 * compiler); dotted sub-paths (`fx.<id>.<param>.<sub>`) validate the head
 * param. Unknown owners or unresolvable extension kinds are left to the
 * commit path (G118/G119), which already owns those errors.
 */
export function assertFxEnvelopeWritable(
  seq: CutholSequence, workspaceDir: string, targetId: string, parameter: string
): void {
  const m = /^fx\.([^.]+)\.(.+)$/.exec(parameter);
  if (!m) return;
  const fxId = m[1];
  const paramName = m[2].split(".")[0];
  const clip = seq.spine.clips.find((c) => c.id === targetId);
  const cue = seq.lanes.flatMap((l) => l.cues).find((c) => c.id === targetId);
  const owner = clip ?? cue;
  if (!owner) return;
  const fx = (owner.fx ?? []).find((f) => f.id === fxId);
  if (!fx) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_FX_ORPHAN(targetId, parameter, fxId, (owner.fx ?? []).map((f) => f.id))
    );
  }
  if (fx.enabled === false) return;
  if (fx.kind === MOTION_FX_KIND) {
    const animatable = MOTION_EFFECT_DEFINITION.animatable ?? [];
    const declared = (MOTION_EFFECT_DEFINITION.params as Record<string, unknown>)[paramName];
    if (!declared || !animatable.includes(paramName)) {
      throw new CutholError(
        DIAGNOSTICS.ENVELOPE_FX_PARAM_NOT_ANIMATABLE(targetId, parameter, fxId, fx.kind, [...animatable])
      );
    }
    return;
  }
  if (fx.kind === BUILTIN_FX_KIND) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_FX_PARAM_NOT_ANIMATABLE(targetId, parameter, fxId, fx.kind, [])
    );
  }
  let def: { params?: Record<string, unknown>; animatable?: string[] } | undefined;
  try {
    const found = listEffectDefinitions(seq, { rootDir: workspaceDir }).find((d) => d.kind === fx.kind);
    if (found) def = { params: found.params, animatable: found.animatable };
  } catch {
    return;
  }
  if (!def) return;
  const animatable = def.animatable ?? [];
  const declared = (def.params ?? {})[paramName];
  if (!declared || !animatable.includes(paramName)) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_FX_PARAM_NOT_ANIMATABLE(targetId, parameter, fxId, fx.kind, [...animatable])
    );
  }
}
import { evaluateEnvelopeAt } from "./spine_envelope.js";
import { PLACEMENT_CHANNELS, placementBaseEnvelope, placementLayers, placementValueAt } from "./placement_resolve.js";
import { MOTION_FX_KIND, PLACEMENT_LAYER_COMBINE, placementLayerIdentity } from "../effects/effect_types.js";
import { MOTION_EFFECT_DEFINITION } from "../effects/effect_types.js";
import { outToSeqMs, tempoOf } from "./tempo.js";
import { BUILTIN_FX_KIND } from "../compositor/compile_fx_stage.js";

export type EnvelopeOwner = SpineClip | LaneCue;

export function findEnvelopeOwner(
  seq: CutholSequence,
  targetId: string
): { owner: EnvelopeOwner; kind: "spine" | "cue" } {
  const clip = seq.spine.clips.find((c) => c.id === targetId);
  if (clip) return { owner: clip, kind: "spine" };
  for (const lane of seq.lanes) {
    const cue = lane.cues.find((c) => c.id === targetId);
    if (cue) return { owner: cue, kind: "cue" };
  }
  throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(targetId));
}

export function ownerTimelineStart(seq: CutholSequence, targetId: string): number {
  const found = findEnvelopeOwner(seq, targetId);
  if (found.kind === "spine") return (found.owner as SpineClip).timeline_in_ms;
  return (found.owner as LaneCue).at_ms;
}

export function ownerDurationMs(seq: CutholSequence, targetId: string): number {
  return findEnvelopeOwner(seq, targetId).owner.duration_ms;
}

function assertKnownParameter(parameter: string, targetId: string): void {
  if (!isKnownEnvelopeParameter(parameter)) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_UNKNOWN_PARAMETER(
        parameter,
        targetId,
        suggestEnvelopeParameter(parameter)
      )
    );
  }
}

function assertOffsetInRange(
  targetId: string,
  parameter: string,
  offsetMs: number,
  durationMs: number
): void {
  if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > durationMs) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_OUT_OF_RANGE(targetId, parameter, Math.round(offsetMs), durationMs)
    );
  }
}

/** Sequence clock (output clock when tempo is active) to item-local ms. */
export function sequenceTimeToLocalMs(
  seq: CutholSequence,
  targetId: string,
  atMs: number
): number {
  const tempo = tempoOf(seq);
  const seqMs = tempo !== 1 ? outToSeqMs(atMs, tempo) : atMs;
  return seqMs - ownerTimelineStart(seq, targetId);
}

export interface BeatPlacement {
  cue: LaneCue;
  assetHandle: string;
  sourceInMs: number;
  rate: number;
}

function rateOfCue(cue: LaneCue): number {
  const r = cue.playback?.rate;
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 1;
}

/** Every placement of an asset: spine clips plus lane cues carrying its handle. */
export function findAssetPlacements(
  seq: CutholSequence,
  assetHandle: string
): Array<{ kind: "spine" | "cue"; id: string; startMs: number; sourceInMs: number; rate: number }> {
  const out: Array<{ kind: "spine" | "cue"; id: string; startMs: number; sourceInMs: number; rate: number }> = [];
  for (const clip of seq.spine.clips) {
    const asset = seq.library.find((a) => a.handle === clip.asset_handle);
    void asset;
    if ((clip as { asset_handle?: string }).asset_handle === assetHandle) {
      const rate = typeof clip.playback?.rate === "number" ? clip.playback.rate : 1;
      out.push({
        kind: "spine",
        id: clip.id,
        startMs: clip.timeline_in_ms,
        sourceInMs: clip.source_in_ms,
        rate,
      });
    }
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.asset_handle === assetHandle) {
        out.push({
          kind: "cue",
          id: cue.id,
          startMs: cue.at_ms,
          sourceInMs: cue.source_in_ms ?? 0,
          rate: rateOfCue(cue),
        });
      }
    }
  }
  return out;
}

/**
 * Beat index (1-based) of an asset to item-local ms on `targetId`.
 * Beat times live in the asset's own clock; they map through the single cue
 * that places the asset (start, in-point, rate) onto the sequence clock.
 */
export function beatToLocalMs(options: {
  seq: CutholSequence;
  targetId: string;
  beat: number;
  beatsOf: string;
  gridMs: number[] | null;
}): number {
  const { seq, targetId, beat, beatsOf, gridMs } = options;
  if (!Number.isInteger(beat) || beat < 1) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_BEAT_INDEX_INVALID(beatsOf, beat)
    );
  }
  if (!gridMs) {
    throw new CutholError(DIAGNOSTICS.ENVELOPE_BEAT_NO_GRID(beatsOf));
  }
  if (beat > gridMs.length) {
    throw new CutholError(DIAGNOSTICS.ENVELOPE_BEAT_INDEX_INVALID(beatsOf, beat));
  }
  const placements = findAssetPlacements(seq, beatsOf).filter((p) => p.kind === "cue");
  if (placements.length === 0) {
    throw new CutholError(DIAGNOSTICS.ENVELOPE_BEAT_NO_PLACEMENT(beatsOf));
  }
  if (placements.length > 1) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_BEAT_AMBIGUOUS(beatsOf, placements.map((p) => p.id))
    );
  }
  const assetMs = gridMs[beat - 1];
  const p = placements[0];
  const seqMs = p.startMs + Math.round((assetMs - p.sourceInMs) / p.rate);
  return seqMs - ownerTimelineStart(seq, targetId);
}

function upsertPoint(
  owner: EnvelopeOwner,
  parameter: ParameterEnvelope["parameter"],
  point: ParameterEnvelopePoint
): ParameterEnvelope {
  const idx = owner.envelopes.findIndex((e) => e.parameter === parameter);
  if (idx === -1) {
    const env: ParameterEnvelope = { parameter, points: [point] };
    owner.envelopes.push(env);
    return env;
  }
  const pts = [...owner.envelopes[idx].points];
  const at = pts.findIndex((p) => p.offset_ms === point.offset_ms);
  if (at >= 0) pts[at] = point;
  else pts.push(point);
  pts.sort((a, b) => a.offset_ms - b.offset_ms);
  owner.envelopes[idx] = { parameter, points: pts };
  return owner.envelopes[idx];
}

export interface EnvelopePointEdit {
  workspaceDir: string;
  targetId: string;
  parameter: ParameterEnvelope["parameter"];
  offsetMs: number;
  value?: number;
  easing?: ParameterEnvelopePoint["easing"];
  bezier?: ParameterEnvelopePoint["bezier"];
}

function buildPoint(edit: EnvelopePointEdit, fallbackValue?: number): ParameterEnvelopePoint {
  const value = edit.value ?? fallbackValue ?? 0;
  if (!Number.isFinite(value)) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_POINT_VALUE_INVALID(edit.targetId, edit.parameter)
    );
  }
  return {
    offset_ms: Math.round(edit.offsetMs),
    value,
    easing: edit.easing ?? "linear",
    ...(edit.bezier ? { bezier: [...edit.bezier] } : {}),
  };
}

export function addEnvelopePoint(
  edit: EnvelopePointEdit
): { envelope: ParameterEnvelope; revision: number; verification: VerificationReport } {
  assertKnownParameter(edit.parameter, edit.targetId);
  // [fxcheck:A G320–G329] frozen probe on the would-be point set.
  {
    const { sequence } = loadSequence(edit.workspaceDir);
    const { owner } = findEnvelopeOwner(sequence, edit.targetId);
    const existing = (owner.envelopes.find((e) => e.parameter === edit.parameter)?.points ?? [])
      .map((p) => ({ offset_ms: p.offset_ms, value: p.value }));
    const pt = buildPoint(edit);
    const next = [...existing.filter((p) => p.offset_ms !== pt.offset_ms), { offset_ms: pt.offset_ms, value: pt.value }];
    fxEnvelopePreCheck(edit.workspaceDir, edit.targetId, edit.parameter, next);
  }
  const { result, revision, verification } = commitVerifiedMutation(
    edit.workspaceDir,
    `envelope.point.add(${edit.targetId},${edit.parameter})`,
    (seq) => {
      const { owner } = findEnvelopeOwner(seq, edit.targetId);
      assertOffsetInRange(edit.targetId, edit.parameter, edit.offsetMs, owner.duration_ms);
      return upsertPoint(owner, edit.parameter, buildPoint(edit));
    }
  );
  return { envelope: result, revision, verification };
}

/**
 * Bulk point add from `--points-file <json>` (long lists exceed the command
 * line). One journal revision for the whole file. Each entry resolves to one
 * `EnvelopePointEdit`; same-offset entries collapse with last-wins.
 */
export function addEnvelopePointsBulk(options: {
  workspaceDir: string;
  targetId: string;
  parameter: ParameterEnvelope["parameter"];
  points: EnvelopePointEdit[];
}): { envelope: ParameterEnvelope; revision: number; verification: VerificationReport } {
  assertKnownParameter(options.parameter, options.targetId);
  // [fxcheck:A G320–G329] frozen probe on the would-be point set.
  {
    const { sequence } = loadSequence(options.workspaceDir);
    const { owner } = findEnvelopeOwner(sequence, options.targetId);
    const merged = new Map<number, { offset_ms: number; value: number }>();
    for (const p of owner.envelopes.find((e) => e.parameter === options.parameter)?.points ?? []) {
      merged.set(p.offset_ms, { offset_ms: p.offset_ms, value: p.value });
    }
    for (const edit of options.points) {
      const pt = buildPoint(edit);
      merged.set(pt.offset_ms, { offset_ms: pt.offset_ms, value: pt.value });
    }
    fxEnvelopePreCheck(options.workspaceDir, options.targetId, options.parameter, [...merged.values()]);
  }
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `envelope.point.add.bulk(${options.targetId},${options.parameter},${options.points.length})`,
    (seq) => {
      const { owner } = findEnvelopeOwner(seq, options.targetId);
      let env = owner.envelopes.find((e) => e.parameter === options.parameter) ?? null;
      for (const edit of options.points) {
        assertOffsetInRange(options.targetId, options.parameter, edit.offsetMs, owner.duration_ms);
        env = upsertPoint(owner, options.parameter, buildPoint(edit));
      }
      return env as ParameterEnvelope;
    }
  );
  return { envelope: result, revision, verification };
}

export function moveEnvelopePoint(options: {
  workspaceDir: string;
  targetId: string;
  parameter: ParameterEnvelope["parameter"];
  fromMs: number;
  toMs: number;
  value?: number;
  easing?: ParameterEnvelopePoint["easing"];
  bezier?: ParameterEnvelopePoint["bezier"];
}): { envelope: ParameterEnvelope; revision: number; verification: VerificationReport } {
  assertKnownParameter(options.parameter, options.targetId);
  // [fxcheck:A G320–G329] frozen probe on the would-be point set.
  {
    const { sequence } = loadSequence(options.workspaceDir);
    const { owner } = findEnvelopeOwner(sequence, options.targetId);
    const from = Math.round(options.fromMs);
    const rest = (owner.envelopes.find((e) => e.parameter === options.parameter)?.points ?? [])
      .filter((p) => p.offset_ms !== from)
      .map((p) => ({ offset_ms: p.offset_ms, value: p.value }));
    const prev = owner.envelopes.find((e) => e.parameter === options.parameter)?.points.find((p) => p.offset_ms === from);
    if (prev) {
      rest.push({ offset_ms: Math.round(options.toMs), value: options.value ?? prev.value });
      fxEnvelopePreCheck(options.workspaceDir, options.targetId, options.parameter, rest);
    }
  }
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `envelope.point.move(${options.targetId},${options.parameter})`,
    (seq) => {
      const { owner } = findEnvelopeOwner(seq, options.targetId);
      assertOffsetInRange(options.targetId, options.parameter, options.toMs, owner.duration_ms);
      const env = owner.envelopes.find((e) => e.parameter === options.parameter);
      const from = Math.round(options.fromMs);
      const existing = env?.points.find((p) => p.offset_ms === from);
      if (!env || !existing) {
        throw new CutholError(
          DIAGNOSTICS.ENVELOPE_POINT_MISSING(options.targetId, options.parameter, from)
        );
      }
      const rest = owner.envelopes.find((e) => e.parameter === options.parameter)!;
      rest.points = rest.points.filter((p) => p.offset_ms !== from);
      const moved: ParameterEnvelopePoint = {
        offset_ms: Math.round(options.toMs),
        value: options.value ?? existing.value,
        easing: options.easing ?? existing.easing,
        ...(options.bezier
          ? { bezier: [...options.bezier] }
          : existing.bezier
            ? { bezier: [...existing.bezier] }
            : {}),
      };
      if (!Number.isFinite(moved.value)) {
        throw new CutholError(
          DIAGNOSTICS.ENVELOPE_POINT_VALUE_INVALID(options.targetId, options.parameter)
        );
      }
      return upsertPoint(owner, options.parameter, moved);
    }
  );
  return { envelope: result, revision, verification };
}

export function removeEnvelopePoint(options: {
  workspaceDir: string;
  targetId: string;
  parameter: ParameterEnvelope["parameter"];
  offsetMs: number;
}): { envelope: ParameterEnvelope | null; revision: number; verification: VerificationReport } {
  assertKnownParameter(options.parameter, options.targetId);
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `envelope.point.remove(${options.targetId},${options.parameter})`,
    (seq) => {
      const { owner } = findEnvelopeOwner(seq, options.targetId);
      const idx = owner.envelopes.findIndex((e) => e.parameter === options.parameter);
      const at = Math.round(options.offsetMs);
      const env = idx >= 0 ? owner.envelopes[idx] : undefined;
      const existing = env?.points.find((p) => p.offset_ms === at);
      if (!env || !existing) {
        throw new CutholError(
          DIAGNOSTICS.ENVELOPE_POINT_MISSING(options.targetId, options.parameter, at)
        );
      }
      const kept = env.points.filter((p) => p.offset_ms !== at);
      if (kept.length === 0) {
        owner.envelopes.splice(idx, 1);
        return null;
      }
      owner.envelopes[idx] = { parameter: options.parameter, points: kept };
      return owner.envelopes[idx];
    }
  );
  return { envelope: result, revision, verification };
}

function staticParameterValue(owner: EnvelopeOwner, parameter: string): number | undefined {
  const anyOwner = owner as unknown as Record<string, unknown>;
  if (parameter === "audio_chain.gain_db") {
    const v = (anyOwner.audio_chain as Record<string, unknown> | undefined)?.gain_db;
    return typeof v === "number" ? v : undefined;
  }
  const grade = /^treatments\.color_grade\.(brightness|contrast|saturation)$/.exec(parameter);
  if (grade) {
    const v = (
      ((anyOwner.treatments as Record<string, unknown> | undefined)?.color_grade as
        | Record<string, unknown>
        | undefined)
    )?.[grade[1]];
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

/** One motion layer's contribution to a placement channel at the queried time. */
export interface PlacementValueLayerTerm {
  id: string;
  value: number;
  source: "envelope" | "static";
}

/**
 * Frozen probe for `spine value` on `fx.<id>.<param>`. Runs the
 * shared `checkFrozenParam` triple-render (cached) when the envelope changes
 * value; non-fx params never probe. Returns `{ frozen }` plus the G324
 * diagnostic when frozen, so the CLI (`...res` spread) emits them as JSON.
 * The filter name comes from the entry's own template (or raw `--filter`
 * text), never from the stage chain's entry converter.
 */
function fxFrozenProbe(
  workspaceDir: string,
  sequence: CutholSequence,
  targetId: string,
  owner: { id: string; fx?: { id: string; kind: string; params?: Record<string, unknown> }[]; envelopes: { parameter: string }[] },
  entry: { id: string; kind: string; params?: Record<string, unknown> } | undefined,
  param: string,
  env: { points: { value: number }[] }
): { frozen: boolean; diagnostic?: unknown } {
  try {
    if (!entry || entry.kind === MOTION_FX_KIND) return { frozen: false };
    const vals = env.points.map((p) => p.value);
    if (!vals.some((v) => v !== vals[0])) return { frozen: false };
    const ctx = { seq: sequence, paths: { rootDir: workspaceDir } } as unknown as import("../compositor/compiler.js").VideoGraphCompileContext;
    const base = owner as unknown as Parameters<typeof buildItemFxStage>[1]["owner"];
    const chainFor = (params: Record<string, unknown>, envelopes: { parameter: string; points: { value: number }[] }[]) => {
      const o = { ...base, fx: (base.fx as unknown[]).map((f) => f === entry ? { ...(f as object), params } : f), envelopes } as unknown as Parameters<typeof buildItemFxStage>[1]["owner"];
      return flattenFxStageParts(buildItemFxStage(ctx, { owner: o, receivedPixFmt: "yuv420p", itemHasAlpha: false })).join(",");
    };
    const chainEnvelope = chainFor(entry.params ?? {}, [{ parameter: `fx.${entry.id}.${param}`, points: env.points }]);
    if (!chainEnvelope) return { frozen: false };
    const chainInit = chainFor({ ...(entry.params ?? {}), [param]: vals[0] }, []);
    const chainFinal = chainFor({ ...(entry.params ?? {}), [param]: vals[vals.length - 1] }, []);
    if (!chainInit || !chainFinal) return { frozen: false };
    const template = entry.kind.startsWith("ext:")
      ? listEffectDefinitions(sequence, { rootDir: workspaceDir }).find((d) => d.kind === entry.kind)?.ffmpeg?.video_filter
      : (typeof entry.params?.filter === "string" ? entry.params.filter : undefined);
    const findings = checkFrozenParam({
      filterName: fxEntryFilterName(template, chainEnvelope),
      chainWithInitial: chainInit,
      chainWithFinal: chainFinal,
      chainWithEnvelope: chainEnvelope,
      frameIndex: 65,
      envelopeChangesValue: true,
      projectDir: workspaceDir,
    });
    if (findings.some((f) => f.severity === "ERROR")) {
      const ferr = findings.find((f) => f.severity === "ERROR")!;
      return { frozen: true, diagnostic: DIAGNOSTICS.FX_PARAM_FROZEN(ferr.filter ?? "?", targetId) };
    }
    return { frozen: false };
  } catch {
    return { frozen: false };
  }
}

/** Read-only lookup for `spine value`: item-local value without rendering. */
export function readEnvelopeValueAt(options: {
  workspaceDir: string;
  targetId: string;
  parameter: string;
  localMs: number;
}): {
  value: number;
  source: "envelope" | "static";
  breakdown?: { base: number; base_source: "envelope" | "static"; layers: PlacementValueLayerTerm[]; combine: "add" | "multiply" };
  layer?: { id: string; value: number; source: "envelope" | "static" };
  frozen?: boolean;
  diagnostic?: unknown;
} {
  const { sequence } = loadSequence(options.workspaceDir);
  const { owner } = findEnvelopeOwner(sequence, options.targetId);
  const env = owner.envelopes.find((e) => e.parameter === options.parameter);
  if (options.parameter.startsWith("placement.")) {
    const channel = options.parameter.slice("placement.".length);
    if ((PLACEMENT_CHANNELS as readonly string[]).includes(channel)) {
      const ch = channel as (typeof PLACEMENT_CHANNELS)[number];
      const baseEnv = placementBaseEnvelope(owner, ch);
      const baseVal =
        baseEnv && baseEnv.points.length > 0
          ? evaluateEnvelopeAt(baseEnv, options.localMs)
          : owner.placement[ch];
      const layers: PlacementValueLayerTerm[] = [];
      for (const layer of placementLayers(owner)) {
        const entry = layer.channels[ch];
        if (!entry) continue;
        if (entry.envelope && entry.envelope.points.length > 0) {
          layers.push({ id: layer.id, value: evaluateEnvelopeAt(entry.envelope, options.localMs), source: "envelope" });
        } else {
          layers.push({ id: layer.id, value: entry.static, source: "static" });
        }
      }
      return {
        value: placementValueAt(owner, ch, options.localMs),
        source: baseEnv ? "envelope" : "static",
        breakdown: {
          base: baseVal,
          base_source: baseEnv && baseEnv.points.length > 0 ? "envelope" : "static",
          layers,
          combine: PLACEMENT_LAYER_COMBINE[ch],
        },
      };
    }
  }
  const fxMatch = /^fx\.([^.]+)\.(.+)$/.exec(options.parameter);
  if (fxMatch) {
    const clip = owner as SpineClip;
    const entry = (clip.fx ?? []).find((f) => f.id === fxMatch[1]);
    if (entry && entry.kind === MOTION_FX_KIND && (PLACEMENT_CHANNELS as readonly string[]).includes(fxMatch[2])) {
      const ch = fxMatch[2] as (typeof PLACEMENT_CHANNELS)[number];
      const layerEnv = owner.envelopes.find((e) => e.parameter === options.parameter);
      if (layerEnv && layerEnv.points.length > 0) {
        return { value: evaluateEnvelopeAt(layerEnv, options.localMs), source: "envelope", layer: { id: entry.id, value: evaluateEnvelopeAt(layerEnv, options.localMs), source: "envelope" } };
      }
      const raw = entry.params?.[fxMatch[2]];
      const n = typeof raw === "number" ? raw : placementLayerIdentity(ch);
      return { value: n, source: "static", layer: { id: entry.id, value: n, source: "static" } };
    }
    if (env && env.points.length > 0) {
      const value = evaluateEnvelopeAt(env, options.localMs);
      return { value, source: "envelope", ...fxFrozenProbe(options.workspaceDir, sequence, options.targetId, owner, entry, fxMatch[2], env) };
    }
    const raw = entry?.params?.[fxMatch[2]];
    if (typeof raw === "number") return { value: raw, source: "static", frozen: false };
  }
  if (env && env.points.length > 0) {
    return { value: evaluateEnvelopeAt(env, options.localMs), source: "envelope" };
  }
  const staticValue = staticParameterValue(owner, options.parameter);
  if (typeof staticValue === "number") return { value: staticValue, source: "static" };
  if (!isKnownEnvelopeParameter(options.parameter)) {
    throw new CutholError(
      DIAGNOSTICS.ENVELOPE_UNKNOWN_PARAMETER(
        options.parameter,
        options.targetId,
        suggestEnvelopeParameter(options.parameter)
      )
    );
  }
  throw new CutholError(
    DIAGNOSTICS.ENVELOPE_VALUE_UNRESOLVABLE(options.targetId, options.parameter)
  );
}
