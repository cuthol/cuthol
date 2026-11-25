// Throw-away one-clip project for effect authoring (`spine fx try`, `spine fx check --full`).
// Builds a generated card through the product's own APIs (workspace init, ingest,
// spine append, `spine fx add` / `spine envelope`), renders frames through the compiled
// product render plan, and deletes the temp dir in `finally`, on SIGINT and on timeout.
// A hard kill (SIGKILL) cannot run cleanup: the next `openFxSandbox` removes stale
// sandbox dirs left behind, so one hard kill never accumulates garbage.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { rmRetrySync } from "../core/fs_retry.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ensurePlanPrePasses } from "../render/pre_pass.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { setItemEnvelope } from "../sequence/spine.js";
import { enableExtensionInWorkspace } from "../extensions/manager.js";

export type FxSandboxCardName = "tv" | "full" | "bit10" | "vertical" | "rgba" | "vfr";

export interface FxSandboxCard {
  name: FxSandboxCardName;
  file: string;
  width: number;
  height: number;
}

export interface FxSandbox {
  dir: string;
  wsDir: string;
  clipId: string;
  card: FxSandboxCardName;
  durationSec: number;
  dispose: () => void;
}

export interface FxSandboxOpenOptions {
  card?: FxSandboxCardName;
  /** Use this media file as the card instead of generating one (for `--on`: a copy of the item's source). */
  mediaFile?: string;
  /** Project-local extension dirs to stage into the sandbox (`<name>` dir with a manifest). */
  extDirs?: Array<{ name: string; dir: string }>;
  /** Non-zero source in-point for the appended clip (ms). Default 0. */
  sourceInMs?: number;
  /** Sandbox dir prefix. Default `cuthol-fxsb-`. */
  prefix?: string;
  /** Watchdog: dispose the sandbox after this long (ms). Default 120_000. */
  timeoutMs?: number;
  /** Extra fx entries applied in order after the first (for stacking checks). */
  extraFx?: Array<{ kind?: string; filter?: string; params?: Record<string, unknown> }>;
  /** Envelopes applied via the same function `spine envelope` uses. */
  envelopes?: Array<{ parameter: string; points: Array<{ offset_ms: number; value: number; easing?: string; bezier?: number[] }> }>;
}

const SANDBOX_PREFIXES = ["cuthol-fxsb-", "cuthol-fxtry-", "cuthol-fxfull-"];

/**
 * Temp dirs that must vanish on a soft interrupt (Ctrl-C / SIGINT, SIGTERM).
 * `finally` blocks never run when the process is signalled, so every temp dir a
 * `try`/`--full` run creates registers here; the handlers remove all of them.
 */
const trackedTempDirs = new Set<string>();
let signalHandlersInstalled = false;
function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const cleanup = (): void => {
    for (const dir of trackedTempDirs) {
      try {
        rmRetrySync(dir);
      } catch {
        // best effort
      }
    }
    trackedTempDirs.clear();
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

/** Register a temp dir for signal cleanup; returns a function that unregisters it. */
export function trackTempDir(dir: string): () => void {
  installSignalHandlers();
  trackedTempDirs.add(dir);
  return () => {
    trackedTempDirs.delete(dir);
  };
}

function ffmpeg(args: string[], cwd?: string): void {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 120_000, cwd, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`ffmpeg failed: ${String(r.stderr ?? r.error ?? "").split("\n").slice(0, 4).join(" | ").slice(0, 400)}`);
  }
}

/**
 * A filter graph passed from a file, never on the command line: long envelope
 * expressions would otherwise exceed the Windows command line limit
 * (ENAMETOOLONG). `flag` is `-/vf` or `-/filter_complex`, as the render path does.
 */
