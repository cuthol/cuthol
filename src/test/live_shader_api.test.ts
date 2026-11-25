/**
 * Live shader sources endpoint + Live wrapper equality
 * (`src/test/live_shader_api.test.ts`): unknown item is 404 (G730), a clip
 * without shader fx answers an empty list, enabled shader entries come back in
 * order with source/uniforms/params/hash while disabled entries are skipped,
 * and the Live wrapper strips reserved uniforms exactly like the render page
 * with an equal line mapping.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";
import { addSpineFx, listSpineFx, setSpineFx } from "../sequence/spine_fx.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { liveShaderSources } from "../live/live_shader_api.js";
import { SHADER_PAGE_HTML, stripPageReservedDecls, pageHeaderLineCount } from "../render/shader_page.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-shader-"));
test.after(() => rmRetrySync(TMP));

const GLSL_A = `precision highp float;
uniform float time;
uniform float ratio;
// @range(0, 1)
uniform float amount; // = 0.5
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv + amount); }
`;

const GLSL_B = `precision highp float;
uniform float time;
uniform float ratio;
uniform vec2 center; // = (0.3, 0.7)
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return getInput(uv - center); }
`;

function media(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
    "-i", "testsrc2=size=160x120:rate=10:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outPath],
    { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? proc.error}`);
}

function makeWs(name: string): { wsDir: string; clipId: string } {
  const wsDir = path.join(TMP, name);
  fs.rmSync(wsDir, { recursive: true, force: true });
  const src = path.join(TMP, "src.mp4");
  media(src);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 10 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [src] });
  const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 2000 });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shlive");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "shaders", "a.glsl"), GLSL_A);
  fs.writeFileSync(path.join(extDir, "shaders", "b.glsl"), GLSL_B);
  fs.writeFileSync(path.join(extDir, "cuthol-extension.json"), JSON.stringify({
    name: "shlive", version: "1.0.0", description: "live proof",
    fx: {
      a: { description: "a", backend: "shader", shader: "shaders/a.glsl" },
      b: { description: "b", backend: "shader", shader: "shaders/b.glsl" },
    },
  }));
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shlive" });
  return { wsDir, clipId: clip.id };
}

test("unknown item is 404 with G730", () => {
  const { wsDir } = makeWs("unknown");
  const out = liveShaderSources(wsDir, "sp_zzz");
  assert.equal(out.status, 404);
  assert.match(String((out.json as { message: string }).message), /CUTHOL-G730/);
});

test("clip without shader fx answers an empty list", () => {
  const { wsDir, clipId } = makeWs("empty");
  const out = liveShaderSources(wsDir, clipId);
  assert.equal(out.status, 200);
  assert.deepEqual((out.json as { shaders: unknown[] }).shaders, []);
});

test("ordered shader sources skip disabled entries", () => {
  const { wsDir, clipId } = makeWs("ordered");
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shlive/a", params: { amount: 0.25 } });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ext:shlive/b", params: { center_x: 0.1, center_y: 0.2 } });
  addSpineFx({ workspaceDir: wsDir, item: clipId, kind: "ffmpeg", params: { filter: "eq=brightness=0.01" } });
  const out = liveShaderSources(wsDir, clipId);
  assert.equal(out.status, 200);
  const body = out.json as {
    ok: boolean; item: string;
    shaders: { id: string; kind: string; file: string; source: string; hash: string; uniforms: string[]; params: Record<string, number> }[];
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.shaders.map((s) => s.kind), ["ext:shlive/a", "ext:shlive/b"]);
  assert.deepEqual(body.shaders[0].uniforms, ["amount"]);
  assert.deepEqual(body.shaders[1].uniforms.sort(), ["center_x", "center_y"]);
  assert.equal(body.shaders[0].params.amount, 0.25);
  assert.ok(body.shaders[0].source.includes("effect(vec2 uv)"));
  assert.match(body.shaders[0].hash, /^[0-9a-f]{16}$/);
  // Disable the first entry: only the second shader is served.
  const listed = listSpineFx({ workspaceDir: wsDir, item: clipId });
  const firstId = listed.fx.find((f) => f.kind === "ext:shlive/a")!.id;
  setSpineFx({ workspaceDir: wsDir, item: clipId, fxId: firstId, enabled: false });
  const out2 = liveShaderSources(wsDir, clipId);
  assert.equal(out2.status, 200);
  assert.deepEqual((out2.json as { shaders: { kind: string }[] }).shaders.map((s) => s.kind), ["ext:shlive/b"]);
});

function extractFn(source: string, name: string): string {
  const m = source.match(new RegExp(`function ${name}[\\s\\S]*?\\n\\}`));
  assert.ok(m?.[0], `${name} found`);
  return m[0];
}

function extractPageFns(): { strip: (src: string) => string; build: (userSrc: string, is16: boolean) => { frag: string } } {
  const stripSrc = extractFn(SHADER_PAGE_HTML, "stripReservedDecls");
  const buildSrc = extractFn(SHADER_PAGE_HTML, "buildSources");
  const factory = new Function(`${stripSrc}\n${buildSrc}\nlet HEADER_LINES = 0;\nreturn { stripReservedDecls, buildSources };`);
  const f = factory() as { stripReservedDecls: (src: string) => string; buildSources: (u: string, i: boolean) => { frag: string } };
  return { strip: f.stripReservedDecls, build: f.buildSources };
}

function extractLiveFns(): {
  strip: (src: string) => string;
  build: (userSrc: string) => { frag: string; headerLines: number };
} {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const liveSrc = fs.readFileSync(path.join(here, "..", "..", "src", "live", "ui", "shader_fx.js"), "utf8");
  const stripSrc = extractFn(liveSrc, "stripReservedDecls");
  const buildSrc = extractFn(liveSrc, "buildLiveSources");
  const factory = new Function(`${stripSrc}\n${buildSrc}\nreturn { stripReservedDecls, buildLiveSources };`);
  const f = factory() as {
    stripReservedDecls: (src: string) => string;
    buildLiveSources: (u: string) => { frag: string; headerLines: number };
  };
  return { strip: f.stripReservedDecls, build: f.buildLiveSources };
}

test("Live wrapper strips reserved uniforms exactly like the render page", () => {
  const page = extractPageFns();
  const live = extractLiveFns();
  const samples = [
    "uniform float time;\nuniform float amount; // = 0.5\nvec4 effect(vec2 uv){return vec4(amount);}\n",
    "  uniform   vec2   ratio  ;\nuniform float progress;\nuniform float x;\n",
    GLSL_A,
  ];
  for (const src of samples) {
    assert.equal(live.strip(src), page.strip(src), "stripped user section equal");
    assert.equal(live.strip(src), stripPageReservedDecls(src), "module mirror equal");
  }
  // Line mapping is equal: frag line headerLines+N names user line N in both.
  const liveBuilt = live.build(GLSL_A);
  const pageBuilt = page.build(GLSL_A, false);
  const pageHeader = 15;
  assert.equal(pageHeaderLineCount(false), pageHeader);
  for (const userLine of [1, 3, 6]) {
    const pageFragLine = pageBuilt.frag.split("\n")[pageHeader + userLine - 1];
    const liveFragLine = liveBuilt.frag.split("\n")[liveBuilt.headerLines + userLine - 1];
    const want = GLSL_A.split("\n")[userLine - 1] === "" ? "" : GLSL_A.split("\n")[userLine - 1];
    void want;
    assert.equal(liveFragLine, pageFragLine, `user line ${userLine} maps equally`);
  }
});
