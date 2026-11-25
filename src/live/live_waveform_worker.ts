// Analyzes one audio asset's waveform off the live server's event loop. A cold
// analysis decodes the whole asset through FFmpeg (seconds to minutes); on the
// main thread it would hold back SSE deltas and every other request.
import { parentPort, workerData } from "node:worker_threads";
import { analyzeAssetWaveform } from "../library/waveform.js";
import type { LiveWaveformResponse } from "./live_types.js";

interface WaveformWorkerData {
  kind: "waveform";
  projectDir: string;
  handle: string;
  bins: number;
}

async function main(): Promise<void> {
  const wd = workerData as Partial<WaveformWorkerData>;
  if (
    wd?.kind !== "waveform" ||
    typeof wd.projectDir !== "string" ||
    typeof wd.handle !== "string" ||
    !Number.isFinite(wd.bins)
  ) {
    parentPort?.postMessage({ ok: false, error: "unknown live waveform worker task" });
    return;
  }
  try {
    const result = analyzeAssetWaveform({ workspaceDir: wd.projectDir, handle: wd.handle, bins: wd.bins, skipSequenceRef: true });
    const response: LiveWaveformResponse = {
      ok: true,
      handle: result.handle,
      bins_count: result.bins_count,
      duration_ms: result.duration_ms,
      peaks: result.bins.map((b) => b.peak_norm),
    };
    parentPort?.postMessage({ ok: true, response });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: String(e instanceof Error ? e.message : e) });
  }
}

void main();
