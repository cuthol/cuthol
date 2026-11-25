/**
 * Cue end frame (K1): a lane cue covers exactly the half-open interval
 * `[start_ms, end_ms)` on every path.
 *
 * A fullscreen flat-green overlay cue over a flat-red spine is rendered, then
 * frames around both cue boundaries are read back one by one (ffmpeg
 * `select` + average color). Frame `n` (time `n/fps`) shows the overlay iff
 * `start_ms <= n*1000/fps < end_ms`. The matrix covers frame-aligned
 * (1000..2000ms) and unaligned (1010..2017ms) cues at 30/25/24/60 fps, plus
 * one image cue, one video cue, one ASS title cue, a monitor-frame/render
 * agreement check, and compiled-plan text assertions.
 */
import test from "node:test";
import { sharedColorMp4 } from "./shared_media.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { addLaneCue } from "../sequence/lanes.js";
import { appendSpineClip } from "../sequence/spine.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");
const OVERLAY_CSS = "#20E020";

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

function lavfiColorMp4(out: string, color: string, durSec: number, fps: number): void {
  assert.equal(
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=${fps}:d=${durSec},format=yuv420p`, out]).status,
    0
  );
}

function lavfiColorPng(out: string, color: string): void {
  assert.equal(
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=30:d=1,format=rgb24`, "-frames:v", "1", out]).status,
    0
  );
}

/** Average RGB of output frame `n` (ffmpeg frame index). */
function frameAvg(mp4: string, n: number): [number, number, number] {
  const px = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", mp4, "-vf", `select='eq(n\\,${n})',scale=1:1:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 }
  ).stdout as Buffer;
  assert.ok(px.length >= 3, `no pixels for frame ${n} of ${mp4}`);
  return [px[0], px[1], px[2]];
}

/** Average RGB of the center 200x60 band (title/text detection). */
function bandAvg(mp4: string, n: number): [number, number, number] {
  const px = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", mp4, "-vf", `select='eq(n\\,${n})',crop=200:60:(in_w-200)/2:(in_h-60)/2,scale=1:1:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 }
  ).stdout as Buffer;
  assert.ok(px.length >= 3, `no pixels for frame ${n} of ${mp4}`);
  return [px[0], px[1], px[2]];
}

function centerPixel(img: string): [number, number, number] {
  const px = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", img, "-vf", "crop=1:1:(in_w-1)/2:(in_h-1)/2", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 }
  ).stdout as Buffer;
  assert.ok(px.length >= 3, `no pixels for ${img}`);
  return [px[0], px[1], px[2]];
}

function countFrames(mp4: string): number {
  const out = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", mp4],
    { encoding: "utf8" }
  ).stdout;
  return Number(String(out).trim());
}

const isOverlayGreen = (c: [number, number, number]): boolean => c[1] > 150 && c[0] < 100;
const isSpineRed = (c: [number, number, number]): boolean => c[0] > 150 && c[1] < 100 && c[2] < 100;

/** Red spine source shared by every workspace at one fps (one lavfi encode per fps). */
function sharedRedVideo(fps: number): string {
  return sharedColorMp4("red", fps, 3);
}

/** Workspace with a 3 s red spine clip at `fps`. */
function setUpSpineWorkspace(name: string, fps: number): string {
  const wsDir = path.join(TEST_ROOT, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, aspect: "16:9", fps, stageExplicit: true });
  fs.copyFileSync(sharedRedVideo(fps), path.join(wsDir, "red.mp4"));
  const ingested = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "red.mp4")] });
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].handle, "vid_01");
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 3000 });
  assert.equal(clip.asset_handle, "vid_01");
  return wsDir;
}

/** Fullscreen flat-green composition cue `[atMs, atMs + durMs)`. */
function addFlatGreenComposition(wsDir: string, compName: string, atMs: number, durMs: number): string {
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
  const indexHtml = path.join(compDir, "index.html");
  const html = fs.readFileSync(indexHtml, "utf8");
  fs.writeFileSync(
    indexHtml,
    html.replace(
      "</style>",
      `  html, body, #root { background: ${OVERLAY_CSS} !important; }\n  #root > * { display: none !important; }\n</style>`
    ),
    "utf8"
  );
  const { cue } = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs,
    durationMs: durMs,
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
  assert.equal(cue.duration_ms, durMs);
  assert.match(fs.readFileSync(indexHtml, "utf8"), new RegExp(OVERLAY_CSS.replace("#", "#?")));
  return cue.id;
}

