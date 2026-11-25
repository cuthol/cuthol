/**
 * CLI cases that used to succeed while dropping part of the request:
 * extra positionals, a range missing `..`, `brief --format json`,
 * unitless monitor timestamps, and a library query page cut by max_tokens.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatEnvelopeCompact } from "../mcp/mcp_format.js";
import { runCliFast } from "./c_helpers.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cli-silent-"));
const LONG_MP4 = path.join(ROOT, "tone30.mp4");
const SHORT_MP4 = path.join(ROOT, "tone2.mp4");

function ffmpegTone(outPath: string, seconds: number): void {
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x4488FF:s=160x160:r=30:d=${seconds}`,
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
    env: { ...process.env, CUTHOL_ENCODER: "x264" },
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

function diagnosticBlob(env: Record<string, unknown>): string {
  const parts: string[] = [];
  const one = env.diagnostic as { code?: string; what?: string; suggestion?: string; formatted?: string } | undefined;
  if (one) parts.push(`${one.code ?? ""} ${one.what ?? ""} ${one.suggestion ?? ""} ${one.formatted ?? ""}`);
  const list = Array.isArray(env.diagnostics) ? env.diagnostics : [];
  for (const d of list as Array<{ code?: string; what?: string; suggestion?: string; formatted?: string }>) {
    parts.push(`${d.code ?? ""} ${d.what ?? ""} ${d.suggestion ?? ""} ${d.formatted ?? ""}`);
  }
  return parts.join("\n");
}

let goldenDir: string | undefined;

/** One CLI init per file; the rest are plain copies of the same empty project. */
function initProject(name: string): string {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!goldenDir) {
    const gold = path.join(ROOT, "golden");
    const res = runCli(["workspace", "init", gold, "--aspect", "1:1", "--fps", "30"]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    goldenDir = gold;
  }
  fs.cpSync(goldenDir, dir, { recursive: true });
  return dir;
}

/** Setup-only CLI calls with payload assertions go in-process; CLI-behavior calls keep runCli. */
async function runSetup(args: string[]): Promise<Record<string, unknown>> {
  const res = await runCliFast(args);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return parseEnvelope(res.stdout, res.stderr);
}

