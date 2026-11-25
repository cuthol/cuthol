/**
 * Cuthol Multi-Layer Sequence Compositor & Filter-Graph Compiler (`src/compositor/compiler.ts`).
 *
 * Compiles `CutholSequence` (`spine` + `lanes` sorted by `z_index` + HyperFrames compositions
 * + interleaved `.ass` typography + multi-bus audio chain) into an executable FFmpeg filter graph.
 */

import { computeRenderDurationMs } from "../core/timeline.js";
import type { CutholDiagnostic } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import {
  ensureLibraryItemVideoProbe,
  isProbeMetadataComplete,
} from "../library/probe.js";
import { compileSequenceAudioPlan } from "./compile_audio.js";
import { atempoChain, outputDurationMs, outputFrameAtSeqMs, tempoOf, tempoVideoRetimeFilter } from "../sequence/tempo.js";
import { StaticStillLayerSpec } from "./compile_backdrop.js";
import { BT709_TO_YUV420P, BT709_TO_YUVA420P } from "./compile_color.js";
import { compileLane } from "./compile_lane.js";
import { compileSpineClip } from "./compile_spine.js";
export { escapeFfmpegFilterPath, compileEnvelopeToFfmpegExpr } from "./compile_filters.js";
export { buildMasterAudioFinalizeFilter, compileSequenceAudioPlan } from "./compile_audio.js";
export type { CompileAudioOptions, CompiledAudioPlan } from "./compile_audio.js";

export type RenderPreset = "draft_480p" | "master_1080p" | "master_2160p" | "master_alpha";

export function isAlphaPreset(preset: RenderPreset): boolean {
  return preset === "master_alpha";
}

export function isMasterPreset(preset: RenderPreset): boolean {
  return preset === "master_1080p" || preset === "master_2160p" || preset === "master_alpha";
}

/** Output pixel-format conversion filter for a preset (alpha presets keep the alpha plane). */
export function presetPixFormatFilter(preset: RenderPreset): string {
  return isAlphaPreset(preset) ? BT709_TO_YUVA420P : BT709_TO_YUV420P;
}

/**
 * One pre-pass job: the prefix of a spine clip chain (source input through the
 * fx-stage cut) rendered once to an intermediate file the main graph reads
 * back. The intermediate keeps the prefix's own pixel format; no conversion
 * is added, so the split is lossless.
 *
 * A job without `kind` is the original ffmpeg pre-pass. A shader cut adds
 * `kind: "shader"` with the ordered steps the shader worker runs between the
 * prefix decode and the intermediate encode. The field stays absent for
 * ffmpeg jobs so plans without shader effects stay byte-identical.
 */
export interface PrePassJob {
  id: string;
  inputArgs: string[];
  filterComplex: string;
  outPath: string;
  pixFmt: string;
  kind?: "shader";
  shader?: ShaderPrePassSpec;
}

/**
 * What the shader worker runs for one pre-pass: the prefix (an ffmpeg graph
 * over the clip's source input, ending in `format=rgba` / `rgba64le`) decoded
 * to raw frames, then the ordered steps (shader passes and ffmpeg steps), then
 * an FFV1 encode of the results. Uniform values are evaluated per frame at
 * the item-local time (`frame n` → `n/fps` seconds).
 */
export interface ShaderPrePassSpec {
  steps: import("./compile_fx_stage.js").FxShaderRunStep[];
  /** Frames per second of the render (per-frame time base). */
  fps: number;
  /** Intermediate pixel format (`rgba` or `rgba64le`). */
  pixFmt: "rgba" | "rgba64le";
}

export interface CompiledRenderPlan {
  inputArgs: string[];
  filterComplex: string;
  videoOutPad: string;
  audioOutPad: string;
  totalDurationMs: number;
  renderWidth: number;
  renderHeight: number;
  fps: number;
  assFilePath: string | null;
  assFilePaths: string[];
  hyperframesBlobs: string[];
  directVideoBlobPath?: string | null;
  /** Present only when the compile cut at least one spine clip chain. */
  prePasses?: PrePassJob[];
  /** Single-frame warnings (e.g. G267); absent when empty so render plans stay byte-identical. */
  compileWarnings?: CutholDiagnostic[];
}

