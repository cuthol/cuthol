/**
 * Cuthol Multi-Lens Context Inspector (`src/brief/inspector.ts`).
 *
 * Provides 4 token-efficient lenses (`overview`, `flow`, `canvas`, `detail`)
 * so an AI agent never has to load raw project JSON into its context window.
 */

import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import path from "node:path";
import { activeCliGroup, activeCliWorkspaceDir } from "../cli_output.js";
import { detectCompositionAudioNotInMix } from "../verify/gates_hf_audio.js";
import { drainLiveInbox, formatLiveNotesBlock } from "../live/live_inbox.js";
import { CutholSequence, LaneCue, SpineClip } from "../core/schema.js";
import { placementLayers, placementStaticValue } from "../sequence/placement_resolve.js";
import { MOTION_FX_KIND, PLACEMENT_CHANNELS } from "../effects/effect_types.js";
import { isVerticalStage, OPEN_STANDARDS } from "../core/standards.js";
import { formatTimecode } from "../core/time.js";
import {
  computeSequenceDurationMs,
  describeSequenceExtent,
  findBackdropOnlySpans,
  resolveCueStartMs,
} from "../core/timeline.js";

export { computeSequenceDurationMs, resolveCueStartMs };

export type BriefLens = "overview" | "flow" | "canvas" | "detail";

export interface BriefOptions {
  lens?: BriefLens;
  targetIds?: string[];
  windowStartMs?: number;
  windowEndMs?: number;
  /** Prepended verbatim as the top line when set (external-change notice). */
  noticeLine?: string;
  /**
   * When false, queued Live notes are left in the inbox (the JSON envelope
   * path delivers them as `live_notes` instead). Defaults to true.
   */
  includeLiveNotes?: boolean;
  /**
   * Project root the cue `composition_dir` values resolve against. When set,
   * a default (absent) `composition_audio` switch is shown only for
   * compositions that actually hold audible elements; without it the
   * configured default is shown as before (the files cannot be located).
   */
  compositionRootDir?: string;
}

/** Per-render cache for composition audio scans (shared ffprobe results). */
export interface CompositionAudioScanCache {
  probeCache: Map<string, boolean>;
}

function describeSpinelessExtent(seq: CutholSequence): string {
  const extent = describeSequenceExtent(seq);
  if (extent.source === "lanes") return ` | Length from: lane cues (spine empty, graphics-only)`;
  if (extent.source === "empty") return ` | Empty: no spine clips and no lane cues`;
  return "";
}

function isOutsideWindow(startMs: number, endMs: number, startFilter: number, endFilter: number): boolean {
  if (endMs > startMs) {
    return endMs <= startFilter || startMs >= endFilter;
  }
  return startMs < startFilter || startMs >= endFilter;
}

function formatScale(scaleX: number, scaleY: number): string {
  return scaleX === scaleY ? `${scaleX}x` : `${scaleX}x, ${scaleY}y`;
}

function sanitizeMdCell(text: string): string {
  return text.replace(/\r?\n/g, " ↵ ").replace(/\|/g, "\\|");
}

function isAudioOnlyKind(kind: string): boolean {
  return kind === "music" || kind === "sfx" || kind === "voiceover";
}

/**
 * Composition cue one-liner with its stem switch (`mix` is the default when
 * absent). An explicit switch is always shown; a default switch is shown only
 * when the composition actually holds audible elements (same static scan as
 * the G416 gate), so silent compositions stay quiet in the brief.
 */
function withCueFx(summary: string, cue: LaneCue): string {
  const fx = describeFxShort(cue.fx);
  return fx ? `${summary} [${fx}]` : summary;
}

function describeCompositionCueSummary(
  cue: LaneCue,
  rootDir?: string,
  cache?: CompositionAudioScanCache
): string {
  const dir = sanitizeMdCell(cue.composition!.composition_dir);
  const explicit = cue.composition_audio;
  if (explicit === "off") return `HyperFrames(${dir}, comp-audio: off)`;
  if (explicit === "mix") return `HyperFrames(${dir}, comp-audio: mix)`;
  if (rootDir !== undefined) {
    const compDir = path.isAbsolute(cue.composition!.composition_dir)
      ? cue.composition!.composition_dir
      : path.resolve(rootDir, cue.composition!.composition_dir);
    const probeCache = cache?.probeCache ?? new Map<string, boolean>();
    let audible = false;
    try {
      audible =
        detectCompositionAudioNotInMix(
          compDir,
          cue.composition!.entry_html,
          probeCache
        ).length > 0;
    } catch {
      audible = true;
    }
    if (!audible) return `HyperFrames(${dir})`;
  }
  return `HyperFrames(${dir}, comp-audio: mix)`;
}

