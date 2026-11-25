// Effective placement of a spine clip or lane cue: the one place that decides what a placement
// channel's value is at a given local time.
//
// API contract:
// - `placementStaticValue(owner, channel)` — the value readers use when the channel does not
//   animate (base value combined with static layer terms).
// - `placementChannelHasEnvelopeInput(owner, channel)` — the path selector: an envelope entry
//   exists, including one with no points.
// - `placementChannelRange(owner, channel)` — extremes for padding/bounds: point values of the
//   base envelope when it animates, else the static value, combined with the layer terms.
//   No sampling.
// - `placementChannelAnimates` — true when an envelope with at least one point exists (points test).
// - `placementLayers(owner)` — the item's active `motion` entries in list order (`enabled !== false`),
//   per channel the entry's param value and its `fx.<id>.<channel>` envelope if any.
// Combine rule: x_pct, y_pct, rotation_deg add; scale_x, scale_y, opacity multiply
// (see `PLACEMENT_LAYER_COMBINE`); the combined opacity is clamped to [0, 1].
// Readers never read `placement.<channel>` directly: every placement read goes through this API.
// Layer values come from `motion` entries only: presets and future extension motion effects expand
// into plain `motion` entries when applied; render never looks up a preset or a registry to combine.
import type { ClipFxSpec, ParameterEnvelope, SpatialPlacement } from "../core/schema.js";
import {
  MOTION_FX_KIND,
  PLACEMENT_CHANNELS,
  PLACEMENT_LAYER_COMBINE,
  type PlacementChannel,
} from "../effects/effect_types.js";
import { evaluateEnvelopeAt } from "./spine_envelope.js";

export { PLACEMENT_CHANNELS, type PlacementChannel };

/** Anything with a placement and envelopes: a spine clip or a lane cue. */
export interface PlacementOwner {
  placement: SpatialPlacement;
  envelopes: ParameterEnvelope[];
  fx?: ClipFxSpec[];
}

export type ResolvedPlacementValues = Record<PlacementChannel, number>;

/**
 * One active motion layer: the entry's channel value (its param, else the channel identity)
 * and the layer's own envelope on that channel (`fx.<id>.<channel>`), if any.
 */
export interface PlacementLayer {
  id: string;
  channels: Partial<Record<PlacementChannel, { static: number; envelope?: ParameterEnvelope }>>;
}

/**
 * The base envelope on `placement.<channel>` as stored (the first one, possibly with no points),
 * or undefined. Same result as `owner.envelopes.find((e) => e.parameter === "placement.<channel>")`.
 */
export function placementBaseEnvelope(owner: PlacementOwner, channel: PlacementChannel): ParameterEnvelope | undefined {
  const parameter = `placement.${channel}`;
  return owner.envelopes.find((e) => e.parameter === parameter);
}

/**
 * The value a reader uses when the channel does not animate (base plus static layer terms).
 * For a channel that animates, this is still the stored static field combined with static
 * layer terms; readers that care whether it animates ask `placementChannelAnimates` /
 * `placementChannelHasEnvelopeInput`.
 */
function layerTermStatic(layer: PlacementLayer, channel: PlacementChannel): number | null {
  const entry = layer.channels[channel];
  if (!entry) return null;
  if (entry.envelope && entry.envelope.points.length > 0) return null;
  return entry.static;
}

function layerTermRange(layer: PlacementLayer, channel: PlacementChannel): { min: number; max: number } | null {
  const entry = layer.channels[channel];
  if (!entry) return null;
  if (entry.envelope && entry.envelope.points.length > 0) {
    let min = entry.envelope.points[0].value;
    let max = entry.envelope.points[0].value;
    for (const p of entry.envelope.points) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    return { min, max };
  }
  return { min: entry.static, max: entry.static };
}

function combineAdd(a: { min: number; max: number }, b: { min: number; max: number }): { min: number; max: number } {
  return { min: a.min + b.min, max: a.max + b.max };
}

function combineMultiply(a: { min: number; max: number }, b: { min: number; max: number }): { min: number; max: number } {
  const ps = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max];
  return { min: Math.min(...ps), max: Math.max(...ps) };
}

export function placementStaticValue(owner: PlacementOwner, channel: PlacementChannel): number {
  let v = owner.placement[channel];
  for (const layer of placementLayers(owner)) {
    const t = layerTermStatic(layer, channel);
    if (t === null) continue;
    v = PLACEMENT_LAYER_COMBINE[channel] === "add" ? v + t : v * t;
  }
  if (channel === "opacity") v = Math.min(1, Math.max(0, v));
  return v;
}

/**
 * The path selector: an envelope entry exists on the base channel or a motion layer,
 * including one with no points.
 */
