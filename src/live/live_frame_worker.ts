// Renders one exact Live frame off the server's event loop. The synchronous
// monitor-frame path takes seconds per frame; on the main thread it would hold
// back SSE deltas and every other request for the whole render.
import { parentPort, workerData } from "node:worker_threads";
import { captureMonitorFrame } from "../monitor/preview.js";

interface FrameWorkerData {
  kind: "frame";
  projectDir: string;
  atMs: number;
  outputPath: string;
}

async function main(): Promise<void> {
  const wd = workerData as Partial<FrameWorkerData>;
  if (wd?.kind !== "frame" || typeof wd.projectDir !== "string" || !Number.isFinite(wd.atMs) || typeof wd.outputPath !== "string") {
    parentPort?.postMessage({ ok: false, error: "unknown live frame worker task" });
    return;
  }
  try {
    const result = captureMonitorFrame({ workspaceDir: wd.projectDir, atMs: wd.atMs as number, showBoxes: false, hideHud: true, outputPath: wd.outputPath as string });
    if (!result.ok) {
      parentPort?.postMessage({ ok: false, error: result.diagnostics[0] ? `${result.diagnostics[0].code}: ${result.diagnostics[0].what}` : "frame render failed" });
      return;
    }
    parentPort?.postMessage({ ok: true, pngPath: result.png_path });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: String(e instanceof Error ? e.message : e) });
  }
}

void main();