function graphFileArgs(flag: "-/vf" | "-/filter_complex", graph: string): { args: string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxgraph-"));
  const file = path.join(dir, "filter.txt");
  fs.writeFileSync(file, graph, "utf8");
  return {
    args: [flag, file],
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/** Run ffmpeg whose graph args already point at files; removes the graph file afterwards. */
function ffmpegGraph(args: string[], cleanup: () => void, opts: { timeout: number; cwd?: string }): void {
  try {
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: opts.timeout, cwd: opts.cwd, windowsHide: true });
    if (r.error || r.status !== 0) {
      throw new Error(`ffmpeg failed: ${String(r.stderr ?? r.error ?? "").split("\n").slice(0, 4).join(" | ").slice(0, 400)}`);
    }
  } finally {
    cleanup();
  }
}

/** Saturated moving pattern + fine grid + grey ramp, so saturation, sharpness and tone changes are visible. */
function cardFilter(name: FxSandboxCardName, w: number, h: number, dur: number): { vf: string; pixFmt: string; extraInput?: string[] } {
  const base = `testsrc2=s=${w}x${h}:r=30:d=${dur},eq=saturation=1.4,drawgrid=w=8:h=8:c=white@0.4`;
  switch (name) {
    case "tv":
      return { vf: base, pixFmt: "yuv420p" };
    case "full":
      return { vf: base, pixFmt: "yuvj420p" };
    case "bit10":
      return { vf: base, pixFmt: "yuv420p10le" };
    case "vertical":
      return { vf: base, pixFmt: "yuv420p" };
    case "rgba":
      return { vf: `${base},format=rgba,fade=t=in:st=0:d=1:alpha=1`, pixFmt: "rgba" };
    case "vfr":
      return { vf: "testsrc2=s=640x360:r=60:d=3", pixFmt: "yuv420p" };
  }
}

function cardSize(name: FxSandboxCardName): [number, number] {
  return name === "vertical" ? [360, 640] : [640, 360];
}

/**
 * Remove stale sandbox dirs from a previous hard kill (best effort). Only dirs
 * older than 10 minutes are touched, so concurrently active sandboxes (including
 * our own siblings) are never removed.
 */
const STALE_MS = 10 * 60 * 1000;
function cleanStaleSandboxes(): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const e of entries) {
    if (!SANDBOX_PREFIXES.some((p) => e.startsWith(p))) continue;
    const full = path.join(os.tmpdir(), e);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory() || Date.now() - st.mtimeMs < STALE_MS) continue;
      rmRetrySync(full);
    } catch {
      // best effort
    }
  }
}

