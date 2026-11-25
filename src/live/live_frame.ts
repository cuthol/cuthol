/**
 * Cuthol Live exact frame (`src/live/live_frame.ts`).
 *
 * The in-window preview is an approximation (no color grade, no clip fx, no
 * LUT). The "Exact frame" button asks the server for the true composite pixel
 * at the playhead through the `monitor frame` path (`captureMonitorFrame`)
 * and overlays it on the stage.
 *
 * Endpoint contract (owned by the live server file; this module only exports
 * the handler so it can be mounted):
 *   GET /api/frame?at=<ms>  -> PNG (exact composite, no HUD/boxes) or
 *                             500 + JSON (CUTHOL-G612) when the render fails.
 *
 * The render goes through the synchronous monitor-frame path (seconds per
 * composite frame), so it runs in a worker thread: the server's event loop
 * stays responsive while the frame renders. Concurrent requests for the same
 * frame share one worker; requests for different frames render in parallel,
 * each to its own output file.
 *
 * The render never touches the sequence, only reads it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DIAGNOSTICS } from "../core/diagnostics.js";

/** In-flight renders keyed by rounded frame time: same-frame requests share one worker. */
const inFlight = new Map<number, Promise<string>>();

function frameKey(atMs: number): number {
  return Math.round(atMs);
}

/** Render the exact composite PNG at `atMs` in a worker thread; returns the temp file path. */
export function renderLiveExactFrame(projectDir: string, atMs: number): Promise<string> {
  const key = frameKey(atMs);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = new Promise<string>((resolve, reject) => {
    const out = path.join(os.tmpdir(), `cuthol-live-frame-${process.pid}-${crypto.randomBytes(4).toString("hex")}.png`);
    let worker: Worker;
    try {
      worker = new Worker(new URL("./live_frame_worker.js", import.meta.url), {
        workerData: { kind: "frame", projectDir: path.resolve(projectDir), atMs, outputPath: out },
      });
    } catch (e) {
      reject(new Error(String(e instanceof Error ? e.message : e)));
      return;
    }
    // The worker stays referenced until it answers (no unref): an unref'd
    // worker lets the process exit mid-render when nothing else holds the
    // loop. It is terminated once the render settles.
    const done = (): void => {
      void worker.terminate();
    };
    worker.on("message", (m: { ok?: boolean; pngPath?: string; error?: string }) => {
      if (m?.ok && typeof m.pngPath === "string" && fs.existsSync(m.pngPath)) {
        done();
        resolve(m.pngPath);
      } else {
        done();
        try {
          fs.unlinkSync(out);
        } catch {}
        reject(new Error(typeof m?.error === "string" && m.error.length > 0 ? m.error : "frame render failed"));
      }
    });
    worker.on("error", (e) => {
      done();
      try {
        fs.unlinkSync(out);
      } catch {}
      reject(new Error(String(e instanceof Error ? e.message : e)));
    });
    // A late nonzero exit after the message already settled the promise is a
    // no-op (promises settle once); this only catches worker crashes.
    worker.on("exit", (code) => {
      if (code !== 0) {
        try {
          fs.unlinkSync(out);
        } catch {}
        reject(new Error(`frame worker exited with code ${code}`));
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
 * Mount point for `GET /api/frame?at=<ms>`. Returns true when handled.
 * Starts the worker render and streams the PNG (or the G612 JSON) when it
 * lands; the temp file is removed afterwards.
 */
export function routeLiveFrameRequest(
  projectDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  atMs: number
): boolean {
  if (!Number.isFinite(atMs) || atMs < 0) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "query param 'at' must be ms >= 0" }));
    return true;
  }
  renderLiveExactFrame(projectDir, atMs).then(
    (file) => {
      if (req.destroyed || res.writableEnded) {
        try {
          fs.unlinkSync(file);
        } catch {}
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": fs.statSync(file).size, "Cache-Control": "no-cache" });
      const stream = fs.createReadStream(file);
      stream.on("close", () => {
        try {
          fs.unlinkSync(file);
        } catch {}
      });
      stream.on("error", () => {
        try {
          fs.unlinkSync(file);
        } catch {}
        if (!res.writableEnded) {
          const diag = DIAGNOSTICS.LIVE_EXACT_FRAME_FAILED(atMs, "failed to stream the rendered frame");
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, diagnostic: diag }));
        }
      });
      stream.pipe(res);
    },
    (e) => {
      if (req.destroyed || res.writableEnded) return;
      const diag = DIAGNOSTICS.LIVE_EXACT_FRAME_FAILED(atMs, String((e as Error)?.message ?? e));
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, diagnostic: diag }));
    }
  );
  return true;
}