function renderDraft(wsDir: string, outName: string): string {
  const render = cli(["render", "--preset", "draft_480p", "--out", `output/${outName}`, "--dir", wsDir]);
  assert.ok(render.ok, render.raw);
  return path.join(wsDir, "output", outName);
}

/** Overlay frames for `[atMs, atMs + durMs)` at `fps`: first/last frame index. */
function expectedOverlayFrames(atMs: number, durMs: number, fps: number): { first: number; last: number } {
  const first = Math.ceil((atMs * fps) / 1000);
  const last = Math.ceil(((atMs + durMs) * fps) / 1000) - 1;
  assert.ok(last >= first, `empty overlay range at=${atMs} dur=${durMs} fps=${fps}`);
  return { first, last };
}

for (const fps of [30, 25, 24, 60]) {
  for (const [atMs, durMs] of [[1000, 1000], [1010, 1007]] as Array<[number, number]>) {
    test(`composition cue [${atMs},${atMs + durMs}) at ${fps} fps ends before its end frame`, () => {
      const wsDir = setUpSpineWorkspace(`cue_end_${fps}_${atMs}`, fps);
      addFlatGreenComposition(wsDir, "card", atMs, durMs);
      const mp4 = renderDraft(wsDir, `cue_${fps}_${atMs}.mp4`);
      assert.equal(countFrames(mp4), 3 * fps);

      const { first, last } = expectedOverlayFrames(atMs, durMs, fps);
      const before = frameAvg(mp4, first - 1);
      const head = frameAvg(mp4, first);
      const tail = frameAvg(mp4, last);
      const after = frameAvg(mp4, last + 1);
      assert.ok(isSpineRed(before), `frame ${first - 1} (t<start) must be spine red, got rgb(${before})`);
      assert.ok(isOverlayGreen(head), `frame ${first} (t=start) must show the overlay, got rgb(${head})`);
      assert.ok(isOverlayGreen(tail), `frame ${last} (t<end) must show the overlay, got rgb(${tail})`);
      assert.ok(isSpineRed(after), `frame ${last + 1} (t=end) must be spine red, got rgb(${after})`);
    });
  }
}

test("image cue [1000,2000) at 30 fps ends before its end frame", () => {
  const wsDir = setUpSpineWorkspace("cue_end_image", 30);
  const png = path.join(wsDir, "green.png");
  lavfiColorPng(png, "0x20E020");
  const imgItems = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [png] });
  assert.equal(imgItems[0].handle, "img_01");
  const { cue: imgCue } = addLaneCue({ workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: "img_01", atMs: 1000, durationMs: 1000, explicitDuration: true });
  assert.equal(imgCue.asset_handle, "img_01");
  const mp4 = renderDraft(wsDir, "cue_image.mp4");
  assert.equal(countFrames(mp4), 90);
  for (const [n, want] of [[29, "red"], [30, "green"], [59, "green"], [60, "red"]] as Array<[number, string]>) {
    const c = frameAvg(mp4, n);
    assert.equal(want === "green" ? isOverlayGreen(c) : isSpineRed(c), true, `frame ${n} must be ${want}, got rgb(${c})`);
  }
});

test("video cue [1000,2000) at 30 fps ends before its end frame", () => {
  const wsDir = setUpSpineWorkspace("cue_end_video", 30);
  lavfiColorMp4(path.join(wsDir, "green.mp4"), "0x20E020", 3, 30);
  const vidItems = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [path.join(wsDir, "green.mp4")] });
  assert.equal(vidItems[0].handle, "vid_02");
  const { cue: vidCue } = addLaneCue({ workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: "vid_02", atMs: 1000, durationMs: 1000, explicitDuration: true });
  assert.equal(vidCue.asset_handle, "vid_02");
  const mp4 = renderDraft(wsDir, "cue_video.mp4");
  assert.equal(countFrames(mp4), 90);
  for (const [n, want] of [[29, "red"], [30, "green"], [59, "green"], [60, "red"]] as Array<[number, string]>) {
    const c = frameAvg(mp4, n);
    assert.equal(want === "green" ? isOverlayGreen(c) : isSpineRed(c), true, `frame ${n} must be ${want}, got rgb(${c})`);
  }
});

