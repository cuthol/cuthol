/**
 * Effect catalog: built-in transitions, the raw ffmpeg chain kind, and enabled
 * extension fx/transitions surface as one EffectDefinition each.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listEffectDefinitions, getEffectDefinition } from "../effects/effect_registry.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout || "ffmpeg failed");
}

function withWs(fn: (wsDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxcat-"));
  const wsDir = path.join(tmp, "proj");
  try {
    initWorkspace({ dir: wsDir, title: "fxcat", aspect: "16:9", fps: 30 });
    fn(wsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeMedia(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

const DEMO_MANIFEST: Record<string, unknown> = {
  name: "fxdemo",
  version: "1.0.0",
  description: "demo",
  fx: {
    glow: {
      description: "glow",
      params: {
        sigma: { type: "number", default: 2, min: 0, max: 10 },
        mode: { type: "string", default: "soft" },
      },
      video_filter: "gblur=sigma={{sigma}}",
      animatable: ["sigma"],
    },
  },
  transitions: {
    swirl: {
      description: "swirl",
      params: { turns: { type: "number", default: 1 } },
      outgoing_filter: "gblur=sigma={{turns}}",
    },
  },
};

test("catalog lists builtins without extensions", () => {
  withWs((wsDir) => {
    const media = path.join(wsDir, "media", "a.mp4");
    makeMedia(media);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
    const { sequence } = loadSequence(wsDir);
    const defs = listEffectDefinitions(sequence, { rootDir: wsDir });
    const kinds = defs.map((d) => d.kind);
    for (const k of ["dissolve", "fade", "wipe_left", "wipe_right", "slide_up", "zoom_in", "ffmpeg"]) {
      assert.ok(kinds.includes(k), `missing ${k}`);
    }
    const dissolve = getEffectDefinition(sequence, "dissolve", { rootDir: wsDir });
    assert.equal(dissolve?.role, "transition");
    assert.equal(dissolve?.backend, "ffmpeg");
    assert.equal(dissolve?.live, "native");
    const wipe = getEffectDefinition(sequence, "wipe_left", { rootDir: wsDir });
    assert.equal(wipe?.live, "server");
    const raw = getEffectDefinition(sequence, "ffmpeg", { rootDir: wsDir });
    assert.equal(raw?.role, "clip");
    assert.deepEqual(raw?.animatable, []);
  });
});

test("catalog includes enabled extension fx and transitions", () => {
  withWs((wsDir) => {
    const media = path.join(wsDir, "media", "a.mp4");
    makeMedia(media);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
    const dir = path.join(wsDir, ".cuthol", "extensions", "fxdemo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(DEMO_MANIFEST), "utf8");
    enableExtensionInWorkspace({ workspaceDir: wsDir, name: "fxdemo" });
    const { sequence } = loadSequence(wsDir);
    const defs = listEffectDefinitions(sequence, { rootDir: wsDir });
    const fx = getEffectDefinition(sequence, "ext:fxdemo/glow", { rootDir: wsDir });
    assert.ok(fx, "extension fx missing");
    assert.equal(fx?.role, "clip");
    assert.equal(fx?.backend, "ffmpeg");
    assert.equal(fx?.live, "server");
    assert.deepEqual(fx?.animatable, ["sigma"]);
    assert.equal(fx?.ffmpeg?.video_filter, "gblur=sigma={{sigma}}");
    assert.equal(fx?.params.sigma.default, 2);
    const tr = getEffectDefinition(sequence, "ext:fxdemo/swirl", { rootDir: wsDir });
    assert.ok(tr, "extension transition missing");
    assert.equal(tr?.role, "transition");
    assert.deepEqual(tr?.animatable, []);
  });
});
