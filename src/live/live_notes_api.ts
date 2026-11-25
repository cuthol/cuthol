/**
 * Cuthol Live notes API (region E).
 *
 * Two endpoints, mounted by the live server file:
 *   GET  /api/coords?at_ms=&x=&y=[&w=&h=]  elements under a pin, topmost first
 *   POST /api/notes                         queue a note packet + contact sheet
 *
 * The coordinate lookup calls the composition geometry query directly as a
 * function (never a subprocess). A cache miss triggers measurement through the
 * existing path, but the response is cut after 5 s with `pending: true`; the
 * window shows "measuring" and asks again once the cache is warm.
 *
 * The contact sheet renders off the server event loop in a worker thread (this
 * same module re-executed with workerData, like the thumbnail worker): the
 * exact composite frame via the `monitor frame` path, one 480x270 cell per
 * note, element boxes as thin lines, numbered pin badges.
 */
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence } from "../core/schema.js";
import { selectPinCandidateCues } from "./live_coords_worker.js";

export { selectPinCandidateCues };
import { spawnWatchedSync } from "../core/subprocess.js";
import { loadSequence } from "../core/workspace.js";
import type { GeometryElementRow, GeometryQueryResult } from "../compositor/coords_query.js";
import { captureMonitorFrame } from "../monitor/preview.js";
import { writeLiveNotePacket } from "./live_inbox.js";
import { resolveLivePaths } from "./live_paths.js";
import { LIVE_SCHEMA, type LiveNote, type LiveNoteElement, type LiveNotePacket } from "./live_types.js";

/** The window waits this long for a coordinate answer before retrying. */
export const COORDS_TIMEOUT_MS = 5000;

export const SHEET_CELL_W = 480;
export const SHEET_CELL_H = 270;
export const SHEET_MAX_COLS = 3;

export interface CoordsAnswer {
  pending: boolean;
  elements: LiveNoteElement[];
  overlap_px2?: number;
}