/** Short fx summary for lenses (`fx: gblur, vignette(off)`), or null when no fx entries. Motion layers are placement layers, not pixel effects, so they never appear here. */
function describeFxShort(fx: Array<{ kind: string; enabled?: boolean }> | undefined): string | null {
  const pixel = (fx ?? []).filter((f) => f.kind !== MOTION_FX_KIND);
  if (pixel.length === 0) return null;
  return `fx: ${pixel.map((f) => (f.enabled === false ? `${f.kind}(off)` : f.kind)).join(", ")}`;
}

/** Short motion-layer note for placement rows (`motion: fx_02(scale_x, opacity), fx_03(x_pct~)`, `~` = animated), or null when the item has no motion layers. */
function describeMotionNote(owner: { fx?: Array<{ id: string; kind: string; enabled?: boolean }>; envelopes?: Array<{ parameter: string; points: unknown[] }> }): string | null {
  const layers = placementLayers(owner as Parameters<typeof placementLayers>[0]);
  if (layers.length === 0) return null;
  const parts = layers.map((l) => {
    const chans = PLACEMENT_CHANNELS.filter((c) => l.channels[c] !== undefined)
      .map((c) => `${c}${(l.channels[c]?.envelope?.points.length ?? 0) > 0 ? "~" : ""}`)
      .join(", ");
    return `${l.id}(${chans})`;
  });
  return `motion: ${parts.join(", ")}`;
}

/** Short ramp shape for lenses (`ramp 1->3x, 2 pts`), or null when unramped. */
function describeSpeedRampShape(clip: SpineClip): string | null {
  const ramp = clip.playback.speed_ramp;
  if (!ramp || ramp.length < 2) return null;
  return `ramp ${ramp[0].rate}->${ramp[ramp.length - 1].rate}x, ${ramp.length} pts`;
}

/** Full ramp description with pitch mode (`ramp 1->3x, 2 pts, pitch kept`). */
function describeSpeedRamp(clip: SpineClip): string | null {
  const shape = describeSpeedRampShape(clip);
  if (!shape) return null;
  return `${shape}, ${clip.playback.preserve_pitch ? "pitch kept" : "pitch shifts"}`;
}

export function renderSequenceBrief(seq: CutholSequence, options: BriefOptions = {}): string {
  const lens = options.lens ?? "overview";
  // A real `brief` CLI run resolves composition dirs against its workspace;
  // library callers either pass `compositionRootDir` or get legacy output.
  const compositionRootDir =
    options.compositionRootDir ??
    (activeCliGroup === "brief" ? activeCliWorkspaceDir : undefined);
  let md: string;
  switch (lens) {
    case "overview":
      md = renderOverviewLens(seq);
      break;
    case "flow":
      md = renderFlowLens(
        seq,
        options.windowStartMs,
        options.windowEndMs,
        compositionRootDir
      );
      break;
    case "canvas":
      md = renderCanvasLens(seq, options.windowStartMs, options.windowEndMs);
      break;
    case "detail":
      md = renderDetailLens(seq, options.targetIds ?? []);
      break;
  }
  const out = options.noticeLine ? `${options.noticeLine}\n${md}` : md;
  if (options.includeLiveNotes === false) return out;
  return appendLiveNotesIfCliBrief(out);
}

// Cuthol Live: the markdown brief path prints this string directly, so queued
// user notes are attached here. Only for a real `brief` CLI run (tests and
// library callers leave activeCliGroup empty); untouched when inbox is empty.
function appendLiveNotesIfCliBrief(md: string): string {
  if (activeCliGroup !== "brief") return md;
  let notes: ReturnType<typeof drainLiveInbox> = null;
  try {
    notes = drainLiveInbox(activeCliWorkspaceDir);
  } catch {
    return md;
  }
  if (!notes) return md;
  return [md, ...formatLiveNotesBlock(notes.lines)].join("\n");
}

