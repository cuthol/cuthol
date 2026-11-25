/**
 * Parakeet detection without spawning the HyperFrames CLI
 * (`src/test/local_speech_parakeet_cache.test.ts`).
 *
 * Read-only commands (`doctor`, `speech providers`, `setup --local-speech`
 * dry run) must detect the Parakeet model by reading the model files in the
 * HyperFrames cache folder — spawning the HyperFrames CLI writes its
 * first-run config into the home folder, which broke the
 * "no CLI command writes into agent tool folders" test.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import {
  parakeetInstallState,
  resetParakeetProbeCache,
} from "../speech/local_engine.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const HOME_VARS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

// Exact byte sizes the pinned HyperFrames 0.9.15 CLI requires for its
// `sherpaParakeetInstalled` check.
const MODEL_FILES: ReadonlyArray<{ name: string; bytes: number }> = [
  { name: "encoder.int8.onnx", bytes: 652184281 },
  { name: "decoder.int8.onnx", bytes: 11845275 },
  { name: "joiner.int8.onnx", bytes: 6355277 },
  { name: "tokens.txt", bytes: 93939 },
];

function modelDir(cacheDir: string): string {
  return path.join(cacheDir, "parakeet", "parakeet-tdt-0.6b-v3-int8");
}

function writeFakeModel(cacheDir: string): void {
  const dir = modelDir(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of MODEL_FILES) {
    const fd = fs.openSync(path.join(dir, f.name), "w");
    try {
      fs.ftruncateSync(fd, f.bytes);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function withCacheEnv<T>(cacheDir: string | undefined, fn: () => T): T {
  const saved = process.env.HYPERFRAMES_CACHE_DIR;
  try {
    if (cacheDir === undefined) delete process.env.HYPERFRAMES_CACHE_DIR;
    else process.env.HYPERFRAMES_CACHE_DIR = cacheDir;
    resetParakeetProbeCache();
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HYPERFRAMES_CACHE_DIR;
    else process.env.HYPERFRAMES_CACHE_DIR = saved;
    resetParakeetProbeCache();
  }
}

function redirectHome(home: string): () => void {
  const prev = new Map<string, string | undefined>();
  for (const key of HOME_VARS) prev.set(key, process.env[key]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  return () => {
    for (const key of HOME_VARS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

function runCli(
  args: string[],
  home: string,
  extra: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  delete env.XDG_CONFIG_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

test("parakeet detection reads the model files in the HyperFrames cache", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-para-cache-"));
  try {
    withCacheEnv(cache, () => {
      assert.equal(parakeetInstallState().installed, false);
    });
    writeFakeModel(cache);
    withCacheEnv(cache, () => {
      const state = parakeetInstallState();
      assert.equal(state.installed, true);
      assert.match(state.reason, /Parakeet/);
    });
    // One file with the wrong size counts as not installed.
    fs.truncateSync(path.join(modelDir(cache), "tokens.txt"), 10);
    withCacheEnv(cache, () => {
      assert.equal(parakeetInstallState().installed, false);
    });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("doctor and speech providers report the cached Parakeet model and write nothing under the temp home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-para-home-"));
  const cache = path.join(home, "hfcache");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-para-proj-"));
  const restore = redirectHome(home);
  try {
    initWorkspace({ dir: project, title: "parakeet", aspect: "16:9", fps: 30 });
  } finally {
    restore();
  }
  try {
    for (const withModel of [true, false]) {
      fs.rmSync(cache, { recursive: true, force: true });
      if (withModel) writeFakeModel(cache);
      resetParakeetProbeCache();
      const before = listFilesRecursive(home);
      const doctor = runCli(["doctor"], home, {
        CUTHOL_SKILLS_AUTO: "0",
        CI: "1",
        HYPERFRAMES_CACHE_DIR: cache,
      });
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      const providers = runCli(["speech", "providers", "--dir", project], home, {
        CUTHOL_SKILLS_AUTO: "0",
        CI: "1",
        HYPERFRAMES_CACHE_DIR: cache,
      });
      assert.equal(providers.status, 0, providers.stderr || providers.stdout);
      const after = listFilesRecursive(home);
      assert.deepEqual(after, before, `withModel=${withModel}: files appeared under the temp home`);
      if (withModel) {
        assert.match(doctor.stdout + doctor.stderr, /parakeet installed/i);
        assert.match(providers.stdout, /parakeet/);
      } else {
        assert.match(doctor.stdout + doctor.stderr, /parakeet missing/i);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
