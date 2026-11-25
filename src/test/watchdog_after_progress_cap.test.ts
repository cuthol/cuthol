/**
 * After-progress stall cap: once an ffmpeg step has produced frames, no
 * progress for 90 s stops it as stalled (CUTHOL-SYS10 naming the last frame).
 * The startup wait and the CUTHOL_STALL_TIMEOUT_SEC override keep their meaning
 * (an explicit shorter value still wins); the default 300 s only governs the
 * wait before the first frame.
 *
 * A pipe feeds 50 frames then goes silent mid-stream: the new build kills
 * ffmpeg ~90 s after frame 50. The old build waits the full 300 s default, so
 * this test (150 s timeout) fails there for the behaviour reason.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSubprocessFailureDiagnostic } from "../core/diagnostics.js";
import { spawnWatchedSync } from "../core/subprocess.js";

test("ffmpeg silent after frame 50 is killed ~90s later, not after 300s", { timeout: 150_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-after-progress-cap-"));
  const pipeName = `\\\\.\\pipe\\cuthol_afterprog_${process.pid}_${Date.now()}`;
  const pipeReadyFile = path.join(dir, "pipe.ready");
  const server = spawn(
    process.execPath,
    [
      "-e",
      `
      const net = require("node:net");
      const fs = require("node:fs");
      const srv = net.createServer((sock) => {
        sock.on("error", () => {});
        const frame = Buffer.alloc(64 * 64 * 3, 128);
        for (let i = 0; i < 50; i++) sock.write(frame);
      });
      srv.listen(${JSON.stringify(pipeName)}, () => {
        fs.writeFileSync(${JSON.stringify(pipeReadyFile)}, "1", "utf8");
      });
      setInterval(() => {}, 10000);
      `,
    ],
    { stdio: "ignore", windowsHide: true }
  );
  try {
    const waitStart = Date.now();
    while (!fs.existsSync(pipeReadyFile) && Date.now() - waitStart < 3000) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(fs.existsSync(pipeReadyFile), "pipe server did not start");

    const outMp4 = path.join(dir, "stalled.mp4");
    const t0 = Date.now();
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        "64x64",
        "-framerate",
        "10",
        "-i",
        pipeName,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        outMp4,
      ],
      { cwd: dir, encoding: "utf8", step: "ffmpeg after-progress cap", cleanupPathsOnStall: [outMp4] }
    );
    const elapsedMs = Date.now() - t0;
    assert.equal(proc.stalled, true, "ffmpeg silent after frame 50 must be terminated by the watchdog");
    assert.ok(
      elapsedMs >= 85_000 && elapsedMs <= 120_000,
      `expected stall kill ~90s after last progress, got ${elapsedMs}ms`
    );
    const diag = createSubprocessFailureDiagnostic({
      tool: "ffmpeg after-progress cap",
      executable: "ffmpeg",
      args: ["-i", pipeName, outMp4],
      proc,
    });
    assert.equal(diag.code, "CUTHOL-SYS10");
    const frameMatch = /frame=(\d+)/.exec(diag.what ?? "");
    assert.ok(frameMatch, `expected a frame count in SYS10 text, got: ${diag.what}`);
    assert.ok(Number(frameMatch[1]) >= 40, `expected progress past frame 40, got ${frameMatch[1]}`);
    assert.equal(fs.existsSync(outMp4), false, "stalled output must be cleaned up");
  } finally {
    try {
      server.kill("SIGKILL");
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
