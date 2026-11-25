/**
 * CLI startup cost: `--version` prints the package version, and the light
 * commands (`help`, `spine trim --help`) run without loading the heavy
 * render/compositor/monitor/verify/MCP modules.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const PKG = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
  version: string;
};

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

test("--version and -v print the package version", () => {
  for (const args of [["--version"], ["-v"]]) {
    const proc = runCli(args);
    assert.equal(proc.status, 0, `cuthol ${args.join(" ")} stderr: ${proc.stderr}`);
    // Compared against the package.json read at test time (not a hardcoded
    // string), so a hardcoded version in the CLI fails this test as soon as
    // package.json changes.
    assert.equal(proc.stdout.trim(), `cuthol ${PKG.version}`);
  }
});

const HEAVY_MODULE_NEEDLES = [
  "dist/cli_cmd_",
  "dist/cli_output.js",
  "dist/render/",
  "dist/monitor/",
  "dist/verify/",
  "dist/compositor/",
  "dist/speech/",
  "dist/extensions/",
  "dist/skills/",
  "dist/live/",
  "dist/library/probe.js",
  "dist/library/media_source.js",
  "dist/mcp/server.js",
  "dist/core/env.js",
  "dist/core/workspace.js",
  "node_modules/undici",
  "puppeteer",
  "node_modules/hyperframes",
];

function loadedModulesProfile(args: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-startup-"));
  try {
    const proc = spawnSync(process.execPath, ["--cpu-prof", "--cpu-prof-dir", dir, CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
    });
    assert.equal(proc.status, 0, `cuthol ${args.join(" ")} stderr: ${proc.stderr}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"));
    assert.equal(files.length, 1, `expected one profile, got ${files.join(",")}`);
    return fs.readFileSync(path.join(dir, files[0]), "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const args of [["help"], ["spine", "trim", "--help"], ["explain", "G101"]]) {
  test(`${args.join(" ")} runs without the heavy modules`, () => {
    const profile = loadedModulesProfile(args);
    assert.ok(profile.includes("dist/cli_main.js"), "profile should record the CLI modules");
    for (const needle of HEAVY_MODULE_NEEDLES) {
      assert.ok(!profile.includes(needle), `help path must not load ${needle}`);
    }
  });
}
