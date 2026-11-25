/**
 * Shader pre-pass compile shape: a shader entry becomes an automatic cut with
 * a `kind: "shader"` pre-pass job (prefix graph + ordered steps + cache key
 * fields), ffmpeg entries between two shaders fold into the same pre-pass,
 * and clips without shader entries compile exactly as before (no prePasses).
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { compileSequenceRenderPlan } from "../compositor/compiler.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadcomp-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const IDENTITY_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
// @range(0, 1)
uniform float amount; // = 0.5
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv); }
`;

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  assert.equal(proc.status, 0, proc.stderr || proc.error);
}

function makeWs(name: string, withShader: "none" | "one" | "sandwich"): string {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const media = path.join(TMP, "src.mp4");
  if (!fs.existsSync(media)) {
    ffmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p",
      media,
    ]);
  }
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({
    workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 2000,
  });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shdemo");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "shaders", "identity.glsl"), IDENTITY_GLSL);
  fs.writeFileSync(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({
      name: "shdemo", version: "1.0.0", description: "shader test",
      fx: { ident: { description: "identity", backend: "shader", shader: "shaders/identity.glsl" } },
    })
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shdemo" });
  if (withShader === "one") {
    addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ffmpeg", params: { filter: "eq=brightness=0.02" } });
    addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ext:shdemo/ident", params: { amount: 0.25 } });
    addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ffmpeg", params: { filter: "hue=h=5" } });
  } else if (withShader === "sandwich") {
    addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ext:shdemo/ident", params: { amount: 0.25 } });
    addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ffmpeg", params: { filter: "eq=brightness=0.02" } });
    addSpineFx({ workspaceDir: wsDir, item: clip.id, kind: "ext:shdemo/ident", params: { amount: 0.75 } });
  }
  return wsDir;
}

test("no shader entries means no prePasses field", () => {
  const wsDir = makeWs("ws_plain", "none");
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  assert.ok(!("prePasses" in plan));
});

test("a shader entry emits a shader pre-pass job and rewires the main graph", () => {
  const wsDir = makeWs("ws_shader", "one");
  const { sequence, paths } = loadSequence(wsDir);
  const plan = compileSequenceRenderPlan(sequence, paths, "draft_480p");
  assert.equal(plan.prePasses?.length, 1);
  const job = plan.prePasses![0];
  assert.equal(job.kind, "shader");
  assert.ok(job.outPath.endsWith(".nut"));
  assert.equal(job.pixFmt, "rgba");
  assert.ok(job.filterComplex.includes("format=rgba"), "prefix ends in rgba");
  const steps = job.shader!.steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "shader");
  if (steps[0].kind === "shader") {
    assert.equal(steps[0].uniforms.amount, 0.25);
    assert.match(steps[0].file, /identity\.glsl$/);
    assert.equal(steps[0].hash.length, 16);
  }
  assert.ok(plan.inputArgs.includes(job.outPath), "main graph reads the intermediate");
});
