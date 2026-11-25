/**
 * Browser compile cache for shader effects:
 * - `ensureShaderCompileCache` compiles each `.glsl` in one short-lived
 * - `ensureShaderCompileCache` compiles each `.glsl` in one short-lived
 *   browser and stores the result by content hash;
 * - an undefined identifier (missed by the static scan) fails with file+line;
 * - `checkEffectDefinition` reads the cache (never a browser): cached failure
 *   is an ERROR, a hash with no result gets the static scan plus a WARN.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkEffectDefinition } from "../effects/fx_check.js";
import {
  ensureShaderCompileCache,
  lookupShaderCompileResult,
  readShaderCompileCache,
} from "../effects/shader_def.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shadcache-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const GOOD_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv); }
`;

// `amout` is undefined: braces and semicolons balance, so the static scan
// passes and only the browser compile catches it (line 5).
const TYPO_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv) * amout; }
`;

test("browser compile passes a good shader and fails a typo with file and line", async () => {
  const rootDir = path.join(TMP, "ws1");
  fs.mkdirSync(path.join(rootDir, ".cuthol"), { recursive: true });
  const results = await ensureShaderCompileCache({
    rootDir,
    shaders: [
      { file: "shaders/good.glsl", source: GOOD_GLSL },
      { file: "shaders/typo.glsl", source: TYPO_GLSL },
    ],
  });
  assert.equal(results.length, 2);
  const good = results.find((r) => r.file === "shaders/good.glsl");
  const typo = results.find((r) => r.file === "shaders/typo.glsl");
  assert.ok(good?.ok, `good shader should compile: ${good?.detail}`);
  assert.equal(good?.cached, false);
  assert.ok(typo && !typo.ok, "typo shader should fail");
  assert.equal(typo.line, 5, `typo should fail on line 5, got ${typo.line}: ${typo.detail}`);
  assert.match(typo.detail ?? "", /amout/);
  const cache = readShaderCompileCache(rootDir);
  assert.ok(cache[good.hash]?.ok, "good result stored by hash");
  assert.ok(cache[typo.hash] && !cache[typo.hash].ok, "bad result stored by hash");
});

test("compile order does not leak: typo first, and two distinct typos", async () => {
  const TYPO2_GLSL = `precision highp float;
uniform float time;
uniform float ratio;
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv) * missing2 + vec4(1.0); }
vec4 extra(vec2 uv) { return getInput(uv); }
`;
  // typo first then good
  {
    const rootDir = path.join(TMP, "ws-order1");
    fs.mkdirSync(path.join(rootDir, ".cuthol"), { recursive: true });
    const results = await ensureShaderCompileCache({
      rootDir,
      shaders: [
        { file: "shaders/typo.glsl", source: TYPO_GLSL },
        { file: "shaders/good.glsl", source: GOOD_GLSL },
      ],
    });
    const good = results.find((r) => r.file === "shaders/good.glsl");
    const typo = results.find((r) => r.file === "shaders/typo.glsl");
    assert.ok(good?.ok, `good after typo should compile: ${good?.detail}`);
    assert.ok(typo && !typo.ok, "typo first should fail");
    assert.equal(typo.line, 5);
  }
  // two different typos each report their own failure
  {
    const rootDir = path.join(TMP, "ws-order2");
    fs.mkdirSync(path.join(rootDir, ".cuthol"), { recursive: true });
    const results = await ensureShaderCompileCache({
      rootDir,
      shaders: [
        { file: "shaders/typo.glsl", source: TYPO_GLSL },
        { file: "shaders/typo2.glsl", source: TYPO2_GLSL },
      ],
    });
    assert.equal(results.length, 2);
    for (const r of results) assert.ok(!r.ok, `${r.file} should fail`);
    for (const r of results) assert.ok((r.line ?? 0) >= 1, `${r.file} should report a line`);
    assert.match(results.find((r) => r.file === "shaders/typo.glsl")?.detail ?? "", /amout/);
    assert.match(results.find((r) => r.file === "shaders/typo2.glsl")?.detail ?? "", /missing2/);
  }
});

test("second ensure call serves from cache without recompiling", async () => {
  const rootDir = path.join(TMP, "ws2");
  fs.mkdirSync(path.join(rootDir, ".cuthol"), { recursive: true });
  const first = await ensureShaderCompileCache({
    rootDir,
    shaders: [{ file: "shaders/good.glsl", source: GOOD_GLSL }],
  });
  assert.equal(first[0].cached, false);
  const second = await ensureShaderCompileCache({
    rootDir,
    shaders: [{ file: "shaders/good.glsl", source: GOOD_GLSL }],
  });
  assert.equal(second[0].cached, true);
  assert.ok(second[0].ok);
});

test("check reads the cache: cached failure is ERROR, missing hash is static scan plus WARN", async () => {
  const rootDir = path.join(TMP, "ws3");
  fs.mkdirSync(path.join(rootDir, ".cuthol"), { recursive: true });
  // No cache yet: static scan passes on the typo (balanced), so WARN G711.
  const uncached = checkEffectDefinition(
    { kind: "ext:shdemo/typo", params: {}, animatable: [], backend: "shader", shaderFile: { file: "shaders/typo.glsl", source: TYPO_GLSL } },
    { projectDir: rootDir }
  );
  assert.ok(uncached.some((f) => f.code === "CUTHOL-G711"), `expected G711, got ${JSON.stringify(uncached)}`);
  assert.ok(!uncached.some((f) => f.severity === "ERROR"), "no ERROR before the browser compile");
  // Populate the cache (what `extension enable` will do after its hook lands).
  await ensureShaderCompileCache({
    rootDir,
    shaders: [{ file: "shaders/typo.glsl", source: TYPO_GLSL }],
  });
  const cachedBad = checkEffectDefinition(
    { kind: "ext:shdemo/typo", params: {}, animatable: [], backend: "shader", shaderFile: { file: "shaders/typo.glsl", source: TYPO_GLSL } },
    { projectDir: rootDir }
  );
  const err = cachedBad.find((f) => f.severity === "ERROR");
  assert.ok(err && err.code === "CUTHOL-G710", `expected G710, got ${JSON.stringify(cachedBad)}`);
  assert.match(err.message, /typo\.glsl/);
  assert.match(err.message, /line 5/);
  // Cached good shader: clean.
  await ensureShaderCompileCache({
    rootDir,
    shaders: [{ file: "shaders/good.glsl", source: GOOD_GLSL }],
  });
  const clean = checkEffectDefinition(
    { kind: "ext:shdemo/good", params: {}, animatable: [], backend: "shader", shaderFile: { file: "shaders/good.glsl", source: GOOD_GLSL } },
    { projectDir: rootDir }
  );
  assert.deepEqual(clean, []);
  // Lookup helper agrees with the cache file.
  assert.ok(lookupShaderCompileResult(rootDir, GOOD_GLSL)?.ok);
  assert.ok(lookupShaderCompileResult(rootDir, "other") === null);
});

test("cache hit reports the caller's own file name and extension", async () => {
  const rootDir = path.join(TMP, "wsremap");
  fs.mkdirSync(path.join(rootDir, ".cuthol"), { recursive: true });
  // Extension `bad` compiles first and stores the failure under its file name.
  const first = await ensureShaderCompileCache({
    rootDir,
    shaders: [{ file: "shaders/a.glsl", source: TYPO_GLSL, ext: "bad" }],
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].cached, false);
  assert.equal(first[0].file, "shaders/a.glsl");
  assert.equal(first[0].ext, "bad");
  assert.ok(!first[0].ok, "typo fails fresh");
  // Extension `mixed` reuses the same bad bytes as `shaders/b.glsl`: the
  // cached hit must name the caller's file and extension, not the storer's.
  const second = await ensureShaderCompileCache({
    rootDir,
    shaders: [
      { file: "shaders/a.glsl", source: GOOD_GLSL, ext: "mixed" },
      { file: "shaders/b.glsl", source: TYPO_GLSL, ext: "mixed" },
    ],
  });
  assert.equal(second.length, 2);
  const bad = second.find((r) => !r.ok);
  assert.ok(bad, "expected one failure");
  assert.equal(bad.cached, true, "the typo came from the cache");
  assert.equal(bad.file, "shaders/b.glsl", `failure must name the caller's file, got ${bad.file}`);
  assert.equal(bad.ext, "mixed", `failure must name the caller's extension, got ${bad.ext}`);
});
