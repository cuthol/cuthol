/**
 * CLI/MCP argument fixes: Windows MCP entry, argument parsing, output flags.
 * Each test fails on the old build (dist-base) for the behaviour reason.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { assertNoExtraPositionals, KNOWN_CLI_FLAGS, parseArgv } from "../cli_args.js";
import { createEmptySequence } from "../core/schema.js";
import { initWorkspace } from "../core/workspace.js";
import { exportTimeline } from "../export/timeline.js";
import { actionsForTool, buildCliArgv, findActionSpec, validateActionArgs } from "../mcp/catalog.js";
import { ACTION_SPECS } from "../mcp/catalog.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { captureMonitorFrame, annotateRgb24BufferToCanvas } from "../monitor/preview.js";
import { renderSingleCompositeFrameRgb24 } from "../render/render_frames.js";
import { loadSequence } from "../core/workspace.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cli-args-"));
after(() => rmRetrySync(ROOT));

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const MCP_BIN = path.resolve(process.cwd(), "dist/mcp_bin.js");

function runCli(args: string[], dir: string): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, `--dir=${dir}`], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function mcpTools(bin: string, extraArgs: string[] = []): Promise<{ count: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...extraArgs], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let timer: NodeJS.Timeout | null = null;
    const done = (v: { count: number; raw: string }): void => {
      if (timer) clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    child.stdout.on("data", (d) => {
      out += String(d);
      const lines = out.split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const msg = JSON.parse(t) as { id?: number; result?: { tools?: unknown[] } };
          if (msg.id === 2 && Array.isArray(msg.result?.tools)) {
            done({ count: (msg.result?.tools as unknown[]).length, raw: out });
            return;
          }
        } catch { /* partial line */ }
      }
    });
    child.on("error", reject);
    timer = setTimeout(() => done({ count: -1, raw: out }), 30000);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
}

test("mcp_bin.js answers initialize/tools/list without a shell (>= 15 tools)", async () => {
  const a = await mcpTools(MCP_BIN);
  assert.ok(a.count >= 15, `mcp_bin tools: ${a.count}\n${a.raw.slice(0, 800)}`);
});

test("cli.js mcp answers initialize/tools/list without a shell (>= 15 tools)", async () => {
  const a = await mcpTools(CLI, ["mcp"]);
  assert.ok(a.count >= 15, `cli mcp tools: ${a.count}\n${a.raw.slice(0, 800)}`);
});

test("color look ops parse (rest budget) and list runs end to end", () => {
  for (const op of ["list", "create", "from-pair", "bind", "remove"]) {
    assert.doesNotThrow(() => assertNoExtraPositionals("color", "look", [op], {}), `color look ${op}`);
  }
  assert.throws(() => assertNoExtraPositionals("color", "look", ["list", "x", "y"], {}), /CUTHOL-G110/);
  const dir = fs.mkdtempSync(path.join(ROOT, "look-"));
  initWorkspace({ dir, title: "look", aspect: "16:9", fps: 30 });
  const r = runCli(["color", "look", "list", "--json"], dir);
  assert.equal(r.status, 0, r.stderr.slice(0, 500));
  assert.match(r.stdout, /"sub": "list"|"look"/);
});

test("color.look takes from_item (snake_case); no hyphenated MCP arg names", () => {
  const spec = findActionSpec("color", "look");
  assert.ok(spec, "color.look spec exists");
  const names = spec.params.map((p) => p.name);
  assert.ok(names.includes("from_item"), `look params: ${names.join(",")}`);
  const okRes = validateActionArgs(spec, { op: "create", from_item: "sp_01" });
  assert.deepEqual(okRes.issues, [], JSON.stringify(okRes.issues));
  const badRes = validateActionArgs(spec, { op: "create", "from-item": "sp_01" });
  assert.ok(badRes.issues.length > 0, "hyphenated from-item is rejected");
  const hyphenated: string[] = [];
  for (const s of ACTION_SPECS) {
    for (const p of s.params) {
      if (p.name.includes("-")) hyphenated.push(`${s.tool}.${s.action ?? ""}:${p.name}`);
    }
  }
  assert.deepEqual(hyphenated, [], `hyphenated MCP names: ${hyphenated.join(",")}`);
});

