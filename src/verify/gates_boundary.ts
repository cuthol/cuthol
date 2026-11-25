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
import { DIAGNOSTICS, CutholDiagnostic } from "../core/diagnostics.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { syncScalarVarsAndComputeCompositionHash } from "../compositor/hf_cache_state.js";
import { resolveFramePngInPngSequenceDir } from "../compositor/hf_frames.js";
import { isKnownEnvelopeParameter, suggestEnvelopeParameter } from "../sequence/envelope_params.js";

const SMALL_SIDE_PX = 96;

function isCompositionCue(cue: LaneCue): boolean {
  return Boolean(cue.composition?.composition_dir && cue.composition?.entry_html);
}

function resolveCompDir(rootDir: string, compDir: string): string {
  return path.isAbsolute(compDir) ? compDir : path.resolve(rootDir, compDir);
}

/** First cached video blob (or pngseq dir) matching any known hash, else null. */
function findCachedCompBlob(blobsDir: string, hashes: string[]): string | null {
  const exts = ["pngseq", "ffv1.mov", "mov", "mp4"];
  for (const hash of hashes) {
    if (!hash) continue;
    for (const ext of exts) {
      const candidate = path.join(blobsDir, `hf_comp_${hash}.${ext}`);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
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
  return buf.length > 0 ? buf : null;
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
    if (!fs.existsSync(entryPath)) return [];
    const htmlSource = fs.readFileSync(entryPath, "utf8");
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
        diagnostics.push(
          DIAGNOSTICS.ENVELOPE_UNKNOWN_PARAMETER(
            env.parameter,
            targetId,
            suggestEnvelopeParameter(env.parameter)
          )
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
