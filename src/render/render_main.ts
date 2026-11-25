// The sequence render: overlays, segments, encode, post-render checks (split out of renderer.ts).
import fs from "node:fs";
import path from "node:path";
import {
  computeRenderDurationMs,
  computeSequenceDurationMs,
} from "../core/timeline.js";
import {
  compileSequenceRenderPlan,
  RenderPreset,
} from "../compositor/compiler.js";
import {
  beginOverlayCollect,
  beginOverlayRenderTracking,
  finishOverlayRenderTracking,
  RenderOverlaySummary,
  runCollectedOverlays,
} from "../compositor/hyperframes_bridge.js";
import { resolveDraftOverlayRes, setDraftNativeOverlayCapture } from "../compositor/hf_render.js";
import {
  type AlphaVideoCodec,
  alphaOutputExtension,
  type RenderEncoderFallback,
  resolveVideoEncoderForRender,
  type VideoEncoderCodec,
} from "./encoder.js";
import { resolveAlphaVideoCodec } from "./render_encode.js";
import {
  CutholError,
  DIAGNOSTICS,
  type CutholDiagnostic,
} from "../core/diagnostics.js";
import { beginLiveRender, failLiveRender, finishLiveRender } from "../live/live_progress.js";
import {
  resolveHyperFramesWorkers,
  resolveMaxClipsPerRenderSegment,
  resolveOverlayConcurrency,
} from "../core/env.js";
import { storedSetting } from "../core/settings.js";
import {
  enforceShaderIntermediateCap,
  listShaderIntermediateFiles,
  releaseShaderReadLocks,
  resolveShaderCacheCapGb,
} from "./pre_pass.js";

/** Default render output folder: `render.output_dir` (project scope) or `<root>/output`. */
export function resolveRenderOutputDir(rootDir: string): string {
  try {
    const stored = storedSetting(rootDir, "render.output_dir");
    if (stored && typeof stored.value === "string" && stored.value.trim()) {
      const v = stored.value.trim();
      return path.isAbsolute(v) ? v : path.resolve(rootDir, v);
    }
  } catch {
    // Unreadable settings: keep the built-in default.
  }
  return path.join(rootDir, "output");
}
import { progressBegin, progressStop } from "../core/progress.js";
import { CutholSequence } from "../core/schema.js";
import { loadSequence, WorkspacePaths } from "../core/workspace.js";
import { ffmpegVersionWarningDiagnostics } from "../core/ffmpeg_version.js";
import { verifySequence, VerificationReport } from "../verify/gates.js";
import { verifyCompositionAudio } from "../verify/gates_hf_audio.js";
import { probeUncachedCompositionScripts } from "../verify/gates_script_errors.js";
import { PostRenderAudioHealthResult, scanRenderedMp4AudioHealth } from "./render_audio_health.js";
import { PostRenderBlankScanResult, scanRenderedMp4ForBlankFrames, scanRenderedMp4ForEdgeStrips } from "./render_scan.js";
import { outputDurationMs, outputFrameAtSeqMs, tempoOf, tempoOutputSegments } from "../sequence/tempo.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import { inspectPngSequenceDir, isPngSequenceBlobDir } from "../compositor/hf_blobs.js";
import {
  snapshotOverlayRenderItems,
  type OverlayRenderItemSummary,
} from "../compositor/hf_overlay_tracking.js";
import { computeRenderTimeSegments } from "./render_segments.js";
import {
  PreparedSequenceRender,
  RenderEncodeStageResult,
  renderMultiSegmentPath,
  renderSingleSegmentPath,
} from "./render_encode.js";

export interface RenderStageTimingsMs {
  verify_ms: number;
  compile_and_overlays_ms: number;
  encode_ms: number;
  blank_scan_ms: number;
  edge_strip_scan_ms?: number;
  audio_health_ms?: number;
  total_ms: number;
}

export interface ShaderCacheSummary {
  total_before_bytes: number;
  total_after_bytes: number;
  deleted_count: number;
}

