/**
 * Engine flag gate and Parakeet auto-language guidance
 * (`src/test/speech_engine_cli_gate.test.ts`).
 *
 * Through the built CLI as a child process (temp `CUTHOL_DATA_DIR`, never
 * the user folder): `setup --local-speech` dry run names both engines and
 * the 25 Parakeet languages; `--apply` without `--engine` fails asking for
 * the choice; `speech transcribe --engine nosuch` fails naming the valid
 * engines (never the unknown-flag code). Unit level: a Parakeet transcript
 * with `--lang auto` fails with the explicit-language retry (25 codes,
 * `--lang en`, Whisper setup command).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import {
  PARAKEET_LANGUAGES,
  resetParakeetProbeCache,
} from "../speech/local_engine.js";
import { transcribeLibraryAsset } from "../speech/transcribe.js";
import { rmRetrySync } from "./fs_cleanup.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace/speech_engine_cli_gate");
const CLI = path.resolve(process.cwd(), "dist/cli.js");
const NO_BIN = path.join(os.tmpdir(), "cuthol-no-hyperframes-bin.mjs");

test.after(() => {
  rmRetrySync(TEST_ROOT);
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    resetParakeetProbeCache();
  }
}

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    resetParakeetProbeCache();
  }
}

function runCli(args: string[], dataDir: string): { status: number | null; out: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CUTHOL_SKILLS_AUTO: "0",
      CI: "1",
      CUTHOL_DATA_DIR: dataDir,
      CUTHOL_HYPERFRAMES_BIN: NO_BIN,
    },
  });
  return { status: proc.status, out: `${proc.stdout ?? ""}\n${proc.stderr ?? ""}` };
}

function writeToneMp4(mediaFile: string, durationSec: number): void {
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=#0F172A:s=320x180:r=30:d=${durationSec}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=16000:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mediaFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(ff.status, 0, ff.stderr);
}

function setupMedia(name: string): { wsDir: string; dataDir: string } {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-gate-"));
  return { wsDir, dataDir };
}

test("CLI setup dry run names both engines and the 25 parakeet languages", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-gate-"));
  try {
    const { status, out } = runCli(["setup", "--local-speech"], dataDir);
    assert.equal(status, 0, out);
    assert.match(out, /parakeet/);
    assert.match(out, /whisper/);
    assert.match(out, /25 European languages/);
    for (const code of PARAKEET_LANGUAGES) {
      assert.ok(out.includes(code), `dry run lists '${code}': ${out.slice(0, 400)}`);
    }
    assert.match(out, /--engine parakeet --apply/);
    assert.match(out, /--engine whisper --apply/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI setup apply without engine fails asking for the choice", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-gate-"));
  try {
    const { status, out } = runCli(["setup", "--local-speech", "--apply"], dataDir);
    assert.notEqual(status, 0, out);
    assert.match(out, /CUTHOL-G238/);
    assert.match(out, /--engine parakeet --apply/);
    assert.match(out, /--engine whisper --apply/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI transcribe with an unknown engine names the valid engines, not the flag gate", () => {
  const { wsDir, dataDir } = setupMedia("ws_unknown_engine");
  try {
    const { status, out } = runCli(
      ["speech", "transcribe", "--handle", "vid_01", "--provider", "local", "--engine", "nosuch", "--dir", wsDir],
      dataDir
    );
    assert.notEqual(status, 0, out);
    assert.match(out, /CUTHOL-G230/);
    assert.match(out, /whisper, parakeet/);
    assert.doesNotMatch(out, /CUTHOL-G110/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function makeFakeParakeetBin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-gate-pbin-"));
  const file = path.join(dir, "hyperframes.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write(JSON.stringify({ models: [{ engine: "parakeet", model: "parakeet-tdt-0.6b-v3", installed: true }] }));
} else if (args[0] === "transcribe") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-gate-pt-"));
  const transcriptPath = path.join(dir, "transcript.json");
  fs.writeFileSync(transcriptPath, JSON.stringify([{ text: "hello", start: 0.1, end: 0.5 }, { text: "world", start: 0.6, end: 1.0 }]), "utf8");
  process.stdout.write(JSON.stringify({ transcriptPath }));
} else {
  process.stderr.write("unexpected call");
  process.exit(1);
}
`,
    "utf8"
  );
  return file;
}

test("parakeet transcript with auto language names the retry and the 25 languages", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_parakeet_auto");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "parakeet auto", aspect: "16:9", fps: 30 });
  const mediaFile = path.join(wsDir, "talk.mp4");
  writeToneMp4(mediaFile, 2);
  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaFile] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-eng-gate-"));
  const binDir = path.dirname(makeFakeParakeetBin());
  const bin = path.join(binDir, "hyperframes.mjs");
  try {
    await withEnvAsync({ CUTHOL_DATA_DIR: dataDir, CUTHOL_HYPERFRAMES_BIN: bin }, async () => {
      await assert.rejects(
        () =>
          transcribeLibraryAsset({
            workspaceDir: wsDir,
            handle: "vid_01",
            provider: "local",
          }),
        (err: unknown) => {
          const text = err instanceof Error ? err.message : String(err);
          if (!/CUTHOL-G239/.test(text)) return false;
          if (!/does not report the detected language/.test(text)) return false;
          for (const code of PARAKEET_LANGUAGES) {
            if (!text.includes(code)) return false;
          }
          if (!/--lang en/.test(text)) return false;
          if (!/--engine whisper --apply/.test(text)) return false;
          return true;
        },
        "expected the explicit parakeet auto-language failure"
      );
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