function logLiveWarn(projectDir: string, line: string): void {
  try {
    const lp = resolveLivePaths(projectDir);
    fs.mkdirSync(lp.dir, { recursive: true });
    fs.appendFileSync(lp.logFile, `${line}\n`);
  } catch {
    // logging never breaks the endpoint
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers (unit-tested).
// ---------------------------------------------------------------------------

/** Races a promise against a timeout; the loser keeps running (cache warmer). */
export async function withQueryTimeout<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), Math.max(0, timeoutMs));
  });
  try {
    const value = await Promise.race([work.then((v): { ok: true; value: T } => ({ ok: true, value: v })), timeout]);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Paint position of every cue; mirrors the compositor (lanes by z_index, then cues by z_index). */
export function cuePaintOrder(sequence: CutholSequence): Map<string, { lane: number; cue: number }> {
  const order = new Map<string, { lane: number; cue: number }>();
  const laneRank = new Map<number, number>();
  sequence.lanes
    .map((lane, index) => ({ lane, index }))
    .sort((a, b) => a.lane.z_index - b.lane.z_index)
    .forEach((entry, rank) => laneRank.set(entry.index, rank));
  sequence.lanes.forEach((lane, laneIndex) => {
    const indexed = lane.cues.map((cue, index) => ({ cue, index }));
    const ordered = lane.cues.some((c) => c.z_index !== undefined)
      ? [...indexed].sort((a, b) => (a.cue.z_index ?? 0) - (b.cue.z_index ?? 0))
      : indexed;
    const cueRank = new Map<number, number>();
    ordered.forEach((entry, rank) => cueRank.set(entry.index, rank));
    lane.cues.forEach((cue, cueIndex) => {
      order.set(cue.id, { lane: laneRank.get(laneIndex) ?? laneIndex, cue: cueRank.get(cueIndex) ?? cueIndex });
    });
  });
  return order;
}

function effectiveBox(el: GeometryElementRow): [number, number, number, number] | null {
  return el.ink ?? el.item;
}

function pointInBox(x: number, y: number, box: [number, number, number, number]): boolean {
  const [bx, by, bw, bh] = box;
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

function boxesIntersect(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/** Axis-aligned intersection area in px^2 (0 when disjoint). */
export function intersectionArea(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface RankedElement {
  ref: string;
  box: [number, number, number, number];
  z: number | null;
  lane: number;
  cue: number;
}

/**
 * Topmost-first ordering over candidates (largest paint position first). The
 * input is expected in reverse document order so that full ties keep the later
 * element on top; sort is stable.
 */
export function sortTopmostFirst(rows: RankedElement[]): RankedElement[] {
  return [...rows].sort((a, b) => b.lane - a.lane || b.cue - a.cue || (b.z ?? 0) - (a.z ?? 0));
}

// ---------------------------------------------------------------------------
// GET /api/coords
// ---------------------------------------------------------------------------

/** In-flight geometry queries by project + frame; concurrent pins share one measurement. */
const inFlightGeometry = new Map<string, Promise<GeometryQueryResult>>();

/** Finished geometry results by project + frame (bounded; avoids re-measuring while the user pins). */
const geometryCache = new Map<string, { at: number; result: GeometryQueryResult }>();
const GEOMETRY_CACHE_MAX = 8;
const GEOMETRY_CACHE_TTL_MS = 60_000;

function geometryCacheGet(key: string): GeometryQueryResult | null {
  const hit = geometryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GEOMETRY_CACHE_TTL_MS) {
    geometryCache.delete(key);
    return null;
  }
  return hit.result;
}

function geometryCacheSet(key: string, result: GeometryQueryResult): void {
  geometryCache.delete(key);
  geometryCache.set(key, { at: Date.now(), result });
  while (geometryCache.size > GEOMETRY_CACHE_MAX) {
    const oldest = geometryCache.keys().next().value;
    if (oldest === undefined) break;
    geometryCache.delete(oldest);
  }
}

/** Test hook: clears the geometry result cache. */
export function clearGeometryCacheForTests(): void {
  geometryCache.clear();
  inFlightGeometry.clear();
}

/**
 * Runs the composition geometry query in a worker thread so a heavy scene
 * never blocks the server event loop (`/api/events` and the preview keep
 * flowing while it measures).
 */
interface ScopedGeometry {
  result: GeometryQueryResult;
  complete: boolean;
  scoped: { kept: number; total: number } | null;
  fallback: boolean;
}

function geometryInWorker(
  projectDir: string,
  frame: number,
  pin: { x: number; y: number; w: number; h: number }
): Promise<ScopedGeometry> {
  return new Promise<ScopedGeometry>((resolve, reject) => {
    let worker: Worker;
    try {
      const workerPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "live_coords_worker.js");
      worker = new Worker(workerPath, {
        workerData: { kind: "coords", projectDir: path.resolve(projectDir), atRaw: `${frame}f`, pin },
      });
    } catch (e) {
      reject(e);
      return;
    }
    const fail = (msg: string): void => {
      try {
        worker.terminate();
      } catch {
        // already gone
      }
      reject(new Error(msg));
    };
    worker.on(
      "message",
      (m: { ok?: boolean; result?: GeometryQueryResult; complete?: boolean; scoped?: { kept: number; total: number } | null; fallback?: boolean; error?: string }) => {
        if (m?.ok) {
          resolve({
            result: m.result as GeometryQueryResult,
            complete: m.complete !== false,
            scoped: m.scoped ?? null,
            fallback: m.fallback === true,
          });
          worker.terminate();
        } else fail(m?.error ?? "geometry worker failed");
      }
    );
    worker.on("error", (e) => fail(String(e instanceof Error ? e.message : e)));
    worker.on("exit", (code) => {
      if (code !== 0) fail(`geometry worker exited with code ${code}`);
    });
  });
}

function pinScopeKey(pin: { x: number; y: number; w: number; h: number }): string {
  return `${pin.x},${pin.y},${pin.w},${pin.h}`;
}

function geometryAtFrame(
  projectDir: string,
  frame: number,
  pin: { x: number; y: number; w: number; h: number }
): Promise<GeometryQueryResult> {
  const root = path.resolve(projectDir);
  const frameKey = `${root}::${frame}`;
  const scopedKey = `${frameKey}::${pinScopeKey(pin)}`;
  // The frame key holds only whole-frame results (every involved cue); a
  // pin-scoped partial answer is cached under its own pin, never as the frame.
  const scopedHit = geometryCacheGet(scopedKey);
  if (scopedHit) return Promise.resolve(scopedHit);
  const frameHit = geometryCacheGet(frameKey);
  if (frameHit) return Promise.resolve(frameHit);
  const running = inFlightGeometry.get(scopedKey);
  if (running) return running;
  // One in-flight measurement per project + frame + pin; the loser of a
  // timeout race keeps warming the cache. Never reject unobserved.
  logLiveWarn(root, DIAGNOSTICS.LIVE_NOTE_MEASURE_OFFLOADED(`frame ${frame} measures in a worker; the server loop stays responsive`).formatted);
  const work = geometryInWorker(projectDir, frame, pin).then((scoped) => {
    if (scoped.scoped && !scoped.fallback) {
      logLiveWarn(
        root,
        DIAGNOSTICS.LIVE_NOTE_COORDS_PIN_SCOPED(frame, scoped.scoped.kept, scoped.scoped.total).formatted
      );
    }
    if (scoped.fallback) {
      logLiveWarn(root, DIAGNOSTICS.LIVE_NOTE_COORDS_PIN_FALLBACK(frame).formatted);
    }
    geometryCacheSet(scopedKey, scoped.result);
    if (scoped.complete) geometryCacheSet(frameKey, scoped.result);
    return scoped.result;
  });
  work.then(
    () => inFlightGeometry.delete(scopedKey),
    () => inFlightGeometry.delete(scopedKey)
  );
  inFlightGeometry.set(scopedKey, work);
  return work;
}

function spineClipAt(sequence: CutholSequence, atMs: number): { id: string } | null {
  const clips = sequence.spine?.clips ?? [];
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (atMs >= (c.timeline_in_ms ?? 0) && atMs < (c.timeline_in_ms ?? 0) + (c.duration_ms ?? 0)) return { id: c.id };
  }
  return null;
}

/**
 * Composition cue under a sequence time (topmost visible in paint order),
 * else the spine clip. This is the user-visible "scene" of a note.
 */
export function cueAtTime(sequence: CutholSequence, atMs: number): string | undefined {
  const order = cuePaintOrder(sequence);
  let best: string | undefined;
  let bestRank: { lane: number; cue: number } | null = null;
  for (const lane of sequence.lanes ?? []) {
    for (const cue of lane.cues ?? []) {
      const start = cue.at_ms ?? 0;
      if (atMs < start || atMs >= start + (cue.duration_ms ?? 0)) continue;
      const rank = order.get(cue.id) ?? { lane: -1, cue: -1 };
      if (!bestRank || rank.lane > bestRank.lane || (rank.lane === bestRank.lane && rank.cue > bestRank.cue)) {
        bestRank = rank;
        best = cue.id;
      }
    }
  }
  return best ?? spineClipAt(sequence, atMs)?.id;
}

/**
 * Elements under a pin (point) or intersecting a dragged area, topmost first.
 * Falls back to the spine clip when no composition element is under the point.
 */
export async function queryElementsAtPoint(
  projectDir: string,
  atMs: number,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { timeoutMs?: number } = {}
): Promise<CoordsAnswer> {
  const root = path.resolve(projectDir);
  const { sequence } = loadSequence(root);
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const fps = Math.max(1, sequence.stage.fps);
  const isArea = w > 0 && h > 0;
  const inside = isArea
    ? boxesIntersect([x, y, w, h], [0, 0, stageW, stageH])
    : x >= 0 && x <= stageW && y >= 0 && y <= stageH;
  if (!inside) return { pending: false, elements: [] };

  const frame = Math.max(0, Math.floor((atMs / 1000) * fps));
  const timeoutMs = opts.timeoutMs ?? COORDS_TIMEOUT_MS;
  let result: GeometryQueryResult;
  try {
    const raced = await withQueryTimeout(geometryAtFrame(root, frame, { x, y, w, h }), timeoutMs);
    if (!raced.ok) {
      logLiveWarn(root, DIAGNOSTICS.LIVE_NOTE_COORDS_FAILED(`measurement still running after ${timeoutMs} ms (frame ${frame})`).formatted);
      return { pending: true, elements: [] };
    }
    result = raced.value;
  } catch (e) {
    logLiveWarn(root, DIAGNOSTICS.LIVE_NOTE_COORDS_FAILED(String(e instanceof Error ? e.message : e)).formatted);
    const clip = spineClipAt(sequence, atMs);
    return {
      pending: false,
      elements: clip ? [{ ref: clip.id, box: [0, 0, stageW, stageH] }] : [],
    };
  }

  return rankElements(sequence, result, atMs, x, y, w, h, isArea);
}

export function rankElements(
  sequence: CutholSequence,
  result: GeometryQueryResult,
  atMs: number,
  x: number,
  y: number,
  w: number,
  h: number,
  isArea: boolean
): CoordsAnswer {
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const order = cuePaintOrder(sequence);
  const candidates: RankedElement[] = [];
  for (let i = result.elements.length - 1; i >= 0; i--) {
    const el = result.elements[i];
    const box = effectiveBox(el);
    if (!box) continue;
    const hit = isArea ? boxesIntersect(box, [x, y, w, h]) : pointInBox(x, y, box);
    if (!hit) continue;
    const rank = order.get(el.cue) ?? { lane: -1, cue: -1 };
    candidates.push({ ref: `${el.cue}/${el.key}`, box, z: el.z, lane: rank.lane, cue: rank.cue });
  }
  const ranked = sortTopmostFirst(candidates);
  if (ranked.length === 0) {
    const clip = spineClipAt(sequence, atMs);
    return {
      pending: false,
      elements: clip ? [{ ref: clip.id, box: [0, 0, stageW, stageH] }] : [],
    };
  }
  const elements: LiveNoteElement[] = ranked.map((r) => ({
    ref: r.ref,
    box: [Math.round(r.box[0] * 10) / 10, Math.round(r.box[1] * 10) / 10, Math.round(r.box[2] * 10) / 10, Math.round(r.box[3] * 10) / 10],
    ...(r.z === null ? {} : { z: r.z }),
  }));
  const answer: CoordsAnswer = { pending: false, elements };
  if (ranked.length >= 2) {
    const overlap = intersectionArea(ranked[0].box, ranked[1].box);
    if (overlap > 0) answer.overlap_px2 = Math.round(overlap * 10) / 10;
  }
  return answer;
}

/**
 * Fills notes that arrived with no elements from the warm geometry cache
 * (synchronous, never waits): element names attach to the packet when the
 * measurement is already ready, otherwise the packet keeps `elements: []`.
 */
export function fillElementsFromCache(projectDir: string, notes: LiveNote[]): number {
  const root = path.resolve(projectDir);
  let sequence: CutholSequence;
  try {
    sequence = loadSequence(root).sequence;
  } catch {
    return 0;
  }
  const fps = Math.max(1, sequence.stage.fps);
  let filled = 0;
  for (const note of notes) {
    if (!note.point || (note.elements?.length ?? 0) > 0) continue;
    const frame = Math.max(0, Math.floor((note.at_ms / 1000) * fps));
    const cached = geometryCacheGet(`${root}::${frame}`);
    if (!cached) continue;
    const area = note.area;
    const w = area ? area[2] : 0;
    const h = area ? area[3] : 0;
    const qx = area ? area[0] : note.point.x;
    const qy = area ? area[1] : note.point.y;
    const answer = rankElements(sequence, cached, note.at_ms, qx, qy, w, h, w > 0 && h > 0);
    if (!answer.pending && answer.elements.length > 0) {
      note.elements = answer.elements;
      if (answer.overlap_px2 !== undefined) note.overlap_px2 = answer.overlap_px2;
      filled++;
    }
  }
  return filled;
}

function numParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Mount point for `GET /api/coords?at_ms=&x=&y=[&w=&h=]`. Returns true when
 * handled. Answers 200 with `{ok:true, pending, elements, overlap_px2?}`;
 * `pending:true` means the window should show "measuring" and ask again.
 */
export function routeLiveCoordsRequest(
  projectDir: string,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  params: URLSearchParams
): boolean {
  const atMs = numParam(params, "at_ms");
  const x = numParam(params, "x");
  const y = numParam(params, "y");
  const w = params.get("w") === null ? 0 : numParam(params, "w");
  const h = params.get("h") === null ? 0 : numParam(params, "h");
  if (atMs === null || atMs < 0 || x === null || y === null || w === null || w < 0 || h === null || h < 0) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ ok: false, error: "query needs at_ms>=0, x, y and optional w,h>=0" })
    );
    return true;
  }
  queryElementsAtPoint(projectDir, atMs, x, y, w, h).then(
    (answer) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ ok: true, at_ms: atMs, pending: answer.pending, elements: answer.elements, ...(answer.overlap_px2 === undefined ? {} : { overlap_px2: answer.overlap_px2 }) })
      );
    },
    (e: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) })
      );
    }
  );
  return true;
}