/** Per-composition capture cost, present only with the opt-in `--profile` render flag. */
export interface RenderCompositionCost {
  composition: string;
  cue_ids: string[];
  cached: boolean;
  reason: string;
  frames_captured: number | null;
  frames_source: "measured" | "expected" | "unknown";
  capture_ms: number;
  ms_per_frame: number | null;
}

/** Opt-in render cost profile: capture ms per frame and frames captured, per composition cue. */
export interface RenderCompositionProfile {
  compositions: RenderCompositionCost[];
  summary: string;
}

export interface RenderOutputSummary {
  ok: boolean;
  output_path: string;
  preset: RenderPreset;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  size_bytes: number;
  encoder: VideoEncoderCodec;
  encoder_fallback: RenderEncoderFallback | null;
  workers: number;
  single_stage: boolean;
  /** Present only when the project holds shader intermediates. */
  shader_cache?: ShaderCacheSummary;
  /** Present only with `--profile` (profiling cost is never paid on unflagged renders). */
  composition_profile?: RenderCompositionProfile;
  overlays?: RenderOverlaySummary;
  timings_ms: RenderStageTimingsMs;
  verification: VerificationReport;
  blank_scan?: PostRenderBlankScanResult;
  audio_health?: PostRenderAudioHealthResult;
}

export function countActiveUniqueCompositions(seq: CutholSequence, rootDir: string): number {
  const dirs = new Set<string>();
  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind === "composition" && cue.composition?.composition_dir) {
        const abs = path.isAbsolute(cue.composition.composition_dir)
          ? path.resolve(cue.composition.composition_dir)
          : path.resolve(rootDir, cue.composition.composition_dir);
        dirs.add(abs);
      }
    }
  }
  return dirs.size;
}

