/**
 * `monitor --at` reads a unitless number as milliseconds (`21.1` -> 21ms).
 * A unitless fraction is now an error asking for a unit; MCP numbers stay
 * milliseconds. And `monitor sheet` with a single `at` plus a
 * `start`/`end` window no longer silently returns one frame (error), while
 * several `at` values plus a window warn that the window is ignored.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMonitorAtMs } from "../cli_cmd_output.js";
import { validateActionArgs, ACTION_SPECS } from "../mcp/catalog.js";
import { CutholError } from "../core/diagnostics.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-monitor-at-"));

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

test("unit parsing: fraction needs a unit, integers stay ms", () => {
  assert.throws(() => parseMonitorAtMs("21.1"), (e: unknown) => {
    assert.ok(e instanceof CutholError);
    assert.equal(e.diagnostic.code, "CUTHOL-G142");
    assert.match(e.diagnostic.formatted, /21\.1s/);
    return true;
  });
  assert.equal(parseMonitorAtMs("21.1s"), 21100);
  assert.equal(parseMonitorAtMs("21100"), 21100);
  assert.equal(parseMonitorAtMs("21100ms"), 21100);
  assert.equal(parseMonitorAtMs("1500ms"), 1500);
});

test("MCP numbers stay milliseconds, unitless strings stay bare", () => {
  const frameSpec = ACTION_SPECS.find((s) => s.tool === "monitor" && s.action === "frame")!;
  const numRes = validateActionArgs(frameSpec, { at: 21.1 });
  assert.deepEqual(numRes.issues, []);
  assert.equal(numRes.values.at, "21.1ms");
  const strRes = validateActionArgs(frameSpec, { at: "21.1" });
  assert.deepEqual(strRes.issues, []);
  assert.equal(strRes.values.at, "21.1");
  const okRes = validateActionArgs(frameSpec, { at: "21.1s" });
  assert.equal(okRes.values.at, "21.1s");
});

test("monitor sheet rejects single at plus window, warns on multi at plus window", { timeout: 300_000 }, () => {
  const media = path.join(ROOT, "tone.mp4");
  if (!fs.existsSync(media)) {
    const proc = spawnSync(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=0x4488FF:s=160x160:r=30:d=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        media,
      ],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  }
  const dir = path.join(ROOT, "proj");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(runCli(["workspace", "init", dir, "--aspect", "1:1", "--fps", "30"]).status, 0);
  assert.equal(runCli(["library", "ingest", media, "--dir", dir]).status, 0);
  assert.equal(runCli(["spine", "append", "--asset", "vid_01", "--dir", dir]).status, 0);

  const single = runCli([
    "monitor", "sheet", "--at", "1s", "--start", "0ms", "--end", "2s", "--dir", dir,
  ]);
  assert.notEqual(single.status, 0, "single at plus window must fail");
  const singleEnv = parseEnvelope(single.stdout, single.stderr);
  assert.equal((singleEnv.diagnostic as { code?: string }).code, "CUTHOL-G143");

  const frac = runCli(["monitor", "frame", "--at", "21.1", "--dir", dir]);
  assert.notEqual(frac.status, 0, "unitless fraction must fail");
  const fracEnv = parseEnvelope(frac.stdout, frac.stderr);
  assert.equal((fracEnv.diagnostic as { code?: string }).code, "CUTHOL-G142");

  const multi = runCli([
    "monitor", "sheet", "--at", "1s,2s", "--start", "0ms", "--end", "3s",
    "--boxes", "false", "--dir", dir,
  ]);
  assert.equal(multi.status, 0, multi.stderr || multi.stdout);
  const multiEnv = parseEnvelope(multi.stdout, multi.stderr);
  const codes = ((multiEnv.diagnostics ?? []) as Array<{ code?: string }>).map((d) => d.code);
  assert.ok(codes.includes("CUTHOL-G144"), `expected G144 warn, got ${codes.join(",")}`);
});
