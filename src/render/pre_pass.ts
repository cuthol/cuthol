/**
 * Fx pre-pass runner (`src/render/pre_pass.ts`).
 *
 * A compiled plan whose spine clip chain was cut at an fx entry carries
 * `prePasses` jobs: each replays one clip's source input through the chain
 * prefix (input through the cut) into a lossless `.nut` intermediate the main
 * graph reads back. This module runs those jobs before the main ffmpeg graph,
 * once per `outPath`:
 *
 * - skip when `outPath` already exists (only completed files are ever renamed
 *   into place, so existence means complete);
 * - otherwise take a lock file beside `outPath` so parallel segment workers
 *   asking for the same key wait instead of racing;
 * - render to `<outPath>.<pid>.tmp` and atomically rename on success, so an
 *   interruption (Ctrl-C, hard kill) never leaves a partial `outPath`;
 * - run under the existing stall watchdog (`spawnWatchedSync` with the tmp
 *   file as the watched path).
 *
 * An executor that cannot run pre-passes must fail loudly (G702) instead of
 * rendering the main graph without the cut.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveSetting } from "../core/settings.js";
import type { CompiledRenderPlan, PrePassJob } from "../compositor/compiler.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import type { ShaderWorkerBatchSpec } from "./shader_worker.js";

/**
 * Single-frame shader intermediates younger than this are never pruned.
 * Second guard behind the per-pid read locks: a file its producer has just
 * renamed into place (and not yet read-locked on an path without locks)
 * survives any concurrent prune until its owner reads it.
 */
export const SINGLE_FRAME_PRUNE_MIN_AGE_MS = 30_000;

export interface PrePassRunOptions {
  /** Working directory for the pre-pass ffmpeg processes (project root). */
  cwd: string;
  /** Label for diagnostics and the watchdog step. */
  step?: string;
  /** How long to wait for another process holding the same key (ms). */
  lockWaitMs?: number;
  /**
   * Skip the trailing single-frame prune (the caller holds read locks and
   * prunes once its own reads are done, so siblings it still needs survive).
   */
  deferSingleFramePrune?: boolean;
}

const DEFAULT_LOCK_WAIT_MS = 30 * 60 * 1000;
const LOCK_POLL_MS = 250;

/** True when the plan carries at least one pre-pass job. */
export function planNeedsPrePasses(plan: CompiledRenderPlan): boolean {
  return (plan.prePasses ?? []).length > 0;
}

/**
 * Records a reuse of a content-keyed intermediate: bumps its mtime so the
 * shader cache cap treats it as recently used. Best-effort; never throws.
 */
function touchReuse(outPath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(outPath, now, now);
  } catch {
    // vanished mid-reuse: the caller re-checks existence where it matters
  }
}

function lockPidLive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePrePassLock(lockPath: string, waitMs: number): number | null {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      // Another producer holds the key: steal the lock when its owner is dead.
      try {
        const owner = Number(fs.readFileSync(lockPath, "utf8").trim());
        if (!lockPidLive(owner)) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // lost the race; fall through to waiting
          }
          continue;
        }
      } catch {
        // unreadable lock: wait for its owner to finish or time out
      }
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

function waitForPrePassFile(outPath: string, waitMs: number): boolean {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(outPath).size > 0) return true;
    } catch {
      // not there yet
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
  try {
    return fs.statSync(outPath).size > 0;
  } catch {
    return false;
  }
}

function inputCount(args: string[]): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-i") n++;
    // `-i` consumed as a value of `-t`/`-ss`-style options never happens: those take numbers.
  }
  return n;
}

