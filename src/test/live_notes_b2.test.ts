// B2: incident log, server registry, cache fill, delivered sheet path.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rmRetrySync } from "./b_helpers.js";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../core/workspace.js";
import { drainLiveInbox, writeLiveNotePacket } from "../live/live_inbox.js";
import { newestIncidentFile, storeIncidentReport, summarizeIncidents } from "../live/live_incidents.js";
import { listLiveServers, othersRunning, registerLiveServer, unregisterLiveServer } from "../live/live_instances.js";
import { fillElementsFromCache } from "../live/live_notes_api.js";
import type { LiveNotePacket } from "../live/live_types.js";

const TEST_ROOT = path.resolve(process.cwd(), "test-workspace");

function makeProject(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  rmRetrySync(dir);
  initWorkspace({ dir, title: name, aspect: "16:9", fps: 30 });
  return dir;
}

function incident(id: string, at = "2026-11-15T10:00:00.000Z"): Record<string, unknown> {
  return {
    id,
    reason: "revision_behind",
    at,
    window_revision: 3,
    server_revision: 5,
    playhead_ms: 1200,
    playing: true,
    recent_events: ["snapshot"],
    console_errors: [],
    action: "reloaded_preview",
  };
}

test("incident report stores, then updates the same file with outcome", () => {
  const dir = makeProject("live-incidents-one");
  const first = storeIncidentReport(dir, incident("win1"));
  assert.equal(first.updated, false);
  assert.ok(fs.existsSync(first.file));
  const second = storeIncidentReport(dir, { ...incident("win1"), outcome: "recovered" });
  assert.equal(second.updated, true);
  assert.equal(second.file, first.file);
  const stored = JSON.parse(fs.readFileSync(first.file, "utf8"));
  assert.equal(stored.outcome, "recovered");
  assert.equal(stored.reason, "revision_behind");
});

test("incident report rejects bad bodies and oversized snapshots", () => {
  const dir = makeProject("live-incidents-bad");
  assert.throws(() => storeIncidentReport(dir, { ...incident("x"), reason: "nope" }), /reason/);
  const big = storeIncidentReport(dir, { ...incident("big"), snapshot_png: "data:" + "x".repeat(3 * 1024 * 1024) });
  const stored = JSON.parse(fs.readFileSync(big.file, "utf8"));
  assert.equal(stored.snapshot_png, undefined);
});

test("incident summary counts one line of state", () => {
  const dir = makeProject("live-incidents-sum");
  // Times relative to now: the summary only counts the last 24 h (fixed dates expired a day later).
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  storeIncidentReport(dir, { ...incident("a", ago(45)), outcome: "recovered" });
  storeIncidentReport(dir, { ...incident("b", ago(15)), outcome: "still_stuck" });
  storeIncidentReport(dir, incident("c", ago(1)));
  const summary = summarizeIncidents(dir, 24 * 3600_000);
  assert.equal(summary.total, 3);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.still_stuck, 1);
  assert.equal(summary.open, 1);
  assert.ok(newestIncidentFile(dir)?.endsWith(".json"));
});

test("server registry lists others and prunes dead pids", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-state-"));
  process.env.CUTHOL_STATE_DIR = home;
  try {
    registerLiveServer({ pid: 999999001, port: 1111, project_dir: path.join(TEST_ROOT, "proj-a"), started_at: new Date().toISOString() });
    registerLiveServer({ pid: process.pid, port: 2222, project_dir: path.join(TEST_ROOT, "proj-b"), started_at: new Date().toISOString() });
    const others = othersRunning(path.join(TEST_ROOT, "proj-b"));
    assert.ok(!others.some((o) => o.project_dir.endsWith("proj-b")));
    assert.ok(listLiveServers().every((r) => r.pid === process.pid));
    unregisterLiveServer(process.pid, path.join(TEST_ROOT, "proj-b"));
    assert.equal(othersRunning(path.join(TEST_ROOT, "proj-b")).length, 0);
  } finally {
    delete process.env.CUTHOL_STATE_DIR;
  }
});

test("fillElementsFromCache leaves notes alone when nothing was measured", () => {
  const dir = makeProject("live-cache-empty");
  const filled = fillElementsFromCache(dir, [
    { n: 1, text: "hi", at_ms: 1000, frame: 30, point: { x: 960, y: 540, nx: 0.5, ny: 0.5 }, elements: [] },
  ]);
  assert.equal(filled, 0);
});

test("drain rewrites the delivered packet sheet path", () => {
  const dir = makeProject("live-drain-sheet");
  const packet: Omit<LiveNotePacket, "schema"> = {
    id: "n_sheet1",
    created_at: new Date().toISOString(),
    revision: 1,
    notes: [{ n: 1, text: "look", at_ms: 500, frame: 15, point: { x: 10, y: 10, nx: 0, ny: 0 }, elements: [] }],
    sheet: ".cuthol/live/inbox/n_sheet1.png",
  };
  writeLiveNotePacket(dir, packet);
  fs.writeFileSync(path.join(dir, ".cuthol", "live", "inbox", "n_sheet1.png"), Buffer.from([137, 80, 78, 71]));
  const drained = drainLiveInbox(dir);
  assert.ok(drained);
  assert.equal(drained.packets[0].sheet, ".cuthol/live/inbox/delivered/n_sheet1.png");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, ".cuthol", "live", "inbox", "delivered", "n_sheet1.json"), "utf8"));
  assert.equal(onDisk.sheet, ".cuthol/live/inbox/delivered/n_sheet1.png");
});
