// Embedded shader-pass page (served by the worker over HTTP on 127.0.0.1).
// Kept as a string constant so the built `dist` needs no extra asset copy:
// the worker imports this module and serves the text directly.
export const SHADER_PAGE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>shader pass</title></head>
<body>
<canvas id="c"></canvas>
<script>
"use strict";
let gl = null, prog = null, fbo = null, outTex = null;
let W = 0, H = 0, IS16 = false, INV = 1 / 255, LOC = {};
let HEADER_LINES = 0;
// Stacked shader steps share each page: two pull loops run concurrently on
// the same GL context, so fetch/program/render must be atomic per frame and
// programs are cached by phase hash (a recompile per frame would stall).
let PROGS = {}, CUR = "", RLOCK = Promise.resolve();

function fail(msg) {
  window.__shaderError = String(msg);
  throw new Error(msg);
}

function stripReservedDecls(src) {
  // Blank reserved lines instead of removing them: frag line numbers stay
  // aligned with the user's source lines, so line= in a compile error
  // names the real .glsl line.
  return src.split("\\n").map((ln) => /^\\s*uniform\\s+\\w+\\s+(time|ratio|progress)\\s*;/.test(ln) ? "" : ln).join("\\n");
}

function buildSources(userSrc, is16) {
  const head = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "precision highp usampler2D;",
    "uniform usampler2D u_input;",
    "uniform int u_w;",
    "uniform int u_h;",
    "uniform float time;",
    "uniform float ratio;",
    "vec4 getInput(vec2 uv) {",
    "  float fx = clamp(uv.x, 0.0, 1.0) * float(u_w);",
    "  float fy = clamp(1.0 - uv.y, 0.0, 1.0) * float(u_h);",
    "  ivec2 p = ivec2(min(int(fx), u_w - 1), min(int(fy), u_h - 1));",
    "  return vec4(texelFetch(u_input, p, 0)) * " + (is16 ? "(1.0/65535.0)" : "(1.0/255.0)") + ";",
    "}",
  ];
  HEADER_LINES = head.length;
  const vert = "#version 300 es\\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float((gl_VertexID&2)));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";
  const frag = head.join("\\n") + "\\n" + stripReservedDecls(userSrc)
    + "\\nout vec4 o;\\nvoid main(){o=effect(vec2(gl_FragCoord.x/float(u_w),gl_FragCoord.y/float(u_h)));}";
  return { vert, frag };
}

function compileOne(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || "compile failed";
    throw new Error(log);
  }
  return sh;
}

function useProgram(progHash, userSrc, width, height, is16) {
  const canvas = document.getElementById("c");
  if (!gl) {
    canvas.width = width; canvas.height = height;
    gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) fail("webgl2 unavailable");
    if (!gl.getExtension("EXT_color_buffer_float")) fail("EXT_color_buffer_float unavailable");
  }
  const hit = PROGS[progHash];
  if (hit && hit.W === width && hit.H === height && hit.IS16 === is16) {
    prog = hit.prog; fbo = hit.fbo; outTex = hit.outTex; LOC = hit.LOC;
    W = width; H = height; IS16 = is16; INV = is16 ? 1 / 65535 : 1 / 255;
    window.__inputTex = hit.inputTex;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, W, H);
    CUR = progHash;
    window.__ready = true;
    return;
  }
  canvas.width = width; canvas.height = height;
  W = width; H = height; IS16 = is16; INV = is16 ? 1 / 65535 : 1 / 255;
  const { vert, frag } = buildSources(userSrc, is16);
  let vs, fs;
  try {
    vs = compileOne(gl.VERTEX_SHADER, vert);
  } catch (e) { throw new Error("vertex: " + e.message); }
  try {
    fs = compileOne(gl.FRAGMENT_SHADER, frag);
  } catch (e) {
    const m = /ERROR:\\s*\\d+:(\\d+)/.exec(e.message);
    const line = m ? Math.max(1, Number(m[1]) - HEADER_LINES) : 0;
    throw new Error(e.message + " line=" + line);
  }
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + (gl.getProgramInfoLog(p) || "failed"));
  prog = p;
  gl.useProgram(prog);
  outTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, outTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
  fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail("RGBA32F framebuffer incomplete");
  gl.viewport(0, 0, W, H);
  LOC = {};
  for (const name of ["u_input", "u_w", "u_h", "time", "ratio"]) LOC[name] = gl.getUniformLocation(prog, name);
  gl.uniform1i(LOC["u_input"], 0);
  gl.uniform1i(LOC["u_w"], W);
  gl.uniform1i(LOC["u_h"], H);
  gl.uniform1f(LOC["ratio"], W / H);
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  window.__inputTex = tex;
  PROGS[progHash] = { prog, fbo, outTex, LOC: Object.assign({}, LOC), inputTex: tex, W, H, IS16 };
  CUR = progHash;
  window.__ready = true;
}