function runPrePassJob(job: PrePassJob, opts: PrePassRunOptions): void {
  const step = opts.step ?? "ffmpeg pre-pass";
  const waitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  if (fs.existsSync(job.outPath)) {
    touchReuse(job.outPath);
    return;
  }
  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
  const lockPath = `${job.outPath}.lock`;
  const fd = acquirePrePassLock(lockPath, waitMs);
  const releaseLock = () => {
    try {
      if (typeof fd === "number") fs.closeSync(fd);
    } catch {
      // already closed
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
  if (fd === null) {
    // Could not take the lock in time: the other producer may still finish.
    if (waitForPrePassFile(job.outPath, 60_000)) {
      touchReuse(job.outPath);
      return;
    }
    throw new CutholError(DIAGNOSTICS.FX_PREPASS_LOCKED(job.id, job.outPath));
  }
  try {
    // The winner re-checks: the previous holder may have finished while we waited.
    if (fs.existsSync(job.outPath)) return;
    if (inputCount(job.inputArgs) !== 1) {
      throw new CutholError(DIAGNOSTICS.FX_PREPASS_INPUT_MISMATCH(job.id));
    }
    if (job.kind === "shader") {
      throw new CutholError(
        DIAGNOSTICS.FX_PREPASS_FAILED(job.id, "shader jobs run through the batch path (ensurePlanPrePasses).")
      );
    }
    const tmpOut = `${job.outPath}.${process.pid}.tmp`;
    const args = [
      ...job.inputArgs,
      "-filter_complex",
      job.filterComplex,
      "-map",
      "[preout]",
      "-c:v",
      "ffv1",
      "-f",
      "nut",
      "-y",
      tmpOut,
    ];
    let proc;
    try {
      proc = spawnWatchedSync("ffmpeg", args, {
        cwd: opts.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        step,
        watchedPaths: [tmpOut],
        cleanupPathsOnStall: [tmpOut],
        windowsHide: true,
      });
    } catch (err) {
      try {
        fs.unlinkSync(tmpOut);
      } catch {
        // nothing to clean
      }
      throw new CutholError(
        DIAGNOSTICS.FX_PREPASS_FAILED(job.id, err instanceof Error ? err.message : String(err))
      );
    }
    if (proc.status !== 0 || proc.error || !fs.existsSync(tmpOut)) {
      try {
        fs.unlinkSync(tmpOut);
      } catch {
        // nothing to clean
      }
      const detail = proc.stalled
        ? "stalled (no output progress)"
        : (proc.stderr || proc.stdout || `exit ${proc.status}`).trim().slice(-240);
      throw new CutholError(DIAGNOSTICS.FX_PREPASS_FAILED(job.id, detail));
    }
    try {
      fs.renameSync(tmpOut, job.outPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpOut);
      } catch {
        // nothing to clean
      }
      throw new CutholError(
        DIAGNOSTICS.FX_PREPASS_FAILED(job.id, err instanceof Error ? err.message : String(err))
      );
    }
    if (!fs.existsSync(job.outPath)) {
      throw new CutholError(DIAGNOSTICS.FX_PREPASS_OUTPUT_MISSING(job.id, job.outPath));
    }
  } finally {
    releaseLock();
  }
}

/**
 * Runs one render's shader pre-pass jobs in a single worker child process
 * (which owns one browser for the whole batch). The spec travels in a file
 * next to the first output (removed afterwards); only each job's `tmpOut` is
 * ever written, so an interruption never leaves a partial intermediate. Exit
 * 3 with a `CUTHOL-G708` marker becomes the frame-timeout diagnostic of the
 * job whose entry timed out; anything else becomes G707.
 */
/**
 * Removes orphaned `<outPath>.<pid>.tmp.spec.json` batch specs of a previous
 * interrupted run for the same output: the producer lock beside the output is
 * cleaned on every exit, but the spec (written before the worker starts) can
 * survive a hard kill. Specs of live pids are kept.
 */
function cleanupOrphanShaderSpecFiles(outPath: string): void {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith(`${base}.`) || !f.endsWith(".tmp.spec.json")) continue;
    const pid = Number(f.slice(base.length + 1, -".tmp.spec.json".length));
    if (Number.isFinite(pid) && pid > 0 && lockPidLive(Math.floor(pid))) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // already gone
    }
  }
}

