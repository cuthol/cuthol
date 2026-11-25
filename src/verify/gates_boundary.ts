// Boundary continuity gate: for back-to-back composition cues on the same lane
// (next starts exactly when the previous ends), report the pixel difference
// between the outgoing composition's last frame and the incoming one's first
// frame. Cache-only and browser-free: both frames come from already-cached
// composition blobs (`hf_comp_<hash>.*`), downscaled to a small resolution.
// Anything uncached is skipped silently; projects without back-to-back
// composition pairs produce no diagnostic.
import fs from "node:fs";
import path from "node:path";
import { spawnWatchedSync } from "../core/subprocess.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { DIAGNOSTICS, CutholDiagnostic, pushRepeatDiagnostic } from "../core/diagnostics.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { syncScalarVarsAndComputeCompositionHash } from "../compositor/hf_cache_state.js";
import { currentHashGeneration, hashFileContent, readTextIfExists } from "../core/file_hash_index.js";
import { resolveFramePngInPngSequenceDir } from "../compositor/hf_frames.js";
import { isKnownEnvelopeParameter, suggestEnvelopeParameter } from "../sequence/envelope_params.js";

const SMALL_SIDE_PX = 96;

function isCompositionCue(cue: LaneCue): boolean {
  return Boolean(cue.composition?.composition_dir && cue.composition?.entry_html);
}

function resolveCompDir(rootDir: string, compDir: string): string {
  return path.isAbsolute(compDir) ? compDir : path.resolve(rootDir, compDir);
}

/**
 * Names present in the blob directory, listed fresh on every call. Boundary
 * checks probe dozens of `hf_comp_<hash>.<ext>` candidates per cue, and a
 * render between two calls of one process (tests, Live, pipelines) adds new
 * blobs without starting a new command generation, so a memoized listing
 * would miss them. One `readdirSync` per lookup is cheap next to the ffmpeg
 * samples it gates.
 */
function blobNameSet(blobsDir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(blobsDir));
  } catch {
    return new Set();
  }
}

/** First cached video blob (or pngseq dir) matching any known hash, else null. */
function findCachedCompBlob(blobsDir: string, hashes: string[]): string | null {
  const names = blobNameSet(blobsDir);
  const exts = ["pngseq", "ffv1.mov", "mov", "mp4"];
  for (const hash of hashes) {
    if (!hash) continue;
    for (const ext of exts) {
      const file = `hf_comp_${hash}.${ext}`;
      if (names.has(file)) return path.join(blobsDir, file);
    }
  }
  return null;
}

const rgbMemoryCache = new Map<string, Buffer>();
const MAX_RGB_MEMORY_ENTRIES = 32;
const MAX_RGB_PERSISTED_FILES = 200;

function rgbCacheDir(rootDir: string): string {
  return path.join(rootDir, ".cuthol", "boundary-rgb");
}

function rgbMemoryKey(absInput: string, frameIdx: number): string | null {
  try {
    const st = fs.statSync(absInput);
    if (!st.isFile()) return null;
    return `${absInput}\n${st.size}\n${st.mtimeMs}\n${frameIdx}`;
  } catch {
    return null;
  }
}