/**
 * Internal trigger for the fx-stage pre-pass split (test-only, never user
 * facing: no CLI flag, no MCP parameter, no documented variable). `clip` is a
 * spine clip id or `*` for every spine clip with pixel fx entries;
 * `afterEntry` counts pixel entries before the cut (`0` = before the first).
 */
export interface ForceFxSplit {
  clip?: string;
  afterEntry: number;
}

/**
 * Reads the internal pre-pass trigger in one place. An explicit compile
 * option wins; otherwise `CUTHOL_FORCE_FX_SPLIT=<clip|*>:<k>` (same shape as
 * `CUTHOL_RENDER_SEGMENT_MAX_CLIPS`). Returns null when no cut is forced.
 */
export function resolveForceFxSplit(options?: CompileSequenceOptions): ForceFxSplit | null {
  if (options?.forceFxSplit) return options.forceFxSplit;
  const raw = (process.env.CUTHOL_FORCE_FX_SPLIT ?? "").trim();
  if (!raw) return null;
  const m = /^([^:]*):(\d+)$/.exec(raw);
  if (!m) return null;
  const clip = m[1] === "" || m[1] === "*" ? undefined : m[1];
  return { clip, afterEntry: Number(m[2]) };
}

export interface CompileSequenceOptions {
  activeWindowMs?: [number, number];
  /** Windowed callers that bound the output with their own frame count
   * (`-frames:v`) set this so the final video trim keeps `start=` (frames
   * before the window are still dropped) but does not end the stream with
   * `end=`. Defaults to false (today's behaviour). */
  windowEndByFrameCount?: boolean;
  singleFrameAtMs?: number;
  /** Early window trim for single-frame compiles; defaults to on. */
  singleFrameEarlyTrim?: boolean;
  minDurationMs?: number;
  workers?: number;
  useGpu?: boolean;
  includeAudio?: boolean;
  /** Internal pre-pass trigger (see `ForceFxSplit`); test-only. */
  forceFxSplit?: ForceFxSplit;
}

export interface DrawnVisualLayer {
  id: string;
  startMs: number;
  endMs: number;
  kind: "still_graphic" | "moving" | "opaque_comp";
  blobPath?: string;
  bakedUnderneathIds?: string[];
  stillSpec?: StaticStillLayerSpec;
}

export interface VideoGraphCompileContext {
  seq: CutholSequence;
  paths: WorkspacePaths;
  preset: RenderPreset;
  compileOptions?: CompileSequenceOptions;
  totalDurationMs: number;
  totalDurationSec: number;
  renderWidth: number;
  renderHeight: number;
  fps: number;
  libMap: Map<string, CutholSequence["library"][number]>;
  inputArgs: string[];
  filterChains: string[];
  hyperframesBlobs: string[];
  assFilePaths: string[];
  drawnVisualLayers: DrawnVisualLayer[];
  nextInputIdx: number;
  addInput: (args: string[]) => number;
  activeWin: [number, number] | undefined;
  winStartMs: number;
  winEndMs: number;
  winLeadStartMs: number;
  winLeadStartSec: string;
  winStartSec: string;
  winEndSec: string;
  winEndPadSec: string;
  currentVideoPad: string;
  vStepCounter: number;
  /** Resolved pre-pass trigger (null without a cut); read from env in one place. */
  forceFxSplit: ForceFxSplit | null;
  /** Pre-pass jobs emitted by spine compiles that cut a chain. */
  prePasses: PrePassJob[];
  /** Single-frame warnings collected during this compile (e.g. G267). */
  compileWarnings: CutholDiagnostic[];
}

function ensureSequenceVideoProbes(seq: CutholSequence, paths: WorkspacePaths): void {
  if (seq.library.some((item) => item.probe.has_video && !isProbeMetadataComplete(item.probe))) {
    let probeLedger: MediaLedger | null = null;
    try {
      for (const item of seq.library) {
        if (item.probe.has_video && !isProbeMetadataComplete(item.probe)) {
          if (!probeLedger && paths?.ledgerFile) {
            try {
              probeLedger = new MediaLedger(paths.ledgerFile);
            } catch {
              // ignore ledger open error
            }
          }
          ensureLibraryItemVideoProbe(item, paths.rootDir, probeLedger);
        }
      }
    } finally {
      probeLedger?.close();
    }
  }
}