function runShaderPrePassJobs(jobs: PrePassJob[], opts: PrePassRunOptions): Array<() => void> {
  // Keepers per clip token (last job wins): only these get their last-use
  // timestamp bumped on reuse, so the single-frame prune still removes
  // superseded same-clip siblings by age.
  const keepByToken = new Map<string, string>();
  for (const job of jobs) {
    const m = /^sh_fxshad1_(.+)_[0-9a-f]{16}\.nut$/.exec(path.basename(job.outPath));
    keepByToken.set(
      m ? `${path.dirname(job.outPath)}:${m[1]}` : `full:${job.outPath}`,
      job.outPath
    );
  }
  const keepers = new Set(keepByToken.values());
  for (const job of jobs) cleanupOrphanShaderSpecFiles(job.outPath);
  const step = opts.step ?? "shader pre-pass";
  const waitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pending: Array<{ job: PrePassJob; tmpOut: string; fd: number; releaseLock: () => void }> = [];
  const releaseAll = (): void => {
    for (const p of pending.splice(0)) {
      try {
        p.releaseLock();
      } catch {
        // already released
      }
    }
  };
  try {
    for (const job of jobs) {
      if (!job.shader) {
        throw new CutholError(DIAGNOSTICS.SHADER_WORKER_FAILED(job.id, "missing shader payload."));
      }
      if (fs.existsSync(job.outPath)) {
        if (keepers.has(job.outPath)) touchReuse(job.outPath);
        continue;
      }
      fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
      const lockPath = `${job.outPath}.lock`;
      const fd = acquirePrePassLock(lockPath, waitMs);
      const releaseLock = (): void => {
        try {
          if (typeof fd === "number") fs.closeSync(fd);
        } catch {
          // already closed
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
      if (fd === null) {
        if (waitForPrePassFile(job.outPath, 60_000)) {
          if (keepers.has(job.outPath)) touchReuse(job.outPath);
          continue;
        }
        releaseAll();
        throw new CutholError(DIAGNOSTICS.FX_PREPASS_LOCKED(job.id, job.outPath));
      }
      if (fs.existsSync(job.outPath)) {
        if (keepers.has(job.outPath)) touchReuse(job.outPath);
        releaseLock();
        continue;
      }
      if (inputCount(job.inputArgs) !== 1) {
        releaseLock();
        releaseAll();
        throw new CutholError(DIAGNOSTICS.FX_PREPASS_INPUT_MISMATCH(job.id));
      }
      pending.push({ job, tmpOut: `${job.outPath}.${process.pid}.tmp`, fd, releaseLock });
    }
    if (pending.length === 0) return [];
    const workerJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "shader_worker.js");
    const specPath = `${pending[0].tmpOut}.spec.json`;
    const spec: ShaderWorkerBatchSpec = {
      jobs: pending.map((p) => ({ job: p.job, tmpOut: p.tmpOut })),
      cwd: opts.cwd,
    };
    fs.writeFileSync(specPath, JSON.stringify(spec));
    try {
      const tmpOuts = pending.map((p) => p.tmpOut);
      const proc = spawnWatchedSync(process.execPath, [workerJs, specPath], {
        cwd: opts.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        step,
        watchedPaths: tmpOuts,
        cleanupPathsOnStall: tmpOuts,
        windowsHide: true,
      });
      const stderr = String(proc.stderr ?? "");
      const failJobForEntry = (entryId: string): PrePassJob =>
        pending.map((p) => p.job).find((j) =>
          (j.shader?.steps ?? []).some((s) => s.kind === "shader" && s.entryId === entryId)
        ) ?? pending[0].job;
      if (proc.status === 0) {
        for (const p of pending) {
          if (!fs.existsSync(p.tmpOut)) {
            throw new CutholError(DIAGNOSTICS.FX_PREPASS_OUTPUT_MISSING(p.job.id, p.job.outPath));
          }
          try {
            fs.renameSync(p.tmpOut, p.job.outPath);
          } catch (err) {
            try {
              fs.unlinkSync(p.tmpOut);
            } catch {
              // nothing to clean
            }
            throw new CutholError(
              DIAGNOSTICS.FX_PREPASS_FAILED(p.job.id, err instanceof Error ? err.message : String(err))
            );
          }
        }
        // Every window where the fresh file is neither producer-locked nor
        // read-locked is a prune race: take the read lock while the producer
        // lock is still held (releaseAll runs after this returns), so a
        // concurrent prune always sees a live reader. Single-frame files
        // only; the frame caller holds its own locks through its extracts.
        const held: Array<() => void> = [];
        for (const p of pending) {
          if (/^sh_fxshad1_.+\.nut$/.test(path.basename(p.job.outPath))) {
            held.push(acquireSingleFrameReadLock(p.job.outPath));
          }
        }
        return held;
      }
      if (proc.status === 3 || stderr.includes("CUTHOL-G708")) {
        const m = /on frame (\d+) after (\d+)ms/.exec(stderr);
        const entry = /Shader pre-pass '([^']+)'/.exec(stderr)?.[1] ?? "";
        const failed = entry ? failJobForEntry(entry) : pending[0].job;
        for (const p of pending) {
          try {
            fs.unlinkSync(p.tmpOut);
          } catch {
            // nothing to clean
          }
        }
        throw new CutholError(
          DIAGNOSTICS.SHADER_FRAME_TIMEOUT(failed.id, m ? Number(m[1]) : 0, m ? Number(m[2]) : 0)
        );
      }
      if (proc.stalled) {
        for (const p of pending) {
          try {
            fs.unlinkSync(p.tmpOut);
          } catch {
            // nothing to clean
          }
        }
        throw new CutholError(DIAGNOSTICS.SHADER_WORKER_FAILED(pending[0].job.id, "stalled (no output progress)"));
      }
      const detail = (stderr || String(proc.stdout ?? "") || `exit ${proc.status}`).trim().slice(-240);
      for (const p of pending) {
        try {
          fs.unlinkSync(p.tmpOut);
        } catch {
          // nothing to clean
        }
      }
      throw new CutholError(DIAGNOSTICS.SHADER_WORKER_FAILED(pending[0].job.id, detail));
    } finally {
      try {
        fs.unlinkSync(specPath);
      } catch {
        // already gone
      }
    }
  } finally {
    releaseAll();
  }
}

