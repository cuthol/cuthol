/**
 * Unknown envelope parameters must fail loudly instead of returning `ok`
 * while the render silently ignores them (`--param scale`, `--param y`).
 * Accepts the compiler's real names (`placement.scale_x`, ...), the
 * `fx.<id>.<param>` family (checked in compile_spine_fx) and the open
 * `color.*` template; anything else is CUTHOL-G140 with a suggestion.
 * Legacy projects already carrying one are flagged by the verify gate.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyEnvelopeParameters } from "../verify/gates_boundary.js";
import { CutholSequence } from "../core/schema.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-envelope-"));

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

function makeTone(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x4488FF:s=160x160:r=30:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

test("spine envelope rejects unknown params, accepts real ones", { timeout: 300_000 }, () => {
  const media = path.join(ROOT, "tone.mp4");
  if (!fs.existsSync(media)) makeTone(media, 4);

  const dir = path.join(ROOT, "proj");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(runCli(["workspace", "init", dir, "--aspect", "1:1", "--fps", "30"]).status, 0);
  assert.equal(runCli(["library", "ingest", media, "--dir", dir]).status, 0);
  assert.equal(runCli(["spine", "append", "--asset", "vid_01", "--dir", dir]).status, 0);

  for (const param of ["scale", "y", "placement.scalex"]) {
    const bad = runCli([
      "spine", "envelope", "--clip", "sp_01", "--param", param,
      "--points", "0ms:1.0,1000ms:1.0", "--dir", dir,
    ]);
    assert.notEqual(bad.status, 0, `--param ${param} must fail`);
    const env = parseEnvelope(bad.stdout, bad.stderr);
    const diag = env.diagnostic as { code?: string; formatted?: string };
    assert.equal(diag.code, "CUTHOL-G140");
    assert.match(diag.formatted ?? "", /ignores it/);
  }

  const sug = runCli([
    "spine", "envelope", "--clip", "sp_01", "--param", "placement.scalex",
    "--points", "0ms:1.0", "--dir", dir,
  ]);
  const sugEnv = parseEnvelope(sug.stdout, sug.stderr);
  assert.match(String((sugEnv.diagnostic as { formatted?: string }).formatted ?? ""), /placement\.scale_x/);

  const good = runCli([
    "spine", "envelope", "--clip", "sp_01", "--param", "placement.scale_x",
    "--points", "0ms:1.0,1000ms:1.2", "--dir", dir,
  ]);
  assert.equal(good.status, 0, good.stderr || good.stdout);

  const fxParam = runCli([
    "spine", "envelope", "--clip", "sp_01", "--param", "fx.fx_01.sigma",
    "--points", "0ms:1.0", "--dir", dir,
  ]);
  assert.equal(fxParam.status, 0, fxParam.stderr || fxParam.stdout);

  const colorParam = runCli([
    "spine", "envelope", "--clip", "sp_01", "--param", "color.block.amount",
    "--points", "0ms:1.0", "--dir", dir,
  ]);
  assert.equal(colorParam.status, 0, colorParam.stderr || colorParam.stdout);
});

test("verify flags a legacy unknown envelope parameter", () => {
  const seq = {
    spine: {
      clips: [
        {
          id: "sp_01",
          envelopes: [{ parameter: "scale", points: [{ offset_ms: 0, value: 1 }] }],
        },
      ],
    },
    lanes: [],
  } as unknown as CutholSequence;
  const diagnostics: never[] = [];
  verifyEnvelopeParameters(seq, diagnostics as never as Parameters<typeof verifyEnvelopeParameters>[1]);
  assert.equal(diagnostics.length, 1);
  assert.equal((diagnostics[0] as unknown as { code: string }).code, "CUTHOL-G140");
});
