/** Sequence tempo mapping: sequence clock <-> output clock. Single source of the tempo formula. */
export function normalizeTempo(raw: unknown): number {
  const v = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isFinite(v)) throw new Error("tempo must be a finite number");
  return v;
}

export function tempoOf(seq: { stage?: { tempo?: number } }): number {
  const t = seq?.stage?.tempo;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 1;
}

export function isTempoActive(seq: { stage?: { tempo?: number } }): boolean {
  return tempoOf(seq) !== 1;
}

/** Default `afade` length (ms) applied at each discontinuous spine join. */
export const DEFAULT_AUDIO_JOIN_FADE_MS = 10;
/** Largest `stage.audio_join_fade_ms` value accepted. */
export const MAX_AUDIO_JOIN_FADE_MS = 100;

export function normalizeAudioJoinFadeMs(raw: unknown): number {
  const v = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isFinite(v)) throw new Error("audio_join_fade_ms must be a finite number");
  return v;
}

/**
 * Effective spine-join fade (ms) for a sequence. A missing field means the
 * default, so old projects open unchanged and only gain the fades at render.
 * Explicit 0 turns the join fades off (old filter text byte-identical).
 */
export function audioJoinFadeMsOf(seq: { stage?: { audio_join_fade_ms?: number } }): number {
  const v = seq?.stage?.audio_join_fade_ms;
  if (v === undefined) return DEFAULT_AUDIO_JOIN_FADE_MS;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DEFAULT_AUDIO_JOIN_FADE_MS;
  return Math.min(MAX_AUDIO_JOIN_FADE_MS, v);
}

/** Sequence ms -> output ms. */
export function seqToOutMs(seqMs: number, tempo: number): number {
  return seqMs / tempo;
}

/** Output ms -> sequence ms. */
export function outToSeqMs(outMs: number, tempo: number): number {
  return outMs * tempo;
}

/** Sequence frame -> output frame (frame-exact). */
export function seqToOutFrame(seqFrame: number, tempo: number, fps: number): number {
  return Math.round((seqFrame * 1000) / fps / tempo * fps / 1000);
}

/** Output frame -> sequence frame. */
export function outToSeqFrame(outFrame: number, tempo: number, fps: number): number {
  void fps;
  return Math.round(outFrame * tempo);
}

/** Output duration for a sequence duration. */
export function outputDurationMs(sequenceDurationMs: number, tempo: number): number {
  return Math.max(1, Math.round(sequenceDurationMs / tempo));
}

/** Frame count for an output duration at fps. */
export function outputFrameCount(outputMs: number, fps: number): number {
  return Math.max(1, Math.round((outputMs / 1000) * Math.max(1, fps)));
}

/** Output frame index whose instant is nearest to a sequence time. */
export function outputFrameAtSeqMs(seqMs: number, tempo: number, fps: number): number {
  return Math.round((seqToOutMs(seqMs, tempo) / 1000) * Math.max(1, fps));
}

/** Sequence time (ms, fractional) of an output frame's instant. */
export function seqMsAtOutputFrame(outFrame: number, tempo: number, fps: number): number {
  return outToSeqMs((outFrame * 1000) / Math.max(1, fps), tempo);
}

/**
 * Video retime for the output stage. Input frames carry absolute sequence
 * timestamps (the composite's clock); output frame k of a segment that starts at
 * output frame `outStartFrame` shows the sequence frame nearest to
 * `seqMsAtOutputFrame(outStartFrame + k)`, so segments join without drift.
 */
export function tempoVideoRetimeFilter(tempo: number, fps: number, outStartFrame: number): string {
  const outStartSec = (outStartFrame / Math.max(1, fps)).toFixed(6);
  return `setpts=PTS/${tempo}-${outStartSec}/TB,fps=fps=${Math.max(1, fps)}:start_time=0:round=near`;
}

/**
 * Splits render segments (sequence-clock windows) on whole output frames: every
 * boundary moves to the sequence instant of the nearest output frame, so each
 * segment holds an integer number of output frames and the counts add up to
 * the whole output.
 */
export function tempoOutputSegments<T extends { startMs: number; endMs: number }>(
  segments: T[],
  tempo: number,
  fps: number,
  totalOutputFrames: number
): Array<T & { startFrame: number; endFrame: number; frameCount: number }> {
  return segments.map((seg, i) => {
    const startFrame = i === 0 ? 0 : outputFrameAtSeqMs(seg.startMs, tempo, fps);
    const endFrame = i === segments.length - 1 ? totalOutputFrames : outputFrameAtSeqMs(seg.endMs, tempo, fps);
    return {
      ...seg,
      startFrame,
      endFrame,
      frameCount: Math.max(1, endFrame - startFrame),
      startMs: seqMsAtOutputFrame(startFrame, tempo, fps),
      endMs: seqMsAtOutputFrame(endFrame, tempo, fps),
    };
  });
}

/** Chain atempo filters preserving pitch for a rate (0.5x-100x via chained 0.5-2.0 stages). */
export function atempoChain(rate: number): string {
  const r = rate <= 0 ? 1 : rate;
  const stages: string[] = [];
  let rest = r;
  while (rest > 2.0) { stages.push("atempo=2.0"); rest /= 2.0; }
  while (rest < 0.5) { stages.push("atempo=0.5"); rest /= 0.5; }
  stages.push(`atempo=${rest.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`);
  return stages.join(",");
}