// ---------------------------------------------------------------------------
// Contact sheet geometry (pure; coordinates stay exact through crop/scale/pad).
// ---------------------------------------------------------------------------

export interface SheetCell {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  /** Uniform scale from cropped pixels to the 480x270 cell. */
  scale: number;
  offX: number;
  offY: number;
}

/** 480x270 crop around the pin, clamped into the frame. */
export function computeSheetCell(stageW: number, stageH: number, pinX: number, pinY: number): SheetCell {
  const cropW = Math.min(SHEET_CELL_W, Math.max(1, Math.floor(stageW)));
  const cropH = Math.min(SHEET_CELL_H, Math.max(1, Math.floor(stageH)));
  const cropX = Math.min(Math.max(0, Math.round(pinX - cropW / 2)), Math.max(0, Math.floor(stageW) - cropW));
  const cropY = Math.min(Math.max(0, Math.round(pinY - cropH / 2)), Math.max(0, Math.floor(stageH) - cropH));
  const scale = Math.min(SHEET_CELL_W / cropW, SHEET_CELL_H / cropH);
  return { cropX, cropY, cropW, cropH, scale, offX: (SHEET_CELL_W - cropW * scale) / 2, offY: (SHEET_CELL_H - cropH * scale) / 2 };
}

/** Stage-pixel point to cell pixels (same transform the ffmpeg chain applies). */
export function stageToCell(cell: SheetCell, sx: number, sy: number): [number, number] {
  return [Math.round((sx - cell.cropX) * cell.scale + cell.offX), Math.round((sy - cell.cropY) * cell.scale + cell.offY)];
}

