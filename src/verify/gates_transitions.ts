// Encoder-free backstop for extension spine transitions (`ext:<extension>/<name>`).
//
// Manifest load rules (G112 unknown/disallowed placeholders, G330 unquoted `{{p}}` in a
// filter field) catch malformed templates, but a well-formed template can still fail at
// render time: a time-varying `incoming_scale` once changed the frame size mid-stream and
// crashed ffmpeg, and a filter option split by commas fails with `No such filter`. So for
// every `ext:` transition used in the sequence, this gate compiles the real render plan
// over a short window around the transition and runs it encoder-free (`-f null`) with a
// frame bound. A non-zero exit — including a crash — is CUTHOL-G331 naming the clip, the
// kind and the field when the failing part can be told from stderr. A timeout (~15 s) or
// a missing ffmpeg is CUTHOL-G332 (WARN, never blocks). Results cache outside the
// sequence and the journal (process tmpdir file keyed by transition definition hash +
// duration + ffmpeg version), so repeated verifies and the write-time check stay cheap.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence } from "../core/schema.js";
import type { WorkspacePaths } from "../core/workspace.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { requirePlanPrePasses } from "../render/pre_pass.js";
import { getSequenceEffectRegistry, isExtensionEffectRef } from "../extensions/ext_effects.js";
import type { ExtensionTransitionSpec } from "../extensions/ext_transitions.js";

const BACKSTOP_TIMEOUT_MS = 15000;
const BACKSTOP_PRESET = "draft_480p" as const;
// Bumped whenever the transition compilation or this check changes, so old cached
// results (keyed by definition hash + duration + ffmpeg version) never mask a fix.
const BACKSTOP_SCHEMA = "crop1";

export type TransitionBackstopStatus = "ok" | "error" | "skipped";

export interface TransitionBackstopOutcome {
  status: TransitionBackstopStatus;
  diagnostic?: CutholDiagnostic;
}

function backstopCachePath(): string {
  return path.join(os.tmpdir(), "cuthol-transition-backstop.json");
}

function readBackstopCache(): Record<string, { pass: boolean; field?: string; err?: string }> {
  try {
    const raw = fs.readFileSync(backstopCachePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, { pass: boolean; field?: string; err?: string }>;
    }
  } catch {
    // No cache yet, or unreadable: recompute and overwrite below.
  }
  return {};
}

function writeBackstopCache(cache: Record<string, { pass: boolean; field?: string; err?: string }>): void {
  try {
    fs.writeFileSync(backstopCachePath(), JSON.stringify(cache), "utf8");
  } catch {
    // Cache loss only costs a re-run next time.
  }
}

let cachedFfmpegVersion: string | null | undefined;

function ffmpegVersionLine(): string | null {
  if (cachedFfmpegVersion !== undefined) return cachedFfmpegVersion;
  try {
    const p = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    const first = String(p.stdout ?? "").split("\n")[0]?.trim() ?? "";
    cachedFfmpegVersion = p.status === 0 && first ? first : null;
  } catch {
    cachedFfmpegVersion = null;
  }
  return cachedFfmpegVersion;
}

function backstopKey(
  extName: string,
  version: string,
  contentHash: string,
  trName: string,
  spec: ExtensionTransitionSpec,
  params: Record<string, unknown> | undefined,
  durationMs: number,
  easing: string,
  ffmpegVersion: string
): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        BACKSTOP_SCHEMA,
        extName,
        version,
        contentHash,
        trName,
        spec,
        params ?? {},
        durationMs,
        easing,
        ffmpegVersion,
      ])
    )
    .digest("hex");
}

/**
 * Short plan window (sequence ms) covering one transition: the outgoing side runs over
 * the clip tail (held under the next clip, or the clip's own tail when not held) and the
 * incoming side over the next clip's head. Padded so the eased progress rests at both ends.
 */
