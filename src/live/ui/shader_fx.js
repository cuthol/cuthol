/* Live shader fx: runs the same .glsl sources as the render in the window's
   WebGL2 canvas. Reserved-uniform stripping matches the render page
   (stripReservedDecls in shader_page.ts): reserved lines are blanked, not
   removed, so compile-error lines map back to the user's .glsl line. */

export function stripReservedDecls(src) {
  return src.split("\n").map((ln) => /^\s*uniform\s+\w+\s+(time|ratio|progress)\s*;/.test(ln) ? "" : ln).join("\n");
}

export function buildLiveSources(userSrc) {
  const head = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "uniform sampler2D u_input;",
    "uniform int u_w;",
    "uniform int u_h;",
    "uniform float time;",
    "uniform float ratio;",
    "uniform float u_flipY;",
    "vec4 getInput(vec2 uv) {",
    "  vec2 c = clamp(uv, 0.0, 1.0);",
    // First pass reads the freshly uploaded proxy frame (row 0 is the top);
    // later passes read the previous pass's framebuffer, which already has
    // the frame orientation, so only the first pass flips.
    "  return texture(u_input, vec2(c.x, mix(c.y, 1.0 - c.y, u_flipY)));",
    "}",
  ];
  const vert = "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float((gl_VertexID&2)));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";
  const frag = head.join("\n") + "\n" + stripReservedDecls(userSrc)
    + "\nout vec4 o;\nvoid main(){o=effect(vec2(gl_FragCoord.x/float(u_w),gl_FragCoord.y/float(u_h)));}";
  return { vert, frag, headerLines: head.length };
}

const SHADE_VERT = "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float((gl_VertexID&2)));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";

/** Quantise item-local seconds to the frame grid like the render (frameIndex / fps). */
export function quantiseTime(localSec, fps) {
  const f = fps > 0 ? fps : 30;
  return Math.floor(localSec * f + 1e-6) / f;
}

export function compileProgram(gl, vertSrc, fragSrc) {
  const sh = (t, s) => {
    const h = gl.createShader(t);
    gl.shaderSource(h, s);
    gl.compileShader(h);
    if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(h) || "compile failed";
      throw new Error(log);
    }
    return h;
  };
  const vs = sh(gl.VERTEX_SHADER, vertSrc);
  let fs;
  try {
    fs = sh(gl.FRAGMENT_SHADER, fragSrc);
  } catch (e) {
    const m = /ERROR:\s*\d+:(\d+)/.exec(e.message);
    const line = m ? Number(m[1]) : 0;
    throw new Error(`${e.message} line=${line}`);
  }
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + (gl.getProgramInfoLog(p) || "failed"));
  return p;
}

/** Map a raw compile log line number (fragment) back to the user's .glsl line. */
export function mapFragLineToUser(fragLine, headerLines) {
  return Math.max(1, Number(fragLine) - headerLines);
}

export function createShaderFx(ctx) {
  const cache = new Map(); // program key -> {prog, headerLines, fragSrc}
  const state = { itemId: null, key: null, progs: [], entries: [], error: null, canvas: null, gl: null, glProgs: [], video: null, raf: 0, fps: { n: 0, t0: 0, value: 0 }, geom: null, gradeCanvas: null, upload: null };

  /** Crop + fit + mirror mapping of the proxy frame (render: crop, then fit to targetW×targetH, then mirror). */
  function setGeometry(geom) { state.geom = geom; }
  /** Grade canvas to sample instead of the raw video when the item is graded (render grades before fx). */
  function setGradeSource(canvas) { state.gradeCanvas = canvas || null; }

  function programKey(itemId, entries) {
    return `${itemId}|${entries.map((e) => `${e.id}:${e.hash}`).join(",")}`;
  }

  async function fetchEntries(itemId) {
    const r = await ctx.api.get(`/api/live/shader?item=${encodeURIComponent(itemId)}`);
    if (!r || !r.ok) return null;
    return r.shaders ?? [];
  }

  function ensureGl(canvas) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    gl.clearColor(0, 0, 0, 0);
    return gl;
  }

  const BLIT_FRAG = "#version 300 es\nprecision highp float;uniform sampler2D u_tex;out vec4 o;void main(){ivec2 p=ivec2(gl_FragCoord.xy);o=texelFetch(u_tex,p,0);}";

  // Upload pass: crop (fractions, y-down) -> fit into the canvas (target aspect) -> mirror.
  // 0 = cover (scale up + centre crop), 1 = contain (scale down + transparent pad), 2 = fill (stretch).
  const UPLOAD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform vec4 u_crop;