function prepareSequenceRender(options: {
  workspaceDir: string;
  outputPath?: string;
  preset?: RenderPreset;
  workers?: number;
  encoder?: string;
  overlayRes?: string;
}): PreparedSequenceRender {
  const tTotal0 = Date.now();
  const { paths, sequence } = loadSequence(options.workspaceDir);
  const tVerify0 = Date.now();
  // A render that was not preceded by `verify` still judges every composition
  // script at run time (one shared browser run; cached records cost nothing).
  probeUncachedCompositionScripts(sequence, paths);
  const verification = verifySequence(sequence, paths);
  const verifyMs = Date.now() - tVerify0;
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }
  // Render start repeats the ffmpeg/ffprobe version warning when verify did
  // not already carry it (same short WARN, never duplicated).
  for (const diag of ffmpegVersionWarningDiagnostics()) {
    if (!verification.diagnostics.some((d) => d.code === diag.code && d.what === diag.what)) {
      verification.diagnostics.push(diag);
      verification.warning_count += 1;
    }
  }
  const g205Diag = verification.diagnostics.find((d) => d.code === "CUTHOL-G205");
  if (g205Diag) {
    throw new CutholError({ ...g205Diag, severity: "ERROR" });
  }
  // An empty sequence would only produce a short clip of backdrop colour; refuse instead of writing it.
  if (computeSequenceDurationMs(sequence) <= 0) {
    throw new CutholError(DIAGNOSTICS.EMPTY_SEQUENCE("ERROR"));
  }

  const preset: RenderPreset = options.preset ?? "master_1080p";
  const workers = resolveHyperFramesWorkers(options.workers);
  const encDecision = resolveVideoEncoderForRender(options.encoder);
  const activeEncoder: VideoEncoderCodec = encDecision.encoder;
  const encoderFallback: RenderEncoderFallback | null = encDecision.fallback;

  const alphaCodec: AlphaVideoCodec | null =
    preset === "master_alpha" ? resolveAlphaVideoCodec() : null;
  const defaultExt = alphaCodec ? alphaOutputExtension(alphaCodec) : ".mp4";
  const defaultOut = path.join(
    resolveRenderOutputDir(paths.rootDir),
    `render_r${sequence.meta.revision}_${preset}${defaultExt}`
  );
  const resolvedOut = options.outputPath
    ? path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(paths.rootDir, options.outputPath)
    : defaultOut;

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.mkdirSync(paths.blobsDir, { recursive: true });
  const tmpOut = `${resolvedOut}.${process.pid}.${Date.now()}.tmp${defaultExt}`;

  // Segments are built on the sequence clock (clip/cue windows); each segment plan
  // retimes to the output clock in the compositor output stage, so frame counts
  // below are scaled to output frames while startMs/endMs stay sequence-clock.
  const seqDurationMs = computeRenderDurationMs(sequence);
  const tempoRate = tempoOf(sequence);
  const totalDurationMs = outputDurationMs(seqDurationMs, tempoRate);
  const maxItemsPerSegment = resolveMaxClipsPerRenderSegment();
  // The transparent master keeps one uninterrupted alpha pipeline: per-segment
  // intermediates are opaque MP4 and would destroy the alpha plane at the joins.
  const seqSegments =
    preset === "master_alpha"
      ? [
          {
            index: 0,
            startFrame: 0,
            endFrame: Math.max(1, Math.ceil((seqDurationMs / 1000) * Math.max(1, sequence.stage.fps))),
            frameCount: Math.max(1, Math.ceil((seqDurationMs / 1000) * Math.max(1, sequence.stage.fps))),
            startMs: 0,
            endMs: seqDurationMs,
          },
        ]
      : computeRenderTimeSegments(sequence, seqDurationMs, maxItemsPerSegment);
  // With a tempo, segment windows move to whole output frames (frame counts are
  // output frames and add up exactly; windows stay on the sequence clock).
  const segments =
    tempoRate === 1
      ? seqSegments
      : tempoOutputSegments(seqSegments, tempoRate, sequence.stage.fps, outputFrameAtSeqMs(seqDurationMs, tempoRate, sequence.stage.fps));

  const { uniqueCompCount, overlayConcurrency } = setupOverlayStage({
    sequence,
    rootDir: paths.rootDir,
    preset,
    workers,
    overlayRes: options.overlayRes,
  });
  // Live hook only: mirrors stages into .cuthol/live/progress.json (plan/output untouched).
  beginLiveRender({
    projectDir: paths.rootDir,
    preset,
    frames: Math.max(1, Math.round((totalDurationMs / 1000) * Math.max(1, sequence.stage.fps))),
    comps: uniqueCompCount,
    footageSec: totalDurationMs / 1000,
    expectOverlay: uniqueCompCount > 0,
    encoder: activeEncoder,
    workers,
    output: resolvedOut,
  });
  if (uniqueCompCount > 0) progressBegin("overlay", uniqueCompCount);

  let overlayPrepassMs = 0;
  if (uniqueCompCount >= 2 && overlayConcurrency > 1) {
    const tPrepass0 = Date.now();
    beginOverlayCollect();
    compileSequenceRenderPlan(sequence, paths, preset, { includeAudio: false, workers });
    runCollectedOverlays({ workers });
    overlayPrepassMs = Date.now() - tPrepass0;
  }

  return {
    tTotal0,
    usedShaderFiles: [],
    shaderReadReleases: [],
    paths,
    sequence,
    verification,
    verifyMs,
    preset,
    workers,
    activeEncoder,
    encoderFallback,
    resolvedOut,
    tmpOut,
    totalDurationMs,
    maxItemsPerSegment,
    segments,
    overlayPrepassMs,
  };
}

/**
 * Shared overlay-stage setup: capture size, overlay tracking. Used by the
 * render and by the Live pre-production child so both compute identical
 * overlay blob keys. Never touches the Live progress hook or the journal.
 */
export function setupOverlayStage(options: {
  sequence: CutholSequence;
  rootDir: string;
  preset: RenderPreset;
  workers?: number;
  overlayRes?: string;
}): { uniqueCompCount: number; overlayConcurrency: number } {
  const workers = resolveHyperFramesWorkers(options.workers);
  const uniqueCompCount = countActiveUniqueCompositions(options.sequence, options.rootDir);
  const overlayConcurrency = resolveOverlayConcurrency({
    workersPerOverlay: workers,
    coldOverlayCount: uniqueCompCount > 0 ? uniqueCompCount : 1,
  });
  const nativeCapture =
    options.preset === "draft_480p" && resolveDraftOverlayRes(options.overlayRes) === "native";
  setDraftNativeOverlayCapture(nativeCapture);
  beginOverlayRenderTracking({
    concurrency: overlayConcurrency,
    workers,
    nativeCaptureForMasterReuse: nativeCapture,
  });
  return { uniqueCompCount, overlayConcurrency };
}