function transitionWindowMs(
  seq: CutholSequence,
  index: number
): { win: [number, number]; kind: string; clipId: string } | null {
  const clip = seq.spine.clips[index];
  const tr = clip?.transition_out;
  if (!clip || !tr || tr.duration_ms <= 0 || !tr.kind.startsWith("ext:")) return null;
  const next = seq.spine.clips[index + 1] ?? null;
  const dur = tr.duration_ms;
  const clipEnd = clip.timeline_in_ms + clip.duration_ms;
  const nextStart = next ? next.timeline_in_ms : clipEnd;
  // Cover both the held tail [clipEnd, clipEnd+dur] and the fade-like tail
  // [clipEnd-dur, clipEnd] (`hold_outgoing: false`), plus the incoming head.
  const lo = Math.max(0, Math.min(clipEnd - dur, nextStart) - 250);
  const hi = Math.max(clipEnd + dur, nextStart + dur) + 250;
  if (!(hi > lo)) return null;
  return { win: [Math.round(lo), Math.round(hi)], kind: tr.kind, clipId: clip.id };
}

/** Best-effort field attribution: an identifier token (>= 6 chars) of a template field found in stderr. */
function attributeField(stderr: string, spec: ExtensionTransitionSpec): string | undefined {
  const fields: Array<[string, string | undefined]> = [
    ["outgoing_filter", spec.outgoing_filter],
    ["incoming_filter", spec.incoming_filter],
    ["incoming_scale", spec.incoming_scale],
    ["incoming_x", spec.incoming_x],
    ["incoming_y", spec.incoming_y],
    ["outgoing_x", spec.outgoing_x],
    ["outgoing_y", spec.outgoing_y],
  ];
  for (const [field, template] of fields) {
    if (!template) continue;
    const tokens = new Set(template.split(/[^a-zA-Z0-9_]+/g).filter((c) => c.length >= 6));
    for (const token of tokens) {
      if (stderr.includes(token)) return field;
    }
  }
  return undefined;
}

/**
 * Runs the backstop for one clip's `ext:` transition. Compiles the real windowed plan and
 * runs it encoder-free with a frame bound; never throws (callers decide). Returns the
 * diagnostic for `error`/`skipped` outcomes so verify and the write path share it.
 */
