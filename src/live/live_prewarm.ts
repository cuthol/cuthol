// Live pre-production (B2): while the window is idle, a background child
// process runs the render's overlay stage over a window around the playhead,
// so the next exact frames hit the cached composition overlays (B1).
//
// The child reuses the render's own setup (`setupOverlayStage` in
// render_main.ts) so its blobs carry exactly the keys a later
// `cuthol render --preset draft_480p` computes. It never calls
// `beginLiveRender`, so it never looks like a render to the stop signal.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSetting } from "../core/settings.js";

export const PREWARM_IDLE_MS = 5000;
export const PREWARM_WINDOW_BACK_MS = 10_000;
export const PREWARM_WINDOW_FWD_MS = 30_000;
export const PREWARM_PRESET = "draft_480p" as const;
export const PREWARM_DEFAULT_CAP_GB = 2;

/** Idle delay: 5 s. Longer than a scrub burst, shorter than a pause-and-look. */
export function prewarmIdleMs(): number {
  const raw = Number(process.env.CUTHOL_LIVE_PREWARM_IDLE_MS ?? PREWARM_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : PREWARM_IDLE_MS;
}

/** Window around the playhead, clamped to [0, durationMs]. Forward-heavy: the user usually resumes forward. */
export function prewarmWindowFor(playheadMs: number, durationMs: number): [number, number] {
  const start = Math.max(0, Math.round(playheadMs - PREWARM_WINDOW_BACK_MS));
  const end = durationMs > 0 ? Math.min(durationMs, Math.round(playheadMs + PREWARM_WINDOW_FWD_MS)) : Math.round(playheadMs + PREWARM_WINDOW_FWD_MS);
  return [Math.min(start, end), end];
}

/** Total bytes of render overlay blobs (`hf_comp_*` files plus `hf_comp_*.pngseq` dirs). */
export function prewarmOverlayBytes(projectDir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(path.resolve(projectDir), ".cuthol", "blobs"), { withFileTypes: true });
  } catch {
    return 0;
  }
  const dirSize = (p: string): number => {
    let sum = 0;
    let stack: string[] = [p];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      let kids: fs.Dirent[] = [];
      try {
        kids = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const k of kids) {
        const full = path.join(cur, k.name);
        try {
          if (k.isDirectory()) stack.push(full);
          else if (k.isFile()) sum += fs.statSync(full).size;
        } catch {
          // vanished mid-scan: ignore
        }
      }
    }
    return sum;
  };
  for (const e of entries) {
    if (!e.name.startsWith("hf_comp_")) continue;
    if (e.name.endsWith(".tmp") || e.name.includes(".tmp")) continue;
    const full = path.join(path.resolve(projectDir), ".cuthol", "blobs", e.name);
    try {
      if (e.isFile()) total += fs.statSync(full).size;
      else if (e.isDirectory() && e.name.endsWith(".pngseq")) total += dirSize(full);
    } catch {
      // vanished mid-scan: ignore
    }
  }
  return total;
}

/** True when the project's overlay blobs exceed the cap (never deletes; the render owns them). */
export function prewarmOverCap(projectDir: string, capGb: number): boolean {
  return prewarmOverlayBytes(projectDir) > capGb * 1024 ** 3;
}

function resolvePrewarmSetting(projectDir: string): { enabled: boolean; capGb: number } {
  let enabled = true;
  let capGb = PREWARM_DEFAULT_CAP_GB;
  try {
    enabled = (resolveSetting(projectDir, "live.prewarm").value as boolean) !== false;
    const cap = Number(resolveSetting(projectDir, "live.prewarm_cap_gb").value);
    if (Number.isFinite(cap) && cap > 0) capGb = cap;
  } catch {
    // unreadable settings: default on
  }
  return { enabled, capGb };
}

