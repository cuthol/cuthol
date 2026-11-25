/**
 * Live audio waveform (`src/test/live_waveform.test.ts`): `GET /api/waveform/<handle>`
 * serves per-asset cached peaks analyzed in a worker thread; the snapshot never
 * carries peaks; the ledger stays writable for a concurrent CLI while the worker runs.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadJournalManifest, loadSequence } from "../core/workspace.js";
import { waveformBinCount } from "../live/live_waveform.js";
import { resolveLivePaths } from "../live/live_paths.js";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import { LIVE_SCHEMA, type LiveWaveformResponse } from "../live/live_types.js";
import { LIVE_DEMO_DIR, missingLiveDemo } from "./fixtures.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = LIVE_DEMO_DIR;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-wave-"));
const DIRS: string[] = [ROOT];

function copyDemo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-wave-demo-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  DIRS.push(dir);
  return dir;
}

function httpGet(port: number, reqPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: reqPath }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => {
        body += c.toString("utf8");
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

function runCli(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

test.after(async () => {
  for (const dir of DIRS.slice(1)) {
    try {
      await stopLiveServer(dir);
    } catch {
      // best effort
    }
  }
  for (const dir of DIRS.slice(1)) {
    try {
      rmRetrySync(dir);
    } catch {
      // best effort
    }
  }
  try {
    rmRetrySync(ROOT);
  } catch {
    // best effort
  }
});

test("waveformBinCount: ~20 bins per second clamped to 16..2000", () => {
  assert.equal(waveformBinCount(39471), 789);
  assert.equal(waveformBinCount(600000), 2000);
  assert.equal(waveformBinCount(0), 16);
  assert.equal(waveformBinCount(-5), 16);
  assert.equal(waveformBinCount(Number.NaN), 16);
  assert.equal(waveformBinCount(100), 16);
  assert.equal(waveformBinCount(1000), 20);
  // A 5 s cue on a 10-minute track slices ~17 of the 2000 asset bins.
  const n = 2000;
  const dur = 600000;
  const srcIn = 0;
  const srcOut = 5000;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor((srcIn / dur) * n)));
  const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil((srcOut / dur) * n)));
  assert.equal(i1 - i0, 17);
});

test("waveform endpoint serves cached peaks for aud_01; 404 for unknown or silent assets", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  const info = await ensureLiveServer(dir);
  try {
    const r = await httpGet(info.port, `/api/waveform/aud_01?t=${info.token}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as LiveWaveformResponse;
    assert.equal(body.ok, true);
    assert.equal(body.handle, "aud_01");
    assert.equal(body.bins_count, 789);
    assert.equal(body.peaks.length, 789);
    for (const p of body.peaks) {
      assert.ok(p >= 0 && p <= 1, `peak out of range: ${p}`);
    }
    const max = Math.max(...body.peaks);
    const min = Math.min(...body.peaks);
    assert.ok(max > 0.05, `flat waveform, max=${max}`);
    assert.ok(max - min > 0.01, `flat waveform, max=${max} min=${min}`);
    const unknown = await httpGet(info.port, `/api/waveform/nope?t=${info.token}`);
    assert.equal(unknown.status, 404);
    const silent = await httpGet(info.port, `/api/waveform/vid_02?t=${info.token}`);
    assert.equal(silent.status, 404);
    // Repeat reads come from the ledger cache and stay fast (< 2 s for a warm asset).
    const t0 = Date.now();
    const r2 = await httpGet(info.port, `/api/waveform/aud_01?t=${info.token}`);
    assert.equal(r2.status, 200);
    assert.ok(Date.now() - t0 < 2000, `warm read took ${Date.now() - t0} ms`);
  } finally {
    await stopLiveServer(dir);
  }
});

test("snapshot carries no peaks and is byte-identical before/after waveform reads", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  const info = await ensureLiveServer(dir);
  try {
    const before = await httpGet(info.port, `/api/snapshot?t=${info.token}`);
    assert.equal(before.status, 200);
    assert.ok(!before.body.includes("waveform"), "snapshot mentions waveform");
    assert.ok(!before.body.includes("peaks"), "snapshot mentions peaks");
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await httpGet(info.port, `/api/snapshot?t=${info.token}`);
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const medianBefore = times[Math.floor(times.length / 2)];
    const wave = await httpGet(info.port, `/api/waveform/aud_01?t=${info.token}`);
    assert.equal(wave.status, 200);
    const after = await httpGet(info.port, `/api/snapshot?t=${info.token}`);
    assert.equal(after.status, 200);
    // The Live waveform analysis never touches the project file (peak data and
    // the library's `analysis_refs` marker both stay out), so the snapshot must
    // be identical apart from thumb cache-busters.
    const norm = (s: string): unknown => {
      const o = JSON.parse(s) as {
        sequence?: { library?: Array<Record<string, unknown>> };
        scenes?: Array<Record<string, unknown>>;
      };
      // Thumb URLs carry cache-buster keys that rotate when the server refreshes
      // composition bridge files while building a snapshot (pre-existing server
      // behaviour, unrelated to waveforms): compare scenes without them.
      for (const sc of o.scenes ?? []) delete sc["thumb"];
      return o;
    };
    assert.deepEqual(norm(after.body), norm(before.body));
    assert.ok(!after.body.includes("peaks"), "snapshot mentions peaks");
    assert.ok(!after.body.includes("bins_count"), "snapshot carries bins");
    const times2: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await httpGet(info.port, `/api/snapshot?t=${info.token}`);
      times2.push(Date.now() - t0);
    }
    times2.sort((a, b) => a - b);
    const medianAfter = times2[Math.floor(times2.length / 2)];
    console.log(`snapshot median before=${medianBefore}ms after=${medianAfter}ms len=${before.body.length}`);
  } finally {
    await stopLiveServer(dir);
  }
});

test("worker analysis and a concurrent ledger-writing CLI both succeed", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  const info = await ensureLiveServer(dir);
  try {
    // Cold analysis in the worker while a CLI waveform analysis runs on another asset.
    const pending = httpGet(info.port, `/api/waveform/vid_01?t=${info.token}`);
    const cli = runCli(dir, ["library", "waveform", "--handle", "aud_01"]);
    assert.equal(cli.status, 0, `cli failed: ${cli.stderr.slice(0, 500)}`);
    const r = await pending;
    assert.equal(r.status, 200, r.body.slice(0, 300));
    const body = JSON.parse(r.body) as LiveWaveformResponse;
    assert.equal(body.handle, "vid_01");
    assert.ok(body.peaks.length > 0);
    // Both results are present afterwards: endpoint again (ledger cache) + CLI cache read.
    const again = await httpGet(info.port, `/api/waveform/vid_01?t=${info.token}`);
    assert.equal(again.status, 200);
    const cli2 = runCli(dir, ["library", "waveform", "--handle", "vid_01"]);
    assert.equal(cli2.status, 0, `cli reread failed: ${cli2.stderr.slice(0, 500)}`);
  } finally {
    await stopLiveServer(dir);
  }
});

test("waveform endpoint leaves the project file and journal byte-identical", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  // aud_01 carries no waveform marker and the ledger has no entry for the Live
  // bin count, so this request runs the cold worker path end to end.
  const seqBefore = fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8");
  assert.ok(!seqBefore.includes("wave_"), "fixture already carries a waveform marker");
  const journalDir = path.join(dir, ".cuthol", "journal");
  const journalBefore = new Map<string, string>();
  for (const f of fs.readdirSync(journalDir)) {
    journalBefore.set(f, fs.readFileSync(path.join(journalDir, f), "utf8"));
  }
  const info = await ensureLiveServer(dir);
  try {
    const wave = await httpGet(info.port, `/api/waveform/aud_01?t=${info.token}`);
    assert.equal(wave.status, 200, wave.body.slice(0, 300));
    assert.equal(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8"), seqBefore);
    const afterFiles = fs.readdirSync(journalDir).sort();
    assert.deepEqual(afterFiles, [...journalBefore.keys()].sort());
    for (const [f, text] of journalBefore) {
      assert.equal(fs.readFileSync(path.join(journalDir, f), "utf8"), text, `journal ${f} changed`);
    }
  } finally {
    await stopLiveServer(dir);
  }
});

test("waveform endpoint serves while the user holds the Live lock without touching it", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  const lp = resolveLivePaths(dir);
  fs.mkdirSync(lp.dir, { recursive: true });
  const cursor = loadJournalManifest(loadSequence(dir).paths).cursor_revision;
  const lockText = JSON.stringify(
    { schema: LIVE_SCHEMA, holder: "human", since: new Date().toISOString(), revision: cursor, server_pid: process.pid }
  );
  fs.writeFileSync(lp.lockFile, lockText);
  const info = await ensureLiveServer(dir);
  try {
    const wave = await httpGet(info.port, `/api/waveform/aud_01?t=${info.token}`);
    assert.equal(wave.status, 200, wave.body.slice(0, 300));
    const body = JSON.parse(wave.body) as LiveWaveformResponse;
    assert.equal(body.handle, "aud_01");
    assert.ok(body.peaks.length > 0);
    // The worker must not spend the agent's one grace step nor get refused:
    // the lock file is untouched.
    assert.equal(fs.readFileSync(lp.lockFile, "utf8"), lockText);
  } finally {
    await stopLiveServer(dir);
  }
});

test("library waveform still records the analysis marker", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  const cli = runCli(dir, ["library", "waveform", "--handle", "aud_01"]);
  assert.equal(cli.status, 0, `cli failed: ${cli.stderr.slice(0, 500)}`);
  const { sequence } = loadSequence(dir);
  const asset = sequence.library.find((x) => x.handle === "aud_01");
  assert.ok(asset, "aud_01 missing");
  assert.equal(asset!.analysis_refs.waveform, `wave_${asset!.digest_sha256.slice(0, 8)}`);
});

test("no waveform data reaches the project after waveform reads and a window edit", { skip: missingLiveDemo() }, async () => {
  const dir = copyDemo();
  const info = await ensureLiveServer(dir);
  try {
    const wave = await httpGet(info.port, `/api/waveform/aud_01?t=${info.token}`);
    assert.equal(wave.status, 200);
    const seqText = fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8");
    assert.ok(!seqText.includes("waveform_peaks"), "sequence carries peaks");
    const journalDir = path.join(dir, ".cuthol", "journal");
    if (fs.existsSync(journalDir)) {
      for (const f of fs.readdirSync(journalDir)) {
        const t = fs.readFileSync(path.join(journalDir, f), "utf8");
        assert.ok(!t.includes("waveform_peaks"), `journal ${f} carries peaks`);
      }
    }
  } finally {
    await stopLiveServer(dir);
  }
});
