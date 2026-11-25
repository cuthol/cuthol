/**
 * `lane add-composition` opens no browser when the static contract check
 * passes: the script check is left to `verify`, which probes every unchecked
 * composition in one shared run and judges the recorded result (including
 * a timeline that runs instead of staying paused).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import { readCurrentScriptErrorRecord, writeCurrentScriptErrorRecord } from "../compositor/coords_extract.js";
import type { CutholDiagnostic } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { verifyCompositionScripts } from "../verify/gates_script_errors.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-add-comp-probe-"));
const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CUTHOL_ENCODER: "x264" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function codesOf(stdout: string, stderr: string): string[] {
  for (const text of [stdout, stderr]) {
    const t = text.trim();
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a < 0 || b <= a) continue;
    try {
      const env = JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
      const found: string[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          if (typeof o.code === "string" && o.code.startsWith("CUTHOL-")) found.push(o.code);
          Object.values(o).forEach(walk);
        }
      };
      walk(env);
      return found;
    } catch {
      continue;
    }
  }
  return [];
}

function compHtml(script: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;width:640px;height:360px;overflow:hidden}#box{position:absolute;left:10px;top:10px;width:80px;height:60px;background:#1F8AFF}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="640" data-height="360" data-fps="30" data-duration="1">
<div id="box"></div>
</div>
<script src="assets/gsap.min.js"></script>
<script>
${script}
</script>
</body></html>
`;
}

const HEALTHY = `const tl = gsap.timeline({ paused: true });
tl.to("#box", { x: 50, duration: 0.5 }, 0);
tl.set({}, {}, 1);
window.__timelines["main"] = tl;`;

// Created paused (so the static check passes) but started at load: only a
// browser run can see that the timeline is running.
const UNPAUSED = `const tl = gsap.timeline({ paused: true });
tl.to("#box", { x: 50, duration: 0.9 }, 0);
tl.set({}, {}, 1);
window.__timelines["main"] = tl;
tl.play();`;

function writeComp(ws: string, name: string, script: string): string {
  const compDir = path.join(ws, "comps", name);
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), compHtml(script), "utf8");
  fs.copyFileSync(GSAP as string, path.join(compDir, "assets", "gsap.min.js"));
  return compDir;
}

function initWs(name: string): string {
  const ws = path.join(ROOT, name);
  fs.rmSync(ws, { recursive: true, force: true });
  const r = runCli(["workspace", "init", ws, "--aspect", "16:9", "--fps", "30"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return ws;
}

test("add-composition: statically valid page is mounted without a browser probe; verify probes it", () => {
  const ws = initWs("healthy");
  const compDir = writeComp(ws, "ok", HEALTHY);

  const add = runCli(["lane", "add-composition", "--dir", ws, "--comp-dir", "comps/ok", "--at", "0s", "--duration", "1s"]);
  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.ok(codesOf(add.stdout, add.stderr).includes("CUTHOL-G509"), `add should say the script is unchecked: ${add.stdout}`);
  // No record file at all: the probe never ran (a stale record under an older
  // file hash would also read back as null, so count the files instead).
  const recordsDir = path.join(ws, ".cuthol", "script_errors");
  const recordFiles = fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json")) : [];
  assert.deepEqual(recordFiles, [], "add must not run the browser probe");
  assert.equal(readCurrentScriptErrorRecord(ws, compDir, "index.html"), null);

  const verify = runCli(["verify", "--dir", ws]);
  const codes = codesOf(verify.stdout, verify.stderr);
  assert.ok(readCurrentScriptErrorRecord(ws, compDir, "index.html"), "verify records the probe result");
  assert.ok(!codes.includes("CUTHOL-G509"), `nothing left unchecked after verify: ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes("CUTHOL-G105"), `healthy page passes: ${JSON.stringify(codes)}`);
});

test("add-composition: a timeline that runs is mounted, and verify reports it as G105", () => {
  const ws = initWs("unpaused");
  writeComp(ws, "run", UNPAUSED);

  const add = runCli(["lane", "add-composition", "--dir", ws, "--comp-dir", "comps/run", "--at", "0s", "--duration", "1s"]);
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const verify = runCli(["verify", "--dir", ws]);
  const codes = codesOf(verify.stdout, verify.stderr);
  assert.ok(codes.includes("CUTHOL-G105"), `verify must flag the running timeline: ${verify.stdout}${verify.stderr}`);
});

test("render without verify still probes the composition and stops on a running timeline", () => {
  const ws = initWs("render-no-verify");
  writeComp(ws, "run", UNPAUSED);
  const add = runCli(["lane", "add-composition", "--dir", ws, "--comp-dir", "comps/run", "--at", "0s", "--duration", "1s"]);
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const render = runCli(["render", "--dir", ws, "--preset", "draft_480p", "--out", path.join(ws, "out.mp4")]);
  assert.notEqual(render.status, 0, `render must stop: ${render.stdout}`);
  assert.ok(codesOf(render.stdout, render.stderr).includes("CUTHOL-G105"), `${render.stdout}${render.stderr}`);
  assert.ok(!fs.existsSync(path.join(ws, "out.mp4")), "no output file for a refused render");
});

test("verify: a recorded running timeline is G105 without a browser", () => {
  const ws = path.join(ROOT, "pure");
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: "pure", aspect: "16:9", fps: 30 });
  const compDir = writeComp(ws, "run", UNPAUSED);
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 1000,
    composition: {
      composition_dir: "comps/run",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });
  writeCurrentScriptErrorRecord(ws, {
    absCompDir: compDir,
    entryHtml: "index.html",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    timelinePaused: false,
    errors: [],
  });
  const { sequence, paths } = loadSequence(ws);
  const diagnostics: CutholDiagnostic[] = [];
  verifyCompositionScripts(sequence, paths, diagnostics);
  const g105 = diagnostics.find((d) => d.code === "CUTHOL-G105");
  assert.ok(g105, `expected G105, got ${JSON.stringify(diagnostics.map((d) => d.code))}`);
  assert.equal(g105?.severity, "ERROR");
});