test("ASS title cue [1000,2000) at 30 fps ends before its end frame", () => {
  const wsDir = setUpSpineWorkspace("cue_end_ass", 30);
  const { cue: titleCue } = addLaneCue({ workspaceDir: wsDir, laneId: "ln_titles", kind: "title", text: "MMMMMMMMMM", fontSizePx: 120, colorHex: "#FFFFFF", atMs: 1000, durationMs: 1000, explicitDuration: true });
  assert.equal(titleCue.typography?.text, "MMMMMMMMMM");
  const mp4 = renderDraft(wsDir, "cue_ass.mp4");
  assert.equal(countFrames(mp4), 90);
  const isTexty = (c: [number, number, number]): boolean => c[0] > 150 && c[1] > 20;
  const isPlainRed = (c: [number, number, number]): boolean => c[0] > 150 && c[1] <= 20 && c[2] <= 20;
  for (const [n, wantText] of [[29, false], [30, true], [59, true], [60, false], [61, false]] as Array<[number, boolean]>) {
    const c = bandAvg(mp4, n);
    assert.equal(wantText ? isTexty(c) : isPlainRed(c), true, `frame ${n} text visible=${wantText}, got rgb(${c})`);
  }
});

test("monitor frame agrees with the render frame on the cue end boundary", () => {
  const wsDir = path.join(TEST_ROOT, "cue_end_30_1000");
  const cue = loadSequence(wsDir).sequence.lanes.flatMap((l) => l.cues).find((c) => c.composition);
  assert.ok(cue, "composition matrix cell must run before this test");

  const atEnd = cli(["monitor", "frame", "--at", "2000ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(atEnd.ok, atEnd.raw);
  const endPx = centerPixel(atEnd.result.png_path);
  assert.ok(isSpineRed(endPx), `monitor frame at 2000ms (t=end) must be spine red, got rgb(${endPx})`);
  assert.ok(!atEnd.result.metrics.active_handles.includes(cue.id), atEnd.raw);

  const atStart = cli(["monitor", "frame", "--at", "1000ms", "--boxes", "false", "--dir", wsDir]);
  assert.ok(atStart.ok, atStart.raw);
  const startPx = centerPixel(atStart.result.png_path);
  assert.ok(isOverlayGreen(startPx), `monitor frame at 1000ms (t=start) must show the overlay, got rgb(${startPx})`);
  assert.ok(atStart.result.metrics.active_handles.includes(cue.id), atStart.raw);
});

test("compiled plan gates lane overlays half-open and skips the cue past its end", () => {
  const wsDir = setUpSpineWorkspace("cue_end_plan", 30);
  const png = path.join(wsDir, "green.png");
  lavfiColorPng(png, "0x20E020");
  const planItems = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [png] });
  assert.equal(planItems[0].handle, "img_01");
  const { cue: planCue } = addLaneCue({ workspaceDir: wsDir, laneId: "ln_broll", kind: "broll", assetHandle: "img_01", atMs: 1000, durationMs: 1000, explicitDuration: true });
  assert.equal(planCue.asset_handle, "img_01");

  const { paths, sequence } = loadSequence(wsDir);
  const cueId = sequence.lanes.flatMap((l) => l.cues).find((c) => c.asset_handle)?.id;
  assert.ok(cueId);
  const full = compileSequenceRenderPlan(sequence, paths, "draft_480p", { includeAudio: false });
  assert.ok(full.filterComplex.includes("enable='gte(t,1.000)*lt(t,2.000)'"), full.filterComplex.slice(0, 2000));
  assert.ok(!full.filterComplex.includes("between(t,1.000,2.000)"), full.filterComplex.slice(0, 2000));

  const pastEnd = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
    activeWindowMs: [2000, 2000 + 1000 / 30],
    singleFrameAtMs: 2000,
    includeAudio: false,
  });
  assert.ok(!pastEnd.filterComplex.includes(`[v_cue_${cueId}]`), pastEnd.filterComplex.slice(0, 2000));

  const atStart = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
    activeWindowMs: [1000, 1000 + 1000 / 30],
    singleFrameAtMs: 1000,
    includeAudio: false,
  });
  assert.ok(atStart.filterComplex.includes(`[v_cue_${cueId}]`), atStart.filterComplex.slice(0, 2000));
});