test("from_item maps to --from-item CLI flag", () => {
  const spec = findActionSpec("color", "look");
  assert.ok(spec);
  const { values, issues } = validateActionArgs(spec, { op: "create", from_item: "sp_01", name: "n" });
  assert.deepEqual(issues, []);
  const argv = buildCliArgv(spec, values, process.cwd());
  assert.ok(argv.includes("--from-item=sp_01"), `argv: ${argv.join(" ")}`);
});

test("export timeline --format fcpxml names the positional, not --format text", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "fmt-"));
  initWorkspace({ dir, title: "fmt", aspect: "16:9", fps: 30 });
  const r = runCli(["export", "timeline", "--format", "fcpxml"], dir);
  assert.notEqual(r.status, 0, "must fail");
  const text = r.stdout + r.stderr;
  assert.match(text, /CUTHOL-G110/);
  assert.match(text, /positional|--as/i);
  assert.doesNotMatch(text, /--format text/);
});

test("one color help block, matching the parser (dry parse, no G110)", () => {
  const help = spawnSync(process.execPath, [CLI, "help"], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
  });
  assert.equal(help.status, 0, help.stderr.slice(0, 300));
  const lines = String(help.stdout).split("\n").filter((l) => l.includes("cuthol color "));
  const mapLines = lines.filter((l) => l.includes("cuthol color map "));
  assert.equal(mapLines.length, 1, `color map blocks: ${JSON.stringify(mapLines)}`);
  assert.match(mapLines[0], /--item/);
  assert.doesNotMatch(mapLines[0], /--clip|--count/);
  assert.equal(lines.filter((l) => l.includes("cuthol color kind ")).length, 1);
  // Dry argument parse of representative invocations from the remaining block.
  const cases: string[][] = [
    ["color", "map", "--item", "sp_01"],
    ["color", "map", "--item", "sp_01", "--frames", "7", "--at", "1s,4s", "--graded"],
    ["color", "map", "--image", "ref.png"],
    ["color", "diff", "--a", "sp_01", "--b", "sp_02"],
    ["color", "solve", "--item", "sp_01", "--to", "sp_02"],
    ["color", "solve", "--mode", "technical", "--targets", "exposure"],
    ["color", "solve", "--mode", "pair", "--before", "a.png", "--after", "b.png", "--name", "n"],
    ["color", "set", "--item", "sp_01", "--exposure", "-0.4"],
    ["color", "compare", "--item", "sp_01", "--variants", "[]"],
    ["color", "look", "list"],
    ["color", "look", "create", "--name", "n", "--from-item", "sp_01"],
    ["color", "look", "bind", "--look", "look_01", "--items", "sp_01"],
    ["color", "kind", "--handle", "vid_01"],
    ["color", "clusters"],
    ["color", "migrate", "--item", "sp_01"],
  ];
  for (const argv of cases) {
    const { positionals, flags } = parseArgv(argv);
    for (const key of Object.keys(flags)) {
      assert.ok(KNOWN_CLI_FLAGS.has(key), `${argv.join(" ")}: unknown flag --${key}`);
    }
    const [group, action, ...rest] = positionals;
    assert.doesNotThrow(() => assertNoExtraPositionals(group, action, rest, flags), argv.join(" "));
  }
});

test("brief --json with a lens returns markdown, without keeps the sequence", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "brief-"));
  initWorkspace({ dir, title: "brief", aspect: "16:9", fps: 30 });
  const lensJson = runCli(["brief", "--lens", "overview", "--json"], dir);
  assert.equal(lensJson.status, 0, lensJson.stderr.slice(0, 500));
  const lensEnv = JSON.parse(lensJson.stdout) as Record<string, unknown>;
  assert.equal(lensEnv.lens, "overview");
  assert.equal(typeof lensEnv.markdown, "string");
  assert.ok(!(("sequence" in lensEnv)), "lens --json must not carry the sequence");
  const lensPos = runCli(["brief", "flow", "--json"], dir);
  assert.equal(lensPos.status, 0, lensPos.stderr.slice(0, 500));
  assert.equal((JSON.parse(lensPos.stdout) as Record<string, unknown>).lens, "flow");
  const full = runCli(["brief", "--json"], dir);
  assert.equal(full.status, 0, full.stderr.slice(0, 500));
  const fullEnv = JSON.parse(full.stdout) as Record<string, unknown>;
  assert.ok(fullEnv.sequence, "bare --json keeps the sequence");
  const bad = runCli(["brief", "--lens", "audio", "--json"], dir);
  assert.notEqual(bad.status, 0, "unknown lens must fail");
  assert.match(bad.stdout + bad.stderr, /overview\|flow\|canvas\|detail/);
});

