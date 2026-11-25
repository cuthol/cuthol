/**
 * comp-probe: the lightweight browser probe records timeline registration
 * and pause state; verify/add-composition judge the contract at run time
 * and surface script errors with the existing G430–G432 codes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBundledGsapMinJs } from "../compositor/bridge_hash.js";
import {
  probeCompositionScriptErrors,
  readCurrentScriptErrorRecord,
  writeCurrentScriptErrorRecord,
} from "../compositor/coords_extract.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { verifyCompositionScripts } from "../verify/gates_script_errors.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-comp-probe-"));
const GSAP = findBundledGsapMinJs();
assert.ok(GSAP, "bundled gsap.min.js must exist");

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

const UNPAUSED = `const tl = gsap.timeline({ paused: false });
tl.to("#box", { x: 50, duration: 0.9 }, 0);
tl.set({}, {}, 1);
window.__timelines["main"] = tl;`;

const THROWING = `noSuchFunctionBeforeTimeline();
const tl = gsap.timeline({ paused: true });
tl.set({}, {}, 1);
window.__timelines["main"] = tl;`;

function writeComp(ws: string, name: string, script: string): string {
  const compDir = path.join(ws, "compositions", name);
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), compHtml(script), "utf8");
  fs.copyFileSync(GSAP as string, path.join(compDir, "assets", "gsap.min.js"));
  return compDir;
}

function setupWs(name: string): string {
  const ws = path.join(TEST_ROOT, name);
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: name, aspect: "16:9", fps: 30 });
  return ws;
}

test("probe: healthy page registers a paused timeline with no errors", async () => {
  const ws = setupWs("healthy");
  const compDir = writeComp(ws, "cmp", HEALTHY);
  const res = await probeCompositionScriptErrors({
    compDir,
    entryHtml: "index.html",
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 1,
  });
  assert.equal(res.timelineExpected, true);
  assert.equal(res.timelineRegistered, true);
  assert.equal(res.timelinePaused, true);
  assert.deepEqual(res.errors, []);
});

test("probe: unpaused timeline is reported as running", async () => {
  const ws = setupWs("unpaused");
  const compDir = writeComp(ws, "cmp", UNPAUSED);
  const res = await probeCompositionScriptErrors({
    compDir,
    entryHtml: "index.html",
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 1,
  });
  assert.equal(res.timelineRegistered, true);
  assert.equal(res.timelinePaused, false);
});

test("probe: throwing page records the error and no timeline", async () => {
  const ws = setupWs("throwing");
  const compDir = writeComp(ws, "cmp", THROWING);
  const res = await probeCompositionScriptErrors({
    compDir,
    entryHtml: "index.html",
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 1,
  });
  assert.equal(res.timelineRegistered, false);
  assert.ok(res.errors.length > 0);
});

test("records: pause state survives the write/read round trip", () => {
  const ws = setupWs("roundtrip");
  const compDir = writeComp(ws, "cmp", HEALTHY);
  const written = writeCurrentScriptErrorRecord(ws, {
    absCompDir: compDir,
    entryHtml: "index.html",
    source: "probe",
    timelineExpected: true,
    timelineRegistered: true,
    timelinePaused: true,
    errors: [],
  });
  assert.equal(written.timeline_paused, true);
  const read = readCurrentScriptErrorRecord(ws, compDir, "index.html");
  assert.ok(read);
  assert.equal(read?.timeline_paused, true);
});

test("verify: recorded run-phase throw surfaces as G431 without a browser", () => {
  const ws = setupWs("verify-g431");
  const compDir = writeComp(ws, "cmp", HEALTHY);
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 1000,
    composition: {
      composition_dir: "compositions/cmp",
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
    timelinePaused: true,
    errors: [{ phase: "run", kind: "pageerror", text: "post-timeline boom" }],
  });
  const { sequence, paths } = loadSequence(ws);
  const diagnostics: import("../core/diagnostics.js").CutholDiagnostic[] = [];
  verifyCompositionScripts(sequence, paths, diagnostics);
  const codes = diagnostics.map((d) => d.code);
  assert.ok(codes.includes("CUTHOL-G431"), `expected G431, got ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes("CUTHOL-G509"), `nothing unprobed, got ${JSON.stringify(codes)}`);
});