/** Pid recorded in a lock file, or null when missing/unreadable. */
function pidFromLockFile(lockPath: string): number | null {
  try {
    const n = Number(fs.readFileSync(lockPath, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

/**
 * True when `outPath` has a live reader (a `*.read.<pid>.lock` beside it
 * whose pid is still alive). Read locks are held from the moment a plan's
 * pre-pass is done until its frame extract finishes, so a concurrent prune
 * in another process never deletes a file that is about to be read. Stale
 * (dead-pid) read locks are removed.
 */
function singleFrameFileHasLiveReader(outPath: string): boolean {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return true;
  }
  let live = false;
  for (const f of files) {
    if (!f.startsWith(`${base}.read.`) || !f.endsWith(".lock")) continue;
    const pid = Number(f.slice(base.length + ".read.".length, -".lock".length));
    if (Number.isFinite(pid) && pid > 0 && lockPidLive(Math.floor(pid))) {
      live = true;
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // already gone
    }
  }
  return live;
}

/**
 * Holds a read lock on a single-frame intermediate from now until `release`
 * runs, so concurrent prunes in other processes skip it. The lock file is
 * per-pid (`<outPath>.read.<pid>.lock`); a crashed holder leaves a dead-pid
 * lock that the next prune removes.
 */
export function acquireSingleFrameReadLock(outPath: string): () => void {
  const lockPath = `${outPath}.read.${process.pid}.lock`;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), "utf8");
  } catch {
    // locking is best-effort: the file stays prunable
    return () => undefined;
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
}

/**
 * Deletes older single-frame shader intermediates of one clip, keeping the
 * just-produced file. Only `sh_fxshad1_` files (single-frame compiles) are
 * ever touched: full-clip and windowed-segment files are never deleted here.
 * A sibling with a live producer lock or a live reader is skipped; a dead
 * producer lock is removed first (its owner can no longer finish the file).
 * An unlink failure (a running render may hold the file open, which fails
 * the delete on Windows) keeps the file instead of failing the render.
 */
export function pruneSingleFrameShaderIntermediates(jobs: PrePassJob[]): void {
  // One keeper per clip: the last job's output (plans compile — and rename
  // their intermediate into place — in order, so the last job is the newest).
  // Passing a whole batch therefore keeps one file per clip, not one per job.
  const keepByDirToken = new Map<string, Map<string, string>>();
  for (const job of jobs) {
    const m = /^sh_fxshad1_(.+)_[0-9a-f]{16}\.nut$/.exec(path.basename(job.outPath));
    if (!m) continue;
    const dir = path.dirname(job.outPath);
    let byToken = keepByDirToken.get(dir);
    if (!byToken) {
      byToken = new Map<string, string>();
      keepByDirToken.set(dir, byToken);
    }
    byToken.set(m[1], job.outPath);
  }
  for (const [dir, byToken] of keepByDirToken) {
    for (const [token, keepPath] of byToken) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith(`sh_fxshad1_${token}_`) && f.endsWith(".nut"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      if (full === keepPath) continue;
      try {
        const producerLock = `${full}.lock`;
        if (fs.existsSync(producerLock)) {
          const owner = pidFromLockFile(producerLock);
          if (owner !== null && lockPidLive(owner)) continue;
          if (owner === null) continue;
          try {
            fs.unlinkSync(producerLock);
          } catch {
            continue;
          }
        }
        if (singleFrameFileHasLiveReader(full)) continue;
        // Second guard behind the read locks: never prune a file younger
        // than SINGLE_FRAME_PRUNE_MIN_AGE_MS. A just-renamed file whose
        // owner has not taken its read lock yet (or reads without one, as
        // the full-render main graph does) survives every concurrent prune.
        try {
          const ageMs = Date.now() - fs.statSync(full).mtimeMs;
          if (ageMs < SINGLE_FRAME_PRUNE_MIN_AGE_MS) continue;
        } catch {
          continue;
        }
        fs.unlinkSync(full);
        try {
          for (const sib of fs.readdirSync(dir)) {
            if (sib.startsWith(`${f}.read.`) && sib.endsWith(".lock")) {
              try {
                fs.unlinkSync(path.join(dir, sib));
              } catch {
                // already gone
              }
            }
          }
        } catch {
          // sibling cleanup is best-effort
        }
      } catch {
        // in use by a running render: keep it
      }
    }
    }
  }
}