function initVideoGraphCompileContext(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset,
  compileOptions?: CompileSequenceOptions
): VideoGraphCompileContext {
  const totalDurationMs = computeRenderDurationMs(seq, compileOptions?.minDurationMs ?? 0);
  const totalDurationSec = Number((totalDurationMs / 1000).toFixed(3));

  const scaleFactor =
    preset === "draft_480p"
      ? 480 / Math.min(seq.stage.width, seq.stage.height)
      : preset === "master_2160p"
        ? 2.0
        : 1.0;
  const renderWidth = Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2);
  const renderHeight = Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2);
  const fps = seq.stage.fps;

  ensureSequenceVideoProbes(seq, paths);

  const libMap = new Map(seq.library.map((item) => [item.handle, item]));
  const inputArgs: string[] = [];
  const filterChains: string[] = [];
  const hyperframesBlobs: string[] = [];
  const assFilePaths: string[] = [];
  const drawnVisualLayers: DrawnVisualLayer[] = [];

  // Input 0: Stage Backdrop Canvas (use microsecond AVTB so downstream overlays and -t trim never quantize to 1/fps)
  const activeWin = compileOptions?.activeWindowMs;
  const winStartMs = activeWin ? Math.max(0, activeWin[0]) : 0;
  const winEndMs = activeWin ? Math.max(winStartMs + 1, activeWin[1]) : totalDurationMs;
  // Align `winLeadStartSec` to a 3-frame multiple (0.1s at 30fps / 0.125s at 24fps) so `PTS + winLeadStartSec/TB`
  // has zero 1-microsecond AVTB rounding drift relative to a 0-based timeline!
  const winStartFrameApprox = Math.floor((winStartMs / 1000) * Math.max(1, fps) + 1e-6);
  const leadAlignedFrame = activeWin
    ? Math.max(0, Math.floor(Math.max(0, winStartFrameApprox - 2) / 3) * 3)
    : 0;
  const winLeadStartMs = activeWin ? (leadAlignedFrame * 1000) / Math.max(1, fps) : 0;
  const winLeadStartSec = (winLeadStartMs / 1000).toFixed(6);
  const winStartSec = (winStartMs / 1000).toFixed(6);
  const winEndSec = (winEndMs / 1000).toFixed(6);
  const winEndPadSec = ((winEndMs + 2000 / Math.max(1, fps)) / 1000).toFixed(6);
  const bgDurationSec = activeWin
    ? Number(
        (
          Math.max(1 / Math.max(1, fps), (winEndMs - winLeadStartMs) / 1000) +
          3 / Math.max(1, fps)
        ).toFixed(6)
      )
    : totalDurationSec;

  const ctx: VideoGraphCompileContext = {
    seq,
    paths,
    preset,
    compileOptions,
    totalDurationMs,
    totalDurationSec,
    renderWidth,
    renderHeight,
    fps,
    libMap,
    inputArgs,
    filterChains,
    hyperframesBlobs,
    assFilePaths,
    drawnVisualLayers,
    nextInputIdx: 0,
    addInput: (args: string[]): number => {
      ctx.inputArgs.push(...args);
      return ctx.nextInputIdx++;
    },
    activeWin,
    winStartMs,
    winEndMs,
    winLeadStartMs,
    winLeadStartSec,
    winStartSec,
    winEndSec,
    winEndPadSec,
    currentVideoPad: "",
    vStepCounter: 0,
    forceFxSplit: resolveForceFxSplit(compileOptions),
    prePasses: [],
    compileWarnings: [],
  };

  const alpha = isAlphaPreset(preset);
  const bgHex = seq.stage.backdrop.color.replace(/^#/, "0x");
  const bgInputIdx = ctx.addInput(
    alpha
      ? [
          "-f",
          "lavfi",
          "-i",
          `color=c=0x00000000:s=${renderWidth}x${renderHeight}:r=${fps}:d=${bgDurationSec},format=yuva420p,settb=AVTB`,
        ]
      : [
          "-f",
          "lavfi",
          "-i",
          `color=c=${bgHex}:s=${renderWidth}x${renderHeight}:r=${fps}:d=${bgDurationSec},format=rgb24,${BT709_TO_YUV420P},settb=AVTB`,
        ]
  );

  ctx.currentVideoPad = `[${bgInputIdx}:v]`;
  if (activeWin && winLeadStartMs > 0) {
    const bgWinPad = `[vc_${++ctx.vStepCounter}]`;
    ctx.filterChains.push(
      `${ctx.currentVideoPad}settb=AVTB,setpts=PTS+${winLeadStartSec}/TB${bgWinPad}`
    );
    ctx.currentVideoPad = bgWinPad;
  }

  return ctx;
}