function runPostRenderChecks(params: {
  resolvedOut: string;
  sequence: CutholSequence;
  paths: WorkspacePaths;
  totalDurationMs: number;
  maxItemsPerSegment: number;
  verification: VerificationReport;
  preset: RenderPreset;
}): {
  blankScan: PostRenderBlankScanResult;
  blankScanMs: number;
  edgeStripScanMs: number;
  audioHealth: PostRenderAudioHealthResult;
  audioHealthMs: number;
} {
  const {
    resolvedOut,
    sequence,
    paths,
    totalDurationMs,
    maxItemsPerSegment,
    verification,
    preset,
  } = params;

  // Transparent masters are intentionally blank where nothing is drawn: the
  // opaque blank-frame and edge-strip scans do not apply to alpha output.
  // Audio health still runs (the alpha file carries the normal mix).
  if (preset === "master_alpha") {
    const tAudioHealth0 = Date.now();
    const audioHealth = scanRenderedMp4AudioHealth(resolvedOut, sequence, paths, {
      maxItemsPerSegment,
    });
    const audioHealthMs = Date.now() - tAudioHealth0;
    for (const diag of audioHealth.diagnostics) {
      verification.diagnostics.push(diag);
      verification.warning_count += 1;
    }
    return {
      blankScan: {
        fps: Math.max(1, sequence.stage.fps),
        total_frames: 0,
        scan_duration_ms: 0,
        events: [],
        blank_frames_count: 0,
        blank_at_s: [],
        diagnostics: [],
      },
      blankScanMs: 0,
      edgeStripScanMs: 0,
      audioHealth,
      audioHealthMs,
    };
  }

  const tScan0 = Date.now();
  const blankScan = scanRenderedMp4ForBlankFrames(resolvedOut, sequence);
  const blankScanMs = Date.now() - tScan0;
  for (const diag of blankScan.diagnostics) {
    verification.diagnostics.push(diag);
    verification.warning_count += 1;
  }
  const tEdge0 = Date.now();
  const edgeStrip = scanRenderedMp4ForEdgeStrips(resolvedOut, totalDurationMs);
  const edgeStripScanMs = Date.now() - tEdge0;
  if (edgeStrip) {
    verification.diagnostics.push(edgeStrip);
    verification.warning_count += 1;
  }
  // Empty-composition WARN (one per cue): a transparent overlay capture that
  // drew nothing writes assets/cuthol-bbox.json with empty:true.
  const seenEmpty = new Set<string>();
  for (const lane of sequence.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition || seenEmpty.has(cue.id)) continue;
      seenEmpty.add(cue.id);
      try {
        const dir = cue.composition.composition_dir;
        const abs = path.isAbsolute(dir) ? dir : path.resolve(paths.rootDir, dir);
        const sidecar = path.join(abs, "assets/cuthol-bbox.json");
        if (!fs.existsSync(sidecar)) continue;
        const raw = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { empty?: boolean };
        if (raw?.empty === true) {
          verification.diagnostics.push(DIAGNOSTICS.EMPTY_COMPOSITION_RENDER(cue.id));
          verification.warning_count += 1;
        }
      } catch {
        // unreadable sidecar: no warning
      }
    }
  }
  const tAudioHealth0 = Date.now();
  const audioHealth = scanRenderedMp4AudioHealth(resolvedOut, sequence, paths, {
    maxItemsPerSegment,
  });
  const audioHealthMs = Date.now() - tAudioHealth0;
  for (const diag of audioHealth.diagnostics) {
    verification.diagnostics.push(diag);
    verification.warning_count += 1;
  }

  return {
    blankScan,
    blankScanMs,
    edgeStripScanMs,
    audioHealth,
    audioHealthMs,
  };
}

