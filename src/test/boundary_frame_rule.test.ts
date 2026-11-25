/**
 * Boundary frame rule: the drawn picture and the reported `active_handles`
 * must name the same cue on every frame around a non-grid cue boundary.
 * Regression test for a monitor/render mismatch where frame 3307 of a
 * [.., 110.22s)/[110.22s, ..) pair reported the incoming cue while drawing
 * the outgoing one: the label time was the rounded request, the picture the
 * snapped grid frame.
 *
 * Two solid-colour broll cues meet off the 30 fps grid (at 220ms); the
 * integer request 233ms sits inside frame 6 ([200ms, 233.33ms)) and must
 * both draw and report the outgoing cue. (Time is integer milliseconds, so
 * the old rounded label 233ms named the incoming cue while the picture
 * showed frame 6 of the outgoing one.)
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-boundary-"));

function ffmpegSolid(outPath: string, color: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=160x160:r=30:d=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CUTHOL_ENCODER: "x264" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function parseEnvelope(stdout: string, stderr: string): Record<string, unknown> {
  for (const text of [stdout, stderr]) {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // try the other stream
    }
  }
  throw new Error(`no JSON envelope\nstdout=${stdout.slice(0, 800)}\nstderr=${stderr.slice(0, 800)}`);
}

test("monitor frame at 233ms reports the cue of frame 6, not frame 7", { timeout: 300_000 }, () => {
  const red = path.join(ROOT, "red.mp4");
  const blue = path.join(ROOT, "blue.mp4");
  if (!fs.existsSync(red)) ffmpegSolid(red, "0xFF0000", 2);
  if (!fs.existsSync(blue)) ffmpegSolid(blue, "0x0000FF", 2);

  const dir = path.join(ROOT, "proj");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(runCli(["workspace", "init", dir, "--aspect", "1:1", "--fps", "30"]).status, 0);
  assert.equal(runCli(["library", "ingest", red, blue, "--dir", dir]).status, 0);

  const addRed = runCli([
    "lane", "add-cue", "--lane", "ln_broll", "--kind", "broll",
    "--asset", "vid_01", "--at", "0ms", "--in", "0s", "--out", "0.22s",
    "--duration", "220ms", "--dir", dir,
  ]);
  assert.equal(addRed.status, 0, addRed.stderr || addRed.stdout);
  const redId = String((parseEnvelope(addRed.stdout, addRed.stderr).cue as { id: string }).id);

  const addBlue = runCli([
    "lane", "add-cue", "--lane", "ln_broll", "--kind", "broll",
    "--asset", "vid_02", "--at", "220ms", "--in", "0s", "--out", "1.78s",
    "--duration", "1780ms", "--dir", dir,
  ]);
  assert.equal(addBlue.status, 0, addBlue.stderr || addBlue.stdout);
  const blueId = String((parseEnvelope(addBlue.stdout, addBlue.stderr).cue as { id: string }).id);

  // 233ms is inside frame 6 ([200ms, 233.33ms)): picture and label must be red.
  const frame = runCli(["monitor", "frame", "--at", "233ms", "--boxes", "false", "--dir", dir]);
  assert.equal(frame.status, 0, frame.stderr || frame.stdout);
  const env = parseEnvelope(frame.stdout, frame.stderr);
  assert.equal(env.ok, true);
  const metrics = env.metrics as { timestamp_ms: number; active_handles: string[] };
  assert.ok(
    Math.abs(metrics.timestamp_ms - (6 * 1000) / 30) < 1e-6,
    `label time ${metrics.timestamp_ms}ms is not frame-6 grid time ${(6 * 1000) / 30}ms`
  );
  assert.deepEqual(metrics.active_handles, [redId]);

  // Frame 7 ([233.33ms, ...)) starts past the boundary: blue.
  const frame7 = runCli(["monitor", "frame", "--at", "234ms", "--boxes", "false", "--dir", dir]);
  assert.equal(frame7.status, 0, frame7.stderr || frame7.stdout);
  const env7 = parseEnvelope(frame7.stdout, frame7.stderr);
  const metrics7 = env7.metrics as { timestamp_ms: number; active_handles: string[] };
  assert.ok(Math.abs(metrics7.timestamp_ms - (7 * 1000) / 30) < 1e-6);
  assert.deepEqual(metrics7.active_handles, [blueId]);
});
