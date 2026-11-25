// Spine clip effect-chain operations (`spine fx` add / set / remove / list).
// Every mutation is revisioned and undoable through `commitVerifiedMutation`, so an invalid kind, bad
// params, or an unsupported envelope is refused with G118/G119 before anything is written. Removing an fx
// also removes its `fx.<id>.*` envelopes, otherwise the sequence would keep a dangling envelope (G119).
// Split/excise need no change here: they `structuredClone` the clip (fx rides along) and slice every envelope
// by clip-local time, which already covers `fx.<id>.<param>` envelopes.
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { ClipFxSpec, CutholSequence, EffectParamValue, LaneCue, SpineClip } from "../core/schema.js";
import { loadSequence } from "../core/workspace.js";
import { commitVerifiedMutation, type VerificationReport } from "../verify/gates.js";
import { BUILTIN_FX_KIND } from "../compositor/compile_spine_fx.js";
import { MOTION_FX_KIND, PLACEMENT_CHANNELS } from "../effects/effect_types.js";

const FX_ID_RE = /^fx_(\d+)$/;

/** Next free `fx_XX` id inside one clip (per-clip numbering, never reused after remove). */
export function allocateFxId(existing: ClipFxSpec[] | undefined): string {
  let max = 0;
  for (const f of existing ?? []) {
    const m = FX_ID_RE.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `fx_${String(max + 1).padStart(2, "0")}`;
}

function findClip(seq: { spine: { clips: SpineClip[] } }, clipId: string): SpineClip {
  const clip = seq.spine.clips.find((c) => c.id === clipId);
  if (!clip) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(clipId));
  }
  return clip;
}

export type FxOwner = SpineClip | LaneCue;

const AUDIO_CUE_KINDS = new Set(["music", "sfx", "voiceover"]);

function findFxOwner(seq: CutholSequence, targetId: string): { owner: FxOwner; kind: "spine" | "cue" } {
  const clip = seq.spine.clips.find((c) => c.id === targetId);
  if (clip) return { owner: clip, kind: "spine" };
  for (const lane of seq.lanes) {
    const cue = lane.cues.find((c) => c.id === targetId);
    if (cue) {
      if (AUDIO_CUE_KINDS.has(cue.kind)) {
        throw new CutholError(DIAGNOSTICS.CUE_FX_AUDIO_NOT_ALLOWED(cue.id, cue.kind));
      }
      return { owner: cue, kind: "cue" };
    }
  }
  throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(targetId));
}

function resolveTargetId(options: { clipId?: string; item?: string }): string {
  const target = options.item ?? options.clipId;
  if (!target) throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE("(missing --item/--clip)"));
  return target;
}

function findFx(owner: FxOwner, fxId: string): ClipFxSpec {
  const fx = (owner.fx ?? []).find((f) => f.id === fxId);
  if (!fx) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(fxId));
  }
  return fx;
}

function assertScalarParams(
  params: Record<string, unknown>,
  clipId: string,
  fxId: string,
  kind: string
): Record<string, EffectParamValue> {
  const out: Record<string, EffectParamValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
      throw new CutholError(
        DIAGNOSTICS.SPINE_FX_INVALID(clipId, fxId, kind, `'${k}' must be a number, text or true/false.`)
      );
    }
    out[k] = v;
  }
  return out;
}

