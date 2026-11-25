/**
 * Bare backdrop under a transparent composition (K2): in a spine-less project,
 * a span whose only picture is a transparent composition with mostly-empty
 * alpha shows bare stage backdrop. Verify reports it once (single aggregate
 * INFO diagnostic naming the spans and the backdrop color). The alpha fill
 * comes from the cached composition measurement sidecar; without a
 * measurement, or with a spine, or with dense content, the check stays silent.
 */
import test from "node:test";
import { sharedColorMp4 } from "./shared_media.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for the assertion message
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function codes(diags: any[] | undefined): string[] {
  return (diags ?? []).map((d: any) => d.code);
}

function readSequence(wsDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(wsDir, "cuthol.sequence.json"), "utf8"));
}

/** Scaffold a transparent composition with the stage geometry of `wsDir`. */
function scaffoldTransparentCard(wsDir: string, compName: string): string {
  const { sequence } = loadSequence(wsDir);
  const compDir = path.join(wsDir, "compositions", compName);
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    width: sequence.stage.width,
    height: sequence.stage.height,
    fps: sequence.stage.fps,
    durationMs: 2000,
    preset: "counter",
    props: {},
    transparent: true,
  });
  assert.ok(fs.existsSync(path.join(compDir, "index.html")));
  return compDir;
}

/** Mount the composition for `[atMs, atMs + durationMs)`; returns the cue id. */
function mountComposition(wsDir: string, compDir: string, atMs: number, durationMs: number): string {
  const { cue } = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs,
    durationMs,
    explicitDuration: true,
    composition: {
      composition_dir: compDir,
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });
  assert.ok(cue.composition);
  assert.equal(cue.at_ms, atMs);
  assert.equal(cue.duration_ms, durationMs);
  return cue.id;
}

/** Transparent scaffold whose only painted pixel area is a centered 25%x25% box. */
function scaffoldSparseBoxComposition(wsDir: string, compName: string): string {
  const compDir = scaffoldTransparentCard(wsDir, compName);
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace(
      "</style>",
      "  #root > * { display: none !important; }\n" +
        "  #root::after { content: ''; position: absolute; left: 37.5%; top: 37.5%; width: 25%; height: 25%; background: #20E020; }\n</style>"
    ),
    "utf8"
  );
  return compDir;
}

/** Transparent scaffold painted fullscreen opaque green (dense alpha). */
function scaffoldDenseComposition(wsDir: string, compName: string): string {
  const compDir = scaffoldTransparentCard(wsDir, compName);
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace(
      "</style>",
      "  html, body, #root { background: #20E020 !important; }\n  #root > * { display: none !important; }\n</style>"
    ),
    "utf8"
  );
  assert.match(fs.readFileSync(indexHtml, "utf8"), /#root \{ background: #20E020/);
  return compDir;
}

function sidecarPath(compDir: string): string {
  return path.join(compDir, "assets", "cuthol-bbox.json");
}

test("spine-less spans under a mostly-empty transparent composition get one aggregate notice", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_agg");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, aspect: "16:9", fps: 30, stageExplicit: true });
  assert.ok(fs.existsSync(path.join(wsDir, "cuthol.sequence.json")));
  const compDir = scaffoldSparseBoxComposition(wsDir, "badge");
  mountComposition(wsDir, compDir, 0, 2000);
  mountComposition(wsDir, compDir, 3000, 1000);
  assert.equal(loadSequence(wsDir).sequence.lanes.find((l) => l.id === "ln_motion")!.cues.length, 2);

  const frame = cli(["monitor", "frame", "--at", "1000ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.ok(fs.existsSync(sidecarPath(compDir)), "alpha measurement sidecar must exist before verify");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  const notices = (verify.result.diagnostics ?? []).filter((d: any) => d.code === "CUTHOL-G316");
  assert.equal(notices.length, 1, `expected a single aggregate notice, got: ${verify.raw}`);
  assert.equal(notices[0].severity, "INFO", verify.raw);
  assert.match(notices[0].what, /0\.\.2000ms/, verify.raw);
  assert.match(notices[0].what, /3000\.\.4000ms/, verify.raw);
  assert.match(notices[0].what, new RegExp(readSequence(wsDir).stage.backdrop.color.replace("#", "#?")), verify.raw);
  assert.match(notices[0].formatted, /Suggestion: /, verify.raw);
  // The truly empty middle stretch still reports G308 next to the new notice.
  const gap = (verify.result.diagnostics ?? []).find((d: any) => d.code === "CUTHOL-G308");
  assert.ok(gap, verify.raw);
  assert.match(gap.what, /2000\.\.3000ms/, verify.raw);
});

test("no notice when a spine is present", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_spine");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, aspect: "16:9", fps: 30, stageExplicit: true });
  assert.ok(fs.existsSync(path.join(wsDir, "cuthol.sequence.json")));
  const sharedRed = sharedColorMp4("red", 30, 3);
  fs.copyFileSync(sharedRed, path.join(wsDir, "red.mp4"));
  const spineItems = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "red.mp4")] });
  assert.equal(spineItems[0].handle, "vid_01");
  const { clip: spineClip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  assert.equal(spineClip.asset_handle, "vid_01");
  const compDir = scaffoldSparseBoxComposition(wsDir, "badge");
  mountComposition(wsDir, compDir, 1000, 1000);
  assert.equal(loadSequence(wsDir).sequence.spine.clips.length, 1);

  const frame = cli(["monitor", "frame", "--at", "1500ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.ok(fs.existsSync(sidecarPath(compDir)), "alpha measurement sidecar must exist before verify");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.ok(!codes(verify.result.diagnostics).includes("CUTHOL-G316"), verify.raw);
});

test("no notice for dense fullscreen content", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_dense");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, aspect: "16:9", fps: 30, stageExplicit: true });
  assert.ok(fs.existsSync(path.join(wsDir, "cuthol.sequence.json")));
  const compDir = scaffoldDenseComposition(wsDir, "card");
  mountComposition(wsDir, compDir, 0, 2000);

  const frame = cli(["monitor", "frame", "--at", "1000ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(frame.ok, frame.raw);
  assert.ok(fs.existsSync(sidecarPath(compDir)), "alpha measurement sidecar must exist before verify");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.ok(!codes(verify.result.diagnostics).includes("CUTHOL-G316"), verify.raw);
});

test("no notice without a cached alpha measurement", () => {
  const wsDir = path.join(TEST_ROOT, "bare_backdrop_unmeasured");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, aspect: "16:9", fps: 30, stageExplicit: true });
  assert.ok(fs.existsSync(path.join(wsDir, "cuthol.sequence.json")));
  const compDir = scaffoldSparseBoxComposition(wsDir, "badge");
  mountComposition(wsDir, compDir, 0, 2000);
  assert.ok(!fs.existsSync(sidecarPath(compDir)), "no measurement must exist for this case");

  const verify = cli(["verify", "--dir", wsDir]);
  assert.ok(verify.ok, verify.raw);
  assert.ok(!codes(verify.result.diagnostics).includes("CUTHOL-G316"), verify.raw);
});