// ---------------------------------------------------------------------------
// Contact sheet rendering (worker thread; synchronous ffmpeg + monitor frame).
// ---------------------------------------------------------------------------

/** One contact-sheet cell: the exact frame to capture plus the pin to draw on it. */
export interface SheetCellSpec {
  at_ms: number;
  note: LiveNote;
}

interface SheetWorkerData {
  kind: "sheet";
  projectDir: string;
  cells: SheetCellSpec[];
  outFile: string;
}

/** Contact-sheet capacity: at most this many cells; extras are reported, not silently dropped. */
export const SHEET_MAX_CELLS = 6;

/**
 * One cell per pinned note at its own frame. Notes with no pin need no cell
 * (`all` never, `range` one representative cell at the note's own frame).
 * Boundary notes get two cells (last frame of `from`, first frame of `to`).
 * Cells are capped at SHEET_MAX_CELLS; the caller reports the dropped count.
 */
export function planSheetCells(notes: LiveNote[], fps: number, frameMs = 0): { cells: SheetCellSpec[]; dropped: number } {
  const cells: SheetCellSpec[] = [];
  for (const note of notes) {
    if (note.scope?.kind === "all") continue;
    if (!note.point && note.scope?.kind !== "boundary") continue;
    if (note.scope?.kind === "boundary") {
      const step = frameMs > 0 ? frameMs : Math.max(1, Math.round(1000 / Math.max(1, fps)));
      cells.push({ at_ms: Math.max(0, note.at_ms - step), note });
      cells.push({ at_ms: note.at_ms, note });
    } else {
      cells.push({ at_ms: note.at_ms, note });
    }
  }
  const dropped = Math.max(0, cells.length - SHEET_MAX_CELLS);
  return { cells: cells.slice(0, SHEET_MAX_CELLS), dropped };
}

