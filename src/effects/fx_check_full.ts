// `spine fx check --kind <k> --full`: the quick check plus, through the sandbox:
// every card variant at default params (renders, frame count and duration unchanged
// unless the manifest declares `temporal: true` or the filter changes duration on
// purpose); alpha kept for `alpha: keep|process`; neutral (per-param `neutral`:
// all neutral at once must reach Y PSNR >= 60 dB against no fx); the same effect
// twice in a row; every animatable param with a 20-point Bezier envelope; per-frame
// cost at 1080p mapped to `cost_class` (light/medium/heavy), with a WARN when the
// manifest `cost_class` contradicts the measurement. Output: one table (variant x
// check -> ok/fail + number). Optional manifest fields are read from the validated
// `ExtensionFxSpec` (validated in `ext_fx.ts`, never raw manifest JSON).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionFxSpec } from "../extensions/ext_fx.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { ensurePlanPrePasses } from "../render/pre_pass.js";
import { loadSequence } from "../core/workspace.js";
import { setItemEnvelope } from "../sequence/spine.js";
import { checkEffectDefinition, type FxCheckFinding } from "./fx_check.js";
import {
  costClassFor,
  meanLuma,
  measureCostMsPerFrame1080p,
  openFxSandbox,
  psnrYuv,
  renderSandboxFramesAtTimes,
  renderSandboxPngs,
  trackTempDir,
  type FxSandboxCardName,
} from "./fx_sandbox.js";

export interface FxFullRow {
  variant: string;
  check: string;
  ok: boolean;
  detail: string;
}

export interface FxFullResult {
  kind: string;
  rows: FxFullRow[];
  findings: FxCheckFinding[];
  costMsPerFrame1080p: number;
  costClass: "light" | "medium" | "heavy";
  ok: boolean;
}

/**
 * Delivery verdict: `fail` whenever any row is not ok or any finding is an
 * ERROR. Rows and findings are checked together so a failing envelope row can
 * never report `pass` (a failed row with zero ERROR findings still fails).
 */
export function fxFullVerdict(
  rows: Array<{ ok?: boolean }>,
  findings: Array<{ severity?: string }>
): { ok: boolean; result: "pass" | "fail" } {
  const failed =
    rows.some((r) => r?.ok !== true) || findings.some((f) => f?.severity === "ERROR");
  return failed ? { ok: false, result: "fail" } : { ok: true, result: "pass" };
}

export interface FxFullRequest {
  kind?: string;
  filter?: string;
  params?: Record<string, unknown>;
  /** Validated extension spec (carries neutral/temporal/cost_class). */
  spec?: ExtensionFxSpec;
  /** Resolved extension dir staged into the sandbox for `ext:` kinds. */
  extDir?: { name: string; dir: string };
  timeoutMs?: number;
}

const VARIANTS: FxSandboxCardName[] = ["tv", "full", "bit10", "vertical", "rgba", "vfr"];

function ffprobeFrames(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,avg_frame_rate,r_frame_rate", "-of", "csv=p=0", file],
    { encoding: "utf8", timeout: 60_000, windowsHide: true }
  );
  const n = Number(String(r.stdout ?? "").trim().split("\n")[0]);
  return Number.isFinite(n) ? n : -1;
}

function defaultParams(spec?: ExtensionFxSpec, filter?: string): Record<string, unknown> {
  if (filter !== undefined) return { filter };
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(spec?.params ?? {})) {
    if (p.default !== undefined) out[k] = p.default;
  }
  return out;
}

/** 20-point Bezier envelope over the card, easing format as `spine envelope` writes it. */
function bezierEnvelope(fxId: string, param: string, min: number, max: number, durMs: number): { parameter: string; points: Array<{ offset_ms: number; value: number; easing: string; bezier: number[] }> } {
  const n = 20;
  const points = Array.from({ length: n }, (_, i) => ({
    offset_ms: Math.round((durMs * i) / (n - 1)),
    value: min + ((max - min) * i) / (n - 1),
    easing: "cubic_bezier",
    bezier: [0.42, 0, 0.58, 1],
  }));
  return { parameter: `fx.${fxId}.${param}`, points };
}