export function openFxSandbox(opts: FxSandboxOpenOptions & { kind?: string; filter?: string; params?: Record<string, unknown> } = {}): FxSandbox {
  cleanStaleSandboxes();
  const card = opts.card ?? "tv";
  const [w, h] = cardSize(card);
  const dur = 3;
  const prefix = opts.prefix ?? "cuthol-fxsb-";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(watchdog);
    process.removeListener("SIGINT", onSigint);
    try {
      rmRetrySync(dir);
    } catch {
      // best effort
    }
  };
  const onSigint = (): void => {
    dispose();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  const watchdog = setTimeout(() => dispose(), opts.timeoutMs ?? 120_000);
  watchdog.unref?.();
  try {
    const wsDir = path.join(dir, "proj");
    initWorkspace({ dir: wsDir, title: "fxsb", aspect: card === "vertical" ? "9:16" : "16:9", fps: 30 });
    for (const ext of opts.extDirs ?? []) {
      const dest = path.join(wsDir, ".cuthol", "extensions", ext.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(ext.dir, dest, { recursive: true });
      enableExtensionInWorkspace({ workspaceDir: wsDir, name: ext.name, scope: "project", skipShaderCompile: true });
    }
    const mediaPath = path.join(dir, `${card}.mp4`);
    if (opts.mediaFile) {
      fs.copyFileSync(opts.mediaFile, mediaPath);
    } else {
      const { vf, pixFmt } = cardFilter(card, w, h, dur);
      if (card === "vfr") {
        const g = graphFileArgs("-/vf", "select='not(mod(n\\,3))+eq(mod(n\\,7)\\,0)'");
        ffmpegGraph(["-y", "-v", "error", "-f", "lavfi", "-i", vf, ...g.args, "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", pixFmt, mediaPath], g.cleanup, { timeout: 120_000 });
      } else {
        ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", vf, "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", pixFmt, mediaPath]);
      }
    }
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mediaPath] });
    const { clip } = appendSpineClip({
      workspaceDir: wsDir,
      assetHandle: item.handle,
      ...(opts.sourceInMs ? { sourceInMs: opts.sourceInMs } : {}),
    });
    // A raw chain carries its values in the text; params belong to extension kinds.
    if (opts.kind !== undefined || opts.filter !== undefined) {
      addSpineFx({
        workspaceDir: wsDir,
        clipId: clip.id,
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
        ...(opts.filter === undefined && opts.params !== undefined ? { params: opts.params } : {}),
      });
    }
    for (const extra of opts.extraFx ?? []) {
      addSpineFx({ workspaceDir: wsDir, clipId: clip.id, ...extra });
    }
    for (const env of opts.envelopes ?? []) {
      setItemEnvelope({
        workspaceDir: wsDir,
        targetId: clip.id,
        parameter: env.parameter as never,
        points: env.points as never,
      });
    }
    return { dir, wsDir, clipId: clip.id, card, durationSec: dur, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** Render the sandbox clip through the compiled product plan to PNG frames. Returns PNG paths. */
export function renderSandboxPngs(sb: FxSandbox, outDir: string, opts: { frames?: number; fps?: number } = {}): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const { sequence, paths } = loadSequence(sb.wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  ensurePlanPrePasses(plan, { cwd: (paths.rootDir as string) ?? sb.wsDir, step: "fx sandbox pre-pass" });
  const frames = opts.frames ?? Math.max(1, Math.round(sb.durationSec * (opts.fps ?? 2)));
  const outPattern = path.join(outDir, "f_%02d.png");
  const graphFile = path.join(outDir, "graph.txt");
  fs.writeFileSync(graphFile, plan.filterComplex, "utf8");
  const started = Date.now();
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", ...plan.inputArgs, "-/filter_complex", graphFile, "-map", plan.videoOutPad, "-frames:v", String(frames), "-fps_mode", "cfr", outPattern, "-map", plan.audioOutPad, "-f", "null", "-"],
    { encoding: "utf8", timeout: 120_000, cwd: paths.rootDir as string, windowsHide: true }
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `sandbox render failed: exit=${r.status} signal=${r.signal} elapsed=${Date.now() - started}ms timeout=120000ms stderr=${String(r.stderr ?? r.error ?? "").slice(-500) || "no stderr"}`
    );
  }
  const pngs = fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(outDir, f));
  if (pngs.length === 0) throw new Error("sandbox render produced no frames");
  return pngs;
}

/**
 * Render the sandbox clip through the compiled product plan and return one PNG per
 * requested time (seconds). The plan renders at the sequence rate (30 fps), so the
 * frame closest to each time is `round(t * 30)` of a render covering the whole card —
 * unlike `renderSandboxPngs`, which only renders the first N frames.
 */