function pngSize(file: string): { w: number; h: number } {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function findDrawTextFont(): string | null {
  const candidates = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/calibri.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

function escapeFilterText(v: string): string {
  return v.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Renders the one contact-sheet PNG for a packet: the exact composite frame,
 * one 480x270 cell per note (at most 3 columns, sheet width <= 1440 px), thin
 * element boxes and a numbered pin badge per cell. Runs in the worker thread.
 */
export function renderContactSheetSync(data: SheetWorkerData): void {
  const root = path.resolve(data.projectDir);
  const { sequence } = loadSequence(root);
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const frameTmp = path.join(os.tmpdir(), `cuthol-notes-frame-${process.pid}-${crypto.randomBytes(4).toString("hex")}.png`);
  const font = findDrawTextFont();
  const branches: string[] = [];
  const labels: string[] = [];
  const inputs: string[] = [];
  let inputIndex = 0;
  try {
    for (const [i, cellSpec] of data.cells.entries()) {
      const note = cellSpec.note;
      const frameFile = `${frameTmp}.${i}.png`;
      const captured = captureMonitorFrame({ workspaceDir: root, atMs: cellSpec.at_ms, showBoxes: false, hideHud: true, outputPath: frameFile });
      if (!captured.ok || !fs.existsSync(frameFile)) {
        const first = captured.diagnostics[0];
        throw new Error(first ? `${first.code}: ${first.what}` : "frame render failed");
      }
      inputs.push("-i", frameFile);
      const png = pngSize(frameFile);
      // The monitor frame may be smaller than the stage; map stage pixels to frame pixels.
      const kx = png.w / Math.max(1, stageW);
      const ky = png.h / Math.max(1, stageH);
      const pinX = (note.point?.x ?? stageW / 2) * kx;
      const pinY = (note.point?.y ?? stageH / 2) * ky;
      const cell = computeSheetCell(png.w, png.h, pinX, pinY);
      // Boxes in frame pixels, clipped to the crop, then mapped to cell pixels.
      const boxes: string[] = [];
      const pushBox = (box: [number, number, number, number], color: string, t: number): void => {
        const fx = box[0] * kx;
        const fy = box[1] * ky;
        const fw = box[2] * kx;
        const fh = box[3] * ky;
        const ix0 = Math.max(fx, cell.cropX);
        const iy0 = Math.max(fy, cell.cropY);
        const ix1 = Math.min(fx + fw, cell.cropX + cell.cropW);
        const iy1 = Math.min(fy + fh, cell.cropY + cell.cropH);
        if (ix1 - ix0 < 2 || iy1 - iy0 < 2) return;
        const x0 = Math.round((ix0 - cell.cropX) * cell.scale + cell.offX);
        const y0 = Math.round((iy0 - cell.cropY) * cell.scale + cell.offY);
        const x1 = Math.round((ix1 - cell.cropX) * cell.scale + cell.offX);
        const y1 = Math.round((iy1 - cell.cropY) * cell.scale + cell.offY);
        boxes.push(`drawbox=x=${x0}:y=${y0}:w=${Math.max(1, x1 - x0)}:h=${Math.max(1, y1 - y0)}:color=${color}:t=${t}`);
      };
      for (const el of note.elements ?? []) pushBox(el.box, "white", 2);
      if (note.area) pushBox(note.area, "red", 2);
      const [pcx, pcy] = stageToCell(cell, pinX, pinY);
      // Exact pin dot plus the numbered badge above it.
      boxes.push(`drawbox=x=${Math.max(0, pcx - 3)}:y=${Math.max(0, pcy - 3)}:w=7:h=7:color=red:t=fill`);
      const badgeX = Math.min(Math.max(0, pcx - 14), SHEET_CELL_W - 40);
      const badgeY = Math.min(Math.max(0, pcy - 62), SHEET_CELL_H - 48);
      if (font) {
        boxes.push(
          `drawtext=fontfile='${escapeFilterText(font)}':text='${note.n}':fontsize=28:fontcolor=white:box=1:boxcolor=red:boxborderw=10:x=${badgeX}:y=${badgeY}`
        );
      } else {
        boxes.push(`drawbox=x=${badgeX}:y=${badgeY}:w=34:h=40:color=red:t=fill`);
      }
      const chain = `crop=${cell.cropW}:${cell.cropH}:${cell.cropX}:${cell.cropY},scale=${SHEET_CELL_W}:${SHEET_CELL_H}:force_original_aspect_ratio=decrease,pad=${SHEET_CELL_W}:${SHEET_CELL_H}:(ow-iw)/2:(oh-ih)/2${boxes.length ? "," : ""}${boxes.join(",")}`;
      branches.push(`[${inputIndex}:v]${chain}[c${i}]`);
      inputIndex++;
      const col = i % SHEET_MAX_COLS;
      const row = Math.floor(i / SHEET_MAX_COLS);
      labels.push(`${col * SHEET_CELL_W}_${row * SHEET_CELL_H}`);
    }
    if (branches.length === 0) throw new Error("contact sheet needs at least one cell");
    const args = ["-y", "-v", "error", ...inputs];
    if (branches.length === 1) {
      args.push("-filter_complex", `${branches[0]},[c0]copy[out]`, "-map", "[out]", "-frames:v", "1", data.outFile);
    } else {
      const layout = labels.join("|");
      const stacked = branches.map((_, i) => `[c${i}]`).join("");
      args.push("-filter_complex", `${branches.join(";")};${stacked}xstack=inputs=${branches.length}:layout=${layout}:fill=black[out]`, "-map", "[out]", "-frames:v", "1", data.outFile);
    }
    const res = spawnWatchedSync("ffmpeg", args, { step: "live note contact sheet" });
    if (res.status !== 0 || !fs.existsSync(data.outFile)) {
      throw new Error((res.stderr ?? "ffmpeg contact sheet failed").toString().slice(0, 300) || "ffmpeg contact sheet failed");
    }
  } finally {
    for (let i = 0; i < data.cells.length; i++) {
      try {
        fs.unlinkSync(`${frameTmp}.${i}.png`);
      } catch {
        // already gone
      }
    }
    try {
      fs.unlinkSync(frameTmp);
    } catch {
      // legacy single-frame temp; usually never written
    }
  }
}

function buildSheetInWorker(data: Omit<SheetWorkerData, "kind">): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./live_notes_api.js", import.meta.url), {
        workerData: { ...data, kind: "sheet" } satisfies SheetWorkerData,
      });
    } catch (e) {
      reject(e);
      return;
    }
    const fail = (msg: string): void => {
      try {
        worker.terminate();
      } catch {
        // already gone
      }
      reject(new Error(msg));
    };
    worker.on("message", (m: { ok?: boolean; error?: string }) => {
      if (m?.ok) resolve();
      else fail(m?.error ?? "contact sheet worker failed");
    });
    worker.on("error", (e) => fail(String(e instanceof Error ? e.message : e)));
    worker.on("exit", (code) => {
      if (code !== 0) fail(`contact sheet worker exited with code ${code}`);
    });
  });
}

