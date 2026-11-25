/**
 * Silent-edit guards: orphan fx envelopes, empty splits, transcript-less captions.
 * Every case fails on the old build (silent OK / silent no-op / empty revision).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { CutholError } from "../core/diagnostics.js";
import { commitSequenceMutation, initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip, setItemEnvelope, splitSpineClip } from "../sequence/spine.js";
import { addEnvelopePoint } from "../sequence/envelope_points.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { generateSequenceCaptions } from "../speech/captions.js";
import { verifySequence } from "../verify/gates.js";

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-ed-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "ed", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    rmRetrySync(tmp);
  }
}

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeAvMp4(outPath: string, durationSec = 4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", outPath,
  ]);
}

function makeVideoOnlyMp4(outPath: string, durationSec = 4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-an", outPath,
  ]);
}

function setupClip(wsDir: string, durationSec = 4): { clipId: string; handle: string } {
  const media = path.join(wsDir, "media", "a.mp4");
  makeAvMp4(media, durationSec);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
  return { clipId: clip.id, handle: item.handle };
}

const FXDEMO_MANIFEST: Record<string, unknown> = {
  name: "fxdemo",
  version: "1.0.0",
  description: "ed guard test effects",
  fx: {
    pulse: {
      description: "Per-frame brightness lift (envelope-safe)",
      params: { level: { type: "number", default: 0, min: -1, max: 1 } },
      animatable: ["level"],
      video_filter: "eq=brightness={{level}}:eval=frame",
    },
    tint: {
      description: "fixed tint (not animatable)",
      params: { amount: { type: "number", default: 2 } },
      video_filter: "eq=brightness={{amount}}",
    },
  },
};

function revisionOf(wsDir: string): number {
  return loadSequence(wsDir).sequence.meta.revision;
}

test("envelope on a missing fx is rejected at write time, nothing written", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const before = revisionOf(ws);
    assert.throws(
      () => setItemEnvelope({ workspaceDir: ws, targetId: clipId, parameter: "fx.fx_09.level", points: [{ offset_ms: 0, value: 0, easing: 'linear' }, { offset_ms: 1000, value: 1, easing: 'linear' }] }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError);
        assert.match(err.diagnostic.formatted, /CUTHOL-G380/);
        assert.match(err.diagnostic.formatted, /suggestion/i);
        assert.match(err.diagnostic.formatted, /no fx entries/i);
        return true;
      }
    );
    assert.equal(revisionOf(ws), before);
    assert.equal(loadSequence(ws).sequence.spine.clips[0].envelopes.length, 0);
    const ver = verifySequence(loadSequence(ws).sequence);
    assert.equal(ver.error_count, 0);
  });
});

test("envelope with a dotted sub-path on a missing fx is rejected too", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const before = revisionOf(ws);
    assert.throws(
      () => setItemEnvelope({ workspaceDir: ws, targetId: clipId, parameter: "fx.fx_01.center.x", points: [{ offset_ms: 0, value: 0, easing: 'linear' }] }),
      /CUTHOL-G380/
    );
    assert.equal(revisionOf(ws), before);
  });
});

test("orphan envelope rejected when other fx exist; suggestion lists fx ids", () => {
  withWs((ws) => {
    writeExtension(ws);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/pulse", params: { level: 0 } });
    const before = revisionOf(ws);
    assert.throws(
      () => setItemEnvelope({ workspaceDir: ws, targetId: clipId, parameter: "fx.fx_09.level", points: [{ offset_ms: 0, value: 0, easing: 'linear' }] }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError);
        assert.match(err.diagnostic.formatted, /CUTHOL-G380/);
        assert.match(err.diagnostic.formatted, /fx_01/);
        return true;
      }
    );
    assert.equal(revisionOf(ws), before);
  });
});

test("envelope on a non-animatable param is rejected; suggestion lists animatable params", () => {
  withWs((ws) => {
    writeExtension(ws);
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const { clipId } = setupClip(ws);
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/tint" });
    const fxId = loadSequence(ws).sequence.spine.clips[0].fx![0].id;
    assert.throws(
      () => setItemEnvelope({ workspaceDir: ws, targetId: clipId, parameter: `fx.${fxId}.amount`, points: [{ offset_ms: 0, value: 0, easing: 'linear' }] }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError);
        assert.match(err.diagnostic.formatted, /CUTHOL-G381/);
        return true;
      }
    );
    // envelope on the animatable param of another fx kind still works
    addSpineFx({ workspaceDir: ws, clipId, kind: "ext:fxdemo/pulse", params: { level: 0 } });
    const pulseId = loadSequence(ws).sequence.spine.clips[0].fx!.find((f) => f.kind === "ext:fxdemo/pulse")!.id;
    const { envelope } = setItemEnvelope({ workspaceDir: ws, targetId: clipId, parameter: `fx.${pulseId}.level`, points: [{ offset_ms: 0, value: 0, easing: 'linear' }, { offset_ms: 500, value: 1, easing: 'linear' }] });
    assert.equal(envelope.points.length, 2);
  });
});

test("envelope point add on a missing fx is rejected, nothing written", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const before = revisionOf(ws);
    assert.throws(
      () => addEnvelopePoint({ workspaceDir: ws, targetId: clipId, parameter: "fx.fx_09.level", offsetMs: 100, value: 1 }),
      /CUTHOL-G380/
    );
    assert.equal(revisionOf(ws), before);
  });
});

test("verify warns on orphan fx envelopes already in a project", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    // Simulate an older build: write the orphan envelope straight into the sequence.
    commitSequenceMutation(ws, "test.orphan", (seq) => {
      seq.spine.clips[0].envelopes.push({
        parameter: "fx.fx_09.level",
        points: [{ offset_ms: 0, value: 0, easing: 'linear' }],
      });
    });
    const { sequence, paths } = loadSequence(ws);
    assert.equal(sequence.spine.clips[0].id, clipId);
    const ver = verifySequence(sequence, paths);
    const warns = ver.diagnostics.filter((d) => d.code === "CUTHOL-G382");
    assert.equal(warns.length, 1);
    assert.match(warns[0].formatted, /fx_09/);
    assert.match(warns[0].formatted, /Suggestion:/);
    assert.equal(ver.error_count, 0);
  });
});

test("split past the clip end errors with both ranges, nothing written", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const before = revisionOf(ws);
    assert.throws(
      () => splitSpineClip({ workspaceDir: ws, clipId, splitPointsMs: [9000] }),
      (err: unknown) => {
        assert.ok(err instanceof CutholError);
        assert.match(err.diagnostic.formatted, /CUTHOL-G383/);
        assert.match(err.diagnostic.formatted, /0\.\.4000ms/);
        assert.match(err.diagnostic.formatted, /0\.\.4000ms/);
        return true;
      }
    );
    assert.equal(revisionOf(ws), before);
    assert.equal(loadSequence(ws).sequence.spine.clips.length, 1);
  });
});

test("split with mixed inside/outside points errors, nothing written", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const before = revisionOf(ws);
    assert.throws(() => splitSpineClip({ workspaceDir: ws, clipId, splitPointsMs: [1000, 9000] }), /CUTHOL-G383/);
    assert.equal(revisionOf(ws), before);
    assert.equal(loadSequence(ws).sequence.spine.clips.length, 1);
  });
});

test("split strictly inside still works", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const { clips } = splitSpineClip({ workspaceDir: ws, clipId, splitPointsMs: [1000, 2000] });
    assert.equal(clips.length, 3);
  });
});

test("captions with no transcript warns and writes no revision", () => {
  withWs((ws) => {
    const { clipId } = setupClip(ws);
    const before = revisionOf(ws);
    const res = generateSequenceCaptions({ workspaceDir: ws });
    assert.equal(res.cues_created, 0);
    assert.equal(revisionOf(ws), before, "no empty revision");
    const warns = res.verification.diagnostics.filter((d) => d.code === "CUTHOL-G384");
    assert.equal(warns.length, 1);
    assert.match(warns[0].formatted, new RegExp(clipId));
    assert.match(warns[0].formatted, /transcribe --handle/);
  });
});

test("captions never warns for b-roll without audio", () => {
  withWs((ws) => {
    const media = path.join(ws, "media", "silent.mp4");
    makeVideoOnlyMp4(media);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
    assert.equal(item.probe.has_audio, false);
    appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
    const before = revisionOf(ws);
    const res = generateSequenceCaptions({ workspaceDir: ws });
    assert.equal(res.cues_created, 0);
    assert.equal(revisionOf(ws), before);
    assert.equal(res.verification.diagnostics.filter((d) => d.code === "CUTHOL-G384").length, 0);
  });
});

function writeExtension(wsDir: string): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", "fxdemo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(FXDEMO_MANIFEST, null, 2), "utf8");
}