function readPersistedRgbSample(rootDir: string, inputSha: string, frameIdx: number): Buffer | null {
  try {
    const file = path.join(rgbCacheDir(rootDir), `${inputSha}_${frameIdx}.bin`);
    const buf = fs.readFileSync(file);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function writePersistedRgbSample(rootDir: string, inputSha: string, frameIdx: number, buf: Buffer): void {
  try {
    const dir = rgbCacheDir(rootDir);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir);
    if (existing.length > MAX_RGB_PERSISTED_FILES) return;
    fs.writeFileSync(path.join(dir, `${inputSha}_${frameIdx}.bin`), buf);
  } catch {
    // boundary samples are best-effort cache; a miss just re-runs ffmpeg
  }
}

function extractSmallRgb(
  blobPath: string,
  frameIdx: number,
  rootDir: string
): Buffer | null {
  // Frame-exact `select` (no pre-seek: input seeking can land a frame off).
  let input: string;
  try {
    if (fs.statSync(blobPath).isDirectory()) {
      const framePng = resolveFramePngInPngSequenceDir(blobPath, frameIdx);
      if (!framePng) return null;
      input = framePng;
    } else {
      input = blobPath;
    }
  } catch {
    return null;
  }
  // Reuse the already-extracted sample when the rendered input did not
  // change: the sample is keyed by the input file's content hash (cheap via
  // the shared per-command/persisted file-hash cache) plus the frame index,
  // so an unchanged boundary costs no ffmpeg call. Stored bytes are the raw
  // ffmpeg output, hence bit-identical to a fresh extraction.
  const absInput = path.resolve(input);
  const memKey = rgbMemoryKey(absInput, frameIdx);
  if (memKey) {
    const memHit = rgbMemoryCache.get(memKey);
    if (memHit) return Buffer.from(memHit);
  }
  const inputSha = hashFileContent(absInput);
  if (inputSha) {
    const persisted = readPersistedRgbSample(rootDir, inputSha, frameIdx);
    if (persisted) {
      if (memKey) {
        if (rgbMemoryCache.size > MAX_RGB_MEMORY_ENTRIES) rgbMemoryCache.clear();
        rgbMemoryCache.set(memKey, persisted);
      }
      return Buffer.from(persisted);
    }
  }
  const isDir = input !== blobPath;
  const proc = spawnWatchedSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
      "-vf",
      isDir
        ? `scale=${SMALL_SIDE_PX}:-1,format=rgb24`
        : `select='eq(n\\,${frameIdx})',scale=${SMALL_SIDE_PX}:-1,format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 4 * 1024 * 1024, step: "verify boundary continuity", cwd: rootDir }
  );
  if (proc.status !== 0 || proc.error) return null;
  const buf = proc.stdout as Buffer;
  if (buf.length === 0) return null;
  if (memKey) {
    if (rgbMemoryCache.size > MAX_RGB_MEMORY_ENTRIES) rgbMemoryCache.clear();
    rgbMemoryCache.set(memKey, buf);
  }
  if (inputSha) writePersistedRgbSample(rootDir, inputSha, frameIdx, buf);
  return buf;
}

function meanAbsDiff(a: Buffer, b: Buffer): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}

/** Draft-480p frame size, mirroring the render compiler's scale factor. */
function draftDims(seq: CutholSequence): { width: number; height: number } {
  const scaleFactor = 480 / Math.min(seq.stage.width, seq.stage.height);
  return {
    width: Math.max(16, Math.round((seq.stage.width * scaleFactor) / 2) * 2),
    height: Math.max(16, Math.round((seq.stage.height * scaleFactor) / 2) * 2),
  };
}

function compHashesForCue(
  rootDir: string,
  seq: CutholSequence,
  cue: LaneCue,
  fps: number,
  dims: { width: number; height: number }
): string[] {
  try {
    const comp = cue.composition!;
    const absCompDir = resolveCompDir(rootDir, comp.composition_dir);
    const entryPath = path.join(absCompDir, comp.entry_html);
    const htmlSource = readTextIfExists(entryPath);
    if (htmlSource === null) return [];
    const mode = comp.mode ?? "overlay_alpha";
    const out: string[] = [];
    // The compiler bakes the stage backdrop into fullscreen opaque blobs and
    // keeps transparency otherwise; cover both variants. Scene-host and
    // baked-still backdrops are not covered (skipped when uncached).
    const variants: Array<{ transparent: boolean; opaqueBackdropColor?: string }> = [
      { transparent: comp.transparent ?? true },
      { transparent: false, opaqueBackdropColor: seq.stage.backdrop?.color },
    ];
    for (const variant of variants) {
      const hashInfo = syncScalarVarsAndComputeCompositionHash({
        absCompDir,
        entryHtml: comp.entry_html,
        htmlSource,
        width: dims.width,
        height: dims.height,
        fps,
        durationMs: cue.duration_ms,
        props: comp.props ?? {},
        transparent: variant.transparent,
        mode: mode === "scene_host" ? "scene_host" : "overlay_alpha",
        ...(variant.opaqueBackdropColor ? { opaqueBackdropColor: variant.opaqueBackdropColor } : {}),
      });
      out.push(hashInfo.hash, hashInfo.nativeHash, hashInfo.legacyHash, hashInfo.legacyNativeHash);
    }
    return out;
  } catch {
    return [];
  }
}

/** Cached blob for a cue, trying master then draft-480p dimensions. */
function findCueBlob(
  paths: WorkspacePaths,
  seq: CutholSequence,
  cue: LaneCue,
  fps: number
): string | null {
  const draft = draftDims(seq);
  const dimSets = [
    { width: seq.stage.width, height: seq.stage.height },
    ...(draft.width !== seq.stage.width || draft.height !== seq.stage.height ? [draft] : []),
  ];
  for (const dims of dimSets) {
    const blob = findCachedCompBlob(
      paths.blobsDir,
      compHashesForCue(paths.rootDir, seq, cue, fps, dims)
    );
    if (blob) return blob;
  }
  return null;
}

/** Flags envelope parameters the compiler ignores (legacy projects). */
export function verifyEnvelopeParameters(
  seq: CutholSequence,
  diagnostics: CutholDiagnostic[]
): void {
  const check = (targetId: string, params: { parameter: string }[]) => {
    for (const env of params) {
      if (!isKnownEnvelopeParameter(env.parameter)) {
        pushRepeatDiagnostic(
          diagnostics,
          `CUTHOL-G140:${env.parameter}`,
          { subjectId: targetId },
          (e) =>
            DIAGNOSTICS.ENVELOPE_UNKNOWN_PARAMETER(
              env.parameter,
              e.subjectId,
              suggestEnvelopeParameter(env.parameter)
            ),
          (es) => DIAGNOSTICS.ENVELOPE_UNKNOWN_PARAMETER_MANY(env.parameter, es.map((e) => e.subjectId))
        );
      }
    }
  };
  for (const clip of seq.spine.clips) check(clip.id, clip.envelopes);
  for (const lane of seq.lanes) {
    for (const cue of lane.cues) check(cue.id, cue.envelopes);
  }
}

/** INFO per back-to-back composition boundary; silent when nothing is cached. */
export function verifyBoundaryContinuity(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  verifyEnvelopeParameters(seq, diagnostics);
  if (!paths) return;
  const fps = Math.max(1, seq.stage.fps);
  for (const lane of seq.lanes) {
    const sorted = [...lane.cues].sort(
      (a, b) => resolveCueStartMs(seq, a) - resolveCueStartMs(seq, b)
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      const prevStart = resolveCueStartMs(seq, prev);
      const prevEnd = prevStart + prev.duration_ms;
      const nextStart = resolveCueStartMs(seq, next);
      if (nextStart !== prevEnd) continue;
      if (!isCompositionCue(prev) || !isCompositionCue(next)) continue;
      const prevBlob = findCueBlob(paths, seq, prev, fps);
      const nextBlob = findCueBlob(paths, seq, next, fps);
      if (!prevBlob || !nextBlob) continue;
      const prevFrames = Math.max(1, Math.round((prev.duration_ms / 1000) * fps));
      const lastRgb = extractSmallRgb(prevBlob, prevFrames - 1, paths.rootDir);
      const firstRgb = extractSmallRgb(nextBlob, 0, paths.rootDir);
      if (!lastRgb || !firstRgb) continue;
      const diff = meanAbsDiff(lastRgb, firstRgb);
      if (diff === null) continue;
      const rounded = Number(diff.toFixed(1));
      diagnostics.push(
        rounded <= 8
          ? DIAGNOSTICS.BOUNDARY_CONTINUITY_MATCH(lane.id, nextStart, rounded)
          : DIAGNOSTICS.BOUNDARY_CONTINUITY_JUMP(lane.id, nextStart, rounded)
      );
    }
  }
}
