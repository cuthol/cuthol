// Frame sampling for colour measurement (owner: measurement). Decodes an item's source frames through the
// input transform, BT.709 to encoded RGB, downscaled; optionally after the colour stage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWatchedParallelFfmpegJobsSync, spawnWatchedSync, type ParallelFfmpegJob } from "../core/subprocess.js";
import { loadSequence } from "../core/workspace.js";
import { itemColorProgram, listColorItems } from "./blocks.js";
import type { ColorFrameSet } from "./types.js";
import type { CutholSequence } from "../core/schema.js";
import { probeStandaloneVideoColorMetadata, resolveSourceColorSpec } from "../library/probe.js";
import { buildSourceScaleFilter } from "../compositor/compile_color.js";
import { inputTransformFilters } from "./input_transform.js";

export interface SampleItemFramesOptions {
  workspaceDir: string;
  /** Spine clip or lane cue id. */
  itemId: string;
  /** Number of frames spread over the item (default 7; 5..9). Ignored when `atMs` is given. */
  count?: number;
  /** Item-local instants to sample. */
  atMs?: number[];
  /** Output width in pixels (default 256; height keeps the aspect). */
  width?: number;
  /** `source` = before the colour stage (default), `graded` = after it (the item's compiled LUT applied). */
  stage?: "source" | "graded";
}

interface ItemMedia {
  file: string;
  startMs: number;
  durationMs: number;
  fps: number;
  asset?: CutholSequence["library"][number];
}

interface FileProbe {
  key: string;
  durationMs: number;
  srcW: number;
  srcH: number;
}

/** Per-file probe cache for the command: one ffprobe per file, not one per frame. */
const fileProbeCache = new Map<string, FileProbe>();