function resolveDirectVideoBlobPath(ctx: VideoGraphCompileContext): string | null {
  const { compileOptions, assFilePaths, drawnVisualLayers, fps, totalDurationMs, preset } = ctx;
  // The transparent master never remuxes an opaque overlay blob: the copy
  // would bake the stage backdrop into every pixel and destroy the alpha plane.
  if (preset === "master_alpha") return null;
  // A global tempo retime cannot be stream-copied: the blob is on the sequence clock.
  if (tempoOf(ctx.seq) !== 1) return null;
  // Determine if the entire sequence visual output is satisfied by a single full-frame opaque HyperFrames MP4 blob
  let directVideoBlobPath: string | null = null;
  if (
    compileOptions?.singleFrameAtMs === undefined &&
    !compileOptions?.activeWindowMs &&
    assFilePaths.length === 0
  ) {
    const opaqueComps = drawnVisualLayers.filter((l) => l.kind === "opaque_comp" && l.blobPath);
    if (opaqueComps.length === 1) {
      const compLayer = opaqueComps[0];
      const bakedSet = new Set(compLayer.bakedUnderneathIds ?? []);
      const otherLayers = drawnVisualLayers.filter(
        (l) => l.id !== compLayer.id && !bakedSet.has(l.id)
      );
      const frameToleranceMs = Math.ceil(1000 / Math.max(1, fps)) + 1;
      if (
        otherLayers.length === 0 &&
        compLayer.startMs === 0 &&
        Math.abs(compLayer.endMs - totalDurationMs) <= frameToleranceMs &&
        compLayer.blobPath
      ) {
        directVideoBlobPath = compLayer.blobPath;
      }
    }
  }
  return directVideoBlobPath;
}