export function placementChannelHasEnvelopeInput(owner: PlacementOwner, channel: PlacementChannel): boolean {
  if (placementBaseEnvelope(owner, channel) !== undefined) return true;
  for (const fx of owner.fx ?? []) {
    if (fx.kind !== MOTION_FX_KIND || fx.enabled === false) continue;
    if (owner.envelopes.some((e) => e.parameter === `fx.${fx.id}.${channel}`)) return true;
  }
  return false;
}

/**
 * True when an envelope entry exists on any placement channel, even one with
 * no points (base or motion layers).
 */
export function placementHasAnyEnvelopeInput(owner: PlacementOwner): boolean {
  return PLACEMENT_CHANNELS.some((c) => placementChannelHasEnvelopeInput(owner, c));
}

/**
 * Extremes for padding/bounds: point values of the base envelope when it animates, else the
 * static value, combined with the motion layer terms (no sampling).
 */
export function placementChannelRange(owner: PlacementOwner, channel: PlacementChannel): { min: number; max: number } {
  const env = placementBaseEnvelope(owner, channel);
  let acc: { min: number; max: number };
  if (env && env.points.length > 0) {
    let min = env.points[0].value;
    let max = env.points[0].value;
    for (const p of env.points) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    acc = { min, max };
  } else {
    const v = owner.placement[channel];
    acc = { min: v, max: v };
  }
  const combine = PLACEMENT_LAYER_COMBINE[channel] === "add" ? combineAdd : combineMultiply;
  for (const layer of placementLayers(owner)) {
    const t = layerTermRange(layer, channel);
    if (!t) continue;
    acc = combine(acc, t);
  }
  return acc;
}

/** True when the channel's value changes over time (base or any layer envelope with points). */
export function placementChannelAnimates(owner: PlacementOwner, channel: PlacementChannel): boolean {
  const env = placementBaseEnvelope(owner, channel);
  if (env && env.points.length > 0) return true;
  for (const layer of placementLayers(owner)) {
    const e = layer.channels[channel]?.envelope;
    if (e && e.points.length > 0) return true;
  }
  return false;
}

/** True when any of the given channels animates. */
export function placementAnimatesAny(owner: PlacementOwner, channels: readonly PlacementChannel[]): boolean {
  return channels.some((c) => placementChannelAnimates(owner, c));
}

/**
 * The item's active `motion` entries in list order (`enabled !== false`). Per channel, the
 * entry's param value and its `fx.<id>.<channel>` envelope if any. The resolver combines
 * these layers with the base placement.
 */
export function placementLayers(owner: PlacementOwner): PlacementLayer[] {
  const out: PlacementLayer[] = [];
  for (const fx of owner.fx ?? []) {
    if (fx.kind !== MOTION_FX_KIND) continue;
    if (fx.enabled === false) continue;
    const channels: PlacementLayer["channels"] = {};
    for (const c of PLACEMENT_CHANNELS) {
      const raw = (fx.params as Record<string, unknown> | undefined)?.[c];
      const envelope = owner.envelopes.find((e) => e.parameter === `fx.${fx.id}.${c}`);
      if (raw === undefined && envelope === undefined) continue;
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      const entry: { static: number; envelope?: ParameterEnvelope } = {
        static: Number.isFinite(n) ? n : c === "opacity" || c === "scale_x" || c === "scale_y" ? 1 : 0,
      };
      if (envelope) entry.envelope = envelope;
      channels[c] = entry;
    }
    out.push({ id: fx.id, channels });
  }
  return out;
}

/**
 * Effective value of one channel at owner-local time `localMs`: the envelope value when the channel
 * animates, else the static value. With `nonFinite: "static"`, a non-finite envelope value falls back
 * to the static value (default: returned as is). An envelope entry with no points also yields the
 * static value (what render compiles); it comes from outside edits or older projects.
 */
export function placementValueAt(
  owner: PlacementOwner,
  channel: PlacementChannel,
  localMs: number,
  options?: { nonFinite?: "keep" | "static" }
): number {
  const baseEnv = placementBaseEnvelope(owner, channel);
  const baseStatic = owner.placement[channel];
  const baseVal =
    baseEnv && baseEnv.points.length > 0
      ? evaluateEnvelopeAt(baseEnv, localMs)
      : baseStatic;
  let v =
    options?.nonFinite === "static" && !Number.isFinite(baseVal) ? baseStatic : baseVal;
  for (const layer of placementLayers(owner)) {
    const entry = layer.channels[channel];
    if (!entry) continue;
    let t: number;
    if (entry.envelope && entry.envelope.points.length > 0) {
      const ev = evaluateEnvelopeAt(entry.envelope, localMs);
      t = options?.nonFinite === "static" && !Number.isFinite(ev) ? entry.static : ev;
    } else {
      t = entry.static;
    }
    v = PLACEMENT_LAYER_COMBINE[channel] === "add" ? v + t : v * t;
  }
  if (channel === "opacity") v = Math.min(1, Math.max(0, v));
  return v;
}