/**
 * Frames actually captured for one overlay blob: exact count for PNG-sequence
 * blobs, ffprobe stream metadata for video blobs, otherwise the mounted cue
 * window (duration x stage fps) labelled "expected".
 */
function profileFramesForBlob(
  blobPath: string | undefined,
  expectedFromCues: number | null
): { frames: number | null; source: RenderCompositionCost["frames_source"] } {
  try {
    if (blobPath && isPngSequenceBlobDir(blobPath)) {
      const info = inspectPngSequenceDir(blobPath);
      if (info.valid && info.frameCount > 0) {
        return { frames: info.frameCount, source: "measured" };
      }
    } else if (blobPath && fs.existsSync(blobPath) && fs.statSync(blobPath).isFile()) {
      const proc = spawnWatchedSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_frames,avg_frame_rate,duration",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          blobPath,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, step: "ffprobe-frames" }
      );
      const parsed = JSON.parse(String(proc.stdout ?? "{}")) as {
        streams?: Array<{ nb_frames?: string; avg_frame_rate?: string; duration?: string }>;
        format?: { duration?: string };
      };
      const stream = parsed.streams?.[0];
      const nb = Number(stream?.nb_frames);
      if (Number.isFinite(nb) && nb > 0) {
        return { frames: Math.round(nb), source: "measured" };
      }
      const durSec = Number(stream?.duration ?? parsed.format?.duration);
      const fpsParts = String(stream?.avg_frame_rate ?? "0/1").split("/");
      const fps = Number(fpsParts[0]) / Math.max(1, Number(fpsParts[1] ?? 1));
      if (Number.isFinite(durSec) && durSec > 0 && Number.isFinite(fps) && fps > 0) {
        return { frames: Math.max(1, Math.round(durSec * fps)), source: "measured" };
      }
    }
  } catch {
    // fall through to the cue-window estimate below
  }
  if (typeof expectedFromCues === "number" && Number.isFinite(expectedFromCues) && expectedFromCues > 0) {
    return { frames: Math.round(expectedFromCues), source: "expected" };
  }
  return { frames: null, source: "unknown" };
}

/**
 * Opt-in per-composition cost profile, built from the live overlay items before
 * the tracking map is consumed. Only called with `--profile`; without the flag
 * the render result keeps exactly its old shape.
 */
function buildCompositionProfile(
  sequence: CutholSequence,
  rootDir: string,
  items: OverlayRenderItemSummary[]
): RenderCompositionProfile {
  const fps = Math.max(1, sequence.stage.fps);
  const cuesByDir = new Map<string, { cueId: string; durationMs: number }[]>();
  for (const lane of sequence.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition?.composition_dir) continue;
      const abs = path.isAbsolute(cue.composition.composition_dir)
        ? path.resolve(cue.composition.composition_dir)
        : path.resolve(rootDir, cue.composition.composition_dir);
      const list = cuesByDir.get(abs) ?? [];
      list.push({ cueId: cue.id, durationMs: cue.duration_ms });
      cuesByDir.set(abs, list);
    }
  }
  const compositions: RenderCompositionCost[] = items.map((item) => {
    const key = path.resolve(item.composition_dir);
    const cues = cuesByDir.get(key) ?? [];
    const expectedFromCues =
      cues.length > 0 ? Math.max(...cues.map((c) => (c.durationMs / 1000) * fps)) : null;
    const { frames, source } = profileFramesForBlob(item.blob_path, expectedFromCues);
    const captureMs = item.cached ? 0 : Math.max(0, Math.round(item.elapsed_ms));
    const msPerFrame =
      !item.cached && frames !== null && frames > 0 && captureMs > 0
        ? Number((captureMs / frames).toFixed(1))
        : null;
    return {
      composition: item.composition,
      cue_ids: cues.map((c) => c.cueId).sort(),
      cached: item.cached,
      reason: item.cached ? "cached" : item.reason,
      frames_captured: frames,
      frames_source: source,
      capture_ms: captureMs,
      ms_per_frame: msPerFrame,
    };
  });
  compositions.sort((a, b) => a.composition.localeCompare(b.composition));
  const summary =
    compositions.length === 0
      ? "profile: no composition overlays"
      : `profile: ${compositions
          .map((c) =>
            c.cached
              ? `${c.composition}: cached (${c.frames_captured ?? "?"} frames, no capture this render)`
              : `${c.composition}: ${c.frames_captured ?? "?"} frames in ${c.capture_ms}ms` +
                (c.ms_per_frame !== null ? ` (${c.ms_per_frame}ms/frame)` : "") +
                `, reason ${c.reason}`
          )
          .join("; ")}`;
  return { compositions, summary };
}