export function compileSequenceRenderPlan(
  seq: CutholSequence,
  paths: WorkspacePaths,
  preset: RenderPreset = "master_1080p",
  compileOptions?: CompileSequenceOptions
): CompiledRenderPlan {
  const ctx = initVideoGraphCompileContext(seq, paths, preset, compileOptions);

  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);
  const underSpineLanes = sortedLanes.filter((l) => l.z_index < 0);
  const overSpineLanes = sortedLanes.filter((l) => l.z_index >= 0);

  // --- 1a. Compile Under-Spine Lanes (`z_index < 0`) ---
  for (const lane of underSpineLanes) {
    compileLane(ctx, lane);
  }

  // --- 1b. Compile Primary Spine Clips (`z_index === 0`) ---
  for (let i = 0; i < seq.spine.clips.length; i++) {
    compileSpineClip(ctx, i);
  }

  // --- 2. Compile Over-Spine Parallel Lanes Sorted by z_index (`z_index >= 0`) ---
  for (const lane of overSpineLanes) {
    compileLane(ctx, lane);
  }

  const directVideoBlobPath = resolveDirectVideoBlobPath(ctx);

  // Finalize Video Output Pad (preserve AVTB so FFmpeg -t duration trim does not round down to 1/fps)
  // Sequence tempo (stage.tempo) is applied here, after compositing: captions and
  // overlays follow automatically, in a single encode. Frames keep their absolute
  // sequence timestamps until the retime, and each output frame takes the nearest
  // sequence frame, so segment windows (whole output frames, see
  // tempoOutputSegments) join without drift. Single frames (monitor) stay on the
  // sequence clock.
  const finalVideoPad = "[vout]";
  const pixFmt = presetPixFormatFilter(preset);
  const tempoRate = compileOptions?.singleFrameAtMs === undefined ? tempoOf(seq) : 1;
  if (tempoRate !== 1) {
    const winStartMs = ctx.activeWin ? Number(ctx.winStartSec) * 1000 : 0;
    const outStartFrame = ctx.activeWin ? outputFrameAtSeqMs(winStartMs, tempoRate, ctx.fps) : 0;
    const retime = tempoVideoRetimeFilter(tempoRate, ctx.fps, outStartFrame);
    if (ctx.activeWin) {
      // Half a sequence frame of margin each side so the nearest frame exists at the edges.
      const halfFrameSec = 0.5 / Math.max(1, ctx.fps);
      const trimStart = Math.max(0, Number(ctx.winStartSec) - halfFrameSec).toFixed(6);
      const trimEnd = (Number(ctx.winEndSec) + 2 * halfFrameSec).toFixed(6);
      const trim = compileOptions?.windowEndByFrameCount
        ? `trim=start=${trimStart}`
        : `trim=start=${trimStart}:end=${trimEnd}`;
      ctx.filterChains.push(`${ctx.currentVideoPad}${trim},${retime},${pixFmt},settb=AVTB${finalVideoPad}`);
    } else {
      ctx.filterChains.push(`${ctx.currentVideoPad}${retime},${pixFmt},settb=AVTB${finalVideoPad}`);
    }
  } else if (ctx.activeWin && compileOptions?.singleFrameAtMs === undefined) {
    const trim = compileOptions?.windowEndByFrameCount
      ? `trim=start=${ctx.winStartSec}`
      : `trim=start=${ctx.winStartSec}:end=${ctx.winEndSec}`;
    ctx.filterChains.push(
      `${ctx.currentVideoPad}${trim},setpts=PTS-STARTPTS,${pixFmt},settb=AVTB${finalVideoPad}`
    );
  } else {
    ctx.filterChains.push(`${ctx.currentVideoPad}${pixFmt},settb=AVTB${finalVideoPad}`);
  }

  // --- 3. Compile Audio Graph via the single shared `compileSequenceAudioPlan` ---
  const shouldIncludeAudio =
    compileOptions?.includeAudio !== false && compileOptions?.singleFrameAtMs === undefined;
  let audioOutPad = "[aout]";
  if (shouldIncludeAudio) {
    const audioPlan = compileSequenceAudioPlan(seq, paths, seq.stage.master_audio, {
      inputIndexOffset: ctx.nextInputIdx,
      minDurationMs: compileOptions?.minDurationMs,
      activeWindowMs: compileOptions?.activeWindowMs,
    });
    ctx.inputArgs.push(...audioPlan.inputArgs);
    ctx.filterChains.push(audioPlan.filterComplex);
    audioOutPad = audioPlan.audioOutPad;
    if (tempoOf(seq) !== 1 && audioPlan.audioOutPad) {
      const tempoPad = "[aout_tempo]";
      ctx.filterChains.push(`${audioPlan.audioOutPad}${atempoChain(tempoOf(seq))}${tempoPad}`);
      audioOutPad = tempoPad;
    }
  }

  return {
    inputArgs: ctx.inputArgs,
    filterComplex: ["sws_flags=accurate_rnd+full_chroma_int", ...ctx.filterChains].join(";"),
    videoOutPad: finalVideoPad,
    audioOutPad,
    totalDurationMs: outputDurationMs(ctx.totalDurationMs, tempoOf(seq)),
    renderWidth: ctx.renderWidth,
    renderHeight: ctx.renderHeight,
    fps: ctx.fps,
    assFilePath: ctx.assFilePaths[0] ?? null,
    assFilePaths: ctx.assFilePaths,
    hyperframesBlobs: ctx.hyperframesBlobs,
    directVideoBlobPath,
    ...(ctx.prePasses.length > 0 ? { prePasses: ctx.prePasses } : null),
    ...(ctx.compileWarnings.length > 0 ? { compileWarnings: [...ctx.compileWarnings] } : null),
  };
}