/** All six effective channel values at owner-local time `localMs` (see `placementValueAt`). */
export function resolvePlacementValuesAt(
  owner: PlacementOwner,
  localMs: number,
  options?: { nonFinite?: "keep" | "static" }
): ResolvedPlacementValues {
  const out = {} as ResolvedPlacementValues;
  for (const c of PLACEMENT_CHANNELS) out[c] = placementValueAt(owner, c, localMs, options);
  return out;
}

/** Envelopes that drive placement: base `placement.*` plus active motion-layer `fx.<id>.<channel>`. */
function placementDrivingEnvelopes(owner: PlacementOwner): ParameterEnvelope[] {
  const out: ParameterEnvelope[] = [];
  for (const c of PLACEMENT_CHANNELS) {
    const base = placementBaseEnvelope(owner, c);
    if (base) out.push(base);
  }
  const motionIds = new Set(
    (owner.fx ?? []).filter((f) => f.kind === MOTION_FX_KIND && f.enabled !== false).map((f) => f.id)
  );
  for (const e of owner.envelopes) {
    if (!e.parameter.startsWith("fx.")) continue;
    const rest = e.parameter.slice("fx.".length).split(".");
    if (rest.length !== 2) continue;
    if (!motionIds.has(rest[0])) continue;
    if (!(PLACEMENT_CHANNELS as readonly string[]).includes(rest[1])) continue;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Resting segments of an item over `[0, durationMs]`: split local time at every point
 * offset of the driving placement envelopes (plus 0 and the duration); a segment is
 * resting when every driving envelope holds the same value at both ends with no point
 * inside it (envelopes hold their first value before the first point and their last
 * value after the last point). Returns `[startMs, endMs]` pairs; empty means no rest.
 */
export function placementRestingSegments(
  owner: PlacementOwner,
  durationMs: number
): Array<[number, number]> {
  const dur = Math.max(0, durationMs);
  const envs = placementDrivingEnvelopes(owner);
  const cuts = new Set<number>([0, dur]);
  for (const e of envs) {
    for (const p of e.points) {
      if (p.offset_ms >= 0 && p.offset_ms <= dur) cuts.add(p.offset_ms);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!(b > a)) continue;
    let rest = true;
    for (const e of envs) {
      if (evaluateEnvelopeAt(e, a) !== evaluateEnvelopeAt(e, b)) {
        rest = false;
        break;
      }
      for (const p of e.points) {
        if (p.offset_ms > a && p.offset_ms < b) {
          rest = false;
          break;
        }
      }
      if (!rest) break;
    }
    if (rest) out.push([a, b]);
  }
  return out;
}

/**
 * Resolved copy of an item at owner-local time `localMs`: combined placement values baked
 * into `placement`, with no motion entries and no motion/placement envelopes (downstream
 * readers resolve through the same resolver and must not add the layers again). Every
 * other envelope rides along untouched. A point-less envelope entry yields the static
 * value, like render.
 */
export function resolvedPlacementCopyAt<T extends PlacementOwner>(owner: T, localMs: number): T {
  const motionIds = new Set(
    (owner.fx ?? []).filter((f) => f.kind === MOTION_FX_KIND).map((f) => f.id)
  );
  if (owner.envelopes.length === 0 && motionIds.size === 0) return owner;
  const fxMotionPrefix = (parameter: string): boolean => {
    if (!parameter.startsWith("fx.")) return false;
    const id = parameter.slice("fx.".length).split(".")[0];
    return motionIds.has(id);
  };
  const isPlacementParam = (parameter: string): boolean =>
    (PLACEMENT_CHANNELS as readonly string[]).some((c) => parameter === `placement.${c}`);
  const keptFx = (owner.fx ?? []).filter((f) => f.kind !== MOTION_FX_KIND);
  return {
    ...owner,
    placement: {
      ...owner.placement,
      x_pct: placementValueAt(owner, "x_pct", localMs),
      y_pct: placementValueAt(owner, "y_pct", localMs),
      scale_x: placementValueAt(owner, "scale_x", localMs),
      scale_y: placementValueAt(owner, "scale_y", localMs),
      rotation_deg: placementValueAt(owner, "rotation_deg", localMs),
      opacity: placementValueAt(owner, "opacity", localMs),
    },
    ...(keptFx.length !== (owner.fx ?? []).length ? { fx: keptFx } : {}),
    envelopes: owner.envelopes.filter((e) => !fxMotionPrefix(e.parameter) && !isPlacementParam(e.parameter)),
  };
}
