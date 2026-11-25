/**
 * The Node `ExperimentalWarning: SQLite ...` line must never reach stderr
 * on a CLI command that opens the media ledger, while any other
 * `ExperimentalWarning` still prints.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";

import { pathToFileURL } from "node:url";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ENV_HOOK = pathToFileURL(path.resolve(process.cwd(), "dist/core/env.js")).href;

function writeToneWav(outPath: string): void {
  const sampleRate = 48000;
  const totalSamples = sampleRate;
  const buf = Buffer.alloc(44 + totalSamples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + totalSamples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(totalSamples * 2, 40);
  for (let i = 0; i < totalSamples; i++) {
    buf.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), 44 + i * 2);
  }
  fs.writeFileSync(outPath, buf);
}

test("ledger-touching CLI command prints no SQLite warning on stderr", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-sqlite-"));
  try {
    const wsDir = path.join(tmp, "ws");
    initWorkspace({ dir: wsDir, title: "sqlite", aspect: "16:9", fps: 30 });
    const wav = path.join(tmp, "tone.wav");
    writeToneWav(wav);
    const proc = spawnSync(process.execPath, [CLI, "library", "ingest", wav, "--dir", wsDir], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    });
    assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
    assert.ok(!/SQLite/.test(String(proc.stderr ?? "")), `SQLite noise on stderr: ${proc.stderr}`);
    assert.ok(
      !/ExperimentalWarning/.test(String(proc.stderr ?? "")),
      `ExperimentalWarning on stderr: ${proc.stderr}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("any other ExperimentalWarning still prints with the filter loaded", () => {
  const proc = spawnSync(
    process.execPath,
    [
      "--import",
      ENV_HOOK,
      "--input-type=module",
      "-e",
      "process.emitWarning('cuthol probe warning', { type: 'ExperimentalWarning' });",
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" } }
  );
  const stderr = String(proc.stderr ?? "");
  assert.ok(
    /ExperimentalWarning.*cuthol probe warning|cuthol probe warning/.test(stderr),
    `other ExperimentalWarning must still print, got: ${stderr}`
  );
  assert.ok(!/SQLite/.test(stderr), `unexpected SQLite text: ${stderr}`);
});
