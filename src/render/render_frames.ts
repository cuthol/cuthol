// Single and multiple composite frames at given times for monitor/sheet (split out of renderer.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ParallelFfmpegJob,
  type ParallelFfmpegJobResult,
  runWatchedParallelFfmpegJobsSync,
  spawnWatchedSync,
} from "../core/subprocess.js";
import {
  computeRenderDurationMs, resolveCueStartMs
} from "../core/timeline.js";
import {
  CompiledRenderPlan, compileSequenceRenderPlan,
  type PrePassJob,
  RenderPreset
} from "../compositor/compiler.js";
import {
  acquireSingleFrameReadLock,
  pruneSingleFrameShaderIntermediates,
  requirePlanPrePasses,
} from "./pre_pass.js";
import {
  createSubprocessFailureDiagnostic, CutholError, DIAGNOSTICS, estimateCommandLineLength,
  type VerificationGateId
} from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { verifySequence } from "../verify/gates.js";
import { ensurePreviewCompositeMp4 } from "./render_preview.js";

export interface CellBboxSidecarUpdate {
  bboxPath: string;
  bboxJson: string | null;
}

interface ActiveCompFrameRef {
  cueId: string;
  compFrameIdx: number;
  bboxPath: string | null;
}

interface SingleFrameFfmpegPlan {
  ffArgs: string[];
  cwd: string;
  width: number;
  height: number;
  pixelCount: number;
  durationMs: number;
  clampedMs: number;
  bboxTargets: Array<{ bboxPath: string; pngPath: string }>;
  /** Full filter graph when it is passed from a file; null when inline. */
  filterScript: string | null;
  /**
   * Shader pre-pass context for the retry path: when the single-frame
   * extract fails because its intermediate vanished, the pre-pass runs once
   * more and the extract is attempted again instead of seeking the preview
   * composite. Null for plans without shader intermediates (those keep the
   * existing preview-seek fallback).
   */
  shaderRetry: { plan: CompiledRenderPlan; cwd: string } | null;
}

export function runParallelFfmpegJobsSync(
  jobs: ParallelFfmpegJob[],
  maxBuffers: number[],
  concurrency = Math.max(2, Math.min(os.cpus().length, 12))
): ParallelFfmpegJobResult[] {
  return runWatchedParallelFfmpegJobsSync(jobs, maxBuffers, concurrency);
}

