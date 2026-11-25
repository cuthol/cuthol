// `spine fx try`: see an effect in seconds. Renders one PNG grid through the
// product frame path (throw-away one-clip sandbox project): rows = sweep values
// (default 5 when `--sweep`), columns = times (default 3 spread over the card).
// The grid layout (row -> value, column -> time) is in the JSON; no text is drawn
// into the image. Works without a project for the generated card; `--on <sp_XX>`
// needs one and copies only that item's source into the sandbox (never written).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmRetrySync } from "../core/fs_retry.js";
import { loadSequence } from "../core/workspace.js";
import { substituteFxTemplateValues } from "../compositor/compile_fx_stage.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { listEffectDefinitions } from "./effect_registry.js";
import { costClassFor, measureCostMsPerFrame1080p, openFxSandbox, renderSandboxFramesAtTimes, trackTempDir } from "./fx_sandbox.js";

export interface FxTrySweep {
  param: string;
  from: number;
  to: number;
  n: number;
}

export interface FxTryRequest {
  kind?: string;
  filter?: string;
  params?: Record<string, unknown>;
  sweep?: FxTrySweep;
  at?: number[];
  on?: string;
  out?: string;
  /** Project dir when `--on <sp_XX>` reads an item's source (read-only). */
  workspaceDir?: string;
  /** Resolved extension dir staged into the sandbox for `ext:` kinds. */
  extDir?: { name: string; dir: string };
  /** Card file copied into the sandbox when `--on` reads a project item (resolved by the caller). */
  onSourceFile?: string;
  timeoutMs?: number;
}

export interface FxTryResult {
  png: string;
  rows: number[];
  cols: number[];
  sweepParam: string | null;
  costMsPerFrame1080p: number;
  cells: Array<{ row: number; col: number; value: number | null; t: number; png: string }>;
}

function ffmpeg(args: string[], cwd?: string): void {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 180_000, cwd, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`ffmpeg failed: ${String(r.stderr ?? r.error ?? "").split("\n").slice(0, 4).join(" | ").slice(0, 400)}`);
  }
}

/**
 * A filter graph passed from a file (`-/vf` / `-/filter_complex`), never on the
 * command line: long envelope expressions would otherwise exceed the Windows
 * command line limit (ENAMETOOLONG), as the render path does.
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

/** Resolve a spine clip's source file without writing to the project. */
function resolveOnSource(workspaceDir: string, itemId: string): string {
  const { sequence, paths } = loadSequence(workspaceDir);
  const clip = sequence.spine.clips.find((c) => c.id === itemId);
  if (!clip) throw new Error(`--on '${itemId}' matches no spine clip in this project.`);
  const asset = sequence.library.find((a) => a.handle === (clip as { asset_handle: string }).asset_handle);
  if (!asset) throw new Error(`--on '${itemId}': asset not found in this project.`);
  const root = (paths.rootDir as string) ?? workspaceDir;
  const candidates = [asset.uri, path.join(root, asset.uri)];
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isFile()) return c;
    } catch {
      // try next
    }
  }
  throw new Error(`--on '${itemId}': source file '${asset.uri}' is not readable.`);
}

function lerpSweep(s: FxTrySweep): number[] {
  if (s.n <= 1) return [s.from];
  return Array.from({ length: s.n }, (_, i) => s.from + ((s.to - s.from) * i) / (s.n - 1));
}

export function parseSweep(raw: string): FxTrySweep {
  const m = /^([a-zA-Z0-9_-]+)=(-?[0-9.]+)\.\.(-?[0-9.]+)(?::(\d+))?$/.exec(raw.trim());
  if (!m) throw new Error(`--sweep must look like 'param=a..b[:n]' (given: '${raw}').`);
  return { param: m[1], from: Number(m[2]), to: Number(m[3]), n: m[4] !== undefined ? Number(m[4]) : 5 };
}

