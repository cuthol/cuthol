/**
 * Stage-level edits. The backdrop colour is what the render starts from: it shows wherever no spine clip
 * and no lane content covers the frame, so in a graphics-only project it is the base colour of the video.
 */

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { computeSequenceDurationMs } from "../core/timeline.js";
import { commitVerifiedMutation, VerificationReport } from "../verify/gates.js";
import { DEFAULT_AUDIO_JOIN_FADE_MS, MAX_AUDIO_JOIN_FADE_MS, normalizeAudioJoinFadeMs, outputDurationMs, tempoOf } from "./tempo.js";

/** Accepts `#RRGGBB` or `RRGGBB` (any case) and returns `#RRGGBB` in upper case. */
export function normalizeHexColor(raw: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
  if (!match) {
    throw new CutholError(DIAGNOSTICS.INVALID_COLOR(raw));
  }
  return `#${match[1].toUpperCase()}`;
}

export function setStageTempo(options: { workspaceDir: string; rate?: number | null }): {
  tempo?: number;
  previous_tempo?: number;
  output_duration_ms: number;
  sequence_duration_ms: number;
  revision: number;
  verification: VerificationReport;
} {
  let out = { tempo: undefined as number | undefined, previous_tempo: undefined as number | undefined, output_duration_ms: 0, sequence_duration_ms: 0, revision: 0, verification: undefined as unknown as VerificationReport };
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    options.rate == null ? `workspace.tempo(clear)` : `workspace.tempo(${options.rate})`,
    (seq) => {
      const prev = tempoOf(seq);
      if (options.rate == null) {
        delete (seq.stage as { tempo?: number }).tempo;
      } else {
        const v = Number(options.rate);
        if (!Number.isFinite(v) || v < 0.5 || v > 2.0) {
          throw new CutholError(DIAGNOSTICS.INVALID_TEMPO(String(options.rate)));
        }
        (seq.stage as { tempo?: number }).tempo = v;
      }
      const seqMs = computeSequenceDurationMs(seq);
      const t = tempoOf(seq);
      out = {
        tempo: (seq.stage as { tempo?: number }).tempo,
        previous_tempo: prev,
        output_duration_ms: outputDurationMs(seqMs, t),
        sequence_duration_ms: seqMs,
        revision: 0,
        verification: undefined as unknown as VerificationReport,
      };
      return { tempo: (seq.stage as { tempo?: number }).tempo };
    }
  );
  out.revision = revision;
  out.verification = verification;
  void result;
  return out;
}

export function setStageAudioJoinFadeMs(options: { workspaceDir: string; ms?: number | null }): {
  audio_join_fade_ms?: number;
  previous_audio_join_fade_ms?: number;
  effective_audio_join_fade_ms: number;
  revision: number;
  verification: VerificationReport;
} {
  let out = { audio_join_fade_ms: undefined as number | undefined, previous_audio_join_fade_ms: undefined as number | undefined, effective_audio_join_fade_ms: DEFAULT_AUDIO_JOIN_FADE_MS, revision: 0, verification: undefined as unknown as VerificationReport };
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    options.ms == null ? `workspace.audio-fade(clear)` : `workspace.audio-fade(${options.ms})`,
    (seq) => {
      const prev = (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms;
      if (options.ms == null) {
        delete (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms;
      } else {
        const v = normalizeAudioJoinFadeMs(options.ms);
        if (!Number.isFinite(v) || v < 0 || v > MAX_AUDIO_JOIN_FADE_MS) {
          throw new CutholError(DIAGNOSTICS.INVALID_AUDIO_JOIN_FADE(String(options.ms)));
        }
        if (v === DEFAULT_AUDIO_JOIN_FADE_MS) {
          delete (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms;
        } else {
          (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms = v;
        }
      }
      const next = (seq.stage as { audio_join_fade_ms?: number }).audio_join_fade_ms;
      out = {
        audio_join_fade_ms: next,
        previous_audio_join_fade_ms: prev,
        effective_audio_join_fade_ms: next ?? DEFAULT_AUDIO_JOIN_FADE_MS,
        revision: 0,
        verification: undefined as unknown as VerificationReport,
      };
      return { audio_join_fade_ms: next };
    }
  );
  out.revision = revision;
  out.verification = verification;
  void result;
  return out;
}

export function setStageBackdropColor(options: { workspaceDir: string; color: string }): {
  backdrop: CutholSequence["stage"]["backdrop"];
  previous_color: string;
  revision: number;
  verification: VerificationReport;
} {
  const color = normalizeHexColor(options.color);
  let previousColor = "";
  const { result, revision, verification } = commitVerifiedMutation(
    options.workspaceDir,
    `workspace.backdrop(${color})`,
    (seq) => {
      previousColor = seq.stage.backdrop.color;
      seq.stage.backdrop = { ...seq.stage.backdrop, color };
      return { ...seq.stage.backdrop };
    }
  );
  return { backdrop: result, previous_color: previousColor, revision, verification };
}