function computeAlphaBboxJsonFromRgbaBuffer(buf: Buffer, probeW = 320, probeH = 180): string | null {
  if (!buf || buf.length < probeW * probeH * 4) return null;
  let minX = probeW;
  let minY = probeH;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < probeH; y++) {
    for (let x = 0; x < probeW; x++) {
      const a = buf[(y * probeW + x) * 4 + 3];
      if (a > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return JSON.stringify(
    {
      left_pct: Number((minX / probeW).toFixed(4)),
      top_pct: Number((minY / probeH).toFixed(4)),
      right_pct: Number(((maxX + 1) / probeW).toFixed(4)),
      bottom_pct: Number(((maxY + 1) / probeH).toFixed(4)),
      width_pct: Number(((maxX - minX + 1) / probeW).toFixed(4)),
      height_pct: Number(((maxY - minY + 1) / probeH).toFixed(4)),
    },
    null,
    2
  );
}

function resolveActiveCompositionRefsAt(
  seq: CutholSequence,
  paths: WorkspacePaths,
  exactFrameMs: number,
  fps: number
): { canReuseTemplate: boolean; signature: string; refs: ActiveCompFrameRef[] } {
  const frameDurMs = 1000 / Math.max(1, fps);
  const winStart = exactFrameMs - 1e-3;
  const winEnd = exactFrameMs + frameDurMs;
  const refs: ActiveCompFrameRef[] = [];
  const sortedLanes = [...seq.lanes].sort((a, b) => a.z_index - b.z_index);

  for (const lane of sortedLanes) {
    if (lane.muted) continue;
    const orderedCues = [...lane.cues].sort(
      (a, b) => resolveCueStartMs(seq, a) - resolveCueStartMs(seq, b)
    );
    for (const cue of orderedCues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const cueStartMs = resolveCueStartMs(seq, cue);
      const cueEndMs = cueStartMs + cue.duration_ms;
      if (cueEndMs <= winStart || cueStartMs > winEnd) continue;

      const compMode = cue.composition.mode ?? "overlay_alpha";
      if (
        compMode === "scene_host" ||
        !(exactFrameMs + frameDurMs >= cueStartMs && exactFrameMs <= cueEndMs)
      ) {
        return { canReuseTemplate: false, signature: "", refs: [] };
      }

      const durationSec = Math.max(0.1, Number((cue.duration_ms / 1000).toFixed(3)));
      const totalFrames = Math.max(1, Math.round(durationSec * fps));
      const localSec = Math.max(0, (exactFrameMs - cueStartMs) / 1000);
      const compFrameIdx = Math.max(0, Math.min(totalFrames - 1, Math.floor(localSec * fps + 1e-6)));
      const absCompDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);

      refs.push({
        cueId: cue.id,
        compFrameIdx,
        bboxPath: cue.composition.transparent
          ? path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json")
          : null,
      });
    }
  }

  return {
    canReuseTemplate: true,
    signature: refs.map((r) => r.cueId).join("|"),
    refs,
  };
}

function buildSingleFrameFfmpegPlanFromCompiledPlan(
  plan: CompiledRenderPlan,
  paths: WorkspacePaths,
  fps: number,
  frameIdx: number,
  clampedMs: number,
  bboxTargets: Array<{ bboxPath: string; pngPath: string }>
): SingleFrameFfmpegPlan {
  const width = plan.renderWidth;
  const height = plan.renderHeight;
  const pixelCount = width * height;
  const snappedSec = (frameIdx / fps).toFixed(6);
  const shortDurSec = (8 / fps).toFixed(6);

  // Split inputArgs into per-input groups and strip any audio inputs
  // so single-frame extraction never decodes or mixes audio tracks.
  const inputGroups: string[][] = [];
  let curGroup: string[] = [];
  for (let i = 0; i < plan.inputArgs.length; i++) {
    const arg = plan.inputArgs[i];
    curGroup.push(arg);
    if (arg === "-i" && i + 1 < plan.inputArgs.length) {
      curGroup.push(plan.inputArgs[++i]);
      inputGroups.push(curGroup);
      curGroup = [];
    }
  }
  const audioStartIdx = inputGroups.findIndex((g) => g[g.length - 1]?.startsWith("anullsrc="));
  const videoInputGroups = audioStartIdx >= 0 ? inputGroups.slice(0, audioStartIdx) : inputGroups;

  const voutIdx = plan.filterComplex.indexOf(plan.videoOutPad);
  let videoFilterComplex =
    voutIdx >= 0
      ? plan.filterComplex.slice(0, voutIdx + plan.videoOutPad.length)
      : plan.filterComplex;

  for (let idx = 0; idx < videoInputGroups.length; idx++) {
    const g = videoInputGroups[idx];
    const loopPos = g.indexOf("-loop");
    const tPos = g.indexOf("-t");
    const frPos = g.indexOf("-framerate");
    const inputPath = g[g.length - 1];
    if (loopPos >= 0 && tPos >= 0 && frPos >= 0 && inputPath?.endsWith(".png")) {
      const fpsVal = g[frPos + 1];
      const leadFrame = Math.max(0, Math.floor(Math.max(0, frameIdx - 2) / 3) * 3);
      const leadStartSec = (leadFrame / fps).toFixed(6);
      const hfSingleFrameRe = new RegExp(
        `\\[${idx}:v\\]([^;]*?)tpad=stop_mode=clone:stop_duration=[\\d.]+,settb=AVTB,setpts=PTS-STARTPTS\\+([\\d.]+)/TB(\\[v_hf_[^\\]]+\\])`
      );
      if (hfSingleFrameRe.test(videoFilterComplex)) {
        // Decode the HyperFrames single-frame PNG once instead of re-decoding via `-loop 1`,
        // and pad for 8 frames (`shortDurSec`) so `frameIdx - leadFrame <= 4` never hits EOF on `3k + 1` frames.
        videoInputGroups[idx] = ["-framerate", fpsVal, "-i", inputPath];
        videoFilterComplex = videoFilterComplex.replace(
          hfSingleFrameRe,
          (_m, midFilters: string, cueStartSecStr: string, outPad: string) => {
            const localSecVal = Math.max(0, Number(snappedSec) - Number(cueStartSecStr)).toFixed(6);
            return `[${idx}:v]settb=AVTB,setpts=PTS+${localSecVal}/TB,${midFilters}tpad=stop_mode=clone:stop_duration=${shortDurSec},settb=AVTB,setpts=PTS-STARTPTS+${leadStartSec}/TB${outPad}`;
          }
        );
      }
    }
  }

  const optimizedInputArgs = videoInputGroups.flat();
  const filterWithSelect = `${videoFilterComplex};${plan.videoOutPad}trim=start=${snappedSec},setpts=PTS-STARTPTS,scale=in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24[v_single_out]`;
  const { args: filterArgs, filterScript } = singleFrameFilterArgs(filterWithSelect, optimizedInputArgs);

  return {
    ffArgs: [
      "-v",
      "error",
      ...optimizedInputArgs,
      ...filterArgs,
      "-map",
      "[v_single_out]",
      "-t",
      shortDurSec,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    cwd: paths.rootDir,
    width,
    height,
    pixelCount,
    durationMs: plan.totalDurationMs,
    clampedMs,
    bboxTargets,
    filterScript,
    shaderRetry: null,
  };
}

/**
 * Long graphs exceed the Windows command-line limit (see the render path in
 * `render_encode.ts`): they are passed from a file (`-/filter_complex <file>`).
 * The placeholder is replaced with the real path by the caller, which owns
 * the ffmpeg run and deletes the file afterwards.
 */
export function singleFrameFilterArgs(
  filterWithSelect: string,
  optimizedInputArgs: string[]
): { args: string[]; filterScript: string | null } {
  const useFilterScript =
    filterWithSelect.length > 4000 ||
    estimateCommandLineLength("ffmpeg", optimizedInputArgs) + filterWithSelect.length > 12000;
  if (!useFilterScript) return { args: ["-filter_complex", filterWithSelect], filterScript: null };
  return { args: ["-/filter_complex", "__CUTHOL_SINGLE_FRAME_FILTER__"], filterScript: filterWithSelect };
}

/**
 * Renders multiple composite frames at `timestampsMs` in parallel through a CPU-bounded async
 * FFmpeg process pool while preserving bit-for-bit identical output to `renderSingleCompositeFrameRgb24`.
 */
export function renderMultipleCompositeFramesRgb24(
  seq: CutholSequence,
  paths: WorkspacePaths,
  timestampsMs: number[],
  preset: RenderPreset = "draft_480p",
  options?: { skipGates?: VerificationGateId[]; singleFrameEarlyTrim?: boolean }
): Array<{
  rgbBuf: Buffer;
  width: number;
  height: number;
  durationMs: number;
  clampedMs: number;
  bboxUpdates: CellBboxSidecarUpdate[];
}> {
  if (timestampsMs.length === 0) return [];

  // The monitor frame/sheet path renders instants of an already-open project;
  // asset checks (G2) re-probe every library file and dominate the run, so the
  // frame caller skips them while schema and timing gates still run.
  const skipGates = new Set<VerificationGateId>(options?.skipGates ?? []);
  const frameGates: VerificationGateId[] = (["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"] as const).filter(
    (g) => !skipGates.has(g)
  );
  const verification = verifySequence(seq, paths, frameGates);
  if (!verification.ok) {
    const firstErr = verification.diagnostics.find((d) => d.severity === "ERROR")!;
    throw new CutholError(firstErr);
  }

  const totalDurationMs = computeRenderDurationMs(seq);
  const fps = Math.max(1, seq.stage.fps);
  const lastFrameIdx = Math.max(0, Math.floor((totalDurationMs / 1000) * fps - 1));
  const maxSafeMs = Math.max(0, Math.floor(lastFrameIdx * (1000 / fps)));
  const frameDurMs = 1000 / fps;

  // Single-frame shader intermediates of this batch (for the end-of-batch
  // prune): read locks are held on each from its pre-pass until every
  // extract finishes, so neither this batch's own prune nor a concurrent
  // process deletes a file this batch still reads.
  const batchShaderJobs: PrePassJob[] = [];
  const releaseReadLocks: Array<() => void> = [];
  const plans: SingleFrameFfmpegPlan[] = timestampsMs.map((atMs) => {
    // Snap from the raw request, not the rounded clamp: rounding first can
    // push a timestamp inside frame N onto frame N+1 across a cue boundary.
    const frameIdx = Math.max(0, Math.min(lastFrameIdx, Math.floor((atMs / 1000) * fps + 1e-6)));
    const exactFrameMs = (frameIdx * 1000) / fps;

    const activeInfo = resolveActiveCompositionRefsAt(seq, paths, exactFrameMs, fps);
    const compiledPlan = compileSequenceRenderPlan(seq, paths, preset, {
      activeWindowMs: [exactFrameMs, exactFrameMs + frameDurMs],
      singleFrameAtMs: exactFrameMs,
      includeAudio: false,
      singleFrameEarlyTrim: options?.singleFrameEarlyTrim,
    });
    // Read locks go on before the pre-pass, not after it: the window
    // between a producer finishing (rename, producer lock released) and this
    // process taking its read lock is exactly where a concurrent prune used
    // to delete the fresh file. The lock file is per-pid and independent of
    // the intermediate's existence, so a concurrent prune always sees a
    // live reader from here until every extract finishes.
    const cellShaderJobs = (compiledPlan.prePasses ?? []).filter(
      (job) => job.kind === "shader" && /^sh_fxshad1_.+\.nut$/.test(path.basename(job.outPath))
    );
    for (const job of cellShaderJobs) {
      releaseReadLocks.push(acquireSingleFrameReadLock(job.outPath));
      batchShaderJobs.push(job);
    }
    // Deferred prune: every cell shades its own intermediate before any
    // extract runs, so no cell ever reads a sibling's pruned file (the
    // fallback full-preview render it used to trigger picked neighbouring
    // frames on VFR sources).
    requirePlanPrePasses(
      compiledPlan,
      { cwd: paths.rootDir, step: "ffmpeg pre-pass", deferSingleFramePrune: true },
      "monitor frame"
    );

    const bboxTargets: Array<{ bboxPath: string; pngPath: string }> = [];
    if (
      timestampsMs.length > 1 &&
      activeInfo.canReuseTemplate &&
      compiledPlan.hyperframesBlobs.length === activeInfo.refs.length
    ) {
      for (let k = 0; k < activeInfo.refs.length; k++) {
        const bboxPath = activeInfo.refs[k].bboxPath;
        const pngPath = compiledPlan.hyperframesBlobs[k];
        if (bboxPath && pngPath) {
          bboxTargets.push({ bboxPath, pngPath });
        }
      }
    }

    // The label time must be the drawn frame-grid instant, not the rounded
    // request: `annotateRgb24BufferToCanvas` derives `active_handles` from it,
    // so a rounded label could name the cue on the other side of a boundary.
    const singlePlan = buildSingleFrameFfmpegPlanFromCompiledPlan(
      compiledPlan,
      paths,
      fps,
      frameIdx,
      exactFrameMs,
      bboxTargets
    );
    singlePlan.shaderRetry =
      cellShaderJobs.length > 0 ? { plan: compiledPlan, cwd: paths.rootDir } : null;
    return singlePlan;
  });

  const bboxJsonByPng = new Map<string, string | null>();
  const uncachedBboxPngs: string[] = [];
  const bboxPngSet = new Set<string>();
  for (const p of plans) {
    for (const bt of p.bboxTargets) {
      if (bboxPngSet.has(bt.pngPath)) continue;
      bboxPngSet.add(bt.pngPath);
      const cachedBboxFile = `${bt.pngPath}.bbox.json`;
      if (fs.existsSync(cachedBboxFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(cachedBboxFile, "utf8"));
          bboxJsonByPng.set(bt.pngPath, parsed.bboxJson ?? null);
          continue;
        } catch {
          // recompute below
        }
      }
      uncachedBboxPngs.push(bt.pngPath);
    }
  }

  // Materialize long filter graphs to files so the command line stays short.
  const filterScriptPaths: string[] = [];
  try {
    fs.mkdirSync(paths.blobsDir, { recursive: true });
  } catch {
    // fall back to the OS temp dir below
  }
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (p.filterScript === null) continue;
    let scriptPath = "";
    try {
      scriptPath = path.join(
        paths.blobsDir,
        `single_frame_${process.pid}_${Date.now()}_${i}.filter.txt`
      );
      fs.writeFileSync(scriptPath, p.filterScript, "utf8");
    } catch {
      scriptPath = path.join(
        os.tmpdir(),
        `cuthol_single_frame_${process.pid}_${Date.now()}_${i}.filter.txt`
      );
      fs.writeFileSync(scriptPath, p.filterScript, "utf8");
    }
    filterScriptPaths.push(scriptPath);
    const at = p.ffArgs.indexOf("__CUTHOL_SINGLE_FRAME_FILTER__");
    if (at >= 0) p.ffArgs[at] = scriptPath;
  }

  const frameJobs: ParallelFfmpegJob[] = plans.map((p) => ({ args: p.ffArgs, cwd: p.cwd }));
  const bboxJobs: ParallelFfmpegJob[] = uncachedBboxPngs.map((pngPath) => ({
    args: [
      "-v",
      "error",
      "-i",
      pngPath,
      "-vf",
      "scale=320:180:flags=neighbor,format=rgba",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    cwd: paths.rootDir,
  }));

  const allJobs = [...frameJobs, ...bboxJobs];
  const allMaxBuffers = [
    ...plans.map((p) => p.pixelCount * 4 + 2 * 1024 * 1024),
    ...uncachedBboxPngs.map(() => 320 * 180 * 4 + 65536),
  ];
  // Test hook (env only, no API change): drop every batch intermediate after
  // the pre-pass and before the extracts, forcing the shader retry path.
  // The old build ignores this variable and falls back to the preview seek.
  if (process.env.CUTHOL_TEST_DROP_SHADER_INTERMEDIATE) {
    for (const j of batchShaderJobs) {
      try {
        fs.unlinkSync(j.outPath);
      } catch {
        // already gone
      }
    }
  }
  const allResults: ParallelFfmpegJobResult[] = runParallelFfmpegJobsSync(allJobs, allMaxBuffers);
  const jobResults = allResults.slice(0, plans.length);
  const bboxResults = allResults.slice(plans.length);

  for (let i = 0; i < uncachedBboxPngs.length; i++) {
    const r = bboxResults[i];
    const bboxJson =
      r && r.status === 0 ? computeAlphaBboxJsonFromRgbaBuffer(r.stdout, 320, 180) : null;
    const pngPath = uncachedBboxPngs[i];
    bboxJsonByPng.set(pngPath, bboxJson);
    try {
      fs.writeFileSync(`${pngPath}.bbox.json`, JSON.stringify({ bboxJson }), "utf8");
    } catch {
      // ignore cache write error
    }
  }

  let fallbackMp4Path: string | null = null;
  let mapped: Array<{
    rgbBuf: Buffer;
    width: number;
    height: number;
    durationMs: number;
    clampedMs: number;
    bboxUpdates: CellBboxSidecarUpdate[];
  }>;
  try {
    mapped = plans.map((p, idx) => {
    const bboxUpdates: CellBboxSidecarUpdate[] = p.bboxTargets.map((bt) => ({
      bboxPath: bt.bboxPath,
      bboxJson: bboxJsonByPng.get(bt.pngPath) ?? null,
    }));

    let res = jobResults[idx];
    if (
      p.shaderRetry &&
      (!res || res.status !== 0 || res.error || !res.stdout || res.stdout.length < p.pixelCount * 3)
    ) {
      // The shader intermediate vanished between the pre-pass and the
      // extract (a concurrent prune won the race): re-run the pre-pass for
      // the missing intermediate once and extract again. A neighbouring
      // frame from the h264 preview composite is never substituted here —
      // on VFR sources that seek lands on the wrong frame.
      requirePlanPrePasses(p.shaderRetry.plan, { cwd: p.shaderRetry.cwd, step: "ffmpeg pre-pass" }, "monitor frame");
      const retryProc = spawnWatchedSync("ffmpeg", p.ffArgs, {
        cwd: p.cwd,
        maxBuffer: p.pixelCount * 4 + 2 * 1024 * 1024,
        step: "ffmpeg single frame extract",
      });
      res = {
        status: retryProc.status,
        stdout: (retryProc.stdout as Buffer) ?? Buffer.alloc(0),
        stderr: retryProc.stderr ? String(retryProc.stderr) : "",
        error: retryProc.error,
        stalled: retryProc.stalled,
        stalledMs: retryProc.stalledMs,
        stallThresholdMs: retryProc.stallThresholdMs,
        lastProgress: retryProc.lastProgress,
        commandSummary: retryProc.commandSummary,
      };
      if (
        res.status !== 0 ||
        res.error ||
        !res.stdout ||
        res.stdout.length < p.pixelCount * 3
      ) {
        throw new CutholError(
          DIAGNOSTICS.SHADER_SINGLE_FRAME_LOST(
            p.clampedMs,
            (typeof res.stderr === "string" && res.stderr.slice(-240)) || `exit ${res.status}`
          )
        );
      }
    }
    if (res && res.status === 0 && !res.error && res.stdout && res.stdout.length >= p.pixelCount * 3) {
      return {
        rgbBuf: res.stdout.subarray(0, p.pixelCount * 3),
        width: p.width,
        height: p.height,
        durationMs: p.durationMs,
        clampedMs: p.clampedMs,
        bboxUpdates,
      };
    }

    if (res?.error) {
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg single frame extract",
          executable: "ffmpeg",
          args: p.ffArgs,
          proc: {
            status: res.status,
            error: res.error,
            stderr: res.stderr,
            stalled: res.stalled,
            stalledMs: res.stalledMs,
            stallThresholdMs: res.stallThresholdMs,
            lastProgress: res.lastProgress,
            commandSummary: res.commandSummary,
          },
          clipCount: seq.spine.clips.length,
          fallbackDetail: "single frame extract failed",
        })
      );
    }

    if (!fallbackMp4Path) {
      fallbackMp4Path = ensurePreviewCompositeMp4(seq, paths, preset).mp4Path;
    }
    const fallbackArgs = [
      "-v",
      "error",
      "-ss",
      (p.clampedMs / 1000).toFixed(3),
      "-i",
      fallbackMp4Path,
      "-vf",
      "scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ];
    const fallbackProc = spawnWatchedSync("ffmpeg", fallbackArgs, {
      maxBuffer: p.pixelCount * 4 + 1024 * 1024,
      step: "ffmpeg single frame extract",
    });
    const fbBuf = fallbackProc.stdout as Buffer;
    if (fallbackProc.status !== 0 || fallbackProc.error || !fbBuf || fbBuf.length < p.pixelCount * 3) {
      throw new CutholError(
        createSubprocessFailureDiagnostic({
          tool: "ffmpeg single frame extract",
          executable: "ffmpeg",
          args: fallbackArgs,
          proc: fallbackProc,
          clipCount: seq.spine.clips.length,
          fallbackDetail: res?.stderr || "extract failed",
        })
      );
    }
    return {
      rgbBuf: fbBuf.subarray(0, p.pixelCount * 3),
      width: p.width,
      height: p.height,
      durationMs: p.durationMs,
      clampedMs: p.clampedMs,
      bboxUpdates,
    };
    });
  } finally {
    for (const scriptPath of filterScriptPaths) {
      try {
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      } catch {
        // ignore cleanup error
      }
    }
    for (const release of releaseReadLocks) {
      try {
        release();
      } catch {
        // ignore lock release error
      }
    }
    // Prune once the whole batch is read: sibling files this batch needed
    // survive the run, and concurrent batches hold their own read locks.
    try {
      pruneSingleFrameShaderIntermediates(batchShaderJobs);
    } catch {
      // prune is best-effort
    }
  }
  return mapped;
}

/**
 * Renders a single composite frame at `atMs` through the exact same `compileSequenceRenderPlan`
 * filtergraph as full `render` (preserving `xfade` dissolves, keyframe envelopes, B-roll lanes,
 * and `.ass` subtitles), while skipping compositions outside `atMs` and capturing only a single
 * frame-grid-snapped RGBA PNG for any uncached composition active at `atMs`.
 */
export function renderSingleCompositeFrameRgb24(
  seq: CutholSequence,
  paths: WorkspacePaths,
  atMs: number,
  preset: RenderPreset = "draft_480p",
  options?: { skipGates?: VerificationGateId[] }
): { rgbBuf: Buffer; width: number; height: number; durationMs: number; clampedMs: number } {
  const res = renderMultipleCompositeFramesRgb24(seq, paths, [atMs], preset, options)[0];
  return {
    rgbBuf: res.rgbBuf,
    width: res.width,
    height: res.height,
    durationMs: res.durationMs,
    clampedMs: res.clampedMs,
  };
}