export function renderSandboxFramesAtTimes(sb: FxSandbox, outDir: string, times: number[]): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const outFps = 30;
  const maxT = Math.max(...times, 0);
  const frames = Math.max(1, Math.round(maxT * outFps) + 1);
  const { sequence, paths } = loadSequence(sb.wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  ensurePlanPrePasses(plan, { cwd: (paths.rootDir as string) ?? sb.wsDir, step: "fx sandbox pre-pass" });
  const framesDir = path.join(outDir, "all");
  fs.mkdirSync(framesDir, { recursive: true });
  const outPattern = path.join(framesDir, "f_%04d.png");
  const graphFile = path.join(outDir, "graph.txt");
  fs.writeFileSync(graphFile, plan.filterComplex, "utf8");
  const started = Date.now();
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", ...plan.inputArgs, "-/filter_complex", graphFile, "-map", plan.videoOutPad, "-frames:v", String(frames), "-fps_mode", "cfr", outPattern, "-map", plan.audioOutPad, "-f", "null", "-"],
    { encoding: "utf8", timeout: 180_000, cwd: paths.rootDir as string, windowsHide: true }
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `sandbox render failed: exit=${r.status} signal=${r.signal} elapsed=${Date.now() - started}ms timeout=180000ms stderr=${String(r.stderr ?? r.error ?? "").slice(-500) || "no stderr"}`
    );
  }
  const all = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(framesDir, f));
  if (all.length === 0) throw new Error("sandbox render produced no frames");
  return times.map((t, i) => {
    const idx = Math.min(all.length - 1, Math.max(0, Math.round(t * outFps)));
    const dest = path.join(outDir, `t_${String(i).padStart(2, "0")}.png`);
    fs.copyFileSync(all[idx], dest);
    return dest;
  });
}

/** Mean sample value (0-255) of a PNG frame: decoded to raw rgb24, averaged in-process. */
export function meanLuma(png: string): number {
  const g = graphFileArgs("-/vf", "scale=160:90");
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("ffmpeg", ["-v", "error", "-i", png, ...g.args, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true } as unknown as Parameters<typeof spawnSync>[2]);
  } finally {
    g.cleanup();
  }
  const buf = r.stdout as unknown as Buffer;
  if (r.error || r.status !== 0 || !buf || buf.length === 0) {
    throw new Error(`luma decode failed for ${png}`);
  }
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length;
}

/** Y/U/V PSNR (dB) of `test` against `ref` (same size, rawvideo YUV). Uses ffmpeg `psnr`. */
export function psnrYuv(refFile: string, testFile: string, w: number, h: number, pixFmt = "yuv420p"): { y: number; u: number; v: number } {
  const g = graphFileArgs("-/filter_complex", "psnr");
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(
      "ffmpeg",
      ["-v", "info", "-s", `${w}x${h}`, "-pix_fmt", pixFmt, "-i", refFile, "-s", `${w}x${h}`, "-pix_fmt", pixFmt, "-i", testFile,
        ...g.args, "-f", "null", "-"],
      { encoding: "utf8", timeout: 60_000, windowsHide: true }
    );
  } finally {
    g.cleanup();
  }
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = /PSNR\s+y:([0-9.inf]+)\s+u:([0-9.inf]+)\s+v:([0-9.inf]+)/.exec(text);
  if (!m) throw new Error(`psnr parse failed: ${text.slice(-400)}`);
  const num = (s: string): number => (s === "inf" ? Infinity : Number(s));
  return { y: num(m[1]), u: num(m[2]), v: num(m[3]) };
}

/**
 * Per-frame cost of a filter chain at 1080p in ms: runs the chain on a 1080p
 * testsrc for 30 frames and divides wall time. Measured, not estimated.
 */
export function measureCostMsPerFrame1080p(chain: string, frames = 30): number {
  const src = "testsrc2=size=1920x1080:rate=30,format=yuv420p";
  const start = process.hrtime.bigint();
  const g = graphFileArgs("-/vf", `${chain},format=yuv420p`);
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", src, ...g.args, "-frames:v", String(frames), "-f", "null", "-"],
      { encoding: "utf8", timeout: 120_000, windowsHide: true }
    );
  } finally {
    g.cleanup();
  }
  if (r.error || r.status !== 0) {
    throw new Error(`cost probe failed: ${String(r.stderr ?? r.error ?? "").split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return ms / frames;
}

export function costClassFor(msPerFrame: number): "light" | "medium" | "heavy" {
  if (msPerFrame < 2) return "light";
  if (msPerFrame < 8) return "medium";
  return "heavy";
}