function buildRenderOutputSummary(params: {
  prep: PreparedSequenceRender;
  encodeResult: RenderEncodeStageResult;
  sizeBytes: number;
  blankScan: PostRenderBlankScanResult;
  blankScanMs: number;
  edgeStripScanMs: number;
  audioHealth: PostRenderAudioHealthResult;
  audioHealthMs: number;
  withProfile: boolean;
}): RenderOutputSummary {
  const {
    prep,
    encodeResult,
    sizeBytes,
    blankScan,
    blankScanMs,
    edgeStripScanMs,
    audioHealth,
    audioHealthMs,
    withProfile,
  } = params;
  // Snapshot before finish consumes the map; without the flag nothing is read.
  const profileItems = withProfile ? snapshotOverlayRenderItems() : [];
  const overlaySummary = finishOverlayRenderTracking();
  const totalMs = Date.now() - prep.tTotal0;

  return {
    ok: true,
    output_path: prep.resolvedOut,
    preset: prep.preset,
    width: encodeResult.renderWidth,
    height: encodeResult.renderHeight,
    fps: encodeResult.fps,
    duration_ms: prep.totalDurationMs,
    size_bytes: sizeBytes,
    encoder: encodeResult.activeEncoder,
    encoder_fallback: encodeResult.encoderFallback,
    workers: prep.workers,
    single_stage: encodeResult.singleStageUsed,
    ...(withProfile
      ? {
          composition_profile: buildCompositionProfile(
            prep.sequence,
            prep.paths.rootDir,
            profileItems
          ),
        }
      : {}),
    overlays: overlaySummary,
    timings_ms: {
      verify_ms: prep.verifyMs,
      compile_and_overlays_ms: encodeResult.compileAndOverlaysMs,
      encode_ms: encodeResult.encodeMs,
      blank_scan_ms: blankScanMs,
      edge_strip_scan_ms: edgeStripScanMs,
      audio_health_ms: audioHealthMs,
      total_ms: totalMs,
    },
    verification: prep.verification,
    blank_scan: blankScan,
    audio_health: audioHealth,
  };
}

/** Short codes of the post-render scan diagnostics for the live window. */
const LIVE_SCAN_FINDINGS = new Map([
  ["CUTHOL-G502", "G502"],
  ["CUTHOL-G506", "G506"],
  ["CUTHOL-G508", "G508"],
]);

function collectLiveScanFindings(diagnostics: CutholDiagnostic[]): string[] {
  const out = new Set<string>();
  for (const d of diagnostics) {
    const short = LIVE_SCAN_FINDINGS.get(d.code);
    if (short) out.add(short);
  }
  return [...out].sort();
}

/**
 * The pre-render verification runs before plan compilation extracts the
 * composition audio stems, so its G416 "no stem extracted yet" warnings are
 * stale once the encode is done. Re-checks only the composition audio gate
 * against the post-extraction state and swaps those entries; every other
 * diagnostic is left untouched.
 */
function refreshCompositionAudioDiagnostics(
  sequence: CutholSequence,
  paths: WorkspacePaths,
  verification: VerificationReport
): void {
  if (!verification.diagnostics.some((d) => d.code === "CUTHOL-G416")) return;
  const fresh: CutholDiagnostic[] = [];
  verifyCompositionAudio(sequence, paths, fresh);
  verification.diagnostics = verification.diagnostics.filter((d) => d.code !== "CUTHOL-G416");
  verification.diagnostics.push(...fresh.filter((d) => d.code === "CUTHOL-G416"));
  verification.warning_count = verification.diagnostics.filter((d) => d.severity === "WARN").length;
  verification.info_count = verification.diagnostics.filter((d) => d.severity === "INFO").length;
}

