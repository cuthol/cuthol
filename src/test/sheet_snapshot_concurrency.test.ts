/**
 * Concurrent batched HyperFrames snapshots for `monitor sheet`.
 *
 * 1. `runSnapshotSpawnsConcurrently` overlaps snapshot child processes but
 *    never runs more than `concurrency` at once (fake snapshot commands with
 *    a shared overlap marker file).
 * 2. A failing snapshot spawn keeps its failure signal (so the shared
 *    single-frame fallback yields the same diagnostic as the sequential path).
 * 3. Concurrent multi-composition batches produce byte-identical PNGs to the
 *    sequential path on a cold cache, and a composition edit changes the
 *    concurrent output (no caching hides a real change).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderHyperFramesBatchFramesPng } from "../compositor/hyperframes_bridge.js";
import {
  renderHyperFramesBatchSnapshotsConcurrently,
  runSnapshotSpawnsConcurrently,
  type BatchSnapshotSpawnRequest,
} from "../compositor/hf_frames.js";
import { loadSequence } from "../core/workspace.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");
const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { ok: boolean; result: any; raw: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = `${proc.stdout ?? ""}`;
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    // keep raw for assertion messages
  }
  return {
    ok: Boolean(env?.ok),
    result: env?.result ?? env,
    raw: raw.slice(0, 3000) + (proc.stderr ?? "").slice(0, 1000),
  };
}

function makeSnapshotRequest(
  markerPath: string,
  id: string,
  waitMs: number,
  exitCode: number,
  tmpSnapDir: string
): BatchSnapshotSpawnRequest {
  const script = [
    "const fs = require('node:fs');",
    "const m = process.argv[1];",
    "const id = process.argv[2];",
    `fs.appendFileSync(m, 's ' + id + ' ' + Date.now() + '\\n');`,
    `const until = Date.now() + ${waitMs};`,
    "while (Date.now() < until) {}",
    `fs.appendFileSync(m, 'e ' + id + ' ' + Date.now() + '\\n');`,
    `process.exit(${exitCode});`,
  ].join("");
  return {
    args: ["-e", script, markerPath, id],
    cwd: path.dirname(markerPath),
    tmpSnapDir,
  };
}

function maxOverlap(markerPath: string): { max: number; events: number } {
  const lines = fs.readFileSync(markerPath, "utf8").trim().split(/\r?\n/);
  const events: Array<{ at: number; delta: number }> = [];
  for (const line of lines) {
    const m = /^([se]) \S+ (\d+)$/.exec(line.trim());
    assert.ok(m, `Unparseable marker line: ${line}`);
    events.push({ at: Number(m[2]), delta: m[1] === "s" ? 1 : -1 });
  }
  events.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));
  let running = 0;
  let max = 0;
  for (const event of events) {
    running += event.delta;
    if (running > max) max = running;
  }
  return { max, events: events.length };
}

test("concurrent snapshot spawns overlap but never exceed the concurrency bound", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-snap-conc-"));
  try {
    const markerPath = path.join(tmpRoot, "overlap.log");
    fs.writeFileSync(markerPath, "", "utf8");
    const requests: BatchSnapshotSpawnRequest[] = ["a", "b", "c", "d"].map((id) => {
      const dir = path.join(tmpRoot, `snap-${id}`);
      fs.mkdirSync(dir, { recursive: true });
      return makeSnapshotRequest(markerPath, id, 600, 0, dir);
    });
    const results = runSnapshotSpawnsConcurrently(requests, 2);
    assert.equal(results.length, 4);
    for (const result of results) {
      assert.equal(result.status, 0);
    }
    const { max, events } = maxOverlap(markerPath);
    assert.equal(events, 8);
    assert.ok(max >= 2, `Expected overlapping snapshot runs, observed max overlap ${max}`);
    assert.ok(max <= 2, `Concurrency bound exceeded: max overlap ${max} with bound 2`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("a failing snapshot spawn keeps its failure signal for the shared fallback", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-snap-fail-"));
  try {
    const markerPath = path.join(tmpRoot, "overlap.log");
    fs.writeFileSync(markerPath, "", "utf8");
    const okDir = path.join(tmpRoot, "snap-ok");
    const failDir = path.join(tmpRoot, "snap-fail");
    fs.mkdirSync(okDir, { recursive: true });
    fs.mkdirSync(failDir, { recursive: true });
    const results = runSnapshotSpawnsConcurrently(
      [
        makeSnapshotRequest(markerPath, "bad", 100, 3, failDir),
        makeSnapshotRequest(markerPath, "good", 100, 0, okDir),
      ],
      2
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 3);
    assert.equal(results[1].status, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("concurrent multi-composition batches match sequential snapshots and see edits", () => {
  const wsDir = path.join(TEST_ROOT, "sheet_snapshot_concurrency");
  fs.rmSync(wsDir, { recursive: true, force: true });
  try {
    assert.ok(cli(["workspace", "init", wsDir, "--aspect", "1:1", "--fps", "30"]).ok);
    assert.ok(cli(["workspace", "backdrop", "--color", "#FFD23F", "--dir", wsDir]).ok);
    const compDirs: string[] = [];
    for (const name of ["compA", "compB"]) {
      const compDir = path.join(wsDir, "compositions", name);
      assert.ok(
        cli(["composition", "scaffold", "--comp-dir", compDir, "--duration", "3s", "--dir", wsDir]).ok
      );
      compDirs.push(compDir);
    }
    assert.ok(
      cli([
        "lane", "add-composition", "--lane", "ln_motion",
        "--comp-dir", compDirs[0], "--at", "0ms", "--duration", "3000ms", "--dir", wsDir,
      ]).ok
    );
    assert.ok(
      cli([
        "lane", "add-composition", "--lane", "ln_motion",
        "--comp-dir", compDirs[1], "--at", "0ms", "--duration", "3000ms", "--dir", wsDir,
      ]).ok
    );

    const { paths: wsPaths, sequence: wsSeq } = loadSequence(wsDir);
    const blobsDir = path.join(wsDir, ".cuthol", "blobs");
    const fps = Math.max(1, wsSeq.stage.fps);
    const size = 480 / Math.min(wsSeq.stage.width, wsSeq.stage.height);
    const renderWidth = Math.max(16, Math.round((wsSeq.stage.width * size) / 2) * 2);
    const renderHeight = Math.max(16, Math.round((wsSeq.stage.height * size) / 2) * 2);
    const batchOptions = compDirs.map((compositionDir) => ({
      compositionDir,
      entryHtml: "index.html",
      blobsDir,
      width: renderWidth,
      height: renderHeight,
      fps,
      durationMs: 3000,
      localSecs: [0.5],
      props: {},
      transparent: true as const,
      mode: "overlay_alpha" as const,
    }));

    const sequentialOut = renderHyperFramesBatchFramesPng(batchOptions[0]);
    assert.equal(sequentialOut.length, 1);
    const sequentialBytes = fs.readFileSync(sequentialOut[0].pngPath);

    for (const entry of fs.readdirSync(blobsDir)) {
      if (entry.startsWith("hf_frame_") && entry.endsWith(".png")) {
        fs.rmSync(path.join(blobsDir, entry), { force: true });
      }
    }

    const concurrentOut = renderHyperFramesBatchSnapshotsConcurrently(batchOptions, 2);
    assert.equal(concurrentOut.length, 2);
    assert.equal(concurrentOut[0].length, 1);
    assert.equal(concurrentOut[1].length, 1);
    const concurrentBytesA = fs.readFileSync(concurrentOut[0][0].pngPath);
    assert.ok(
      concurrentBytesA.equals(sequentialBytes),
      "Expected concurrent snapshot bytes to equal sequential snapshot bytes"
    );

    const indexHtml = path.join(compDirs[0], "index.html");
    const beforeHtml = fs.readFileSync(indexHtml, "utf8");
    const visibleDiv = '<div style="position:absolute;left:10px;top:10px;width:200px;height:200px;background:#D82346;"></div>';
    const editedHtml = beforeHtml.includes("</body>")
      ? beforeHtml.replace("</body>", `${visibleDiv}</body>`)
      : `${beforeHtml}\n${visibleDiv}\n`;
    assert.ok(editedHtml !== beforeHtml, "Expected the counter-test edit to change index.html");
    fs.writeFileSync(indexHtml, editedHtml, "utf8");
    const afterEditOut = renderHyperFramesBatchSnapshotsConcurrently([batchOptions[0]], 1);
    assert.equal(afterEditOut.length, 1);
    assert.notEqual(
      afterEditOut[0][0].pngPath,
      sequentialOut[0].pngPath,
      "Expected edited composition to hash to a different snapshot file (no stale cache)"
    );
    const afterEditBytes = fs.readFileSync(afterEditOut[0][0].pngPath);
    assert.ok(
      !afterEditBytes.equals(sequentialBytes),
      "Expected edited composition to produce different snapshot bytes (no stale cache)"
    );
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});