/**
 * `extension enable` browser compile check for shader effects:
 * - a good shader enables, writes the compile cache, and `check` reports no G711;
 * - a typo shader (`amout`) fails the enable naming file and line, sequence untouched;
 * - `--dry-run` compiles and reports without writing (no cache, no enable);
 * - `skipShaderCompile` (the fx sandbox path) enables without compiling;
 * - an extension without shader fx pays no compile cost (`none`).
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { checkEffectDefinition } from "../effects/fx_check.js";
import { readShaderCompileCache } from "../effects/shader_def.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const GOOD_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv); }
`;

const TYPO_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv) * amout; }
`;

function withWs(fn: (wsDir: string) => void | Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadenable-"));
  const wsDir = path.join(tmp, "proj");
  const done = async (): Promise<void> => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return (async () => {
    try {
      initWorkspace({ dir: wsDir, title: "shaden", aspect: "16:9", fps: 30 });
      await fn(wsDir);
    } finally {
      await done();
    }
  })();
}

function writeShaderExt(wsDir: string, name: string, glslFile: string, glsl: string): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(path.join(dir, "shaders"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        description: `${name} shader test extension.`,
        fx: { glow: { description: "Test glow.", backend: "shader", shader: glslFile } },
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, glslFile), glsl, "utf8");
}

function writePlainExt(wsDir: string, name: string): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        description: `${name} plain test extension.`,
        fx: {
          lift: {
            description: "Brightness lift.",
            params: { level: { type: "number", default: 0 } },
            animatable: ["level"],
            video_filter: "eq=brightness={{level}}:eval=frame",
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );
}

function enabledNames(wsDir: string): string[] {
  return (loadSequence(wsDir).sequence.extensions ?? []).map((e) => e.name);
}

test("enable compiles a good shader, caches it, and check reports no G711", async () => {
  await withWs((ws) => {
    writeShaderExt(ws, "shgood", "shaders/good.glsl", GOOD_GLSL);
    const res = enableExtensionInWorkspace({ workspaceDir: ws, name: "shgood" });
    assert.equal(res.shader_compile?.status, "compiled");
    assert.deepEqual(enabledNames(ws), ["shgood"]);
    const cache = readShaderCompileCache(ws);
    const keys = Object.keys(cache);
    assert.equal(keys.length, 1);
    assert.ok(cache[keys[0]].ok, "good result cached as ok");
    const findings = checkEffectDefinition(
      { kind: "ext:shgood/glow", params: {}, animatable: [], backend: "shader", shaderFile: { file: "shaders/good.glsl", source: GOOD_GLSL } },
      { projectDir: ws }
    );
    assert.ok(!findings.some((f) => f.code === "CUTHOL-G711"), `no G711 after enable, got ${JSON.stringify(findings)}`);
    assert.ok(!findings.some((f) => f.severity === "ERROR"), `no ERROR, got ${JSON.stringify(findings)}`);
  });
});

test("enable refuses a typo shader naming file and line, sequence untouched", async () => {
  await withWs((ws) => {
    writeShaderExt(ws, "shbad", "shaders/typo.glsl", TYPO_GLSL);
    assert.throws(
      () => enableExtensionInWorkspace({ workspaceDir: ws, name: "shbad" }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return /typo\.glsl/.test(msg) && /line 5/.test(msg);
      },
      "enable should fail naming the file and line"
    );
    assert.deepEqual(enabledNames(ws), [], "failed enable leaves the sequence untouched");
    const cache = readShaderCompileCache(ws);
    const keys = Object.keys(cache);
    assert.equal(keys.length, 1, "failed compile is still cached");
    assert.ok(!cache[keys[0]].ok, "typo cached as failure");
  });
});

test("dry-run compiles and reports without writing cache or enable", async () => {
  await withWs((ws) => {
    writeShaderExt(ws, "shdry", "shaders/good.glsl", GOOD_GLSL);
    const res = enableExtensionInWorkspace({ workspaceDir: ws, name: "shdry", dryRun: true });
    assert.equal(res.dry_run, true);
    assert.equal(res.shader_compile?.status, "compiled");
    assert.deepEqual(enabledNames(ws), [], "dry-run enables nothing");
    assert.ok(!fs.existsSync(path.join(ws, ".cuthol", "shader-compile-cache.json")), "dry-run writes no cache");
  });
});

test("skipShaderCompile enables a typo shader without compiling (sandbox path)", async () => {
  await withWs((ws) => {
    writeShaderExt(ws, "shskip", "shaders/typo.glsl", TYPO_GLSL);
    const res = enableExtensionInWorkspace({ workspaceDir: ws, name: "shskip", skipShaderCompile: true });
    assert.equal(res.shader_compile?.status, "skipped");
    assert.deepEqual(enabledNames(ws), ["shskip"]);
    assert.ok(!fs.existsSync(path.join(ws, ".cuthol", "shader-compile-cache.json")), "skipped enable writes no cache");
  });
});

test("extension without shader fx pays no compile cost", async () => {
  await withWs((ws) => {
    writePlainExt(ws, "plainfx");
    const res = enableExtensionInWorkspace({ workspaceDir: ws, name: "plainfx" });
    assert.equal(res.shader_compile?.status, "none");
    assert.deepEqual(enabledNames(ws), ["plainfx"]);
  });
});