/** One-line colour summary for the overview lens: staged items and Looks. */
export function describeSequenceColour(seq: CutholSequence): string {
  let staged = 0;
  for (const clip of seq.spine.clips) {
    if (clip.treatments.color) staged += 1;
  }
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if ((cue as { color?: unknown }).color) staged += 1;
    }
  }
  const looks = seq.looks?.length ?? 0;
  if (staged === 0 && looks === 0) return "no stages, no Looks";
  return `${staged} staged item(s), ${looks} Look(s)`;
}

function renderOverviewLens(seq: CutholSequence): string {
  const totalMs = computeSequenceDurationMs(seq);
  const lines: string[] = [];

  lines.push(`# CUTHOL BRIEF [LENS: OVERVIEW]`);
  lines.push(
    `- Project: **${sanitizeMdCell(seq.meta.title)}** (\`${seq.meta.project_id}\`) | Rev: \`r${seq.meta.revision}\` | Updated: \`${seq.meta.updated_at}\``
  );
  lines.push(
    `- Stage: \`${seq.stage.width}x${seq.stage.height}\` (\`${seq.stage.aspect}\`) @ \`${seq.stage.fps}fps\` | Backdrop: \`${seq.stage.backdrop.kind}(${seq.stage.backdrop.color})\``
  );
  lines.push(`- Colour: \`${describeSequenceColour(seq)}\``);
  const tempoRate = seq.stage.tempo ?? 1;
  lines.push(
    `- Sequence Duration: \`${totalMs}ms\` (\`${formatTimecode(totalMs)}\`) | Magnetic Spine: \`${seq.spine.magnetic ? "ON" : "OFF"}\`${describeSpinelessExtent(seq)}${tempoRate !== 1 ? ` | Tempo: \`${tempoRate}x\` (output \`${Math.max(1, Math.round(totalMs / tempoRate))}ms\`)` : ""}`
  );
  lines.push("");

  lines.push(`## Library (${seq.library.length} items)`);
  if (seq.library.length === 0) {
    lines.push(`_(empty)_`);
  } else {
    lines.push(`| Handle | Kind | Duration | Dimensions | Audio | Cached Metrics | URI |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const item of seq.library) {
      const dims = item.probe.has_video ? `${item.probe.width}x${item.probe.height}@${item.probe.fps}fps` : "audio-only";
      const audio = item.probe.has_audio ? `${item.probe.sample_rate ?? 48000}Hz/${item.probe.channels ?? 2}ch` : "none";
      const metrics = Object.keys(item.analysis_refs).filter((k) => Boolean((item.analysis_refs as Record<string, unknown>)[k]));
      lines.push(
        `| \`${item.handle}\` | ${item.kind} | ${item.probe.duration_ms}ms | ${dims} | ${audio} | ${metrics.length > 0 ? metrics.join(", ") : "-"} | \`${sanitizeMdCell(item.uri)}\` |`
      );
    }
  }
  lines.push("");

  lines.push(`## Primary Spine (${seq.spine.clips.length} clips)`);
  if (seq.spine.clips.length === 0) {
    lines.push(`_(no spine clips)_`);
  } else {
    for (const clip of seq.spine.clips) {
      const endMs = clip.timeline_in_ms + clip.duration_ms;
      const trans = clip.transition_out ? ` -> [${clip.transition_out.kind} ${clip.transition_out.duration_ms}ms]` : "";
      const ramp = describeSpeedRamp(clip);
      const rampCell = ramp ? ` | ramp \`${ramp}\`` : "";
      const fxSummary = describeFxShort(clip.fx);
      const fxCell = fxSummary ? ` | \`${fxSummary}\`` : "";
      lines.push(
        `- \`${clip.id}\` (\`${clip.asset_handle}\`): timeline \`${clip.timeline_in_ms}..${endMs}ms\` | source \`${clip.source_in_ms}..${clip.source_out_ms}ms\` | rate \`${clip.playback.rate}x\`${rampCell}${trans}${fxCell}`
      );
    }
  }
  lines.push("");

  lines.push(`## Parallel Lanes (${seq.lanes.length} lanes)`);
  for (const lane of seq.lanes) {
    lines.push(
      `- \`${lane.id}\` (kind: \`${lane.kind}\`, z: \`${lane.z_index}\`, cues: \`${lane.cues.length}\`${lane.muted ? ", MUTED" : ""})`
    );
  }

  if (seq.extensions && seq.extensions.length > 0) {
    lines.push("");
    lines.push(`## Enabled Extensions (${seq.extensions.length})`);
    for (const ext of seq.extensions) {
      lines.push(
        `- \`${ext.name}\` v${ext.version} (\`${ext.scope}\`, hash: \`${ext.content_hash}\`)`
      );
    }
  }

  return lines.join("\n");
}

