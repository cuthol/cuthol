import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import {
  buildItemFxStage,
  emitFxStageParts,
  fxStageHasTemporalFilter,
  fxStageWouldKeepAlpha,
  itemCarriesAlphaAtFx,
} from "../compositor/compile_fx_stage.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addSpineFx } from "../sequence/spine_fx.js";

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxalpha-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "fxalpha", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function makeOpaqueMp4(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function makeRgbaPng(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=0xFF000080:size=320x240:rate=30:duration=1,format=rgba",
    "-frames:v", "1",
    outPath,
  ]);
}

function fakeCtx(): VideoGraphCompileContext {
  return { vStepCounter: 0 } as unknown as VideoGraphCompileContext;
}

test("alpha rule: rgb and alpha formats carry alpha, plain yuv does not", () => {
  const rgbSpec = { isRgb: true };
  const yuvSpec = { isRgb: false };
  const noProbe = { probe: {} };
  assert.equal(itemCarriesAlphaAtFx("rgba", yuvSpec, noProbe), true);
  assert.equal(itemCarriesAlphaAtFx("yuva420p", yuvSpec, noProbe), true);
  assert.equal(itemCarriesAlphaAtFx("yuv420p", yuvSpec, noProbe), false);
  assert.equal(itemCarriesAlphaAtFx("yuv420p", rgbSpec, noProbe), true);
  assert.equal(itemCarriesAlphaAtFx(null, rgbSpec, noProbe), true);
  assert.equal(itemCarriesAlphaAtFx(null, yuvSpec, { probe: { pix_fmt: "yuva420p" } }), true);
  assert.equal(itemCarriesAlphaAtFx(null, yuvSpec, { probe: { pix_fmt: "yuv420p" } }), false);
});

test("keep entries become an alpha_keep part only with alpha, consecutive keeps share it", () => {
  const owner = {
    id: "clip1",
    envelopes: [],
    fx: [
      { id: "fx1", kind: "ffmpeg", params: { filter: "vignette" } },
      { id: "fx2", kind: "ffmpeg", params: { filter: "eq=brightness=0" } },
    ],
  };
  const noAlpha = buildItemFxStage(fakeCtx(), {
    owner,
    receivedPixFmt: "yuv420p",
    itemHasAlpha: false,
  });
  assert.equal(noAlpha.length, 1);
  assert.equal(noAlpha[0].type, "chain");
  assert.ok(!noAlpha[0].filters.join(",").includes("alphaextract"));

  const withAlpha = buildItemFxStage(fakeCtx(), {
    owner,
    receivedPixFmt: "rgba",
    itemHasAlpha: true,
  });
  const keep = withAlpha.filter((p) => p.type === "alpha_keep");
  assert.equal(keep.length, 1, JSON.stringify(withAlpha));
  assert.ok(keep[0].type === "alpha_keep" && keep[0].filters.join(",").includes("vignette"));
  assert.ok(keep[0].type === "alpha_keep" && keep[0].filters.join(",").includes("eq=brightness=0"));
});

test("emitFxStageParts wraps alpha_keep with a labelled split and ends on the exit converter", () => {
  const ctx = fakeCtx();
  const parts = buildItemFxStage(ctx, {
    owner: {
      id: "clip1",
      envelopes: [],
      fx: [{ id: "fx1", kind: "ffmpeg", params: { filter: "vignette" } }],
    },
    receivedPixFmt: "rgba",
    itemHasAlpha: true,
  });
  const vFilters: string[] = ["scale=320:240"];
  const { exitFilterIdx } = emitFxStageParts(ctx, vFilters, parts);
  const joined = vFilters.join(",");
  assert.ok(joined.includes("alphaextract"), joined);
  assert.ok(joined.includes("alphamerge"), joined);
  assert.ok(vFilters[exitFilterIdx].includes("format=rgba"), vFilters[exitFilterIdx]);
  assert.equal(exitFilterIdx, vFilters.length - 1);
});

