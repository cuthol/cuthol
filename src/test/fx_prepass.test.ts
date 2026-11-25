/**
 * Fx pre-pass split (`src/compositor/*`, `src/render/pre_pass.ts`).
 *
 * - A `cut` part is a marker only: the flattened chain with a cut equals the
 *   flattened chain without it (both sides still checked).
 * - A forced cut emits plan `prePasses` jobs and rewires the main graph to a
 *   new input; without a cut the plan has no `prePasses` field at all.
 * - The runner writes atomically (tmp + rename), skips completed outputs, and
 *   serializes one producer per key via a lock file.
 * - A forced-cut render of a tiny generated source is framemd5-identical to
 *   the uncut render.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import {
  buildItemFxStage,
  flattenFxStageParts,
} from "../compositor/compile_fx_stage.js";
import { ensurePlanPrePasses } from "../render/pre_pass.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxpre-"));
test.after(() => rmRetrySync(TMP));

function ffmpeg(args: string[], cwd?: string): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, cwd, timeout: 300_000 });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? proc.error}`);
}

function makeMedia(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2,eq=saturation=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

function fakeCtx(seq: unknown, rootDir: string): VideoGraphCompileContext {
  return { seq, paths: { rootDir, blobsDir: path.join(rootDir, ".cuthol", "blobs") }, vStepCounter: 0 } as unknown as VideoGraphCompileContext;
}

const OWNER = {
  id: "sp_01",
  fx: [
    { id: "fx_01", kind: "ffmpeg", params: { filter: "format=rgba" } },
    { id: "fx_02", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } },
    { id: "fx_03", kind: "ffmpeg", params: { filter: "hue=h=10" } },
  ],
  envelopes: [],
};

test("flattened chain with a cut equals the flattened chain without it", () => {
  const ctx = fakeCtx({}, TMP);
  const plain = flattenFxStageParts(
    buildItemFxStage(ctx, { owner: OWNER, receivedPixFmt: "yuv420p", itemHasAlpha: false })
  ).join(",");
  for (const at of [0, 1, 2, 3]) {
    const parts = buildItemFxStage(ctx, {
      owner: OWNER, receivedPixFmt: "yuv420p", itemHasAlpha: false, cutAfterEntry: at,
    });
    assert.ok(parts.some((p) => p.type === "cut"), `cut marker missing at ${at}`);
    assert.equal(flattenFxStageParts(parts).join(","), plain, `flatten differs at cut ${at}`);
  }
});

test("cut inside an alpha_keep run snaps past the wrapper; never splits it", () => {
  const ctx = fakeCtx({}, TMP);
  const alphaOwner = {
    id: "sp_02",
    fx: [
      { id: "fx_01", kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } },
      { id: "fx_02", kind: "ffmpeg", params: { filter: "hue=h=10" } },
    ],
    envelopes: [],
  };
  // Both entries merge into one keep run: a cut after entry 1 would split the
  // wrapper, so it snaps after entry 2 instead.
  const parts = buildItemFxStage(ctx, {
    owner: alphaOwner, receivedPixFmt: "rgba", itemHasAlpha: true, cutAfterEntry: 1,
  });
  const kinds = parts.map((p) => p.type);
  assert.deepEqual(kinds, ["alpha_keep", "cut", "chain"]);
  assert.equal((parts[1] as { cutAfterEntry: number }).cutAfterEntry, 2);
  const plain = flattenFxStageParts(
    buildItemFxStage(ctx, { owner: alphaOwner, receivedPixFmt: "rgba", itemHasAlpha: true })
  ).join(",");
  assert.equal(flattenFxStageParts(parts).join(","), plain);
});

function makeWs(name: string): { wsDir: string } {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const media = path.join(TMP, "src.mp4");
  makeMedia(media);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({
    workspaceDir: wsDir,
    assetHandle: item.handle,
    sourceInMs: 0,
    sourceOutMs: 2000,
  });
  addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ffmpeg", params: { filter: "eq=brightness=0.05" } });
  addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ffmpeg", params: { filter: "hue=h=10" } });
  return { wsDir };
}

test("forced cut emits a pre-pass and one more input; no cut means no prePasses field", () => {
  const { wsDir } = makeWs("ws_plan");
  const { sequence, paths } = loadSequence(wsDir);
  const plain = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  assert.ok(!("prePasses" in plain), "uncut plan must have no prePasses field");
  const cut = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
    forceFxSplit: { afterEntry: 0 },
  });
  assert.ok(cut.prePasses && cut.prePasses.length >= 1, "cut plan needs a pre-pass");
  const job = cut.prePasses![0];
  assert.ok(job.outPath.endsWith(".nut") && job.outPath.includes("sh_fxpre_"));
  assert.ok(job.filterComplex.includes("[0:v]") && job.filterComplex.endsWith("[preout]"));
  assert.ok(cut.inputArgs.length > plain.inputArgs.length, "main graph gains the intermediate input");
  assert.ok(cut.filterComplex.includes("settb=AVTB"), "cut restarts on the AVTB timeline");
});

test("pre-pass runner writes atomically and skips completed outputs", () => {
  const { wsDir } = makeWs("ws_run");
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
    forceFxSplit: { afterEntry: 0 },
  });
  assert.ok(plan.prePasses && plan.prePasses.length >= 1);
  ensurePlanPrePasses(plan, { cwd: paths.rootDir, step: "test pre-pass" });
  for (const job of plan.prePasses!) {
    assert.ok(fs.existsSync(job.outPath), "intermediate exists after run");
    const st = fs.statSync(job.outPath);
    assert.ok(st.size > 0, "intermediate is complete");
    assert.equal(fs.existsSync(`${job.outPath}.${process.pid}.tmp`), false);
  }
  const before = plan.prePasses!.map((j) => ({
    outPath: j.outPath,
    hash: crypto.createHash("sha256").update(fs.readFileSync(j.outPath)).digest("hex"),
    size: fs.statSync(j.outPath).size,
    birthtimeMs: fs.statSync(j.outPath).birthtimeMs,
    ino: fs.statSync(j.outPath).ino,
  }));
  // Backdate mtime so the reuse touch (last-use contract) is observable
  // even on coarse mtime granularity.
  const backdated = plan.prePasses!.map((j) => {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(j.outPath, past, past);
    return fs.statSync(j.outPath).mtimeMs;
  });
  ensurePlanPrePasses(plan, { cwd: paths.rootDir, step: "test pre-pass" });
  const jobs = plan.prePasses!;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    assert.equal(fs.existsSync(`${job.outPath}.${process.pid}.tmp`), false);
    const st = fs.statSync(job.outPath);
    assert.equal(st.size, before[i].size, "second run must not re-encode the output");
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(job.outPath)).digest("hex"),
      before[i].hash,
      "second run must not re-encode the output",
    );
    if (before[i].birthtimeMs > 0) assert.equal(st.birthtimeMs, before[i].birthtimeMs);
    if (before[i].ino > 0) assert.equal(st.ino, before[i].ino);
    assert.ok(st.mtimeMs > backdated[i], "reuse must advance the mtime (last-use contract)");
  }
});

test("forced-cut render is framemd5-identical to the uncut render", () => {
  const { wsDir } = makeWs("ws_ident");
  const { sequence, paths } = loadSequence(wsDir);
  const render = (force: boolean): string => {
    const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p", {
      includeAudio: false,
      ...(force ? { forceFxSplit: { afterEntry: 1 } } : null),
    });
    if (force) ensurePlanPrePasses(plan, { cwd: paths.rootDir, step: "test pre-pass" });
    const out = path.join(TMP, force ? "cut.nut" : "plain.nut");
    ffmpeg([
      "-y", "-v", "error",
      ...plan.inputArgs,
      "-filter_complex", plan.filterComplex,
      "-map", plan.videoOutPad,
      "-t", (plan.totalDurationMs / 1000).toFixed(3),
      "-c:v", "ffv1",
      out,
    ], paths.rootDir);
    return out;
  };
  const plainMd5 = path.join(TMP, "plain.framemd5");
  const cutMd5 = path.join(TMP, "cut.framemd5");
  const r1 = render(false);
  const r2 = render(true);
  ffmpeg(["-y", "-v", "error", "-i", r1, "-map", "0:v", "-f", "framemd5", plainMd5]);
  ffmpeg(["-y", "-v", "error", "-i", r2, "-map", "0:v", "-f", "framemd5", cutMd5]);
  assert.equal(fs.readFileSync(cutMd5, "utf8"), fs.readFileSync(plainMd5, "utf8"));
});