test("brief lens JSON has no sequence key while the bare envelope does", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "brief2-"));
  initWorkspace({ dir, title: "brief2", aspect: "16:9", fps: 30 });
  const lensed = JSON.parse(runCli(["brief", "--lens", "detail", "--json"], dir).stdout) as Record<string, unknown>;
  assert.ok(!("sequence" in lensed));
  assert.ok(String(lensed.markdown).length < 3000, `detail markdown bytes: ${String(lensed.markdown).length}`);
});

function makeClipProject(tag: string): string {
  const dir = fs.mkdtempSync(path.join(ROOT, `${tag}-`));
  initWorkspace({ dir, title: tag, aspect: "16:9", fps: 30 });
  const media = path.join(ROOT, `${tag}-src.mp4`);
  if (!fs.existsSync(media)) {
    const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media], { encoding: "utf8", windowsHide: true });
    assert.equal(mk.status, 0, mk.stderr);
  }
  ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [media] });
  appendSpineClip({ workspaceDir: dir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  return dir;
}

function topStripRaw(pngPath: string, rows: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-v", "error", "-i", pngPath, "-vf", `crop=in_w:${rows}:0:0`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg crop exit ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

test("--no-hud top strip equals the raw frame; default draws the HUD", async () => {
  const dir = makeClipProject("hud");
  const hudPng = path.join(dir, "hud.png");
  const cleanPng = path.join(dir, "clean.png");
  captureMonitorFrame({ workspaceDir: dir, atMs: 1000, showBoxes: false, outputPath: hudPng });
  captureMonitorFrame({ workspaceDir: dir, atMs: 1000, showBoxes: false, hideHud: true, outputPath: cleanPng });
  const hudTop = await topStripRaw(hudPng, 12);
  const cleanTop = await topStripRaw(cleanPng, 12);
  assert.ok(!hudTop.equals(cleanTop), "default frame must draw the HUD strip");
  const { sequence, paths } = loadSequence(dir);
  const raw = renderSingleCompositeFrameRgb24(sequence, paths, 1000, "draft_480p", { skipGates: ["G2_ASSETS"] });
  const rawTop = Buffer.from(raw.rgbBuf.subarray(0, raw.width * 12 * 3));
  assert.ok(cleanTop.equals(rawTop), "with --no-hud the top strip equals the raw frame");
  // CLI flag accepted end to end.
  const r = runCli(["monitor", "frame", "--at", "1000ms", "--boxes", "false", "--no-hud", "--out", "cli-clean.png"], dir);
  assert.equal(r.status, 0, r.stderr.slice(0, 500));
});

test("annotateRgb24BufferToCanvas showHud=false keeps raw pixels", () => {
  const w = 64;
  const h = 16;
  const rgb = Buffer.alloc(w * h * 3, 200);
  const seq = createEmptySequence({ projectId: "hud-u", title: "hud-u" });
  const withHud = annotateRgb24BufferToCanvas(rgb, w, h, 0, seq, false, undefined, true);
  const noHud = annotateRgb24BufferToCanvas(rgb, w, h, 0, seq, false, undefined, false);
  const top = (c: { pixels: Uint8Array }): Buffer => Buffer.from(c.pixels.subarray(0, w * 12 * 4));
  assert.ok(!top(withHud.canvas).equals(top(noHud.canvas)), "HUD strip must differ");
  for (let i = 0; i < w * 12; i++) {
    assert.equal(noHud.canvas.pixels[i * 4], 200);
    assert.equal(noHud.canvas.pixels[i * 4 + 1], 200);
    assert.equal(noHud.canvas.pixels[i * 4 + 2], 200);
  }
});

test("export finds the rendered overlay via the comp cache state", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "exp-"));
  initWorkspace({ dir, title: "exp", aspect: "16:9", fps: 30 });
  const media = path.join(dir, "src.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media], { encoding: "utf8", windowsHide: true });
  assert.equal(mk.status, 0, mk.stderr);
  ingestAssetsIntoWorkspace({ workspaceDir: dir, filePaths: [media] });
  appendSpineClip({ workspaceDir: dir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  // Composition cue pointing at a comp dir, with a render-written cache state.
  const compDir = path.join(dir, "compositions", "intro");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), "<!DOCTYPE html><html><body></body></html>");
  const loaded = loadSequence(dir);
  const lane = loaded.sequence.lanes.find((l) => l.id === "ln_motion") ?? loaded.sequence.lanes[0];
  lane.cues.push({
    id: "cue_01",
    kind: "composition",
    anchor: null,
    at_ms: 0,
    duration_ms: 2000,
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
    composition: { composition_dir: path.relative(dir, compDir), entry_html: "index.html", props: {}, transparent: true },
    envelopes: [],
  });
  // What a render leaves behind: hash-named blob + per-comp state record.
  const { paths } = loaded;
  const absCompDir = path.resolve(dir, "compositions", "intro");
  const compKey = crypto.createHash("sha256").update(path.resolve(absCompDir)).digest("hex").slice(0, 16);
  const blob = path.join(paths.blobsDir, "hf_comp_deadbeef1234.mp4");
  fs.mkdirSync(paths.blobsDir, { recursive: true });
  fs.writeFileSync(blob, "fake-mp4");
  fs.writeFileSync(
    path.join(paths.blobsDir, `hf_state_${compKey}.json`),
    JSON.stringify({ cachedBlobs: { "480x270:mp4:digest": blob } })
  );
  const res = exportTimeline(loaded.sequence, paths, "fcpxml");
  const compRef = res.cueRefs.find((c) => c.kind === "composition");
  assert.ok(compRef, "composition cue exported");
  assert.equal(compRef.overlayPath, blob, "overlay found through the cache state");
  assert.ok(!res.notExported.some((l) => l.includes("no rendered overlay")), `notes: ${res.notExported.join("; ")}`);
  // Without the state record the marker warning is still reported, never silent.
  fs.rmSync(path.join(paths.blobsDir, `hf_state_${compKey}.json`));
  const res2 = exportTimeline(loaded.sequence, paths, "fcpxml");
  assert.ok(res2.cueRefs.find((c) => c.kind === "composition")?.overlayPath === null);
  assert.ok(res2.notExported.some((l) => l.includes("no rendered overlay")), `notes: ${res2.notExported.join("; ")}`);
});