test("stage would keep alpha for builtin fx, not for an empty chain", () => {
  withWs((ws) => {
    const { sequence, paths } = loadSequence(ws);
    assert.equal(
      fxStageWouldKeepAlpha(sequence, paths.rootDir, { id: "c", envelopes: [], fx: [] }),
      false
    );
    assert.equal(
      fxStageWouldKeepAlpha(sequence, paths.rootDir, {
        id: "c",
        envelopes: [],
        fx: [{ id: "fx1", kind: "ffmpeg", params: { filter: "vignette" } }],
      }),
      true
    );
  });
});

test("temporal detector matches video blenders only", () => {
  assert.equal(fxStageHasTemporalFilter(["scale=1", "tmix=frames=4"]), true);
  assert.equal(fxStageHasTemporalFilter(["lagfun=decay=0.9"]), true);
  assert.equal(fxStageHasTemporalFilter(["tblend=all_mode=average"]), true);
  assert.equal(fxStageHasTemporalFilter(["gblur=sigma=3", "vignette"]), false);
});

test("composition temporal diagnostic keeps the required shape", () => {
  const d = DIAGNOSTICS.COMPOSITION_TEMPORAL_FX_SINGLEFRAME("cue1", "tmix=frames=4");
  assert.equal(d.code, "CUTHOL-G267");
  assert.ok(d.formatted.startsWith("[CUTHOL-G267]"), d.formatted);
  assert.ok(d.formatted.includes("Suggestion:"), d.formatted);
});

test("spine clip from an alpha png wraps keep fx, opaque footage stays a plain chain", () => {
  withWs((wsDir) => {
    const png = path.join(wsDir, "media", "card.png");
    makeRgbaPng(png);
    const [pngItem] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [png] });
    void pngItem;
    const mp4 = path.join(wsDir, "media", "bg.mp4");
    makeOpaqueMp4(mp4);
    const [mp4Item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [mp4] });
    const pngClip = appendSpineClip({ workspaceDir: wsDir, assetHandle: pngItem.handle });
    const mp4Clip = appendSpineClip({ workspaceDir: wsDir, assetHandle: mp4Item.handle });
    addSpineFx({ workspaceDir: wsDir, clipId: pngClip.clip.id, filter: "vignette" });
    addSpineFx({ workspaceDir: wsDir, clipId: mp4Clip.clip.id, filter: "eq=brightness=0" });
    const { sequence, paths } = loadSequence(wsDir);
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
    const segs = plan.filterComplex.split(";");
    const pngSeg = segs.find((s) => s.includes("vignette"));
    assert.ok(pngSeg, "png chain with vignette missing");
    assert.ok(pngSeg.includes("alphaextract"), pngSeg);
    assert.ok(pngSeg.includes("alphamerge"), pngSeg);
    const mp4Seg = segs.find((s) => s.includes("eq=brightness=0"));
    assert.ok(mp4Seg, "footage chain with eq missing");
    assert.ok(!mp4Seg.includes("alphaextract"), mp4Seg);
  });
});

test("still bake gate: keep fx unbakes a still, plain chain keeps it baked", () => {
  withWs((wsDir) => {
    const png = path.join(wsDir, "media", "still.png");
    makeRgbaPng(png);
    const [pngItem] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [png] });
    const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: pngItem.handle });
    const { sequence, paths } = loadSequence(wsDir);
    // No fx: nothing to keep, the still stays bakeable.
    assert.equal(
      fxStageWouldKeepAlpha(sequence, paths.rootDir, { id: clip.id, envelopes: [], fx: [] }),
      false
    );
    // Builtin keep fx on the still: the gate fires, so no `stillSpec` is recorded.
    addSpineFx({ workspaceDir: wsDir, clipId: clip.id, filter: "vignette" });
    const { sequence: seq2, paths: paths2 } = loadSequence(wsDir);
    const withFx = seq2.spine.clips.find((c) => c.id === clip.id);
    assert.ok(withFx);
    assert.equal(fxStageWouldKeepAlpha(seq2, paths2.rootDir, withFx), true);
    // And the compiled chain really carries labelled pads, which a linear
    // `stillSpec.spatialFilters` list could not hold.
    const plan = compileSequenceRenderPlan(seq2, paths2, "draft_480p");
    const seg = plan.filterComplex.split(";").find((s) => s.includes("vignette"));
    assert.ok(seg, "still chain with vignette missing");
    assert.match(seg, /\[fxk\d+[ab]\]/);
  });
});