uniform vec2 u_canvas;
uniform int u_fit;
uniform vec2 u_mirror;
out vec4 o;
void main(){
  // Note the GL row order: buffer row 0 (fragY 0) is the displayed top, so
  // the canvas top samples the source top; the shader passes' y-up uv then
  // matches the render's, and the final blit displays upright.
  vec2 f = vec2(gl_FragCoord.x / u_canvas.x, gl_FragCoord.y / u_canvas.y);
  vec2 box0 = u_crop.xy;
  vec2 box1 = vec2(1.0 - u_crop.z, 1.0 - u_crop.w);
  vec2 boxPx = max(box1 - box0, vec2(1e-6)) * u_srcSize;
  vec2 centerPx = (box0 + box1) * 0.5 * u_srcSize;
  vec2 d;
  if (u_fit == 2) {
    d = (f - 0.5) * boxPx;
  } else {
    // s = source px per canvas px: cover shrinks the sample step so the box
    // overflows the canvas (min), contain enlarges it so the box fits (max).
    float s = u_fit == 0 ? min(boxPx.x / u_canvas.x, boxPx.y / u_canvas.y)
                         : max(boxPx.x / u_canvas.x, boxPx.y / u_canvas.y);
    d = (f - 0.5) * s * u_canvas;
  }
  vec2 uv = (centerPx + d * u_mirror) / u_srcSize;
  // Contain pads are transparent where the canvas pixel falls outside the
  // crop box (not merely outside the source).
  vec2 brel = (centerPx + d * u_mirror - box0 * u_srcSize) / boxPx;
  if (brel.x < 0.0 || brel.x > 1.0 || brel.y < 0.0 || brel.y > 1.0) o = vec4(0.0);
  else o = texture(u_src, uv);
}`;

  function buildUpload(gl) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, SHADE_VERT);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, UPLOAD_FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error("upload: " + (gl.getShaderInfoLog(fs) || "failed"));
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("upload link failed");
    return p;
  }

  function buildBlit(gl) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, SHADE_VERT);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, BLIT_FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error("blit: " + (gl.getShaderInfoLog(fs) || "failed"));
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("blit link failed");
    return p;
  }

  async function attach(video, itemId) {
    const entries = await fetchEntries(itemId);
    if (!entries || entries.length === 0) { stop(); return { shaded: false }; }
    const key = programKey(itemId, entries);
    const hit = cache.get(key);
    if (hit && hit.ok === false) {
      state.itemId = itemId; state.key = key; state.error = hit.error;
      return { shaded: false, error: hit.error };
    }
    // A key change rebuilds the GL context; the geometry/grade set by the
    // caller this tick must survive the rebuild (paused, no later tick).
    const keepGeom = state.geom, keepGrade = state.gradeCanvas;
    if (state.canvas && state.key !== key) stop();
    state.geom = keepGeom; state.gradeCanvas = keepGrade;
    if (!ensureCanvas(video)) return { shaded: false, cpu: true };
    const gl = state.gl;
    try {
      const progs = entries.map((e) => {
        const { vert, frag, headerLines } = buildLiveSources(e.source);
        return { entry: e, prog: compileProgram(gl, vert, frag), headerLines };
      });
      for (const old of state.glProgs) { try { gl.deleteProgram(old.prog); } catch {} }
      cache.set(key, { ok: true });
      state.itemId = itemId; state.key = key; state.progs = progs; state.entries = entries;
      state.glProgs = progs; state.video = video; state.error = null;
      if (!state.blit) state.blit = buildBlit(gl);
      return { shaded: true, count: progs.length };
    } catch (e) {
      const err = { fx: entries[0]?.id ?? "fx", detail: String((e && e.message) || e) };
      cache.set(key, { ok: false, error: err });
      // No shaded canvas on compile failure: the fallback is the unshaded
      // video, so a canvas created above must not stay in the DOM.
      if (state.canvas) { try { state.canvas.remove(); } catch {} state.canvas = null; state.gl = null; }
      cancelAnimationFrame(state.raf);
      state.raf = 0;
      state.itemId = itemId; state.key = key; state.error = err; state.progs = []; state.glProgs = []; state.video = null;
      return { shaded: false, error: err };
    }
  }

  function ensureCanvas(video) {
    if (state.canvas) return true;
    const canvas = document.createElement("canvas");
    canvas.className = "pv-shader";
    const slots = video.parentElement ? [...video.parentElement.querySelectorAll(".pv-video")] : [video];
    (slots[slots.length - 1] ?? video).insertAdjacentElement("afterend", canvas);
    const gl = ensureGl(canvas);
    if (!gl) { canvas.remove(); return false; }
    state.canvas = canvas;
    state.gl = gl;
    state.glProgs = [];
    return true;
  }

  function uniformValue(entry, name, localMs, envelopes) {
    const param = entry.params?.[name];
    const base = typeof param === "number" ? param : Number(param ?? 0);
    const env = (envelopes ?? []).find((e) => e.parameter === `fx.${entry.id}.${name}`);
    if (!env || !Array.isArray(env.points) || env.points.length === 0) return Number.isFinite(base) ? base : 0;
    // Reuse the preview's envelope port via the entry's points (linear scan).
    const pts = env.points;
    if (localMs <= pts[0].offset_ms) return pts[0].value;
    if (localMs >= pts[pts.length - 1].offset_ms) return pts[pts.length - 1].value;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (localMs >= a.offset_ms && localMs <= b.offset_ms) {
        const span = Math.max(1, b.offset_ms - a.offset_ms);
        return a.value + ((b.value - a.value) * (localMs - a.offset_ms)) / span;
      }
    }
    return pts[pts.length - 1].value;
  }

  function drawFrame(localSec, fps, envelopes) {
    const gl = state.gl, v = state.video;
    if (!gl || !v || !state.glProgs.length) return;
    const visible = v.style.visibility !== "hidden" && v.readyState >= 2 && v.videoWidth > 0;
    state.canvas.style.visibility = visible ? "visible" : "hidden";
    if (!visible) return;
    // Target aspect is the stage aspect (render: targetW×targetH follows the
    // render size), not the proxy aspect: a portrait proxy still shades a
    // landscape target. The CSS box already follows placement.
    const aspect = (state.geom && state.geom.aspect > 0) ? state.geom.aspect : (v.videoWidth / Math.max(1, v.videoHeight));
    const cw = Math.max(8, Math.round((v.videoHeight * aspect) / 2) * 2), ch = v.videoHeight;
    if (state.canvas.width !== cw || state.canvas.height !== ch) {
      state.canvas.width = cw; state.canvas.height = ch;
    }
    // Overlay this clip's own slot exactly (placement, crop clip-path and
    // dissolve opacity ride on the video element): the canvas buffer holds
    // the same clip frame, so it mirrors the slot's style.
    try {
      const cs = state.canvas.style, vs = v.style;
      if (cs.position !== "absolute") { cs.position = "absolute"; cs.inset = "0"; cs.width = "100%"; cs.height = "100%"; }
      if (cs.transform !== vs.transform) cs.transform = vs.transform;
      if (cs.opacity !== vs.opacity) cs.opacity = vs.opacity;
      if (cs.clipPath !== vs.clipPath) cs.clipPath = vs.clipPath;
      if (cs.objectFit !== vs.objectFit && vs.objectFit) cs.objectFit = vs.objectFit;
    } catch {}
    const w = state.canvas.width, h = state.canvas.height;
    const tq = quantiseTime(localSec, fps);
    const localMs = tq * 1000;
    // Render order: grade first, then the fx stage. Sample the grade canvas
    // when it shows this clip, else the raw video.
    const srcEl = (state.gradeCanvas && state.gradeCanvas.width > 0) ? state.gradeCanvas : v;
    const srcW = srcEl.videoWidth || srcEl.width, srcH = srcEl.videoHeight || srcEl.height;
    if (!srcW || !srcH) return;
    let srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcEl); }
    catch { gl.deleteTexture(srcTex); return; }
    if (!state.upload) state.upload = buildUpload(gl);
    let fb = null;
    // Crop + fit + mirror into the target-aspect canvas, like the render.
    const g = state.geom || {};
    const crop = g.crop || [0, 0, 0, 0];
    const fit = g.fit == null ? 0 : g.fit;
    const mirror = g.mirror || [1, 1];
    const upTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, upTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!fb) fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, upTex, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(state.upload);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(state.upload, "u_src"), 0);
    gl.uniform2f(gl.getUniformLocation(state.upload, "u_srcSize"), srcW, srcH);
    gl.uniform4f(gl.getUniformLocation(state.upload, "u_crop"), crop[0], crop[1], crop[2], crop[3]);
    gl.uniform2f(gl.getUniformLocation(state.upload, "u_canvas"), w, h);
    gl.uniform1i(gl.getUniformLocation(state.upload, "u_fit"), fit);
    gl.uniform2f(gl.getUniformLocation(state.upload, "u_mirror"), mirror[0], mirror[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.deleteTexture(srcTex);
    srcTex = upTex;
    const ratio = w / Math.max(1, h);
    let ping = null;
    try {
      let first = true;
      for (const rec of state.glProgs) {
        const dst = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, dst);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (!fb) fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
        gl.viewport(0, 0, w, h);
        gl.useProgram(rec.prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.uniform1i(gl.getUniformLocation(rec.prog, "u_input"), 0);
        gl.uniform1i(gl.getUniformLocation(rec.prog, "u_w"), w);
        gl.uniform1i(gl.getUniformLocation(rec.prog, "u_h"), h);
        gl.uniform1f(gl.getUniformLocation(rec.prog, "time"), tq);
        gl.uniform1f(gl.getUniformLocation(rec.prog, "ratio"), ratio);
        gl.uniform1f(gl.getUniformLocation(rec.prog, "u_flipY"), first ? 1 : 0);
        first = false;
        for (const u of rec.entry.uniforms ?? []) {
          const loc = gl.getUniformLocation(rec.prog, u);
          if (loc) gl.uniform1f(loc, uniformValue(rec.entry, u, localMs, envelopes));
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.deleteTexture(srcTex);
        srcTex = dst;
        if (ping) gl.deleteTexture(ping);
        ping = null;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(state.blit);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(gl.getUniformLocation(state.blit, "u_tex"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      if (fb) gl.deleteFramebuffer(fb);
      if (srcTex) gl.deleteTexture(srcTex);
    }
    const f = state.fps;
    f.n++;
    const now = performance.now();
    if (now - f.t0 > 1000) { f.value = Math.round((f.n * 1000) / Math.max(1, now - f.t0)); f.n = 0; f.t0 = now; }
  }

  function loop(localSecFn, fpsFn, envFn) {
    cancelAnimationFrame(state.raf);
    const tick = () => { try { drawFrame(localSecFn(), fpsFn(), envFn()); } catch {} state.raf = requestAnimationFrame(tick); };
    state.raf = requestAnimationFrame(tick);
  }

  function capture(maxW = 64) {
    const gl = state.gl;
    if (!gl || !state.canvas) return null;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (!w || !h) return null;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const dw = Math.min(maxW, w), dh = Math.max(1, Math.round((h * dw) / w));
    const out = [];
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(w - 1, Math.floor((x / dw) * w));
        const sy = Math.min(h - 1, Math.floor((y / dh) * h));
        const o = ((h - 1 - sy) * w + sx) * 4;
        out.push(px[o], px[o + 1], px[o + 2]);
      }
    }
    return { w: dw, h: dh, data: out };
  }

  function stop() {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (state.canvas) { state.canvas.remove(); state.canvas = null; state.gl = null; state.glProgs = []; state.blit = null; state.upload = null; }
    state.video = null;
    state.itemId = null; state.key = null; state.progs = []; state.entries = []; state.error = null;
    state.geom = null; state.gradeCanvas = null;
  }

  return { state, cache, attach, stop, drawFrame, loop, capture, programKey, setGeometry, setGradeSource, stripReservedDecls, buildLiveSources, mapFragLineToUser, quantiseTime };
}