test("setup help line: every flag parses (no G110)", () => {
  const help = spawnSync(process.execPath, [CLI, "help"], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
  });
  assert.equal(help.status, 0, help.stderr.slice(0, 300));
  const line = String(help.stdout).split("\n").find((l) => l.includes("cuthol setup ["));
  assert.ok(line, "help prints a setup usage line");
  const flags = [...line.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  for (const want of ["agent", "ffmpeg", "apply", "force"]) {
    assert.ok(flags.includes(want), `setup line lists --${want}: ${line}`);
  }
  for (const flag of flags) {
    assert.ok(KNOWN_CLI_FLAGS.has(flag), `setup flag --${flag} is known (no G110)`);
  }
  // Dry-parse and dry-run representative invocations from the line.
  for (const argv of [
    ["setup"],
    ["setup", "--agent", "codex"],
    ["setup", "--agent", "codex,cursor"],
    ["setup", "--ffmpeg"],
    ["setup", "--ffmpeg", "--apply", "--json"],
    ["setup", "--agent", "codex", "--apply", "--force"],
  ]) {
    const { positionals, flags: parsed } = parseArgv(argv);
    for (const key of Object.keys(parsed)) {
      assert.ok(KNOWN_CLI_FLAGS.has(key), `${argv.join(" ")}: unknown flag --${key}`);
    }
    assert.deepEqual(positionals, ["setup"]);
  }
  const dir = fs.mkdtempSync(path.join(ROOT, "setup-help-"));
  initWorkspace({ dir, title: "setup-help", aspect: "16:9", fps: 30 });
  for (const args of [["setup"], ["setup", "--agent", "codex"], ["setup", "--ffmpeg"]]) {
    const r = runCli(args, dir);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr.slice(0, 500)}`);
    assert.doesNotMatch(r.stdout + r.stderr, /G110/);
  }
});