function renderFlowLens(
  seq: CutholSequence,
  winStart?: number,
  winEnd?: number,
  compositionRootDir?: string
): string {
  const startFilter = winStart ?? 0;
  const endFilter = winEnd ?? Number.MAX_SAFE_INTEGER;
  const audioScanCache: CompositionAudioScanCache = { probeCache: new Map<string, boolean>() };
  const lines: string[] = [];

  lines.push(`# CUTHOL BRIEF [LENS: FLOW]`);
  lines.push(`- Window: \`${startFilter}ms .. ${endFilter === Number.MAX_SAFE_INTEGER ? "END" : `${endFilter}ms`}\``);
  lines.push("");

  lines.push(`## Spine Narrative & Anchored Cues`);
  if (seq.spine.clips.length === 0) {
    const extent = describeSequenceExtent(seq);
    if (extent.source === "empty") {
      lines.push(`_(no spine clips and no lane cues: the sequence is empty)_`);
    } else {
      lines.push(
        `_(no spine clips: graphics-only sequence, its length comes from the lane cues below and ends at ${extent.duration_ms}ms)_`
      );
      for (const span of findBackdropOnlySpans(seq)) {
        if (isOutsideWindow(span.start_ms, span.end_ms, startFilter, endFilter)) continue;
        lines.push(`- Backdrop only (no visual cue): \`${span.start_ms}..${span.end_ms}ms\``);
      }
    }
  } else {
    for (const clip of seq.spine.clips) {
      const clipEnd = clip.timeline_in_ms + clip.duration_ms;
      if (isOutsideWindow(clip.timeline_in_ms, clipEnd, startFilter, endFilter)) continue;

      lines.push(
        `### [${clip.id}] ${clip.timeline_in_ms}ms .. ${clipEnd}ms (dur: ${clip.duration_ms}ms, asset: ${clip.asset_handle}, src: ${clip.source_in_ms}..${clip.source_out_ms}ms)`
      );
      const ramp = describeSpeedRamp(clip);
      if (ramp) {
        lines.push(`  - Speed: ${ramp}`);
      }
      const flags: string[] = [];
      if (clip.audio_chain.denoise.enabled) flags.push(`denoise(${clip.audio_chain.denoise.nr_db}dB)`);
      if (clip.audio_chain.voice_clarity.enabled) flags.push(`voice_clarity`);
      if (clip.audio_chain.loudness_target_lufs !== null) {
        flags.push(`loudness(${clip.audio_chain.loudness_target_lufs}LUFS)`);
      }
      if (clip.envelopes.length > 0) flags.push(`envelopes(${clip.envelopes.length})`);
      if (flags.length > 0) {
        lines.push(`  - Active Chain: ${flags.join(", ")}`);
      }

      // Find cues anchored to this clip
      for (const lane of seq.lanes) {
        const muteTag = lane.muted ? " [MUTED]" : "";
        for (const cue of lane.cues) {
          if (cue.anchor?.ref === clip.id) {
            const cueStart = resolveCueStartMs(seq, cue);
            const cueEnd = cueStart + cue.duration_ms;
            const summary = withCueFx(
              cue.typography
                ? `"${sanitizeMdCell(cue.typography.text)}"`
                : cue.composition
                  ? describeCompositionCueSummary(cue, compositionRootDir, audioScanCache)
                  : cue.asset_handle ?? cue.kind,
              cue
            );
            lines.push(
              `  - Anchored \`${cue.id}\` on \`${lane.id}\`${muteTag} (+${cue.anchor.offset_ms}ms => ${cueStart}..${cueEnd}ms): ${summary}`
            );
          }
        }
      }
    }
  }

  const spineClipIds = new Set(seq.spine.clips.map((c) => c.id));
  const danglingCues: Array<{ laneId: string; zIndex: number; muted: boolean; cue: LaneCue }> = [];
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) {
      if (cue.anchor && !spineClipIds.has(cue.anchor.ref)) {
        const cueStart = resolveCueStartMs(seq, cue);
        const cueEnd = cueStart + cue.duration_ms;
        if (!isOutsideWindow(cueStart, cueEnd, startFilter, endFilter)) {
          danglingCues.push({ laneId: lane.id, zIndex: lane.z_index, muted: lane.muted, cue });
        }
      }
    }
  }

  if (danglingCues.length > 0) {
    lines.push("");
    lines.push(`## Dangling / Unresolved Anchored Cues`);
    for (const { laneId, zIndex, muted, cue } of danglingCues) {
      const cueStart = resolveCueStartMs(seq, cue);
      const cueEnd = cueStart + cue.duration_ms;
      const summary = withCueFx(
        cue.typography
          ? `"${sanitizeMdCell(cue.typography.text)}"`
          : cue.composition
            ? describeCompositionCueSummary(cue, compositionRootDir, audioScanCache)
            : cue.asset_handle ?? cue.kind,
        cue
      );
      lines.push(
        `- [WARN: DANGLING ANCHOR \`${cue.anchor?.ref}\`] \`${cue.id}\` (\`${laneId}\`, z=${zIndex}${muted ? ", MUTED" : ""}): \`${cueStart}..${cueEnd}ms\` | ${summary}`
      );
    }
  }

  lines.push("");
  lines.push(`## Unanchored (Absolute Time) Lane Cues`);
  let unanchoredCount = 0;
  for (const lane of seq.lanes) {
    const muteTag = lane.muted ? ", MUTED" : "";
    for (const cue of lane.cues) {
      if (cue.anchor) continue;
      const cueStart = cue.at_ms;
      const cueEnd = cueStart + cue.duration_ms;
      if (isOutsideWindow(cueStart, cueEnd, startFilter, endFilter)) continue;
      unanchoredCount++;
      const summary = withCueFx(
        cue.typography
          ? `"${sanitizeMdCell(cue.typography.text)}"`
          : cue.composition
            ? describeCompositionCueSummary(cue, compositionRootDir, audioScanCache)
            : cue.asset_handle ?? cue.kind,
        cue
      );
      lines.push(`- \`${cue.id}\` (\`${lane.id}\`, z=${lane.z_index}${muteTag}): \`${cueStart}..${cueEnd}ms\` | ${summary}`);
    }
  }
  if (unanchoredCount === 0) {
    lines.push(`_(none)_`);
  }

  return lines.join("\n");
}