/**
 * Releases this render's read locks, then enforces the shader intermediate
 * cap. Runs on success and on failure; never throws, so the cap can
 * never fail the render. Returns undefined when the project holds no shader
 * intermediates (the result then omits `shader_cache`).
 */
function finishShaderCacheCap(prep: PreparedSequenceRender): ShaderCacheSummary | undefined {
  try {
    releaseShaderReadLocks(prep.shaderReadReleases);
  } catch {
    // best-effort
  }
  try {
    if (listShaderIntermediateFiles(prep.paths.blobsDir).length === 0) return undefined;
    const capGb = resolveShaderCacheCapGb(prep.paths.rootDir);
    const r = enforceShaderIntermediateCap(prep.paths.blobsDir, prep.usedShaderFiles, capGb);
    const summary: ShaderCacheSummary = {
      total_before_bytes: r.totalBeforeBytes,
      total_after_bytes: r.totalAfterBytes,
      deleted_count: r.deletedCount,
    };
    if (r.deletedCount > 0) {
      const mb = (b: number): string => (b / 1024 ** 2).toFixed(1);
      prep.verification.diagnostics.push(
        DIAGNOSTICS.SHADER_CACHE_ENFORCED(r.deletedCount, mb(r.totalBeforeBytes), mb(r.totalAfterBytes))
      );
      prep.verification.info_count = prep.verification.diagnostics.filter(
        (d) => d.severity === "INFO"
      ).length;
    }
    return summary;
  } catch {
    return undefined;
  }
}

export function renderSequenceToMp4(options: {
  workspaceDir: string;
  outputPath?: string;
  preset?: RenderPreset;
  workers?: number;
  encoder?: string;
  overlayRes?: string;
  profile?: boolean;
}): RenderOutputSummary {
  let prep: PreparedSequenceRender | null = null;
  try {
    prep = prepareSequenceRender(options);

    const encodeResult =
      prep.segments.length <= 1
        ? renderSingleSegmentPath(prep)
        : renderMultiSegmentPath(prep);

    refreshCompositionAudioDiagnostics(prep.sequence, prep.paths, prep.verification);

    fs.renameSync(prep.tmpOut, prep.resolvedOut);
    const stat = fs.statSync(prep.resolvedOut);
    const diagsBeforeScans = prep.verification.diagnostics.length;
    const {
      blankScan,
      blankScanMs,
      edgeStripScanMs,
      audioHealth,
      audioHealthMs,
    } = runPostRenderChecks({
      resolvedOut: prep.resolvedOut,
      sequence: prep.sequence,
      paths: prep.paths,
      totalDurationMs: prep.totalDurationMs,
      maxItemsPerSegment: prep.maxItemsPerSegment,
      verification: prep.verification,
      preset: prep.preset,
    });
    finishLiveRender(collectLiveScanFindings(prep.verification.diagnostics.slice(diagsBeforeScans)));

    const summary = buildRenderOutputSummary({
      prep,
      encodeResult,
      sizeBytes: stat.size,
      blankScan,
      blankScanMs,
      edgeStripScanMs,
      audioHealth,
      audioHealthMs,
      withProfile: options.profile === true,
    });
    const shaderCache = finishShaderCacheCap(prep);
    if (shaderCache) summary.shader_cache = shaderCache;
    return summary;
  } catch (e) {
    if (prep) finishShaderCacheCap(prep);
    // Live mirror only: the stopping diagnostic rides the progress document so
    // the window can name the failure (the render itself still throws).
    if (e instanceof CutholError) {
      const d = e.diagnostic;
      failLiveRender({ code: d.code, message: d.what.slice(0, 300), suggestion: d.suggestion.slice(0, 300) });
    } else {
      failLiveRender({ code: "ERROR", message: String((e as Error)?.message ?? e).slice(0, 300) });
    }
    throw e;
  } finally {
    setDraftNativeOverlayCapture(false);
    progressStop();
  }
}
