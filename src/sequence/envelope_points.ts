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
import { isKnownEnvelopeParameter, suggestEnvelopeParameter } from "./envelope_params.js";
import { evaluateEnvelopeAt } from "./spine_envelope.js";
import { PLACEMENT_CHANNELS, placementBaseEnvelope, placementLayers, placementValueAt } from "./placement_resolve.js";
import { MOTION_FX_KIND, PLACEMENT_LAYER_COMBINE, placementLayerIdentity } from "../effects/effect_types.js";
import { outToSeqMs, tempoOf } from "./tempo.js";

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
      return { value: evaluateEnvelopeAt(env, options.localMs), source: "envelope" };
    }
    const raw = entry?.params?.[fxMatch[2]];
    if (typeof raw === "number") return { value: raw, source: "static" };
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