function renderCanvasLens(seq: CutholSequence, winStart?: number, winEnd?: number): string {
  const startFilter = winStart ?? 0;
  const endFilter = winEnd ?? Number.MAX_SAFE_INTEGER;
  const lines: string[] = [];

  const titleMarginX = Math.round(seq.stage.width * (OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100));
  const titleMarginY = Math.round(seq.stage.height * (OPEN_STANDARDS.SAFE_ZONES.TITLE_MARGIN_PCT / 100));
  const verticalStage = isVerticalStage(seq.stage);
  const rightSafeX = verticalStage
    ? Math.round(seq.stage.width * (1 - OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_RIGHT_CHROME_PCT / 100))
    : seq.stage.width - titleMarginX;
  const bottomSafeY = verticalStage
    ? Math.round(seq.stage.height * (1 - OPEN_STANDARDS.SAFE_ZONES.VERTICAL_9_16_BOTTOM_CHROME_PCT / 100))
    : seq.stage.height - titleMarginY;

  lines.push(`# CUTHOL BRIEF [LENS: CANVAS GEOMETRY]`);
  lines.push(
    `- Stage: \`${seq.stage.width}x${seq.stage.height}\` (\`${seq.stage.aspect}\`) | Safe Box (EBU R95 / Social UI): \`x=[${titleMarginX}..${rightSafeX}], y=[${titleMarginY}..${bottomSafeY}]\``
  );
  lines.push("");

  lines.push(`| ID | Layer/Lane | z_index | Time Window | Position (x%, y%) | Scale | Opacity | Notes |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);

  for (const clip of seq.spine.clips) {
    const end = clip.timeline_in_ms + clip.duration_ms;
    if (isOutsideWindow(clip.timeline_in_ms, end, startFilter, endFilter)) continue;
    const scaleStr = formatScale(placementStaticValue(clip, "scale_x"), placementStaticValue(clip, "scale_y"));
    const rampShape = describeSpeedRampShape(clip);
    let notes = rampShape ? `fit=${clip.placement.fit_mode}, ${rampShape}` : `fit=${clip.placement.fit_mode}`;
    const motionNote = describeMotionNote(clip);
    if (motionNote) notes += `; ${motionNote}`;
    lines.push(
      `| \`${clip.id}\` | \`spine\` | 0 | ${clip.timeline_in_ms}..${end}ms | (${placementStaticValue(clip, "x_pct")}%, ${placementStaticValue(clip, "y_pct")}%) | ${scaleStr} | ${placementStaticValue(clip, "opacity")} | ${notes} |`
    );
  }

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  for (const lane of sortedLanes) {
    if (lane.muted || isAudioOnlyKind(lane.kind)) continue;
    for (const cue of lane.cues) {
      if (isAudioOnlyKind(cue.kind)) continue;
      const start = resolveCueStartMs(seq, cue);
      const end = start + cue.duration_ms;
      if (isOutsideWindow(start, end, startFilter, endFilter)) continue;
      const scaleStr = formatScale(placementStaticValue(cue, "scale_x"), placementStaticValue(cue, "scale_y"));
      let note = cue.typography
        ? `font=${cue.typography.font_size_px}px, max_w=${cue.typography.max_width_pct}%`
        : cue.composition
        ? `hyperframes(${cue.composition.transparent ? "alpha" : "opaque"})`
        : `fit=${cue.placement.fit_mode}`;
      const cueMotionNote = describeMotionNote(cue);
      if (cueMotionNote) note += `; ${cueMotionNote}`;
      lines.push(
        `| \`${cue.id}\` | \`${lane.id}\` | ${lane.z_index} | ${start}..${end}ms | (${placementStaticValue(cue, "x_pct")}%, ${placementStaticValue(cue, "y_pct")}%) | ${scaleStr} | ${placementStaticValue(cue, "opacity")} | ${note} |`
      );
    }
  }

  return lines.join("\n");
}

