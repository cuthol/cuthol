/**
 * Lane-cue fx: `spine fx` on `cue_XX` (add/set/remove/list with `--item`),
 * fx envelopes on cues, verify of cue fx, excise carrying fx, thumb key,
 * brief lines and the MCP path.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSpineCommand } from "../cli_cmd_spine.js";
import type { CliCommandContext } from "../cli_output.js";
import { commitSequenceMutation, initWorkspace, loadSequence, stepJournal } from "../core/workspace.js";
import { computeSceneThumbKey } from "../live/live_thumbs.js";
import { CutholMcpServer } from "../mcp/server.js";
import { renderSequenceBrief } from "../brief/inspector.js";
import { listEffectDefinitions } from "../effects/effect_registry.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { addLaneCue, exciseLaneCueRanges } from "../sequence/lanes.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addSpineFx, listSpineFx, removeSpineFx, setSpineFx } from "../sequence/spine_fx.js";
import { readEnvelopeValueAt } from "../sequence/envelope_points.js";
import { setItemEnvelope } from "../sequence/spine.js";
import { verifySequence } from "../verify/gates.js";

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cuefx-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "cuefx", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeAvMp4(outPath: string, durationSec = 4): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=30:duration=${durationSec}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", outPath,
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(proc.status, 0, proc.stderr || "ffmpeg failed");
}

function setupBrollCue(wsDir: string): { cueId: string; handle: string } {
  const media = path.join(wsDir, "media", "b.mp4");
  makeAvMp4(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { cue } = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_broll", kind: "broll",
    assetHandle: item.handle, atMs: 0, durationMs: 4000,
    sourceInMs: 0, sourceOutMs: 4000,
  });
  return { cueId: cue.id, handle: item.handle };
}

function setupAudioCue(wsDir: string): string {
  const media = path.join(wsDir, "media", "m.mp4");
  makeAvMp4(media);
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { cue } = addLaneCue({
    workspaceDir: wsDir, laneId: "ln_bgm", kind: "music",
    assetHandle: item.handle, atMs: 0, durationMs: 4000,
  });
  return cue.id;
}

test("cue fx add/set/list/remove via item, clip keys unchanged", () => {
  withWs((ws) => {
    setupBrollCue(ws);
    const { sequence } = loadSequence(ws);
    const cueId = sequence.lanes.flatMap((l) => l.cues)[0].id;
    const a = addSpineFx({ workspaceDir: ws, item: cueId, filter: "gblur=sigma=3" });
    assert.equal(a.fx.id, "fx_01");
    assert.equal(a.item, cueId);
    assert.ok(!("clip" in a));
    const s = setSpineFx({ workspaceDir: ws, item: cueId, fxId: "fx_01", filter: "gblur=sigma=5" });
    assert.equal(s.item, cueId);
    assert.deepEqual(s.fx.params, { filter: "gblur=sigma=5" });
    const l = listSpineFx({ workspaceDir: ws, item: cueId });
    assert.equal(l.item, cueId);
    assert.deepEqual(l.fx.map((f) => f.id), ["fx_01"]);
    const r = removeSpineFx({ workspaceDir: ws, item: cueId, fxId: "fx_01" });
    assert.equal(r.removed_id, "fx_01");
    assert.equal(r.item, cueId);
    assert.deepEqual(listSpineFx({ workspaceDir: ws, item: cueId }).fx, []);
    // Legacy --clip path keeps today's keys on spine clips.
    const media = path.join(ws, "media", "a.mp4");
    makeAvMp4(media);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
    const { clip } = appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
    const c = addSpineFx({ workspaceDir: ws, clipId: clip.id, filter: "null" });
    assert.equal(c.clip, clip.id);
    assert.equal(c.item, clip.id);
  });
});

test("cue fx undo after add and after remove", () => {
  withWs((ws) => {
    setupBrollCue(ws);
    const cueId = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues)[0].id;
    addSpineFx({ workspaceDir: ws, item: cueId, filter: "gblur=sigma=3" });
    addSpineFx({ workspaceDir: ws, item: cueId, filter: "unsharp" });
    removeSpineFx({ workspaceDir: ws, item: cueId, fxId: "fx_01" });
    assert.deepEqual(listSpineFx({ workspaceDir: ws, item: cueId }).fx.map((f) => f.id), ["fx_02"]);
    stepJournal(ws, "undo", 1);
    assert.deepEqual(listSpineFx({ workspaceDir: ws, item: cueId }).fx.map((f) => f.id), ["fx_01", "fx_02"]);
    stepJournal(ws, "undo", 2);
    assert.deepEqual(listSpineFx({ workspaceDir: ws, item: cueId }).fx, []);
  });
});

test("audio cue fx refused with G271", () => {
  withWs((ws) => {
    const cueId = setupAudioCue(ws);
    assert.throws(
      () => addSpineFx({ workspaceDir: ws, item: cueId, filter: "gblur=sigma=3" }),
      (err: unknown) => {
        const d = (err as { diagnostic?: { code?: string } }).diagnostic;
        return d?.code === "CUTHOL-G271";
      }
    );
  });
});

test("fx envelopes on a cue: set + spine value", () => {
  withWs((ws) => {
    setupBrollCue(ws);
    const cueId = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues)[0].id;
    addSpineFx({ workspaceDir: ws, item: cueId, filter: "eq=brightness=0" });
    setItemEnvelope({
      workspaceDir: ws, targetId: cueId, parameter: "placement.opacity",
      points: [{ offset_ms: 0, value: 1, easing: "linear" }],
    });
    const v = readEnvelopeValueAt({ workspaceDir: ws, targetId: cueId, parameter: "placement.opacity", localMs: 0 });
    assert.equal(v.value, 1);
  });
});

test("verify catches unknown fx kind on a cue like on clips", () => {
  withWs((ws) => {
    setupBrollCue(ws);
    const cueId = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues)[0].id;
    commitSequenceMutation(ws, `test.cuefx(${cueId})`, (seq) => {
      for (const lane of seq.lanes) {
        for (const cue of lane.cues) {
          if (cue.id === cueId) cue.fx = [{ id: "fx_01", kind: "ext:nope/missing", params: {} }];
        }
      }
      return null;
    });
    const { sequence, paths } = loadSequence(ws);
    const report = verifySequence(sequence, paths);
    const codes = report.diagnostics.map((d) => d.code);
    assert.ok(codes.includes("CUTHOL-G118"), `expected G118, got ${codes.join(",")}`);
  });
});

test("lane excise carries fx and slices fx envelopes on every piece", () => {
  withWs((ws) => {
    setupBrollCue(ws);
    const dir = path.join(ws, ".cuthol", "extensions", "fxdemo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cuthol-extension.json"),
      JSON.stringify({
        name: "fxdemo", version: "1.0.0", description: "fx test effects",
        fx: {
          soft_blur: {
            description: "Gaussian blur",
            params: { sigma: { type: "number", default: 4, min: 0, max: 50 } },
            animatable: ["sigma"],
            video_filter: "gblur=sigma={{sigma}}",
          },
        },
      }),
      "utf8"
    );
    enableExtensionInWorkspace({ workspaceDir: ws, name: "fxdemo" });
    const cueId = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues)[0].id;
    addSpineFx({ workspaceDir: ws, item: cueId, kind: "ext:fxdemo/soft_blur", params: { sigma: 4 } });
    setItemEnvelope({
      workspaceDir: ws, targetId: cueId, parameter: "fx.fx_01.sigma",
      points: [
        { offset_ms: 0, value: 1, easing: "linear" },
        { offset_ms: 4000, value: 5, easing: "linear" },
      ],
    });
    const res = exciseLaneCueRanges({
      workspaceDir: ws, cueId,
      ranges: [{ start_ms: 1000, end_ms: 2000 }],
      coordinateSpace: "cue_local",
    });
    assert.equal(res.remainingCues.length, 2);
    for (const cue of res.remainingCues) {
      assert.deepEqual((cue.fx ?? []).map((f) => f.id), ["fx_01"]);
      assert.ok(cue.envelopes.some((e) => e.parameter === "fx.fx_01.sigma"));
    }
  });
});

test("scene thumb key changes with cue fx and stays without it", () => {
  const seq: Record<string, unknown> = {
    stage: { width: 192, height: 108 },
    spine: { clips: [] },
    lanes: [
      {
        id: "ln_broll", cues: [
          {
            id: "cue_01", kind: "broll", at_ms: 0, duration_ms: 2000,
            placement: { x_pct: 0, y_pct: 0 },
          },
        ],
      },
    ],
  };
  const scene = { id: "sc_1", start_ms: 0, end_ms: 2000, members: [] as string[] };
  const plain = computeSceneThumbKey(seq, scene as never);
  const withFx = computeSceneThumbKey(
    {
      ...seq,
      lanes: [
        {
          id: "ln_broll", cues: [
            { id: "cue_01", kind: "broll", at_ms: 0, duration_ms: 2000, placement: { x_pct: 0, y_pct: 0 }, fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: "gblur=sigma=3" } }] },
          ],
        },
      ],
    },
    scene as never
  );
  assert.notEqual(plain, withFx);
  const withColor = computeSceneThumbKey(
    {
      ...seq,
      lanes: [
        {
          id: "ln_broll", cues: [
            { id: "cue_01", kind: "broll", at_ms: 0, duration_ms: 2000, placement: { x_pct: 0, y_pct: 0 }, color: { blocks: [] } },
          ],
        },
      ],
    },
    scene as never
  );
  assert.notEqual(plain, withColor);
  // Absent fields and undefined fields hash identically (projects without cue fx keep their key).
  const explicit = computeSceneThumbKey(
    {
      ...seq,
      lanes: [
        {
          id: "ln_broll", cues: [
            { id: "cue_01", kind: "broll", at_ms: 0, duration_ms: 2000, placement: { x_pct: 0, y_pct: 0 }, fx: undefined, color: undefined },
          ],
        },
      ],
    },
    scene as never
  );
  assert.equal(plain, explicit);
});

test("brief shows fx lines only when fx exist", () => {
  withWs((ws) => {
    const media = path.join(ws, "media", "a.mp4");
    makeAvMp4(media);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: ws, filePaths: [media] });
    const { clip } = appendSpineClip({ workspaceDir: ws, assetHandle: item.handle });
    setupBrollCue(ws);
    const cueId = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues)[0].id;
    const beforeOverview = renderSequenceBrief(loadSequence(ws).sequence, { lens: "overview" });
    const beforeFlow = renderSequenceBrief(loadSequence(ws).sequence, { lens: "flow" });
    addSpineFx({ workspaceDir: ws, clipId: clip.id, filter: "gblur=sigma=3" });
    addSpineFx({ workspaceDir: ws, item: cueId, filter: "null" });
    const afterOverview = renderSequenceBrief(loadSequence(ws).sequence, { lens: "overview" });
    const afterFlow = renderSequenceBrief(loadSequence(ws).sequence, { lens: "flow" });
    assert.ok(!beforeOverview.includes("fx:"));
    assert.ok(afterOverview.includes("`fx: ffmpeg`"));
    assert.ok(!beforeFlow.includes("fx:"));
    assert.ok(afterFlow.includes("[fx: ffmpeg]"));
  });
});

test("CLI spine fx --item plus legacy --clip, catalog shows alpha", () => {
  withWs((ws) => {
    setupBrollCue(ws);
    const cueId = loadSequence(ws).sequence.lanes.flatMap((l) => l.cues)[0].id;
    const run = (rest: string[], flags: Record<string, string | boolean>): void => {
      const ctx: CliCommandContext = {
        group: "spine", action: "fx", rest, flags, workspaceDir: ws, formatFlag: "",
      };
      const orig = console.log;
      console.log = () => {};
      try {
        runSpineCommand(ctx);
      } finally {
        console.log = orig;
      }
    };
    run(["add"], { item: cueId, filter: "gblur=sigma=3" });
    assert.deepEqual(listSpineFx({ workspaceDir: ws, item: cueId }).fx.map((f) => f.id), ["fx_01"]);
    run(["set"], { item: cueId, fx: "fx_01", filter: "gblur=sigma=5" });
    run(["list"], { item: cueId });
    run(["remove"], { clip: cueId, fx: "fx_01" });
    assert.deepEqual(listSpineFx({ workspaceDir: ws, item: cueId }).fx, []);
    assert.throws(() => run(["add"], {}), /--item/);
    const dir = path.join(ws, ".cuthol", "extensions", "alphademo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cuthol-extension.json"),
      JSON.stringify({
        name: "alphademo", version: "1.0.0", description: "alpha demo",
        fx: {
          blurry: { description: "blur", params: {}, alpha: "process", video_filter: "gblur=sigma=2" },
          grainy: { description: "grain", params: {}, video_filter: "noise=alls=4:allf=t" },
        },
      }),
      "utf8"
    );
    enableExtensionInWorkspace({ workspaceDir: ws, name: "alphademo" });
    const defs = listEffectDefinitions(loadSequence(ws).sequence, { rootDir: ws });
    assert.equal(defs.find((d) => d.kind === "ext:alphademo/blurry")?.alpha, "process");
    assert.equal(defs.find((d) => d.kind === "ext:alphademo/grainy")?.alpha, "keep");
  });
});

test("MCP: tool count unchanged, spine fx add with item works", async () => {
  const mcp = new CutholMcpServer();
  const list = await mcp.handleJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = (list?.result as { tools: Array<{ name: string }> }).tools;
  assert.equal(tools.length, 15);
  assert.ok(tools.some((t) => t.name === "spine"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-cuefx-mcp-"));
  try {
    const ws = path.join(tmp, "proj");
    const init = await mcp.callTool("workspace", { action: "init", dir: ws, aspect: "16:9", fps: 30 });
    assert.equal(init.isError, false);
    const media = path.join(tmp, "b.mp4");
    makeAvMp4(media);
    const ing = await mcp.callTool("library", { action: "ingest", files: [media] });
    assert.equal(ing.isError, false);
    const cue = await mcp.callTool("lane", { action: "add_cue", lane: "ln_broll", asset: "vid_01", at: "0s", duration: "4s" });
    assert.equal(cue.isError, false, JSON.stringify(cue).slice(0, 500));
    const seq = loadSequence(ws).sequence;
    const cueId = seq.lanes.flatMap((l) => l.cues)[0].id;
    const add = await mcp.callTool("spine", { action: "fx_add", item: cueId, filter: "gblur=sigma=3" });
    assert.equal(add.isError, false, JSON.stringify(add).slice(0, 500));
    const listed = listSpineFx({ workspaceDir: ws, item: cueId });
    assert.deepEqual(listed.fx.map((f) => f.id), ["fx_01"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