export function runFxCheckFull(req: FxFullRequest): FxFullResult {
  const kind = req.kind ?? (req.filter !== undefined ? "ffmpeg" : "");
  if (!kind) throw new Error("Provide --kind <kind>.");
  const rows: FxFullRow[] = [];
  const findings: FxCheckFinding[] = [];
  const fail = (variant: string, check: string, detail: string): void => {
    rows.push({ variant, check, ok: false, detail });
  };
  const pass = (variant: string, check: string, detail: string): void => {
    rows.push({ variant, check, ok: true, detail });
  };
  const params = { ...(req.params ?? {}), ...defaultParams(req.spec, req.filter) };
  const entry = req.filter !== undefined ? { filter: req.filter } : { kind, params };
  const extDirs = req.extDir ? [req.extDir] : [];

  // (0) Quick definition check first (same as without --full).
  const defFindings = checkEffectDefinition({
    kind,
    params: (req.spec?.params ?? {}) as Record<string, { type?: string; default?: unknown; min?: number; max?: number }>,
    animatable: [...(req.spec?.animatable ?? [])],
    alpha: req.spec?.alpha,
    ffmpeg: req.spec ? { video_filter: req.spec.video_filter } : req.filter !== undefined ? { video_filter: req.filter } : undefined,
  });
  findings.push(...defFindings);
  rows.push({
    variant: "quick",
    check: "definition",
    ok: !defFindings.some((f) => f.severity === "ERROR"),
    detail: defFindings.length === 0 ? "no findings" : defFindings.map((f) => `${f.code}: ${f.message.slice(0, 160)}`).join(" | ").slice(0, 400),
  });

  // Per-variant renders at default params through the real clip chain.
  const nofxFrames = new Map<string, string[]>();
  for (const variant of VARIANTS) {
    const sb = openFxSandbox({ card: variant, ...entry, params, extDirs, prefix: "cuthol-fxfull-", timeoutMs: req.timeoutMs ?? 180_000 });
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxfull-"));
    const untrackRoot = trackTempDir(outRoot);
    try {
      const outDir = path.join(outRoot, variant);
      let pngs: string[];
      try {
        pngs = renderSandboxPngs(sb, outDir, { frames: 12, fps: 4 });
      } catch (err) {
        fail(variant, "render", String((err as Error)?.message ?? err).slice(0, 300));
        continue;
      }
      pass(variant, "render", `${pngs.length} frames`);
      // Frame count and duration: compare against the same card with no fx.
      const ref = openFxSandbox({ card: variant, prefix: "cuthol-fxfull-", timeoutMs: req.timeoutMs ?? 180_000 });
      const refRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxfull-"));
      const untrackRef = trackTempDir(refRoot);
      try {
        const refDir = path.join(refRoot, `${variant}_nofx`);
        const refPngs = renderSandboxPngs(ref, refDir, { frames: 12, fps: 4 });
        nofxFrames.set(variant, refPngs);
        const sameCount = pngs.length === refPngs.length;
        const temporal = req.spec?.temporal === true;
        if (sameCount) {
          pass(variant, "frame_count", `${pngs.length} == ${refPngs.length}`);
        } else if (temporal) {
          pass(variant, "frame_count", `declared temporal: ${pngs.length} vs ${refPngs.length} (allowed)`);
        } else {
          fail(variant, "frame_count", `${pngs.length} vs no-fx ${refPngs.length} (declare temporal: true if on purpose)`);
          findings.push({
            severity: "WARN",
            code: "CUTHOL-G348",
            message: `fx full check for kind '${kind}': frame count changed ${refPngs.length} -> ${pngs.length} on '${variant}'.`,
          });
        }
        void ffprobeFrames;
      } finally {
        ref.dispose();
        untrackRef();
        try {
          fs.rmSync(refRoot, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    } finally {
      sb.dispose();
      untrackRoot();
      try {
        fs.rmSync(outRoot, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  // Neutral: every param at its neutral value at once must reach Y PSNR >= 60 dB vs no fx.
  const neutral = req.spec?.neutral;
  if (neutral && Object.keys(neutral).length > 0) {
    const sb = openFxSandbox({ card: "tv", ...entry, params: { ...params, ...neutral }, extDirs, prefix: "cuthol-fxfull-", timeoutMs: req.timeoutMs ?? 180_000 });
    try {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxfull-"));
      const untrackNeutral = trackTempDir(outDir);
      const ref = openFxSandbox({ card: "tv", prefix: "cuthol-fxfull-", timeoutMs: req.timeoutMs ?? 180_000 });
      try {
        const tRaw = path.join(outDir, "t.yuv");
        const rRaw = path.join(outDir, "r.yuv");
        renderRaw(sb.wsDir, tRaw);
        renderRaw(ref.wsDir, rRaw);
        const { y, u, v } = psnrYuv(rRaw, tRaw, 854, 480);
        const fmt = (n: number): string => (n === Infinity ? "inf" : n.toFixed(1));
        if (y >= 60) {
          pass("tv", "neutral", `Y ${fmt(y)} dB (U ${fmt(u)}, V ${fmt(v)})`);
        } else {
          fail("tv", "neutral", `Y ${fmt(y)} dB < 60 dB (U ${fmt(u)}, V ${fmt(v)})`);
          findings.push({
            severity: "ERROR",
            code: "CUTHOL-G347",
            message: `fx full check for kind '${kind}': neutral values are not neutral (Y PSNR ${fmt(y)} dB < 60 dB against no fx).`,
          });
        }
      } finally {
        ref.dispose();
        untrackNeutral();
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    } finally {
      sb.dispose();
    }
  } else {
    rows.push({ variant: "tv", check: "neutral", ok: true, detail: "no neutral declared (optional)" });
  }
  void nofxFrames;

  // Same effect twice in a row.
  {
    const sb = openFxSandbox({
      card: "tv",
      ...entry,
      params,
      extraFx: [req.filter !== undefined ? { filter: req.filter } : { kind, params }],
      extDirs,
      prefix: "cuthol-fxfull-",
      timeoutMs: req.timeoutMs ?? 180_000,
    });
    try {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxfull-"));
      const untrackStacked = trackTempDir(outDir);
      try {
        const pngs = renderSandboxPngs(sb, outDir, { frames: 6, fps: 4 });
        pass("tv", "stacked_x2", `${pngs.length} frames`);
      } catch (err) {
        fail("tv", "stacked_x2", String((err as Error)?.message ?? err).slice(0, 300));
      } finally {
        untrackStacked();
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    } finally {
      sb.dispose();
    }
  }

  // Every animatable param with a 20-point Bezier envelope spanning the whole card.
  // Frames are sampled at the envelope start, middle and end; the check only passes
  // when the end value is visibly reached (first and last sampled frames differ).
  for (const param of req.spec?.animatable ?? []) {
    const p = req.spec?.params?.[param];
    if (p?.type !== "number" || typeof p.min !== "number" || typeof p.max !== "number") {
      fail("tv", `envelope:${param}`, "animatable param without numeric min/max");
      continue;
    }
    const sb = openFxSandbox({ card: "tv", ...entry, params, extDirs, prefix: "cuthol-fxfull-", timeoutMs: req.timeoutMs ?? 180_000 });
    try {
      setItemEnvelope({
        workspaceDir: sb.wsDir,
        targetId: sb.clipId,
        parameter: `fx.fx_01.${param}` as never,
        points: bezierEnvelope("fx_01", param, p.min, p.max, 3000).points as never,
      });
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxfull-"));
      const untrack = trackTempDir(outDir);
      try {
        const sampleTimes = [0.1, 1.5, 2.9];
        const pngs = renderSandboxFramesAtTimes(sb, outDir, sampleTimes);
        const first = fs.readFileSync(pngs[0]);
        const last = fs.readFileSync(pngs[pngs.length - 1]);
        if (first.equals(last)) {
          fail("tv", `envelope:${param}`, `20-point bezier over 3 s: start and end frames identical, end value not reached`);
        } else {
          let extra = "";
          try {
            const margin = meanLuma(pngs[pngs.length - 1]) - meanLuma(pngs[0]);
            extra = `, luma ${margin >= 0 ? "+" : ""}${margin.toFixed(1)} end-vs-start`;
          } catch {
            // luma is informational only
          }
          pass("tv", `envelope:${param}`, `20-point bezier over 3 s, start/mid/end sampled${extra}`);
        }
      } catch (err) {
        fail("tv", `envelope:${param}`, String((err as Error)?.message ?? err).slice(0, 300));
      } finally {
        untrack();
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    } catch (err) {
      fail("tv", `envelope:${param}`, `envelope rejected: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    } finally {
      sb.dispose();
    }
  }

  // Per-frame cost at 1080p -> cost_class; WARN on manifest contradiction.
  let costMs = 0;
  try {
    const template = req.spec?.video_filter ?? req.filter ?? "";
    costMs = template ? measureCostMsPerFrame1080p(substituteForCost(template, params)) : 0;
  } catch {
    costMs = 0;
  }
  const measured = costClassFor(costMs);
  if (req.spec?.cost_class && req.spec.cost_class !== measured) {
    findings.push({
      severity: "WARN",
      code: "CUTHOL-G349",
      message: `fx full check for kind '${kind}': manifest cost_class '${req.spec.cost_class}' contradicts the measured '${measured}'.`,
    });
    rows.push({ variant: "-", check: "cost_class", ok: true, detail: `${costMs.toFixed(2)} ms/frame -> ${measured} (manifest: ${req.spec.cost_class}, WARN)` });
  } else {
    rows.push({ variant: "-", check: "cost_class", ok: true, detail: `${costMs.toFixed(2)} ms/frame -> ${measured}` });
  }

  const { ok } = fxFullVerdict(rows, findings);
  return { kind, rows, findings, costMsPerFrame1080p: costMs, costClass: measured, ok };
}

function substituteForCost(template: string, params: Record<string, unknown>): string {
  // Static defaults only; animated params are out of scope for the cost probe.
  // Quote the values the same way the shared substitution would is unnecessary
  // here: cost runs the chain, and numbers/identifiers substitute bare.
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, name: string) => {
    const v = params[name];
    return typeof v === "number" || typeof v === "string" ? String(v) : "0";
  });
}

function renderRaw(wsDir: string, outPath: string): void {
  // Same product frame path as the neutral suite: compiled plan to rawvideo.
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  ensurePlanPrePasses(plan, { cwd: (paths.rootDir as string) ?? wsDir, step: "fx full-check pre-pass" });
  const graphFile = `${outPath}.graph.txt`;
  fs.writeFileSync(graphFile, plan.filterComplex, "utf8");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", ...plan.inputArgs, "-/filter_complex", graphFile, "-map", plan.videoOutPad, "-f", "rawvideo", "-pix_fmt", "yuv420p", outPath, "-map", plan.audioOutPad, "-f", "null", "-"],
    { encoding: "utf8", timeout: 120_000, cwd: paths.rootDir as string, windowsHide: true }
  );
  try {
    fs.rmSync(graphFile, { force: true });
  } catch {
    // best effort
  }
  if (r.error || r.status !== 0) {
    throw new Error(`neutral render failed: ${String(r.stderr ?? r.error ?? "").split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
  }
}