function renderDetailLens(seq: CutholSequence, targetIds: string[]): string {
  if (targetIds.length === 0) {
    return `# CUTHOL BRIEF [LENS: DETAIL]\n_(No --id specified. Provide --id <handle_or_clip_id>.)_`;
  }

  const found: Record<string, unknown> = {};
  for (const id of targetIds) {
    const matches: unknown[] = [];

    for (const lib of seq.library) {
      if (lib.handle === id) {
        matches.push({ entity_type: "library_item", ...lib });
      }
    }
    for (const sp of seq.spine.clips) {
      if (sp.id === id) {
        matches.push({ entity_type: "spine_clip", ...sp });
      }
    }
    for (const lane of seq.lanes) {
      if (lane.id === id) {
        matches.push({ entity_type: "parallel_lane", ...lane });
      }
      for (const cue of lane.cues) {
        if (cue.id === id) {
          matches.push({
            entity_type: "lane_cue",
            lane_id: lane.id,
            resolved_start_ms: resolveCueStartMs(seq, cue),
            ...cue,
          });
        }
      }
    }
    for (const marker of seq.markers) {
      if (marker.id === id) {
        matches.push({ entity_type: "timeline_marker", ...marker });
      }
    }

    if (matches.length === 0) {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(id));
    }
    found[id] = matches.length === 1 ? matches[0] : { duplicate_handle_conflict: true, matches };
  }

  return `# CUTHOL BRIEF [LENS: DETAIL]\n\`\`\`json\n${JSON.stringify(found, null, 2)}\n\`\`\``;
}
