/**
 * Shader effect definitions: manifest `fx` entries with backend "shader" read
 * their params from the `.glsl` uniforms, and `spine fx check --kind` answers
 * an explicit WARN while it cannot probe shaders.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseManifestFxSection } from "../extensions/ext_fx.js";
import { parseShaderUniforms } from "../effects/shader_def.js";
import { checkEffectDefinition } from "../effects/fx_check.js";

const GLSL = `precision highp float;
uniform sampler2D u_input;
uniform float time;
uniform float ratio;
// @range(0, 1)
uniform float amount; // = 0.5
uniform int steps; // = 4
vec4 getInput(vec2 uv) { return texture(u_input, uv); }
vec4 effect(vec2 uv) { return getInput(uv); }
`;

function extDirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shader-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("shader uniforms parse to params with defaults and range", () => {
  const { params, animatable } = parseShaderUniforms(GLSL, "demo", "glow");
  assert.equal(params.amount?.type, "number");
  assert.equal(params.amount?.default, 0.5);
  assert.equal(params.amount?.min, 0);
  assert.equal(params.amount?.max, 1);
  assert.equal(params.steps?.default, 4);
  assert.deepEqual(animatable.sort(), ["amount", "steps"]);
  assert.ok(!("time" in params), "host uniform time is not a param");
  assert.ok(!("ratio" in params), "host uniform ratio is not a param");
});

test("shader entry without effect() fails", () => {
  assert.throws(() => parseShaderUniforms("uniform float a; // = 1.0\n", "demo", "glow"), /vec4 effect/);
});

test("vec2 uniform expands to component params with split defaults", () => {
  const src = "vec4 effect(vec2 uv) { return vec4(0.0); }\nuniform vec2 center; // = (0.5, 0.5)\n";
  const { params, animatable } = parseShaderUniforms(src, "demo", "glow");
  assert.equal(params.center_x?.default, 0.5);
  assert.equal(params.center_y?.default, 0.5);
  assert.deepEqual(animatable.sort(), ["center_x", "center_y"]);
});

test("vec3/ivec defaults expand and round", () => {
  const src = "vec4 effect(vec2 uv) { return vec4(0.0); }\nuniform vec3 tint; // = (1.0, 0.5, 0.0)\nuniform ivec2 cell; // = (2.6, 3.0)\n";
  const { params } = parseShaderUniforms(src, "demo", "glow");
  assert.equal(params.tint_z?.default, 0);
  assert.equal(params.cell_x?.default, 3);
  assert.equal(params.cell_y?.default, 3);
});

test("manifest shader entry resolves uniforms from the file", () => {
  const dir = extDirWith({ "shaders/glow.glsl": GLSL });
  try {
    const parsed = parseManifestFxSection(
      { glow: { backend: "shader", shader: "shaders/glow.glsl", description: "d" } },
      "demo",
      dir
    );
    assert.equal(parsed?.glow.backend, "shader");
    assert.equal(parsed?.glow.params?.amount?.default, 0.5);
    assert.deepEqual(parsed?.glow.animatable, ["amount", "steps"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest shader entry rejects manifest params and missing file", () => {
  const dir = extDirWith({ "shaders/glow.glsl": GLSL });
  try {
    assert.throws(
      () => parseManifestFxSection({ glow: { backend: "shader", shader: "shaders/glow.glsl", params: { amount: { type: "number" } } } }, "demo", dir),
      /from the '.glsl' uniforms only/
    );
    assert.throws(
      () => parseManifestFxSection({ glow: { backend: "shader", shader: "shaders/nope.glsl" } }, "demo", dir),
      /not found/
    );
    assert.throws(
      () => parseManifestFxSection({ glow: { backend: "shader", shader: "../out.glsl" } }, "demo", dir),
      /no '\.\.'/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("definition check warns for shader kinds instead of passing silently", () => {
  const findings = checkEffectDefinition(
    { kind: "ext:demo/glow", params: {}, animatable: ["amount"], backend: "shader" },
    {}
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "WARN");
  assert.match(findings[0].message, /shader effects are not checked by spine fx check yet/);
});

test("definition check compiles valid shader source and reports file:line", () => {
  // No cached browser compile for this hash: the static scan passes, so the
  // check answers WARN (G711, "not compiled yet") instead of passing silently.
  const ok = checkEffectDefinition(
    { kind: "ext:demo/glow", params: {}, animatable: [], backend: "shader", shaderFile: { file: "glow.glsl", source: GLSL } },
    {}
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0].severity, "WARN");
  assert.equal(ok[0].code, "CUTHOL-G711");
  const badSrc = "vec4 effect(vec2 uv) { return vec4(0.0);\nuniform float amount; // = 0.5\n";
  const bad = checkEffectDefinition(
    { kind: "ext:demo/glow", params: {}, animatable: [], backend: "shader", shaderFile: { file: "glow.glsl", source: badSrc } },
    {}
  );
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, "ERROR");
  assert.match(bad[0].message, /glow\.glsl.*line 1/);
});