/**
 * Runs every pre-pass in the plan, in order. Shader jobs run together in one
 * worker (one browser); other jobs run one by one. Jobs with distinct keys
 * are independent files; jobs sharing a key (parallel segments of one clip)
 * collapse onto one producer via the lock. Throws G700/G701/G703/G704 on
 * failure, never renders a partial result.
 */
export function ensurePlanPrePasses(plan: CompiledRenderPlan, opts: PrePassRunOptions): void {
  const jobs = plan.prePasses ?? [];
  for (const job of jobs) {
    if (job.kind !== "shader") runPrePassJob(job, opts);
  }
  const shaderJobs = jobs.filter((j) => j.kind === "shader");
  let held: Array<() => void> = [];
  if (shaderJobs.length > 0) held = runShaderPrePassJobs(shaderJobs, opts);
  try {
    if (!opts.deferSingleFramePrune) pruneSingleFrameShaderIntermediates(shaderJobs);
  } finally {
    // Internal read locks covered rename-to-prune; the frame caller holds
    // its own locks (taken before the pre-pass) through its extracts.
    for (const release of held.splice(0)) {
      try {
        release();
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Runs the plan's pre-passes, or throws G702 when this render path cannot run
 * them. Call from every executor that runs a compiled plan, before the main
 * ffmpeg graph starts.
 */
export function requirePlanPrePasses(
  plan: CompiledRenderPlan,
  opts: PrePassRunOptions,
  where: string
): void {
  if (!planNeedsPrePasses(plan)) return;
  if (!opts.cwd) throw new CutholError(DIAGNOSTICS.FX_PREPASS_UNAVAILABLE(where));
  ensurePlanPrePasses(plan, opts);
}

// ---------------------------------------------------------------------------
// Shader intermediate disk cap (`render.shader_cache_cap_gb`).
// ---------------------------------------------------------------------------

/** Files this render did not use stay deletable only after this much disuse. */
export const SHADER_CACHE_UNUSED_GRACE_MS = 5 * 60 * 1000;

export interface ShaderCacheEnforcement {
  totalBeforeBytes: number;
  totalAfterBytes: number;
  deletedCount: number;
}

function isShaderIntermediateName(name: string): boolean {
  return (
    (name.startsWith("sh_fxshad_") || name.startsWith("sh_fxshad1_")) &&
    name.endsWith(".nut")
  );
}

/** All shader intermediate files in a blobs dir (single-frame ones included). */
export function listShaderIntermediateFiles(blobsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(blobsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!isShaderIntermediateName(e)) continue;
    const full = path.join(blobsDir, e);
    try {
      if (fs.statSync(full).isFile()) out.push(full);
    } catch {
      // vanished mid-scan: ignore
    }
  }
  return out;
}

/**
 * Holds a read lock (`*.read.<pid>.lock`) on every existing file, so a
 * concurrent cap enforcement in another process skips them. Callers hold the
 * releases until their encode ends and release them before enforcing the cap
 * on their own files. Best-effort; never throws.
 */
export function acquireShaderReadLocks(outPaths: string[]): Array<() => void> {
  const held: Array<() => void> = [];
  for (const outPath of new Set(outPaths)) {
    try {
      if (!fs.existsSync(outPath)) continue;
      held.push(acquireSingleFrameReadLock(outPath));
    } catch {
      // best-effort: the file stays prunable
    }
  }
  return held;
}

function releaseAll(releases: Array<() => void>): void {
  for (const release of releases.splice(0)) {
    try {
      release();
    } catch {
      // already gone
    }
  }
}

/** Release read locks held by `acquireShaderReadLocks`. Never throws. */
export function releaseShaderReadLocks(releases: Array<() => void>): void {
  releaseAll(releases);
}

/**
 * True when the file is held by a producer (its `.lock` names a live pid or
 * is empty/unreadable). A dead owner's lock is removed (the existing
 * stale-lock rule: only a live owner protects the file); an empty or
 * unreadable lock keeps the file, same as the pre-pass wait path.
 */
function shaderFileProducerLive(full: string): boolean {
  const lockPath = `${full}.lock`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }
  if (stat.size === 0) return true;
  const owner = pidFromLockFile(lockPath);
  if (owner === null) return true;
  if (lockPidLive(owner)) return true;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    return true;
  }
  return false;
}

/**
 * Sweeps leftovers of dead processes: `<name>.nut.<pid>.tmp`, its
 * `.tmp.spec.json` (pid in the name) and stale `.lock` files (dead-pid owner
 * removed; 0-byte/unreadable locks kept per the existing stale-lock rule).
 * Never throws.
 */
export function sweepDeadShaderProcessFiles(blobsDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(blobsDir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(blobsDir, e);
    const tmpM = /^(.+\.nut)\.(\d+)\.tmp$/.exec(e);
    if (tmpM) {
      if (lockPidLive(Number(tmpM[2]))) continue;
      try {
        fs.unlinkSync(full);
      } catch {
        // held open by a running process (Windows): keep it
      }
      continue;
    }
    if (e.endsWith(".tmp.spec.json")) {
      const m = /\.(\d+)\.tmp\.spec\.json$/.exec(e);
      const pid = m ? Number(m[1]) : NaN;
      if (Number.isFinite(pid) && lockPidLive(pid)) continue;
      try {
        fs.unlinkSync(full);
      } catch {
        // keep it
      }
      continue;
    }
    if (e.endsWith(".lock")) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;
      const owner = pidFromLockFile(full);
      if (owner !== null && !lockPidLive(owner)) {
        try {
          fs.unlinkSync(full);
        } catch {
          // keep it
        }
      }
    }
  }
}

