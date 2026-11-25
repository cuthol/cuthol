/**
 * Small generated media shared by test files (built once, reused across files and runs).
 *
 * The file name carries every generation parameter, so a changed parameter never reuses a
 * stale file, and the file is written to a temporary name and renamed into place, so two
 * test files running at the same time never read a half-written file.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SHARED_DIR = path.resolve(process.cwd(), "test-workspace", "_shared");

/** Flat-colour H.264 clip `width`x`height`, `fps`, `durSec` long (yuv420p, no audio). */
export function sharedColorMp4(color: string, fps: number, durSec: number, width = 320, height = 180): string {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  const out = path.join(SHARED_DIR, `color_${color}_${width}x${height}_${fps}fps_${durSec}s.mp4`);
  if (fs.existsSync(out)) return out;
  const tmp = `${out}.${process.pid}.${Date.now()}.tmp.mp4`;
  const res = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:r=${fps}:d=${durSec},format=yuv420p`,
    tmp,
  ]);
  if (res.status !== 0) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`ffmpeg failed to build ${out}: ${String(res.stderr ?? "")}`);
  }
  try {
    fs.renameSync(tmp, out);
  } catch {
    // Another file finished first: its copy is identical, keep it.
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(out)) throw new Error(`could not place ${out}`);
  }
  return out;
}
