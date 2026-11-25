import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { LaneCue } from "../core/schema.js";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveCueStartMs } from "../core/timeline.js";
import { loadSequence } from "../core/workspace.js";
import { measureCompositionCues, readCompositionPixelSize } from "../compositor/coords_extract.js";
import type { CoordsDocument } from "../compositor/coords_extract.js";
import { listGeometryFrame, parseGeometryMoment } from "../compositor/coords_query.js";
import type { GeometryCueRow, GeometryQueryResult } from "../compositor/coords_query.js";
import { mapLocalBoxToStage } from "../compositor/coords_map.js";

interface CoordsWorkerData {
  kind: "coords";
  projectDir: string;
  atRaw: string;
  pin?: { x: number; y: number; w: number; h: number };
}

export interface PinBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointInBox(x: number, y: number, box: [number, number, number, number]): boolean {
  const [bx, by, bw, bh] = box;
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

function boxesIntersect(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/**
 * Stage-pixel box of the whole composition cue at a sequence frame (the same
 * placement math the answers use, applied to the full composition rect). Every
 * measured element box is a mapped sub-box of this rect, so a pin outside it
 * can never resolve to this cue; a pin inside may. Unknown composition size
 * returns null (the cue is measured, never skipped).
 */
function fullCueStageBox(
  projectDir: string,
  stageW: number,
  stageH: number,
  cue: LaneCue,
  localMs: number
): [number, number, number, number] | null {
  const comp = cue.composition;
  if (!comp) return null;
  const absCompDir = path.isAbsolute(comp.composition_dir)
    ? comp.composition_dir
    : path.resolve(projectDir, comp.composition_dir);
  const size = readCompositionPixelSize(absCompDir, comp.entry_html || "index.html");
  if (!size) return null;
  const r = mapLocalBoxToStage(
    { x: 0, y: 0, w: size.width, h: size.height },
    cue,
    { compWidth: size.width, compHeight: size.height, stageWidth: stageW, stageHeight: stageH },
    localMs
  ).box;
  return [r.x, r.y, r.w, r.h];
}

/**
 * Active composition cues at a sequence frame whose whole-composition stage
 * box covers the pin (point) or intersects the dragged area. Order follows the
 * sequence so repeated pins scope deterministically.
 */
export function selectPinCandidateCues(
  sequence: import("../core/schema.js").CutholSequence,
  projectDir: string,
  sequenceFrame: number,
  x: number,
  y: number,
  w: number,
  h: number
): string[] {
  const root = path.resolve(projectDir);
  const stageW = sequence.stage.width;
  const stageH = sequence.stage.height;
  const stageFps = Math.max(1, sequence.stage.fps);
  const sequenceMs = Math.round((sequenceFrame / stageFps) * 1000);
  const isArea = w > 0 && h > 0;
  const out: string[] = [];
  for (const lane of sequence.lanes ?? []) {
    if (lane.muted) continue;
    for (const cue of lane.cues ?? []) {
      if (!cue.composition) continue;
      const startMs = resolveCueStartMs(sequence, cue);
      const local = sequenceFrame - Math.round((startMs * stageFps) / 1000);
      const count = Math.max(1, Math.round((cue.duration_ms * stageFps) / 1000));
      if (local < 0 || local >= count) continue;
      const box = fullCueStageBox(root, stageW, stageH, cue, sequenceMs - startMs);
      if (!box) {
        out.push(cue.id);
        continue;
      }
      const hit = isArea ? boxesIntersect(box, [x, y, w, h]) : pointInBox(x, y, box);
      if (hit) out.push(cue.id);
    }
  }
  return out;
}

function effectiveBox(el: { item: GeometryQueryResult["elements"][number]["item"]; ink: GeometryQueryResult["elements"][number]["ink"] }): [number, number, number, number] | null {
  return el.ink ?? el.item;
}

async function main(): Promise<void> {
  const wd = workerData as Partial<CoordsWorkerData>;
  if (wd?.kind !== "coords") {
    parentPort?.postMessage({ ok: false, error: "unknown live coords worker task" });
    return;
  }
  try {
    const root = path.resolve(wd.projectDir as string);
    const { sequence } = loadSequence(root);
    const stageW = sequence.stage.width;
    const stageH = sequence.stage.height;
    const stageFps = Math.max(1, sequence.stage.fps);
    const moment = parseGeometryMoment(wd.atRaw as string, stageFps);
    const pin = wd.pin;

    // All involved cues (same rule as the whole-frame query: active unmuted
    // composition cues at the frame).
    const involved: string[] = [];
    for (const lane of sequence.lanes) {
      if (lane.muted) continue;
      for (const cue of lane.cues) {
        if (!cue.composition) continue;
        const startFrame = Math.round((resolveCueStartMs(sequence, cue) * stageFps) / 1000);
        const frameCount = Math.max(1, Math.round((cue.duration_ms * stageFps) / 1000));
        const local = moment.sequence_frame - startFrame;
        if (local >= 0 && local < frameCount) involved.push(cue.id);
      }
    }

    let candidates = involved;
    if (pin) {
      candidates = selectPinCandidateCues(sequence, root, moment.sequence_frame, pin.x, pin.y, pin.w, pin.h);
    }

    const docs: CoordsDocument[] = [];
    const cachedOf = new Map<string, boolean>();
    const measuredThisCall: string[] = [];
    const loadDocs = async (cueIds: string[]): Promise<void> => {
      if (cueIds.length === 0) return;
      const measured = await measureCompositionCues({ workspaceDir: root, cueIds });
      if (measured.skipped_cues.length > 0) {
        const first = measured.skipped_cues[0];
        throw new CutholError(DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(first.cue, first.reason));
      }
      const fileOf = new Map(measured.cues.map((c) => [c.cue, c]));
      for (const cueId of cueIds) {
        const entry = fileOf.get(cueId);
        if (!entry) {
          throw new CutholError(DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(cueId, "measured result missing"));
        }
        cachedOf.set(cueId, entry.cached);
        if (!entry.cached) measuredThisCall.push(cueId);
        const fileDoc = JSON.parse(fs.readFileSync(entry.file, "utf8")) as CoordsDocument;
        const found = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
        const startFrame = found
          ? Math.round((resolveCueStartMs(sequence, found) * stageFps) / 1000)
          : moment.sequence_frame;
        docs.push({ ...fileDoc, cue_id: cueId, sequence_start_frame: startFrame });
      }
    };

    await loadDocs(candidates);

    let listed = listGeometryFrame({ sequence, docs, sequenceFrame: moment.sequence_frame });
    let fallback = false;
    if (pin) {
      const isArea = pin.w > 0 && pin.h > 0;
      const hit = listed.elements.some((el) => {
        const box = effectiveBox(el);
        if (!box) return false;
        return isArea ? boxesIntersect(box, [pin.x, pin.y, pin.w, pin.h]) : pointInBox(pin.x, pin.y, box);
      });
      if (!hit) {
        const rest = involved.filter((id) => !candidates.includes(id));
        if (rest.length > 0) {
          await loadDocs(rest);
          listed = listGeometryFrame({ sequence, docs, sequenceFrame: moment.sequence_frame });
          fallback = true;
        }
      }
    }

    const frameByCue = new Map(listed.frames.map((f) => [f.cue, f]));
    const order = [...docs.map((d) => d.cue_id)].sort();
    const cues: GeometryCueRow[] = order.map((cueId) => {
      const doc = docs.find((d) => d.cue_id === cueId)!;
      const use = frameByCue.get(cueId);
      return {
        cue: cueId,
        composition: path.basename(doc.composition_dir),
        active: use?.active ?? true,
        cached: cachedOf.get(cueId) === true,
        local_frame: use?.local_frame ?? null,
      };
    });
    const listedSet = new Set(docs.map((d) => d.cue_id));
    const complete = involved.every((id) => listedSet.has(id));
    const result: GeometryQueryResult = {
      mode: "geometry",
      detail: false,
      at: (wd.atRaw as string).trim(),
      sequence_frame: moment.sequence_frame,
      sequence_ms: moment.sequence_ms,
      stage: { width: stageW, height: stageH, fps: stageFps },
      cues,
      measured: measuredThisCall,
      elements: listed.elements,
      pairs: [],
    };
    parentPort?.postMessage({
      ok: true,
      result,
      complete,
      scoped: pin ? { kept: candidates.length, total: involved.length } : null,
      fallback,
    });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: String(e instanceof Error ? e.message : e) });
  }
}

void main();
