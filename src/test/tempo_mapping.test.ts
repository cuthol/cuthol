/** Sequence tempo mapping and CLI contract: single formula, plan output duration, validation. */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atempoChain, outToSeqMs, outputDurationMs, outputFrameCount, seqToOutMs, tempoOf } from "../sequence/tempo.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { exportTimeline } from "../export/timeline.js";

test("tempo mapping: sequence clock to output clock and back", () => {
  assert.equal(tempoOf({}), 1);
  assert.equal(tempoOf({ stage: {} }), 1);
  assert.equal(tempoOf({ stage: { tempo: 1.1 } }), 1.1);
  assert.ok(Math.abs(seqToOutMs(1100, 1.1) - 1000) < 1e-9);
  assert.equal(outToSeqMs(1000, 1.1), 1100);
  assert.equal(outputDurationMs(11000, 1.1), 10000);
  assert.equal(outputFrameCount(10000, 30), 300);
  assert.equal(outputDurationMs(11000, 1), 11000);
});

test("tempo atempo chain stays within 0.5..2.0 per stage and inverts the rate", () => {
  for (const rate of [0.5, 0.8, 1.1, 2.0, 4.0]) {
    const chain = atempoChain(rate);
    for (const m of chain.matchAll(/atempo=([0-9.]+)/g)) {
      const v = Number(m[1]);
      assert.ok(v >= 0.5 - 1e-9 && v <= 2.0 + 1e-9, `${chain}`);
    }
    const product = [...chain.matchAll(/atempo=([0-9.]+)/g)].reduce((a, m) => a * Number(m[1]), 1);
    assert.ok(Math.abs(product - rate) / rate < 1e-6, `${chain} product ${product} != ${rate}`);
  }
});

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { status: number; out: string; err: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: proc.status ?? 1, out: `${proc.stdout ?? ""}`, err: `${proc.stderr ?? ""}` };
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-test-"));
  const r = cli(["workspace", "init", dir, "--aspect", "16:9", "--fps", "30", "--dir", dir]);
  assert.equal(r.status, 0, r.out + r.err);
  return dir;
}

function readTempo(dir: string): number | undefined {
  const seq = JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8"));
  return seq.stage.tempo;
}

test("workspace tempo set, clear and limits", () => {
  const dir = makeWorkspace();
  try {
    let r = cli(["workspace", "tempo", "--rate", "1.1", "--dir", dir]);
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(readTempo(dir), 1.1);
    const env = JSON.parse(r.out);
    assert.equal(env.tempo, 1.1);
    assert.ok(Math.abs(env.output_duration_ms - env.sequence_duration_ms / 1.1) < 1e-9 || env.sequence_duration_ms === 0);

    r = cli(["workspace", "tempo", "--rate", "1", "--dir", dir]);
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(readTempo(dir), undefined);

    for (const bad of ["0.4", "2.5", "abc"]) {
      const b = cli(["workspace", "tempo", "--rate", bad, "--dir", dir]);
      assert.notEqual(b.status, 0, `rate ${bad} should fail`);
      assert.match(b.out + b.err, /CUTHOL-G160/);
    }
    const empty = cli(["workspace", "tempo", "--dir", dir]);
    assert.notEqual(empty.status, 0, "missing --rate should fail");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G161 retired: tempo rides into all four timeline exports as clip rate", () => {
  assert.ok(!("TEMPO_FORMAT_UNSUPPORTED" in DIAGNOSTICS), "G161 must stay removed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-export-"));
  try {
    const seq: any = {
      schema_version: "1.0.0",
      meta: { project_id: "tempo-export", title: "Tempo Export", revision: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      stage: { width: 320, height: 180, aspect: "16:9", fps: 30, timebase: "ms", tempo: 2, backdrop: { kind: "solid", color: "#101010" } },
      library: [{ handle: "vid_01", uri: "media/talk.mp4" }],
      spine: {
        magnetic: true,
        clips: [
          {
            id: "sp_01",
            asset_handle: "vid_01",
            source_in_ms: 0,
            source_out_ms: 4000,
            timeline_in_ms: 0,
            duration_ms: 4000,
            playback: { rate: 1, preserve_pitch: true, speed_ramp: null },
            placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "cover", crop: null, mirror_x: false, mirror_y: false },
            audio_chain: { gain_db: 0, muted: false, fade_in_ms: 0, fade_out_ms: 0, denoise: { enabled: false }, voice_clarity: { enabled: false }, loudness_target_lufs: null },
            treatments: {},
            transition_out: null,
            envelopes: [],
          },
        ],
      },
      lanes: [],
      markers: [],
    };
    const paths: any = { rootDir: dir, blobsDir: path.join(dir, ".cuthol", "blobs") };
    for (const format of ["fcpxml", "xmeml", "edl", "otio"] as const) {
      const res = exportTimeline(seq, paths, format);
      assert.ok(res.content.length > 50, `${format} content`);
      if (format === "otio") {
        const doc: any = JSON.parse(res.content);
        const warps = doc.tracks.children[0].children[0].effects.filter(
          (e: any) => e.OTIO_SCHEMA === "LinearTimeWarp.1"
        );
        assert.deepEqual(warps.map((e: any) => e.time_scalar), [2]);
      }
      if (format === "edl") assert.match(res.content, /M2 {3}AX {7}060\.0/);
      if (format === "fcpxml") assert.match(res.content, /<timeMap>/);
      if (format === "xmeml") assert.match(res.content, /<speed><value>200\.00<\/value><\/speed>/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