// ---------------------------------------------------------------------------
// POST /api/notes
// ---------------------------------------------------------------------------

function sanitizeNote(raw: unknown, stageW: number, stageH: number): LiveNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = Number(r.n);
  const atMs = Number(r.at_ms);
  const frame = Number(r.frame);
  const point = r.point as { x?: unknown; y?: unknown } | undefined;
  const px = point == null ? NaN : Number(point?.x);
  const py = point == null ? NaN : Number(point?.y);
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(atMs) || atMs < 0 || !Number.isInteger(frame) || frame < 0) return null;
  // A note without a point is a general note: no pin, no contact sheet cell.
  const hasPoint = Number.isFinite(px) && Number.isFinite(py);
  if (point != null && !hasPoint) return null;
  // The window refuses to send textless notes; the API refuses them too.
  if (typeof r.text !== "string" || r.text.trim() === "") return null;
  const text = r.text.slice(0, 2000);
  let area: [number, number, number, number] | undefined;
  if (Array.isArray(r.area) && r.area.length === 4 && r.area.every((v) => Number.isFinite(Number(v)))) {
    const [ax, ay, aw, ah] = (r.area as unknown[]).map(Number);
    if (aw > 0 && ah > 0) area = [ax, ay, aw, ah];
  }
  const elements: LiveNoteElement[] = [];
  if (Array.isArray(r.elements)) {
    for (const e of r.elements.slice(0, 12)) {
      const el = e as { ref?: unknown; box?: unknown; z?: unknown };
      if (typeof el?.ref !== "string" || !Array.isArray(el.box) || el.box.length !== 4) continue;
      const box = (el.box as unknown[]).map(Number);
      if (!box.every((v) => Number.isFinite(v))) continue;
      elements.push({ ref: el.ref.slice(0, 200), box: [box[0], box[1], box[2], box[3]], ...(Number.isFinite(Number(el.z)) ? { z: Number(el.z) } : {}) });
    }
  }
  const overlap = Number((r as { overlap_px2?: unknown }).overlap_px2);
  const cue = typeof r.cue === "string" && r.cue.trim() !== "" ? r.cue.slice(0, 200) : undefined;
  let scope: LiveNote["scope"];
  if (r.scope && typeof r.scope === "object") {
    const s = r.scope as { kind?: unknown; from?: unknown; to?: unknown };
    if (s.kind === "all") scope = { kind: "all" };
    else if ((s.kind === "boundary" || s.kind === "range") && typeof s.from === "string" && typeof s.to === "string" && s.from !== "" && s.to !== "") {
      scope = s.kind === "boundary" ? { kind: "boundary", from: s.from.slice(0, 200), to: s.to.slice(0, 200) } : { kind: "range", from: s.from.slice(0, 200), to: s.to.slice(0, 200) };
    }
  }
  return {
    n,
    text,
    at_ms: Math.round(atMs),
    frame,
    ...(hasPoint
      ? { point: { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10, nx: Math.round((px / Math.max(1, stageW)) * 10000) / 10000, ny: Math.round((py / Math.max(1, stageH)) * 10000) / 10000 } }
      : {}),
    ...(area ? { area } : {}),
    elements,
    ...(Number.isFinite(overlap) && overlap > 0 ? { overlap_px2: Math.round(overlap * 10) / 10 } : {}),
    ...(cue ? { cue } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** A packet carries at most this many notes; the rest is reported, not silently dropped. */
export const MAX_NOTES_PER_PACKET = 32;

export interface NotesPostResult {
  id: string;
  /** Relative sheet path, or null when the packet carries no image. */
  sheet: string | null;
  /** Notes received in the request body. */
  received: number;
  /** Notes stored in the packet. */
  stored: number;
  /** Received notes cut off by MAX_NOTES_PER_PACKET. */
  dropped_over_limit: number;
  /** Received notes that failed validation (within the limit). */
  dropped_invalid: number;
}

/**
 * Validates the window's notes, renders the contact sheet in a worker thread
 * (the packet goes without an image when that fails, G617), and queues the
 * packet. Keeps the previous contract: an explicit `sheet_png_base64` is still
 * accepted; the window no longer sends one.
 */
export async function handleLiveNotesPost(
  projectDir: string,
  body: Record<string, unknown>,
  revision: number,
  log: (msg: string) => void
): Promise<NotesPostResult> {
  const t0 = Date.now();
  const root = path.resolve(projectDir);
  const lp = resolveLivePaths(root);
  if (!Array.isArray(body.notes)) throw new Error("body needs notes: LiveNote[]");
  const { sequence } = loadSequence(root);
  const received = (body.notes as unknown[]).length;
  const notes: LiveNote[] = [];
  let dropped_invalid = 0;
  for (const raw of (body.notes as unknown[]).slice(0, MAX_NOTES_PER_PACKET)) {
    const note = sanitizeNote(raw, sequence.stage.width, sequence.stage.height);
    if (note) notes.push(note);
    else dropped_invalid++;
  }
  const dropped_over_limit = Math.max(0, received - MAX_NOTES_PER_PACKET);
  if (notes.length === 0) throw new Error("body needs at least one valid note");
  for (const note of notes) {
    if (!note.cue) {
      const cue = cueAtTime(sequence, note.at_ms);
      if (cue) note.cue = cue;
    }
  }
  const fps = Math.max(1, sequence.stage.fps);
  const plan = planSheetCells(notes, fps);
  const id = `n_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const packet: LiveNotePacket = {
    schema: LIVE_SCHEMA,
    id,
    created_at: new Date().toISOString(),
    revision,
    notes,
    ...(plan.dropped > 0 ? { sheet_note: `${plan.dropped} of ${plan.dropped + plan.cells.length} sheet cells dropped (cap ${SHEET_MAX_CELLS})` } : {}),
  };
  // The packet is queued at once; the contact sheet renders in the background
  // and is attached to the stored packet when ready (the agent reads the
  // inbox on its next step, by which time the image is usually there).
  const tValidated = Date.now();
  const filled = fillElementsFromCache(root, notes);
  let sheet: string | null = null;
  if (typeof body.sheet_png_base64 === "string" && body.sheet_png_base64.length > 0) {
    const file = path.join(lp.inboxDir, `${id}.png`);
    fs.mkdirSync(lp.inboxDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(body.sheet_png_base64, "base64"));
    sheet = path.relative(root, file).split(path.sep).join("/");
  }
  if (sheet) packet.sheet = sheet;
  writeLiveNotePacket(root, packet);
  const t1 = Date.now();
  const distinctFrames = new Set(plan.cells.map((c) => c.at_ms)).size;
  log(DIAGNOSTICS.LIVE_MULTI_NOTES_QUEUED(id, plan.cells.length, distinctFrames).formatted + ` (validated ${notes.length}/${received} in ${tValidated - t0} ms, cache-filled ${filled}, queued in ${t1 - t0} ms total)`);
  if (plan.dropped > 0) log(DIAGNOSTICS.LIVE_SHEET_CELLS_DROPPED(plan.dropped, plan.dropped + plan.cells.length, SHEET_MAX_CELLS).formatted);
  if (!sheet && plan.cells.length > 0) {
    const file = path.join(lp.inboxDir, `${id}.png`);
    fs.mkdirSync(lp.inboxDir, { recursive: true });
    const sheetRel = path.relative(root, file).split(path.sep).join("/");
    const sheetCells = plan.cells.map((c) => ({ at_ms: c.at_ms, note: { ...c.note, elements: c.note.elements ?? [] } }));
    void buildSheetInWorker({ projectDir: root, cells: sheetCells, outFile: file }).then(
      () => {
        // The agent may have drained the packet while the sheet rendered;
        // attach wherever the packet file is now (inbox or delivered).
        for (const packetFile of [path.join(lp.inboxDir, `${id}.json`), path.join(lp.inboxDir, "delivered", `${id}.json`)]) {
          try {
            const cur = JSON.parse(fs.readFileSync(packetFile, "utf8")) as LiveNotePacket;
            if (!cur.sheet) {
              cur.sheet = packetFile.includes("delivered") ? path.posix.join(".cuthol/live/inbox/delivered", `${id}.png`) : sheetRel;
              const { schema: _drop, ...rest } = cur as unknown as Record<string, unknown>;
              void _drop;
              fs.writeFileSync(packetFile, JSON.stringify({ schema: LIVE_SCHEMA, ...rest }, null, 2));
              // A drained packet's png already moved with it; an inbox
              // packet's png sits next to its json.
              const wantPng = path.join(path.dirname(packetFile), `${id}.png`);
              if (wantPng !== file) {
                try {
                  fs.renameSync(file, wantPng);
                } catch {
                  // already moved or never written
                }
              }
              log(`note packet ${id}: contact sheet attached`);
            }
            return;
          } catch {
            // not here; try the next location
          }
        }
        log(DIAGNOSTICS.LIVE_NOTE_SHEET_FAILED(`packet ${id} left the inbox before the sheet finished`).formatted);
      },
      (e: unknown) => {
        const detail = String(e instanceof Error ? e.message : e);
        log(DIAGNOSTICS.LIVE_NOTE_SHEET_FAILED(detail).formatted);
        try {
          fs.unlinkSync(file);
        } catch {
          // never written
        }
      }
    );
  }
  return { id, sheet, received, stored: notes.length, dropped_over_limit, dropped_invalid };
}

// ---------------------------------------------------------------------------
// Worker entry: this module re-executed with {kind:"sheet"} workerData.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  const wd = workerData as Partial<SheetWorkerData>;
  if (wd?.kind === "sheet") {
    try {
      renderContactSheetSync(wd as SheetWorkerData);
      parentPort?.postMessage({ ok: true });
    } catch (e) {
      parentPort?.postMessage({ ok: false, error: String(e instanceof Error ? e.message : e) });
    }
  } else {
    parentPort?.postMessage({ ok: false, error: "unknown live notes worker task" });
  }
}