export function checkExtTransitionBackstop(
  seq: CutholSequence,
  paths: WorkspacePaths,
  clipIndex: number
): TransitionBackstopOutcome {
  const found = transitionWindowMs(seq, clipIndex);
  if (!found) return { status: "ok" };
  const { win, kind, clipId } = found;
  const clip = seq.spine.clips[clipIndex];
  const tr = clip.transition_out!;
  if (!isExtensionEffectRef(kind)) {
    // Malformed references already fail with G122 elsewhere; the backstop adds nothing.
    return { status: "ok" };
  }
  const registry = getSequenceEffectRegistry(seq, paths.rootDir);
  const def = registry.transitions.get(kind as `ext:${string}/${string}`);
  if (!def) {
    // Unknown/disabled kinds already fail with G122 elsewhere; the backstop has nothing to run.
    return { status: "ok" };
  }
  const ffmpegVersion = ffmpegVersionLine();
  if (!ffmpegVersion) {
    return { status: "skipped", diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_SKIPPED("ffmpeg is not on PATH") };
  }
  const key = backstopKey(
    def.extension,
    def.version,
    def.content_hash,
    kind.slice(`ext:${def.extension}/`.length),
    def.spec,
    tr.params as Record<string, unknown> | undefined,
    tr.duration_ms,
    tr.easing,
    ffmpegVersion
  );
  const cache = readBackstopCache();
  const hit = cache[key];
  if (hit) {
    if (hit.pass) return { status: "ok" };
    return {
      status: "error",
      diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_FAILED(kind, clipId, hit.err ?? "cached failure", hit.field),
    };
  }
  let plan;
  try {
    plan = compileSequenceRenderPlan(seq, paths, BACKSTOP_PRESET, { workers: 1, activeWindowMs: win });
    requirePlanPrePasses(plan, { cwd: paths.rootDir, step: "ffmpeg pre-pass" }, "transition backstop");
  } catch (err) {
    if (err instanceof CutholError && err.diagnostic.code === "CUTHOL-G122") {
      // Unknown/disabled kinds already fail with G122 elsewhere; the backstop adds nothing.
      return { status: "ok" };
    }
    const detail = err instanceof CutholError ? err.diagnostic.formatted : String(err).slice(0, 300);
    cache[key] = { pass: false, err: `windowed compile failed: ${detail}` };
    writeBackstopCache(cache);
    return {
      status: "error",
      diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_FAILED(kind, clipId, `windowed compile failed: ${detail}`),
    };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-trback-"));
  try {
    const graph = path.join(tmp, "graph.txt");
    fs.writeFileSync(graph, plan.filterComplex, "utf8");
    const frames = Math.max(4, Math.ceil(((win[1] - win[0]) / 1000) * plan.fps) + 2);
    const args = [
      "-v", "error",
      ...plan.inputArgs,
      "-filter_complex_script", graph,
      "-map", plan.videoOutPad,
      "-frames:v", String(frames),
      "-f", "null", "-",
    ];
    if (plan.audioOutPad) {
      args.push("-map", plan.audioOutPad, "-f", "null", "-");
    }
    let p: ReturnType<typeof spawnSync>;
    try {
      p = spawnSync("ffmpeg", args, {
        cwd: paths.rootDir,
        timeout: BACKSTOP_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      const msg = String((err as NodeJS.ErrnoException)?.code ?? err);
      if (msg.includes("ENOENT")) {
        return { status: "skipped", diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_SKIPPED("ffmpeg is not on PATH") };
      }
      throw err;
    }
    const stderr = String(p.stderr ?? "").slice(0, 500);
    if (p.error && (p.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return {
        status: "skipped",
        diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_SKIPPED(`timed out after ${BACKSTOP_TIMEOUT_MS / 1000} s`),
      };
    }
    if ((p.status ?? -1) !== 0 || p.signal) {
      const detail = p.signal
        ? `ffmpeg ended with signal ${p.signal}${stderr ? `: ${stderr}` : ""}`
        : `ffmpeg exited with code ${p.status}${stderr ? `: ${stderr}` : ""}`;
      const field = attributeField(String(p.stderr ?? ""), def.spec);
      cache[key] = { pass: false, field, err: detail.slice(0, 500) };
      writeBackstopCache(cache);
      return { status: "error", diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_FAILED(kind, clipId, detail.slice(0, 500), field) };
    }
    cache[key] = { pass: true };
    writeBackstopCache(cache);
    return { status: "ok" };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * Verify entry: one encoder-free windowed run per `ext:` transition in the sequence.
 * Sequences without `ext:` transitions return with zero diagnostics and without probing
 * ffmpeg, so builtin-only projects verify byte-identically to before.
 */
export function verifyTransitionBackstop(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  if (!paths) return;
  const indices: number[] = [];
  for (let i = 0; i < seq.spine.clips.length; i++) {
    const tr = seq.spine.clips[i].transition_out;
    if (tr && tr.duration_ms > 0 && tr.kind.startsWith("ext:")) indices.push(i);
  }
  if (indices.length === 0) return;
  let skipped: CutholDiagnostic | null = null;
  for (const i of indices) {
    let outcome: TransitionBackstopOutcome;
    try {
      outcome = checkExtTransitionBackstop(seq, paths, i);
    } catch (err) {
      outcome = {
        status: "error",
        diagnostic: DIAGNOSTICS.EXTENSION_TRANSITION_BACKSTOP_FAILED(
          seq.spine.clips[i].transition_out!.kind,
          seq.spine.clips[i].id,
          err instanceof CutholError ? err.diagnostic.formatted : String(err).slice(0, 300)
        ),
      };
    }
    if (outcome.status === "error" && outcome.diagnostic) diagnostics.push(outcome.diagnostic);
    else if (outcome.status === "skipped" && outcome.diagnostic && !skipped) skipped = outcome.diagnostic;
  }
  if (skipped && !diagnostics.some((d) => d.code === "CUTHOL-G331")) diagnostics.push(skipped);
}