function shaderFileSize(full: string): number {
  try {
    return fs.statSync(full).size;
  } catch {
    return 0;
  }
}

function shaderFileMtimeMs(full: string): number {
  try {
    return fs.statSync(full).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Enforces the per-project shader intermediate cap after a render's (or a
 * prewarm window's) pre-passes have been used. Deletes, until the total is
 * under the cap, first the files this render did not use (oldest last-use
 * first), then this render's own files (oldest first). Skips files held by a
 * live producer or read lock, files this render did not use whose last use is
 * younger than `SHADER_CACHE_UNUSED_GRACE_MS`, and files whose unlink fails.
 * The render never fails because of the cap: this function never throws.
 */
export function enforceShaderIntermediateCap(
  blobsDir: string,
  usedOutPaths: string[],
  capGb: number
): ShaderCacheEnforcement {
  sweepDeadShaderProcessFiles(blobsDir);
  const files = listShaderIntermediateFiles(blobsDir);
  const sizes = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    const s = shaderFileSize(f);
    sizes.set(f, s);
    total += s;
  }
  const before = total;
  const capBytes =
    Number.isFinite(capGb) && capGb > 0 ? capGb * 1024 ** 3 : Number.MAX_SAFE_INTEGER;
  if (total <= capBytes) return { totalBeforeBytes: before, totalAfterBytes: total, deletedCount: 0 };
  const used = new Set(usedOutPaths.map((p) => path.resolve(p)));
  const now = Date.now();
  const unused = files
    .filter((f) => !used.has(path.resolve(f)))
    .map((f) => ({ f, mtime: shaderFileMtimeMs(f) }))
    .sort((a, b) => a.mtime - b.mtime);
  const own = files
    .filter((f) => used.has(path.resolve(f)))
    .map((f) => ({ f, mtime: shaderFileMtimeMs(f) }))
    .sort((a, b) => a.mtime - b.mtime);
  let deleted = 0;
  const tryDelete = (full: string): void => {
    if (total <= capBytes) return;
    if (shaderFileProducerLive(full)) return;
    if (singleFrameFileHasLiveReader(full)) return;
    try {
      fs.unlinkSync(full);
    } catch {
      // a failed unlink (e.g. open by another process on Windows) is skipped
      return;
    }
    total -= sizes.get(full) ?? 0;
    deleted++;
  };
  for (const { f, mtime } of unused) {
    if (total <= capBytes) break;
    if (now - mtime < SHADER_CACHE_UNUSED_GRACE_MS) continue;
    tryDelete(f);
  }
  for (const { f } of own) {
    if (total <= capBytes) break;
    tryDelete(f);
  }
  return { totalBeforeBytes: before, totalAfterBytes: total, deletedCount: deleted };
}

/** Resolves the shader cache cap for a project (env > project > user > default). Never throws. */
export function resolveShaderCacheCapGb(projectDir: string): number {
  try {
    const v = Number(resolveSetting(projectDir, "render.shader_cache_cap_gb").value);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    // fall through to default
  }
  return 2;
}