export function addSpineFx(options: {
  workspaceDir: string;
  clipId?: string;
  /** Spine clip (`sp_XX`) or lane cue (`cue_XX`) id; `clipId` is the legacy alias. */
  item?: string;
  /** Effect kind: `ext:<extension>/<name>`, or `ffmpeg` for a raw chain (then `filter` is required). */
  kind?: string;
  /** Raw filter chain; shorthand for `kind: "ffmpeg"` with `params.filter`. Exactly one of kind/filter. */
  filter?: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
}): { fx: ClipFxSpec; item: string; clip?: string; revision: number; verification: VerificationReport } {
  const targetId = resolveTargetId(options);
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.fx.add(${targetId})`,
    (seq) => {
      const { owner, kind: ownerKind } = findFxOwner(seq, targetId);
      const hasKind = options.kind !== undefined && options.kind !== "";
      const hasFilter = options.filter !== undefined && options.filter !== "";
      if (hasKind === hasFilter) {
        throw new CutholError(
          DIAGNOSTICS.SPINE_FX_INVALID(
            targetId,
            "fx_??",
            options.kind ?? BUILTIN_FX_KIND,
            `pass either '--kind <kind>' or '--filter "<chain>"' (not both, not neither).`
          )
        );
      }
      const kind = hasFilter ? BUILTIN_FX_KIND : options.kind!.trim();
      if (!kind) {
        throw new CutholError(
          DIAGNOSTICS.SPINE_FX_INVALID(targetId, "fx_??", kind, `kind must not be empty.`)
        );
      }
      const id = allocateFxId(owner.fx);
      const merged: Record<string, unknown> = { ...(options.params ?? {}) };
      if (hasFilter) merged.filter = options.filter;
      const entry: ClipFxSpec = {
        id,
        kind,
        params: assertScalarParams(merged, targetId, id, kind),
        ...(options.enabled === false ? { enabled: false as const } : {}),
      };
      owner.fx = [...(owner.fx ?? []), entry];
      void ownerKind;
      return structuredClone(entry);
    }
  );

  const out: { fx: ClipFxSpec; item: string; clip?: string; revision: number; verification: VerificationReport } = { fx: result, item: targetId, revision, verification };
  if (targetId.startsWith("sp_")) out.clip = targetId;
  return out;
}

export function setSpineFx(options: {
  workspaceDir: string;
  clipId?: string;
  item?: string;
  fxId: string;
  /** Param updates, merged over the stored params (not replaced). */
  params?: Record<string, unknown>;
  /** Replaces the whole chain; only for `kind: "ffmpeg"` entries. */
  filter?: string;
  enabled?: boolean;
}): { fx: ClipFxSpec; item: string; clip?: string; revision: number; verification: VerificationReport } {
  const targetId = resolveTargetId(options);
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.fx.set(${targetId},${options.fxId})`,
    (seq) => {
      const { owner } = findFxOwner(seq, targetId);
      const fx = findFx(owner, options.fxId);
      if (options.filter !== undefined) {
        if (fx.kind !== BUILTIN_FX_KIND) {
          throw new CutholError(
            DIAGNOSTICS.SPINE_FX_INVALID(
              targetId,
              options.fxId,
              fx.kind,
              `'--filter' can only be used with the built-in 'ffmpeg' kind.`
            )
          );
        }
        fx.params = { ...fx.params, filter: options.filter };
      }
      if (options.params) {
        fx.params = {
          ...fx.params,
          ...assertScalarParams(options.params, targetId, options.fxId, fx.kind),
        };
      }
      if (options.enabled !== undefined) {
        if (options.enabled) delete fx.enabled;
        else fx.enabled = false;
      }
      return structuredClone(fx);
    }
  );

  const out: { fx: ClipFxSpec; item: string; clip?: string; revision: number; verification: VerificationReport } = { fx: result, item: targetId, revision, verification };
  if (targetId.startsWith("sp_")) out.clip = targetId;
  return out;
}

export function removeSpineFx(options: {
  workspaceDir: string;
  clipId?: string;
  item?: string;
  fxId: string;
}): { removed_id: string; item: string; clip?: string; revision: number; verification: VerificationReport } {
  const targetId = resolveTargetId(options);
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `spine.fx.remove(${targetId},${options.fxId})`,
    (seq) => {
      const { owner } = findFxOwner(seq, targetId);
      findFx(owner, options.fxId);
      owner.fx = (owner.fx ?? []).filter((f) => f.id !== options.fxId);
      if (owner.fx.length === 0) delete owner.fx;
      const prefix = `fx.${options.fxId}.`;
      owner.envelopes = owner.envelopes.filter((e) => !e.parameter.startsWith(prefix));
      return options.fxId;
    }
  );

  const out: { removed_id: string; item: string; clip?: string; revision: number; verification: VerificationReport } = { removed_id: result, item: targetId, revision, verification };
  if (targetId.startsWith("sp_")) out.clip = targetId;
  return out;
}

/** One motion layer as listed by `spine fx list`: per channel the stored param value and whether an envelope animates it. */
export interface ListedMotionLayer {
  id: string;
  enabled: boolean;
  channels: Record<string, { value: number; animated: boolean }>;
}

export function listSpineFx(options: {
  workspaceDir: string;
  clipId?: string;
  item?: string;
}): { item: string; clip?: string; fx: ClipFxSpec[]; motion: ListedMotionLayer[] } {
  const targetId = resolveTargetId(options);
  const { sequence } = loadSequence(options.workspaceDir);
  const { owner } = findFxOwner(sequence, targetId);
  const motion: ListedMotionLayer[] = [];
  for (const fx of owner.fx ?? []) {
    if (fx.kind !== MOTION_FX_KIND) continue;
    const channels: ListedMotionLayer["channels"] = {};
    for (const c of PLACEMENT_CHANNELS) {
      const raw = (fx.params as Record<string, unknown> | undefined)?.[c];
      const envelope = owner.envelopes.find((e) => e.parameter === `fx.${fx.id}.${c}`);
      if (raw === undefined && envelope === undefined) continue;
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      channels[c] = {
        value: Number.isFinite(n) ? n : c === "opacity" || c === "scale_x" || c === "scale_y" ? 1 : 0,
        animated: (envelope?.points.length ?? 0) > 0,
      };
    }
    motion.push({ id: fx.id, enabled: fx.enabled !== false, channels });
  }
  const out: { item: string; clip?: string; fx: ClipFxSpec[]; motion: ListedMotionLayer[] } = { item: targetId, fx: structuredClone(owner.fx ?? []), motion };
  if (targetId.startsWith("sp_")) out.clip = targetId;
  return out;
}