window.__programShader = function (userSrc, width, height, is16, progHash) {
  const key = progHash || "__warmup";
  const run = RLOCK.then(() => { useProgram(key, userSrc, width, height, is16); return true; });
  RLOCK = run.then(() => undefined, () => undefined);
  return run;
};

function setUniforms(time, values) {
  gl.uniform1f(LOC["time"], time);
  for (const [name, spec] of Object.entries(values || {})) {
    let loc = LOC["p_" + name];
    if (loc === undefined) {
      loc = gl.getUniformLocation(prog, name);
      LOC["p_" + name] = loc;
    }
    if (loc === null) continue;
    const t = spec.t;
    if (t === "i") gl.uniform1i(loc, Math.round(spec.v));
    else if (t === "v2") gl.uniform2f(loc, spec.vec[0], spec.vec[1]);
    else if (t === "v3") gl.uniform3f(loc, spec.vec[0], spec.vec[1], spec.vec[2]);
    else if (t === "v4") gl.uniform4f(loc, spec.vec[0], spec.vec[1], spec.vec[2], spec.vec[3]);
    else if (t === "i2") gl.uniform2i(loc, Math.round(spec.vec[0]), Math.round(spec.vec[1]));
    else if (t === "i3") gl.uniform3i(loc, Math.round(spec.vec[0]), Math.round(spec.vec[1]), Math.round(spec.vec[2]));
    else if (t === "i4") gl.uniform4i(loc, Math.round(spec.vec[0]), Math.round(spec.vec[1]), Math.round(spec.vec[2]), Math.round(spec.vec[3]));
    else gl.uniform1f(loc, spec.v);
  }
}

window.__renderFrame = function (data, time, values) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, window.__inputTex);
  if (IS16) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, W, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, W, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bytes);
  }
  setUniforms(time, values);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Float32Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
  if (IS16) {
    const out = new Uint16Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const s = (H - 1 - y) * W * 4, d = y * W * 4;
      for (let i = 0; i < W * 4; i++) {
        let v = Math.round(px[s + i] * 65535);
        out[d + i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
      }
    }
    return out.buffer.slice(0);
  }
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const s = (H - 1 - y) * W * 4, d = y * W * 4;
    for (let i = 0; i < W * 4; i++) {
      let v = Math.round(px[s + i] * 255);
      out[d + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out.buffer.slice(0);
};

window.__progHash = "";
window.__pullLoop = async function (phaseId, progHash, source, w, h, is16) {
  for (;;) {
    let r;
    // Never serve frame/result traffic from the HTTP cache: a cached 410
    // ("no more frames") from a previous job would end this job's loop
    // before it shades a single frame (batched pre-passes share one browser).
    try { r = await fetch("frame?id=" + encodeURIComponent(phaseId), { cache: "no-store" }); } catch (e) { await new Promise((s) => setTimeout(s, 100)); continue; }
    if (r.status === 410) return "done";
    if (r.status === 204) { await new Promise((s) => setTimeout(s, 50)); continue; }
    if (!r.ok) fail("frame: HTTP " + r.status);
    const idx = r.headers.get("X-Index");
    const time = Number(r.headers.get("X-Time") || "0");
    const values = JSON.parse(r.headers.get("X-Uniforms") || "{}");
    const frameHash = r.headers.get("X-Prog") || progHash;
    const buf = await r.arrayBuffer();
    // The program check and the render hold one page-wide lock: two stacked
    // phases pull on the same page, and without the lock a sibling phase's
    // re-program lands between this frame's check and its draw, so the frame
    // renders under the sibling's program (chained passes run twice).
    let pixels;
    try {
      pixels = await (function (run) { const p = RLOCK.then(run); RLOCK = p.then(() => undefined, () => undefined); return p; })(() => {
        if (CUR !== frameHash) useProgram(frameHash, source, w, h, is16);
        return window.__renderFrame(new Uint8Array(buf), time, values);
      });
    } catch (e) { window.__shaderError = String((e && e.message) || e); throw e; }
    const post = await fetch("result?id=" + encodeURIComponent(phaseId), {
      method: "POST",
      headers: { "X-Index": idx || "0", "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      body: new Blob([pixels]),
      cache: "no-store",
    });
    if (!post.ok) fail("result: HTTP " + post.status);
  }
};
</` + `script>
</body>
</html>`;

/**
 * Module-level mirror of the page's reserved-uniform rule, exported for tests
 * (the page itself is a string asset and its behaviour is unchanged).
 */
export const SHADER_PAGE_RESERVED_RE = /^\s*uniform\s+\w+\s+(time|ratio|progress)\s*;/;

export function stripPageReservedDecls(src: string): string {
  return src.split("\n").map((ln) => (SHADER_PAGE_RESERVED_RE.test(ln) ? "" : ln)).join("\n");
}

/** Number of fragment header lines the page prepends (HEADER_LINES). */
export function pageHeaderLineCount(is16: boolean): number {
  void is16;
  return 15;
}
