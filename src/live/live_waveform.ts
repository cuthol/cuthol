// Live audio waveform (`src/live/live_waveform.ts`).
//
// The timeline draws a waveform for an audio cue, but the snapshot never
// carries peaks: the window fetches each audio asset's waveform once through
// `GET /api/waveform/<handle>` and slices the bins covering each cue's source
// range itself.
//
// Endpoint contract (owned by the live server file; this module only exports
// the handler so it can be mounted):
//   GET /api/waveform/<handle>  -> LiveWaveformResponse (JSON) or
//                                  404 + JSON when the handle is unknown or
//                                  has no audio track.
//
// The analysis goes through the library's cached waveform path
// (`analyzeAssetWaveform`, bins keyed by digest and bin count in the media
// ledger), so it runs in a worker thread: a cold analysis takes seconds to
// minutes (a 10-minute file takes 15+ s) and must not hold back SSE deltas
// and every other request. Concurrent requests for the same asset share one
// worker; requests for different assets analyze in parallel, each writing to
// the ledger (SQLite WAL mode plus a busy timeout keeps the worker and a
// concurrent CLI from locking each other out).
//
// The analysis never touches the project file: the worker skips the library's
// usual `analysis_refs.waveform` marker (the ledger cache still fills, so a
// later `library waveform` call is fast and records the marker then). No peak
// data is ever written to the sequence or the journal.
import type http from "node:http";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { loadSequence } from "../core/workspace.js";
import type { LiveWaveformResponse } from "./live_types.js";

/** Bins per asset second; the library clamps the count to 16..2000. */
const BINS_PER_SECOND = 20;

/** Bin count for an asset duration: ~20 bins per second, clamped to 16..2000. */
export function waveformBinCount(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 16;
  return Math.max(16, Math.min(2000, Math.round(durationMs / 50)));
}

/** In-flight analyses keyed by asset handle: same-asset requests share one worker. */
const inFlight = new Map<string, Promise<LiveWaveformResponse>>();

/** Analyze one audio asset's waveform in a worker thread. */
export function computeLiveWaveform(projectDir: string, handle: string, bins: number): Promise<LiveWaveformResponse> {
  const key = `${handle}:${bins}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = new Promise<LiveWaveformResponse>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./live_waveform_worker.js", import.meta.url), {
        workerData: { kind: "waveform", projectDir: path.resolve(projectDir), handle, bins },
      });
    } catch (e) {
      reject(new Error(String(e instanceof Error ? e.message : e)));
      return;
    }
    // The worker stays referenced until it answers (no unref): an unref'd
    // worker lets the process exit mid-analysis when nothing else holds the
    // loop. It is terminated once the analysis settles.
    const done = (): void => {
      void worker.terminate();
    };
    worker.on("message", (m: { ok?: boolean; response?: LiveWaveformResponse; error?: string }) => {
      if (m?.ok && m.response) {
        done();
        resolve(m.response);
      } else {
        done();
        reject(new Error(typeof m?.error === "string" && m.error.length > 0 ? m.error : "waveform analysis failed"));
      }
    });
    worker.on("error", (e) => {
      done();
      reject(new Error(String(e instanceof Error ? e.message : e)));
    });
    // A late nonzero exit after the message already settled the promise is a
    // no-op (promises settle once); this only catches worker crashes.
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`waveform worker exited with code ${code}`));
      }
    });
  });
  inFlight.set(key, task);
  const release = (): void => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  };
  task.then(release, release);
  return task;
}

/**
 * Mount point for `GET /api/waveform/<handle>`. Returns true when handled.
 * Unknown handles and assets without an audio track get a 404 + JSON note;
 * analysis failures get a 500 + JSON note.
 */
export function routeLiveWaveformRequest(
  projectDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handle: string
): boolean {
  if (!handle) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, note: "missing asset handle" }));
    return true;
  }
  let bins: number;
  let durationMs: number;
  try {
    const { sequence } = loadSequence(projectDir);
    const asset = (sequence as { library?: Array<{ handle?: string; probe?: { has_audio?: boolean; duration_ms?: number } }> }).library?.find(
      (a) => a?.handle === handle
    );
    if (!asset) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, note: `unknown handle '${handle}'` }));
      return true;
    }
    if (!asset.probe?.has_audio) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, note: `asset '${handle}' has no audio track` }));
      return true;
    }
    durationMs = typeof asset.probe.duration_ms === "number" ? asset.probe.duration_ms : 0;
    bins = waveformBinCount(durationMs);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, note: "project state unreadable" }));
    return true;
  }
  computeLiveWaveform(projectDir, handle, bins).then(
    (response) => {
      if (req.destroyed || res.writableEnded) return;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(JSON.stringify(response));
    },
    (e) => {
      if (req.destroyed || res.writableEnded) return;
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: false, note: String((e as Error)?.message ?? e) }));
    }
  );
  return true;
}
