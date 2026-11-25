/**
 * Docs example: the "Shader effects" section of
 * `skills/cuthol-extensions/references/effects.md` carries a complete working
 * extension (```glsl shader-docs-example + ```json shader-docs-manifest).
 * This test extracts both fences, stages the extension, enables it, adds the
 * fx to a sandbox clip with an envelope on `center_x`, and renders frames
 * through the real shader pass.
 */

import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { setItemEnvelope } from "../sequence/spine.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { openFxSandbox, renderSandboxPngs } from "../effects/fx_sandbox.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shdocs-"));
test.after(() => rmRetrySync(TMP));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EFFECTS_MD = path.resolve(HERE, "..", "..", "skills", "cuthol-extensions", "references", "effects.md");

function extractFence(md: string, tag: string): string {
  const m = new RegExp("```\\w* " + tag + "\\r?\\n([\\s\\S]*?)```").exec(md);
  assert.ok(m, `fence '${tag}' missing from effects.md`);
  return m[1];
}

const GLSL = extractFence(fs.readFileSync(EFFECTS_MD, "utf8"), "shader-docs-example");
const MANIFEST = extractFence(fs.readFileSync(EFFECTS_MD, "utf8"), "shader-docs-manifest");

test("docs shader example extracts, enables and renders", () => {
  assert.match(GLSL, /vec4 effect\(vec2 uv\)/);
  assert.match(GLSL, /uniform vec2 center;/);
  const manifest = JSON.parse(MANIFEST) as {
    name: string;
    fx: Record<string, { backend: string; shader: string; description: string }>;
  };
  assert.equal(manifest.fx.vignette.backend, "shader");

  const wsDir = path.join(TMP, "proj");
  initWorkspace({ dir: wsDir, title: "shdocs", aspect: "16:9", fps: 30 });
  const extDir = path.join(wsDir, ".cuthol", "extensions", manifest.name);
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "shaders", "vignette.glsl"), GLSL);
  fs.writeFileSync(path.join(extDir, "cuthol-extension.json"), MANIFEST);
  const media = path.join(TMP, "src.mp4");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-qp", "8", "-pix_fmt", "yuv420p", media],
    { encoding: "utf8", timeout: 120_000, windowsHide: true }
  );
  assert.equal(r.status, 0, String(r.stderr ?? r.error).slice(-300));
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: manifest.name });
  const kind = `ext:${manifest.name}/vignette`;
  addSpineFx({ workspaceDir: wsDir, item: clip.id, kind, params: { amount: 0.6 } });
  setItemEnvelope({
    workspaceDir: wsDir,
    targetId: clip.id,
    parameter: "fx.fx_01.center_x" as never,
    points: [
      { offset_ms: 0, value: 0.2, easing: "linear" },
      { offset_ms: 2000, value: 0.8, easing: "linear" },
    ] as never,
  });

  const sb = openFxSandbox({
    kind,
    params: { amount: 0.6 },
    extDirs: [{ name: manifest.name, dir: extDir }],
    envelopes: [{ parameter: "fx.fx_01.center_x", points: [{ offset_ms: 0, value: 0.2, easing: "linear" }, { offset_ms: 2000, value: 0.8, easing: "linear" }] }],
    prefix: "cuthol-shdocs-",
    timeoutMs: 240_000,
  });
  try {
    const outDir = path.join(TMP, "frames");
    const pngs = renderSandboxPngs(sb, outDir, { frames: 2, fps: 1 });
    assert.equal(pngs.length, 2);
    for (const p of pngs) assert.ok(fs.statSync(p).size > 0, `${p} is empty`);
    // The center_x envelope moves the vignette: the two frames differ.
    assert.ok(!fs.readFileSync(pngs[0]).equals(fs.readFileSync(pngs[1])), "enveloped center_x leaves frames identical");
  } finally {
    sb.dispose();
  }
});