test("cli silent argument errors", { timeout: 300_000 }, async (t) => {
  ffmpegTone(LONG_MP4, 30);
  ffmpegTone(SHORT_MP4, 2);

  await t.test("extra positional is rejected; ingest, comma ranges, show, and monitor frame still work", async () => {
    const dir = initProject("edit");
    const ingestedEnv = await runSetup(["library", "ingest", LONG_MP4, SHORT_MP4, "--dir", dir]);
    const items = ingestedEnv.ingested as unknown[];
    assert.equal(items.length, 2);

    await runSetup(["spine", "append", "--asset", "vid_01", "--dir", dir]);
    const addedEnv = await runSetup([
      "lane",
      "add-cue",
      "--lane",
      "ln_broll",
      "--kind",
      "broll",
      "--asset",
      "vid_01",
      "--at",
      "0ms",
      "--in",
      "0s",
      "--out",
      "10s",
      "--duration",
      "10s",
      "--dir",
      dir,
    ]);
    const cueId = String((addedEnv.cue as { id: string }).id);

    await runSetup([
      "extension",
      "create",
      "--name",
      "demo_ext",
      "--scope",
      "project",
      "--template",
      "helper",
      "--dir",
      dir,
    ]);
    const shownEnv = await runSetup(["extension", "show", "demo_ext", "--dir", dir]);
    assert.equal((shownEnv.manifest as { name?: string } | undefined)?.name ?? (shownEnv as { name?: string }).name, "demo_ext");

    const frameEnv = await runSetup(["monitor", "frame", "1s", "--boxes", "false", "--dir", dir]);
    assert.equal(frameEnv.ok, true);

    const dropped = runCli([
      "lane",
      "excise",
      "--cue",
      cueId,
      "--ranges",
      "2s..3s",
      "6s..7s",
      "--dir",
      dir,
    ]);
    assert.notEqual(dropped.status, 0, dropped.stdout);
    const droppedEnv = parseEnvelope(dropped.stdout, dropped.stderr);
    const droppedDiag = droppedEnv.diagnostic as { code?: string; suggestion?: string; formatted?: string };
    assert.equal(droppedDiag.code, "CUTHOL-G110");
    assert.match(`${droppedDiag.suggestion ?? ""}\n${droppedDiag.formatted ?? ""}`, /2s\.\.3s,6s\.\.7s/);
    assert.match(`${droppedDiag.suggestion ?? ""}\n${droppedDiag.formatted ?? ""}`, /commas/i);

    const cut = runCli([
      "lane",
      "excise",
      "--cue",
      cueId,
      "--ranges",
      "2s..3s,6s..7s",
      "--dir",
      dir,
    ]);
    assert.equal(cut.status, 0, cut.stderr || cut.stdout);
    const cutEnv = parseEnvelope(cut.stdout, cut.stderr);
    assert.equal(cutEnv.savedSequenceMs, 2000);
    const kept = (cutEnv.remainingCues as Array<{ duration_ms: number }>).reduce((sum, cue) => sum + cue.duration_ms, 0);
    assert.equal(kept, 8000);
  });

  await t.test("excise range without .. names the broken piece", () => {
    const dir = initProject("ranges");
    for (const group of ["spine", "lane"] as const) {
      const idFlag = group === "spine" ? "--clip" : "--cue";
      const bad = runCli([group, "excise", idFlag, "sp_01", "--ranges", "2s", "--dir", dir]);
      assert.notEqual(bad.status, 0);
      const blob = diagnosticBlob(parseEnvelope(bad.stdout, bad.stderr));
      assert.match(blob, /CUTHOL-G311/);
      assert.match(blob, /2s/);
      assert.match(blob, /\.\./);

      const second = runCli([group, "excise", idFlag, "sp_01", "--ranges", "2s..3s,6s", "--dir", dir]);
      assert.notEqual(second.status, 0);
      const secondBlob = diagnosticBlob(parseEnvelope(second.stdout, second.stderr));
      assert.match(secondBlob, /CUTHOL-G311/);
      assert.match(secondBlob, /6s/);
    }
  });

  await t.test("brief --format json matches --json; default stays markdown", () => {
    const dir = initProject("brief");
    const byFlag = runCli(["brief", "--json", "--dir", dir]);
    const byFormat = runCli(["brief", "--format", "json", "--dir", dir]);
    assert.equal(byFlag.status, 0, byFlag.stderr);
    assert.equal(byFormat.status, 0, byFormat.stderr);
    const flagEnv = JSON.parse(byFlag.stdout) as { ok?: boolean; command?: string };
    const formatEnv = JSON.parse(byFormat.stdout) as { ok?: boolean; command?: string };
    assert.equal(flagEnv.ok, true);
    assert.equal(flagEnv.command, "brief");
    assert.deepEqual(formatEnv, flagEnv);

    const plain = runCli(["brief", "--dir", dir]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /# CUTHOL BRIEF/);
    assert.throws(() => JSON.parse(plain.stdout));
  });

  await t.test("unitless monitor --at warns only for a long sequence and several small bare numbers", async () => {
    const dir = initProject("monitor");
    await runSetup(["library", "ingest", LONG_MP4, "--dir", dir]);
    await runSetup(["spine", "append", "--asset", "vid_01", "--dir", dir]);

    const warned = runCli(["monitor", "sheet", "--at", "21,27", "--boxes", "false", "--dir", dir]);
    assert.equal(warned.status, 0, warned.stderr || warned.stdout);
    const warnedEnv = parseEnvelope(warned.stdout, warned.stderr);
    assert.match(diagnosticBlob(warnedEnv), /CUTHOL-G114/);
    assert.match(diagnosticBlob(warnedEnv), /milliseconds/);
    assert.match(diagnosticBlob(warnedEnv), /21\.1s/);
    const compact = formatEnvelopeCompact({
      envelope: warnedEnv,
      command: "monitor.sheet",
      dir,
      exitCode: 0,
    });
    assert.match(compact.text, /WARN \[CUTHOL-G114\]/);

    const withUnits = runCli(["monitor", "sheet", "--at", "21.1s,27s", "--boxes", "false", "--dir", dir]);
    assert.equal(withUnits.status, 0, withUnits.stderr || withUnits.stdout);
    assert.doesNotMatch(diagnosticBlob(parseEnvelope(withUnits.stdout, withUnits.stderr)), /CUTHOL-G114/);

    const single = runCli(["monitor", "frame", "--at", "1500", "--boxes", "false", "--dir", dir]);
    assert.equal(single.status, 0, single.stderr || single.stdout);
    assert.doesNotMatch(diagnosticBlob(parseEnvelope(single.stdout, single.stderr)), /CUTHOL-G114/);

    const oneBareFraction = runCli(["monitor", "frame", "--at", "21.1", "--boxes", "false", "--dir", dir]);
    assert.notEqual(oneBareFraction.status, 0, oneBareFraction.stdout);
    assert.match(
      diagnosticBlob(parseEnvelope(oneBareFraction.stdout, oneBareFraction.stderr)),
      /CUTHOL-G142/
    );

    const short = initProject("monitor-short");
    await runSetup(["library", "ingest", LONG_MP4, "--dir", short]);
    await runSetup(["spine", "append", "--asset", "vid_01", "--in", "0s", "--out", "3s", "--dir", short]);
    const shortSheet = runCli(["monitor", "sheet", "--at", "1100,1200", "--boxes", "false", "--dir", short]);
    assert.equal(shortSheet.status, 0, shortSheet.stderr || shortSheet.stdout);
    assert.doesNotMatch(diagnosticBlob(parseEnvelope(shortSheet.stdout, shortSheet.stderr)), /CUTHOL-G114/);
  });

  await t.test("library query max_tokens truncation is a visible warning", async () => {
    const dir = initProject("query");
    await runSetup(["library", "ingest", LONG_MP4, "--dir", dir]);
    await runSetup(["library", "waveform", "--handle", "vid_01", "--bins", "24", "--dir", dir]);

    const queried = runCli([
      "library",
      "query",
      "--handle",
      "vid_01",
      "--kind",
      "waveform",
      "--limit",
      "200",
      "--max-tokens",
      "100",
      "--format",
      "compact",
      "--dir",
      dir,
    ]);
    assert.equal(queried.status, 0, queried.stderr || queried.stdout);
    const env = parseEnvelope(queried.stdout, queried.stderr);
    assert.equal(env.truncated_by, "max_tokens");
    assert.equal(typeof env.next_cursor, "string");
    const blob = diagnosticBlob(env);
    assert.match(blob, /CUTHOL-G115/);
    assert.match(blob, /token/);
    assert.match(blob, new RegExp(String(env.returned)));
    assert.match(blob, new RegExp(`next_cursor=${env.next_cursor}`));

    const compact = formatEnvelopeCompact({
      envelope: env,
      command: "library.query",
      dir,
      exitCode: 0,
    });
    assert.match(compact.text, /WARN \[CUTHOL-G115\]/);

    const text = runCli([
      "library",
      "query",
      "--handle",
      "vid_01",
      "--kind",
      "waveform",
      "--limit",
      "200",
      "--max-tokens",
      "100",
      "--compact",
      "--dir",
      dir,
    ]);
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /WARN \[CUTHOL-G115\]/);
    assert.match(text.stdout, /next_cursor=/);
  });
});
