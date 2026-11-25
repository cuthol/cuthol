/**
 * First-visual-source stage adoption (canvas G151/G152).
 *
 * Applies only to projects created by CLI/MCP `workspace init` without
 * `--aspect`/`--size` (no `stage.set_explicit` marker). Direct
 * `initWorkspace()` callers get `set_explicit` and keep today's behaviour.
 */
import fs from "node:fs";
import path from "node:path";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";

export interface VisualSourceDims {
  width: number;
  height: number;
}

export function isProjectEmptyForAdoption(seq: CutholSequence): boolean {
  if (seq.spine.clips.length > 0) return false;
  return !seq.lanes.some((lane) => lane.cues.length > 0);
}

function toEven(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

function aspectForDims(width: number, height: number): CutholSequence["stage"]["aspect"] {
  if (width === 1080 && height === 1920) return "9:16";
  if (width === 1920 && height === 1080) return "16:9";
  if (width === 1080 && height === 1080) return "1:1";
  if (width === 1080 && height === 1350) return "4:5";
  return "custom";
}

/**
 * Adopt the source size into an unmarked stage. Returns the INFO diagnostic
 * to surface, or null when the stage was set explicitly (caller then uses
 * `suggestStageCommand` output instead).
 */
export function maybeAdoptStageFromFirstSource(
  seq: CutholSequence,
  source: VisualSourceDims,
  undoHint: string
): CutholDiagnostic | null {
  const width = toEven(source.width);
  const height = toEven(source.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
    return null;
  }
  if (seq.stage.set_explicit) {
    return DIAGNOSTICS.STAGE_SIZE_SUGGESTED(`${width}x${height}`, suggestStageCommand(width, height));
  }
  seq.stage.width = width;
  seq.stage.height = height;
  seq.stage.aspect = aspectForDims(width, height);
  seq.stage.set_explicit = true;
  return DIAGNOSTICS.STAGE_ADOPTED_FROM_SOURCE(`${width}x${height}`, undoHint);
}

export function suggestStageCommand(width: number, height: number): string {
  return `cuthol workspace stage --size ${width}x${height}`;
}

export function readCompositionDims(
  rootDir: string,
  compositionDir: string,
  entryHtml: string
): VisualSourceDims | null {
  try {
    const dir = path.isAbsolute(compositionDir) ? compositionDir : path.resolve(rootDir, compositionDir);
    const html = fs.readFileSync(path.join(dir, entryHtml), "utf8");
    const m = /data-width\s*=\s*"(\d+)"[\s\S]*?data-height\s*=\s*"(\d+)"/.exec(html);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
  } catch {
    return null;
  }
}