function cacheKeyFor(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${path.resolve(file)}|${st.size}|${st.mtimeMs}`;
  } catch {
    return path.resolve(file);
  }
}

function probeFileCached(file: string): FileProbe {
  const key = cacheKeyFor(file);
  const hit = fileProbeCache.get(key);
  if (hit) return hit;
  const probed = spawnWatchedSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height", "-of", "json", file],
    { encoding: "utf8", windowsHide: true }
  );
  let durMs = NaN;
  let srcW = 0;
  let srcH = 0;
  try {
    const parsed = JSON.parse(String(probed.stdout ?? "{}")) as {
      format?: { duration?: unknown };
      streams?: Array<{ width?: unknown; height?: unknown }>;
    };
    durMs = Number(parsed.format?.duration) * 1000;
    srcW = Number(parsed.streams?.[0]?.width);
    srcH = Number(parsed.streams?.[0]?.height);
  } catch { /* fall through to defaults */ }
  const got: FileProbe = {
    key,
    durationMs: Number.isFinite(durMs) && durMs > 0 ? durMs : 10000,
    srcW: srcW || 16,
    srcH: srcH || 9,
  };
  fileProbeCache.set(key, got);
  return got;
}

function probeDurationMs(file: string): number {
  return probeFileCached(file).durationMs;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".svg"]);

/**
 * True when the file is a still image (not a timed video): sampling any media time must decode the
 * still frame at 0. A still has no time axis, so seeking past 0 decodes nothing and the old code
 * failed with `short frame buffer 0 < ...` (seen on k2 `sp_01`, a PNG spine clip).
 */
function isStillImageFile(file: string, asset?: CutholSequence["library"][number]): boolean {
  if (IMAGE_EXTS.has(path.extname(file).toLowerCase())) return true;
  const probe = asset?.probe as { fps?: number; video_codec?: string | null; duration_ms?: number } | undefined;
  if (!probe) return false;
  if (probe.fps === 0) return true;
  const codec = (probe.video_codec ?? "").toLowerCase();
  if (["png", "mjpeg", "webp", "bmp", "gif"].includes(codec)) return true;
  return false;
}

function resolveItemMedia(workspaceDir: string, itemId: string): ItemMedia {
  const seq = loadSequence(workspaceDir).sequence;
  const clips = seq.spine.clips;
  const clipIdx = clips.findIndex((c: any) => c.id === itemId);
  let assetHandle: string | undefined;
  let startMs = 0;
  let durationMs = 0;
  if (clipIdx >= 0) {
    const c = clips[clipIdx];
    assetHandle = c.asset_handle;
    startMs = c.source_in_ms ?? 0;
    durationMs = c.duration_ms;
  } else {
    for (const lane of seq.lanes) {
      const cue = lane.cues.find((q: any) => q.id === itemId);
      if (cue) {
        assetHandle = cue.asset_handle;
        startMs = cue.source_in_ms ?? 0;
        durationMs = cue.duration_ms || 5000;
        break;
      }
    }
  }
  if (!assetHandle) throw new Error(`unknown item '${itemId}'`);
  const asset = seq.library.find((a: any) => a.handle === assetHandle);
  const uri = (asset as { uri?: string } | undefined)?.uri ?? assetHandle;
  const file = path.isAbsolute(uri) ? uri : path.join(workspaceDir, uri);
  if (!fs.existsSync(file)) throw new Error(`asset file missing '${file}'`);
  const dur = probeDurationMs(file);
  if (!(durationMs > 0)) durationMs = dur;
  const fpsRaw = (asset as { probe?: { fps?: unknown } } | undefined)?.probe?.fps;
  const fps = typeof fpsRaw === "number" && Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 30;
  return { file, startMs, durationMs, fps, asset: asset as CutholSequence["library"][number] | undefined };
}

/** Clamp an absolute media time to the decodable range; stills always sample at 0. */
function clampAtSec(file: string, atSec: number, asset?: CutholSequence["library"][number]): number {
  if (isStillImageFile(file, asset)) return 0;
  if (!(atSec > 0)) return 0;
  const durSec = probeDurationMs(file) / 1000;
  if (atSec >= durSec) return Math.max(0, durSec - 0.05);
  return atSec;
}

/** The shared colour decode filter chain for one file (identical to the render's source path). */
function decodeFilter(file: string, width: number, asset?: CutholSequence["library"][number]): string {
  const colorProbe = asset?.probe ?? probeStandaloneVideoColorMetadata(file);
  // No full-range pin (`fitPixFmt`) in measurement decodes: the render graph needs it so the range
  // conversion does not move with later filters, but here a `yuvj*` frame is converted to RGB once,
  // and splitting that into two default-precision steps moves the measured colours (measured on a
  // full-range phone clip: Lab chroma median 1.42 → 2.39 against an exact decode at 1.04).
  const spec = { ...resolveSourceColorSpec(colorProbe, file), fitPixFmt: undefined };
  const pre = asset ? inputTransformFilters(asset) : [];
  return [
    ...pre,
    spec.isRgb
      ? `scale=${width}:-2`
      : `${buildSourceScaleFilter(width, -2, spec)},scale=in_color_matrix=bt709:in_range=tv:out_range=full`,
  ].join(",");
}

/**
 * Decode one frame at `atSec` (absolute media seconds) to rgb24 raw at `width` px wide, through the same colour
 * path as the render: input transform (HDR to SDR), the source's own matrix and range to BT.709 TV range, then
 * BT.709 to full-range RGB. `asset` gives the probe of a library item; files outside the library are probed.
 */
export function decodeFrameRgb24(
  file: string,
  atSec: number,
  width: number,
  asset?: CutholSequence["library"][number]
): { width: number; height: number; data: Buffer } {
  return decodeFramesBatch(file, [atSec], width, asset)[0];
}

/**
 * Decode several frames of one file: one `-ss <t>` input seek per frame (input-side, so no
 * decode-from-start scan) sharing the decode filter chain, chunked into small jobs that run in
 * parallel. Input seeking is frame-accurate (ffmpeg seeks to the keyframe then decodes forward to
 * `t`), so the decoded pixels are the same frames the old one-process-per-frame output seek chose.
 */
export function decodeFramesBatch(
  file: string,
  atSecs: number[],
  width: number,
  asset?: CutholSequence["library"][number]
): Array<{ width: number; height: number; data: Buffer }> {
  if (!atSecs.length) return [];
  const m = decodeFramesBatchMany([{ key: "\0", file, atSecs, width, asset }]);
  return m.get("\0")!;
}

interface BatchRequest {
  key: string;
  file: string;
  atSecs: number[];
  width: number;
  asset?: CutholSequence["library"][number];
}

/**
 * Decode frames of several files at once: one ffmpeg process per file (each with input-side seeks for
 * all its frames), files in parallel bounded by the CPU count. Jobs that share a file share the decode.
 */
export function decodeFramesBatchMany(reqs: BatchRequest[]): Map<string, Array<{ width: number; height: number; data: Buffer }>> {
  const out = new Map<string, Array<{ width: number; height: number; data: Buffer }>>();
  if (!reqs.length) return out;
  // Small jobs (few inputs each): one giant multi-input ffmpeg fans out to dozens of decoder
  // threads, and several of those side by side thrash the CPUs. Chunks of 4 stay fast alone and
  // schedule well across files through the CPU-bounded parallel runner.
  const CHUNK = 4;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-frames-"));
  try {
    const jobs: ParallelFfmpegJob[] = [];
    const maxBuffers: number[] = [];
    const outs: string[][] = [];
    const heights: number[] = [];
    const clocks: number[][] = [];
    for (const r of reqs) {
      const probed = probeFileCached(r.file);
      const vf = decodeFilter(r.file, r.width, r.asset);
      const h = Math.max(2, Math.round((probed.srcH * r.width) / probed.srcW / 2) * 2);
      const clampedAll = r.atSecs.map((t) => clampAtSec(r.file, Math.max(0, t), r.asset));
      (r as BatchRequest & { clamped?: number[] }).clamped = clampedAll;
      for (let c = 0; c < clampedAll.length; c += CHUNK) {
        const clamped = clampedAll.slice(c, c + CHUNK);
        const dir = fs.mkdtempSync(path.join(tmpRoot, "job-"));
        const files = clamped.map((_, i) => path.join(dir, `f${i}.raw`));
        // Cap decoder threads per input: one multi-input process fans out to dozens of threads,
        // and a dozen such processes side by side thrash the CPUs. Pixels are unaffected
        // (verified byte-identical with and without the cap).
        const args: string[] = ["-v", "error", "-y"];
        for (const t of clamped) args.push("-threads", "2", "-ss", String(t), "-i", r.file);
        clamped.forEach((_, i) => {
          args.push("-map", `${i}:v`, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", files[i]);
        });
        heights.push(h);
        outs.push(files);
        clocks.push(clamped);
        jobs.push({ args, cwd: process.cwd(), step: "ffmpeg frame sample" });
        maxBuffers.push(256 * 1024 * 1024);
      }
    }
    const results = runWatchedParallelFfmpegJobsSync(jobs, maxBuffers);
    // Jobs were chunked per file; reassemble in request order.
    const perReq: Array<{ r: BatchRequest; h: number; expect: number; frames: Array<{ width: number; height: number; data: Buffer }> }> =
      reqs.map((r) => {
        const h0 = Math.max(2, Math.round((probeFileCached(r.file).srcH * r.width) / probeFileCached(r.file).srcW / 2) * 2);
        return { r, h: h0, expect: r.width * h0 * 3, frames: [] };
      });
    let ji = 0;
    for (let ri = 0; ri < reqs.length; ri++) {
      const slot = perReq[ri];
      const clampedAll = (slot.r as BatchRequest & { clamped?: number[] }).clamped ?? slot.r.atSecs;
      for (let c = 0; c < clampedAll.length; c += CHUNK) {
        const res = results[ji];
        const files = outs[ji];
        const h = heights[ji];
        const chunkTimes = clocks[ji];
        if (res.status !== 0) {
          const detail = String(res.stderr ?? res.error ?? "").trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300);
          throw new Error(
            `ffmpeg frame decode failed for '${slot.r.file}' at [${chunkTimes.map((t) => t.toFixed(3)).join(", ")}]s (${detail || `exit ${res.status}`})`
          );
        }
        files.forEach((f, i) => {
          const buf = fs.readFileSync(f);
          if (buf.length < slot.expect) {
            throw new Error(
              `short frame buffer ${buf.length} < ${slot.expect} for '${slot.r.file}' at ${chunkTimes[i].toFixed(3)}s (width ${slot.r.width}, height ${h}); the seek landed past the last frame`
            );
          }
          slot.frames.push({ width: slot.r.width, height: h, data: buf.subarray(0, slot.expect) });
        });
        ji++;
      }
      out.set(slot.r.key, slot.frames);
    }
    return out;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function toFrameSet(frames: Array<{ width: number; height: number; data: Buffer }>, atMs: number[], stage: "source" | "graded"): ColorFrameSet {
  const width = frames[0].width;
  const height = frames[0].height;
  return {
    width,
    height,
    at_ms: atMs,
    stage,
    frames: frames.map((f) => {
      const out = new Float32Array(f.data.length);
      for (let i = 0; i < f.data.length; i++) out[i] = f.data[i] / 255;
      return out;
    }),
  };
}

export function frameSetSamples(set: ColorFrameSet, maxPerFrame = 2048): Float32Array {
  const per = Math.min(maxPerFrame, Math.floor(set.frames[0].length / 3));
  const out = new Float32Array(set.frames.length * per * 3);
  let o = 0;
  for (const fr of set.frames) {
    const n = Math.floor(fr.length / 3);
    const step = Math.max(1, Math.floor(n / per));
    let taken = 0;
    for (let i = 0; i < n && taken < per; i += step, taken++) {
      out[o++] = fr[i * 3]; out[o++] = fr[i * 3 + 1]; out[o++] = fr[i * 3 + 2];
    }
  }
  return out.subarray(0, o);
}

function applyStageInPlace(set: ColorFrameSet, workspaceDir: string, itemId: string): void {
  const seq = loadSequence(workspaceDir).sequence;
  const item = listColorItems(seq).find((c: any) => c.id === itemId);
  if (!item) throw new Error(`unknown item '${itemId}'`);
  const { fn } = itemColorProgram(seq, workspaceDir, item);
  const p: [number, number, number] = [0, 0, 0];
  for (const fr of set.frames) {
    for (let i = 0; i < fr.length; i += 3) {
      p[0] = fr[i]; p[1] = fr[i + 1]; p[2] = fr[i + 2];
      fn(p);
      fr[i] = p[0]; fr[i + 1] = p[1]; fr[i + 2] = p[2];
    }
  }
}

function localsFor(media: ItemMedia, count?: number, atMs?: number[]): number[] {
  if (atMs && atMs.length > 0) return [...atMs];
  const n = Math.max(5, Math.min(9, Math.round(count ?? 7)));
  const locals: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = 0.05 + (0.9 * i) / Math.max(1, n - 1);
    locals.push(f * media.durationMs);
  }
  return locals;
}

export function sampleItemFrames(opts: SampleItemFramesOptions): ColorFrameSet {
  return sampleItemFramesMany(opts.workspaceDir, [opts.itemId], opts)[0];
}

/**
 * Sample several items at once, sharing one ffmpeg process per source file and decoding files in
 * parallel. Returns one frame set per requested id, in order. Times and pixels match `sampleItemFrames`.
 */
export function sampleItemFramesMany(
  workspaceDir: string,
  itemIds: string[],
  opts?: { count?: number; atMs?: number[]; width?: number; stage?: "source" | "graded" }
): ColorFrameSet[] {
  const width = Math.max(32, Math.min(512, Math.round(opts?.width ?? 256)));
  const stage = opts?.stage ?? "source";
  const medias = itemIds.map((id) => ({ id, media: resolveItemMedia(workspaceDir, id) }));
  const localsById = new Map<string, number[]>();
  for (const { id, media } of medias) localsById.set(id, localsFor(media, opts?.count, opts?.atMs));
  // Group by file so items cut from the same source share one decode pass.
  const byFile = new Map<string, { file: string; width: number; asset?: CutholSequence["library"][number]; atSecs: number[]; slots: Array<{ id: string; idx: number }> }>();
  for (const { id, media } of medias) {
    const locals = localsById.get(id)!;
    const atSecs = locals.map((lm) => (media.startMs + lm) / 1000);
    const key = `${path.resolve(media.file)}|${width}`;
    let g = byFile.get(key);
    if (!g) {
      g = { file: media.file, width, asset: media.asset, atSecs: [], slots: [] };
      byFile.set(key, g);
    }
    for (let i = 0; i < atSecs.length; i++) g.slots.push({ id, idx: g.atSecs.length + i });
    g.atSecs.push(...atSecs);
  }
  const reqs: BatchRequest[] = [...byFile.entries()].map(([key, g]) => ({ key, file: g.file, atSecs: g.atSecs, width: g.width, asset: g.asset }));
  const decoded = decodeFramesBatchMany(reqs);
  const framesById = new Map<string, Array<{ width: number; height: number; data: Buffer }>>();
  for (const [key, g] of byFile) {
    const frames = decoded.get(key)!;
    for (const s of g.slots) {
      let arr = framesById.get(s.id);
      if (!arr) { arr = []; framesById.set(s.id, arr); }
      arr.push(frames[s.idx]);
    }
  }
  return itemIds.map((id) => {
    const set = toFrameSet(framesById.get(id)!, localsById.get(id)!, "source");
    if (stage === "graded") {
      applyStageInPlace(set, workspaceDir, id);
      set.stage = "graded";
    }
    return set;
  });
}

/** Frames of a reference file outside the timeline: an image (one frame) or a video (`count` frames). */
export function loadReferenceFrames(file: string, opts?: { width?: number; count?: number }): ColorFrameSet {
  const width = Math.max(32, Math.min(1920, Math.round(opts?.width ?? 256)));
  const ext = path.extname(file).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(ext);
  if (isImage) {
    const f = decodeFrameRgb24(file, 0, width);
    return toFrameSet([f], [0], "source");
  }
  const dur = probeDurationMs(file);
  const count = Math.max(5, Math.min(9, Math.round(opts?.count ?? 7)));
  const atMs: number[] = [];
  for (let i = 0; i < count; i++) atMs.push(((0.05 + (0.9 * i) / Math.max(1, count - 1)) * dur));
  const clamped = atMs.map((m) => clampAtSec(file, m / 1000));
  const decoded = decodeFramesBatch(file, clamped, width);
  return toFrameSet(decoded, atMs, "source");
}