export interface PrewarmRequest {
  projectDir: string;
  startMs: number;
  endMs: number;
  /** The live server's pid: when it dies (Windows SIGTERM never runs handlers) the orphaned child stops itself. */
  serverPid?: number;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Starts one low-priority child running the overlay pre-pass. Never on the server event loop. */
export function startPrewarmChild(req: PrewarmRequest, log: (msg: string) => void): ChildProcess | null {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const entry = path.resolve(here, "live_prewarm.js");
    const args = [entry, "--live-prewarm-child", path.resolve(req.projectDir), String(req.startMs), String(req.endMs)];
    if (req.serverPid) args.push("--server-pid", String(req.serverPid));
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(req.projectDir),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
    });
    try {
      const prio = (os.constants.priority as unknown as Record<string, number>).PRIORITY_BELOW_NORMAL;
      if (typeof prio === "number" && child.pid) os.setPriority(child.pid, prio);
      else if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // priority is best-effort
    }
    child.stdout?.on("data", (d: Buffer) => log(`prewarm: ${String(d).trimEnd()}`));
    child.stderr?.on("data", (d: Buffer) => log(`prewarm: ${String(d).trimEnd()}`));
    child.on("error", (e) => log(`prewarm child failed: ${e.message}`));
    log(`prewarm started (${req.startMs}..${req.endMs} ms, pid ${child.pid ?? "?"})`);
    return child;
  } catch (e) {
    log(`prewarm start failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Stops the child and its HyperFrames/Chrome/ffmpeg descendants, then sweeps
 * the child's own tmp/stage files. The render publishes blobs by tmp + rename,
 * so a kill can still leave the tmp behind; only `hf_stage_*` dirs and
 * pid-tagged `.tmp` files are removed, never a finished blob.
 */
export function stopPrewarmChild(child: ChildProcess | null, log: (msg: string) => void, projectDir?: string): void {
  if (!child || child.exitCode !== null && child.signalCode !== null) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    } else if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // already gone
  }
  if (projectDir && pid) sweepPrewarmTemp(projectDir, pid, log);
  log(`prewarm stopped (pid ${pid ?? "?"})`);
  // Capture workers stage under their own pid and may still hold locks while
  // the tree dies; re-sweep dead owners shortly after, without blocking.
  if (projectDir) {
    const timer = setTimeout(() => {
      try {
        sweepOrphanedPrewarmTemp(projectDir, log);
      } catch {
        // best effort
      }
    }, 1500);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

/**
 * Removes tmp/stage files tagged with pids that are no longer alive: a kill
 * can land while a capture holds a file lock, so the dead owner's garbage is
 * recovered here instead of at kill time. Never touches a finished blob or a
 * living owner's files.
 */
export function sweepOrphanedPrewarmTemp(projectDir: string, log: (msg: string) => void): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(path.resolve(projectDir), ".cuthol", "blobs"), { withFileTypes: true });
  } catch {
    return;
  }
  const tagOf = (name: string): number | null => {
    const m = /(?:^hf_stage_[0-9a-f]+_|[_ .])(\d+)_\d+/i.exec(name);
    if (!m) return null;
    const pid = Number(m[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  for (const e of entries) {
    const isStage = e.name.startsWith("hf_stage_");
    const isTmp = e.name.includes(".tmp");
    if (!isStage && !isTmp) continue;
    const pid = tagOf(e.name);
    if (pid === null || pidAlive(pid)) continue;
    try {
      fs.rmSync(path.join(path.resolve(projectDir), ".cuthol", "blobs", e.name), { recursive: true, force: true });
      log(`prewarm swept orphan ${e.name}`);
    } catch {
      // locked or vanished; the next start tries again
    }
  }
}

/** Removes one prewarm child's tmp/stage files, never a finished blob. */
export function sweepPrewarmTemp(projectDir: string, pid: number, log: (msg: string) => void): void {
  const tag = `_${pid}_`;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(path.resolve(projectDir), ".cuthol", "blobs"), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const isStage = e.name.startsWith("hf_stage_") && e.name.includes(tag);
    const isTmp = e.name.includes(".tmp") && (e.name.includes(tag) || e.name.includes(`.${pid}_`));
    if (!isStage && !isTmp) continue;
    try {
      fs.rmSync(path.join(path.resolve(projectDir), ".cuthol", "blobs", e.name), { recursive: true, force: true });
      log(`prewarm swept ${e.name}`);
    } catch {
      // best effort
    }
  }
}

/** Idle scheduler owned by the live server: one child at most, restarted from new state after every stop. */
export class LivePrewarmer {
  private child: ChildProcess | null = null;
  private lastStartSig = "";
  private lastCapLogAt = 0;

  constructor(
    private readonly projectDir: string,
    private readonly log: (msg: string) => void,
  ) {}

  running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Stop conditions: an edit, a CLI render (progress file), or window activity. */
  stop(): void {
    if (!this.running()) {
      this.child = null;
      return;
    }
    const c = this.child;
    this.child = null;
    this.lastStartSig = "";
    stopPrewarmChild(c, this.log, this.projectDir);
  }

  onChildExit(): void {
    this.child = null;
  }

  /** Idle check: start one child when due. Pure decision inputs so tests can drive it. */
  maybeStart(now: number, state: { revision: number; progressJson: string; playheadMs: number; durationMs: number; windowActiveAt: number; lastChangeAt: number; lastProgressAt: number }): void {
    if (this.running()) return;
    const { enabled, capGb } = resolvePrewarmSetting(this.projectDir);
    if (!enabled) return;
    if (now - state.windowActiveAt < prewarmIdleMs()) return;
    if (now - state.lastChangeAt < prewarmIdleMs()) return;
    if (now - state.lastProgressAt < prewarmIdleMs()) return;
    if (state.progressJson !== "" && state.progressJson !== "null") return;
    if (prewarmOverCap(this.projectDir, capGb)) {
      if (now - this.lastCapLogAt > 60_000) {
        this.lastCapLogAt = now;
        this.log(`prewarm skipped: overlay blobs exceed the ${capGb} GB cap`);
      }
      return;
    }
    const [startMs, endMs] = prewarmWindowFor(state.playheadMs, state.durationMs);
    const sig = `r${state.revision}:${startMs}..${endMs}`;
    if (sig === this.lastStartSig) return;
    this.lastStartSig = sig;
    const child = startPrewarmChild({ projectDir: this.projectDir, startMs, endMs, serverPid: process.pid }, this.log);
    if (child) {
      this.child = child;
      const pid = child.pid;
      child.on("exit", () => {
        if (this.child === child) this.child = null;
        // Locks held at kill time defeat the immediate sweep; retry now that the tree is dead.
        if (pid) sweepPrewarmTemp(this.projectDir, pid, this.log);
      });
    }
  }
}

/** Child entry: runs the overlay stage over [startMs, endMs] with one overlay and one worker at a time. */
export async function runPrewarmChild(projectDir: string, startMs: number, endMs: number, serverPid?: number): Promise<void> {
  // The server may die without stopping us (its Windows SIGTERM never runs
  // handlers). Watch it and exit between captures: capture batches are
  // synchronous, so this fires after the in-flight batch lands; any tmp it
  // leaves behind carries our pid and is swept at the next server start.
  if (serverPid) {
    const watch = setInterval(() => {
      if (pidAlive(serverPid)) return;
      clearInterval(watch);
      try {
        sweepPrewarmTemp(projectDir, process.pid, () => {});
      } catch {
        // best effort; the next server start sweeps dead-pid leftovers
      }
      // Take the whole tree (HyperFrames/Chrome/ffmpeg grandchildren) with
      // us; anything still locked is swept at the next server start.
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
        }
      } catch {
        // fall through to exit
      }
      process.exit(0);
    }, 2000);
    (watch as unknown as { unref?: () => void }).unref?.();
  }
  const { loadSequence } = await import("../core/workspace.js");
  const { compileSequenceRenderPlan } = await import("../compositor/compiler.js");
  const { beginOverlayCollect, sortCollectedOverlays, runCollectedOverlaysSequential, finishOverlayRenderTracking } =
    await import("../compositor/hf_overlay_tracking.js");
  const { setupOverlayStage } = await import("../render/render_main.js");
  const { computeRenderDurationMs, resolveCueStartMs } = await import("../core/timeline.js");
  const root = path.resolve(projectDir);
  const { sequence, paths } = loadSequence(root);
  const durationMs = computeRenderDurationMs(sequence);
  const [start, end] = [Math.max(0, startMs), durationMs > 0 ? Math.min(durationMs, endMs) : endMs];
  setupOverlayStage({ sequence, rootDir: paths.rootDir, preset: PREWARM_PRESET });
  beginOverlayCollect();
  const prewarmPlan = compileSequenceRenderPlan(sequence, paths, PREWARM_PRESET, { includeAudio: false, workers: 1, activeWindowMs: [start, end] });
  const { requirePlanPrePasses, enforceShaderIntermediateCap, resolveShaderCacheCapGb } =
    await import("../render/pre_pass.js");
  requirePlanPrePasses(prewarmPlan, { cwd: paths.rootDir, step: "ffmpeg pre-pass" }, "live prewarm");
  // A prewarm window writes shader intermediates like a render; enforce
  // the same cap with the same rules (never throws, never fails prewarm).
  try {
    const used = (prewarmPlan.prePasses ?? [])
      .filter((job) => job.kind === "shader")
      .map((job) => job.outPath);
    enforceShaderIntermediateCap(paths.blobsDir, used, resolveShaderCacheCapGb(paths.rootDir));
  } catch {
    // best-effort
  }
  // Nearest-to-playhead first (forward before backward at equal distance), so a
  // stop keeps the overlay the user is most likely to need. Each job finalizes
  // its blob right after its own capture, so a stop loses at most one capture.
  const cueStartByComp = new Map<string, number>();
  for (const lane of sequence.lanes ?? []) {
    for (const cue of lane.cues ?? []) {
      const dir = (cue as { composition?: { composition_dir?: string } }).composition?.composition_dir;
      if (cue.kind !== "composition" || !dir) continue;
      const abs = path.isAbsolute(dir) ? dir : path.resolve(root, dir);
      const cueStart = resolveCueStartMs(sequence, cue as never);
      const prev = cueStartByComp.get(abs);
      if (prev === undefined || cueStart < prev) cueStartByComp.set(abs, cueStart);
    }
  }
  const playhead = Math.max(0, startMs);
  sortCollectedOverlays((job) => {
    const cueStart = cueStartByComp.get(path.resolve(job.absCompDir));
    if (cueStart === undefined) return Number.MAX_SAFE_INTEGER;
    const dist = Math.abs(cueStart - playhead);
    // Forward before backward at equal distance: backward cues sort half a step later.
    return dist * 2 + (cueStart < playhead ? 1 : 0);
  });
  runCollectedOverlaysSequential({ workers: 1 });
  const summary = finishOverlayRenderTracking();
  process.stdout.write(`prewarm done: ${summary.rendered} rendered, ${summary.cached} cached (${start}..${end} ms)\n`);
}

const childIdx = process.argv.indexOf("--live-prewarm-child");
if (childIdx >= 0) {
  const dir = process.argv[childIdx + 1] ?? process.cwd();
  const startMs = Number(process.argv[childIdx + 2] ?? "0");
  const endMs = Number(process.argv[childIdx + 3] ?? "0");
  const serverPidIdx = process.argv.indexOf("--server-pid");
  const serverPid = serverPidIdx >= 0 ? Number(process.argv[serverPidIdx + 1]) : undefined;
  runPrewarmChild(dir, startMs, endMs, Number.isFinite(serverPid) ? serverPid : undefined).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`prewarm failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