export function runFxTry(req: FxTryRequest): FxTryResult {
  if (!req.kind && !req.filter) throw new Error("Provide --kind <kind> or --filter \"<chain>\".");
  const sweepValues: number[] | null = req.sweep ? lerpSweep(req.sweep) : null;
  const rows = sweepValues ?? [NaN];
  const cols = req.at && req.at.length > 0 ? [...req.at] : [0.5, 1.5, 2.5];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxtry-"));
  const untrackTmp = trackTempDir(tmp);
  const cells: FxTryResult["cells"] = [];
  // Per-frame cost is measured once, on the default (middle) row, with the
  // compiled chain substituted through the shared template rule.
  let costMs = 0;
  try {
    const rowDirs: string[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const params: Record<string, unknown> = { ...(req.params ?? {}) };
      const sweepVal = sweepValues ? sweepValues[ri] : null;
      if (req.sweep && sweepVal !== null) params[req.sweep.param] = sweepVal;
      const sb = openFxSandbox({
        kind: req.kind,
        filter: req.filter,
        params,
        ...(req.onSourceFile ? { mediaFile: req.onSourceFile } : {}),
        ...(req.extDir ? { extDirs: [req.extDir] } : {}),
        prefix: "cuthol-fxsb-",
        timeoutMs: req.timeoutMs ?? 120_000,
      });
      try {
        const rowDir = path.join(tmp, `row_${ri}`);
        // Frames at the requested times from a render covering the whole card
        // (plan rate 30 fps: frame `round(t * 30)`), not the first 0.6 s.
        const pngs = renderSandboxFramesAtTimes(sb, rowDir, cols);
        rowDirs.push(rowDir);
        for (let ci = 0; ci < cols.length; ci++) {
          const cellPng = path.join(tmp, `cell_${ri}_${ci}.png`);
          fs.copyFileSync(pngs[ci], cellPng);
          cells.push({ row: ri, col: ci, value: sweepVal, t: cols[ci], png: cellPng });
        }
        if (ri === Math.floor(rows.length / 2)) {
          costMs = measureRowCost(sb.wsDir, req);
        }
      } finally {
        sb.dispose();
      }
    }
    void rowDirs;
    // Tile: hstack each row, then vstack rows; scale cells to 320x180 first.
    const scaledCells: string[] = [];
    for (const cell of cells) {
      const scaled = path.join(tmp, `s_${cell.row}_${cell.col}.png`);
      const sg = graphFileArgs("-/vf", "scale=320:180");
      try {
        ffmpeg(["-y", "-v", "error", "-i", cell.png, ...sg.args, scaled]);
      } finally {
        sg.cleanup();
      }
      scaledCells.push(scaled);
    }
    const rowPngs: string[] = [];
    const nCols = cols.length;
    for (let ri = 0; ri < rows.length; ri++) {
      const rowInputs: string[] = [];
      for (let ci = 0; ci < nCols; ci++) rowInputs.push("-i", scaledCells[ri * nCols + ci]);
      const rowPng = path.join(tmp, `grid_row_${ri}.png`);
      const hg = graphFileArgs("-/filter_complex", `hstack=inputs=${nCols}`);
      try {
        ffmpeg([...rowInputs, ...hg.args, "-frames:v", "1", rowPng]);
      } finally {
        hg.cleanup();
      }
      rowPngs.push(rowPng);
    }
    const outPng = req.out ?? path.join(process.cwd(), `fxtry_${Date.now()}.png`);
    if (rowPngs.length === 1) {
      fs.copyFileSync(rowPngs[0], outPng);
    } else {
      const inputs: string[] = [];
      for (const r of rowPngs) inputs.push("-i", r);
      const vg = graphFileArgs("-/filter_complex", `vstack=inputs=${rowPngs.length}`);
      try {
        ffmpeg([...inputs, ...vg.args, "-frames:v", "1", outPng]);
      } finally {
        vg.cleanup();
      }
    }
    void resolveOnSource;
    return {
      png: outPng,
      rows: sweepValues ?? [],
      cols,
      sweepParam: req.sweep ? req.sweep.param : null,
      costMsPerFrame1080p: costMs,
      cells,
    };
  } finally {
    untrackTmp();
    try {
      rmRetrySync(tmp);
    } catch {
      // best effort
    }
  }
}

/**
 * Per-frame cost of the middle row at 1080p: substitutes the row's params through
 * the shared template rule and times the chain on a 1080p card. Falls back to 0
 * when the chain cannot be timed (the error surfaces from the render already).
 */
function measureRowCost(sandboxWsDir: string, req: FxTryRequest): number {
  try {
    if (req.filter) return measureCostMsPerFrame1080p(req.filter);
    if (!req.kind) return 0;
    const { sequence } = loadSequence(sandboxWsDir);
    const defs = listEffectDefinitions(sequence, { rootDir: sandboxWsDir });
    const def = defs.find((d) => d.kind === req.kind);
    const template = def?.ffmpeg?.video_filter;
    if (!template) return 0;
    const fail = (detail: string): never => {
      throw new CutholError(DIAGNOSTICS.FX_TRY_FAILED(req.kind ?? "?", detail));
    };
    const values: Record<string, number | string | boolean> = {};
    for (const [k, p] of Object.entries(def.params ?? {})) {
      const v = (req.params as Record<string, unknown> | undefined)?.[k] ?? (p as { default?: unknown }).default;
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") values[k] = v;
    }
    const chain = substituteFxTemplateValues(template, values, new Map(), fail);
    return measureCostMsPerFrame1080p(chain);
  } catch {
    return 0;
  }
}

export { costClassFor, measureCostMsPerFrame1080p };
