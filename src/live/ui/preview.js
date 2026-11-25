// preview region. Render-free live preview: the stage shows
// the sequence at the playhead without waiting for a render. Spine clips play
// through two <video> elements (one shows, the other preloads the next clip),
// compositions play in same-origin iframes seeked every frame, captions render
// as an HTML text layer, music/VO cues mix through WebAudio gains.
// Anything the stage cannot imitate (color grade, treatments, LUTs, extension
// effects) raises the "Approximate" badge with an "Exact frame" button.
import { DEFAULT_SHORTCUTS, loadShortcuts, matchShortcut, resolveShortcuts } from "./shortcuts.js";
import { createGrader } from "./color.js";
import { createShaderFx } from "./shader_fx.js";

const SPEEDS = [1, 2, 0.5];
const PROXY_POLL_MS = 2500;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dbToLin = (db) => (db === -Infinity ? 0 : Math.pow(10, (Number.isFinite(db) ? db : 0) / 20));

/** Port of cubicBezierY/cubicBezierU (src/core/easing.ts); same Newton + bisection solver. */
function cubicAt(b, u) {
  const [x1, y1, x2, y2] = b;
  const v = 1 - u;
  return {
    x: 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u,
    y: 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u,
    dx: 3 * v * v * x1 + 6 * v * u * (x2 - x1) + 3 * u * u * (1 - x2),
  };
}

function cubicBezierU(b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 16; i++) {
    const p = cubicAt(b, u);
    if (Math.abs(p.x - x) < 1e-9) break;
    if (Math.abs(p.dx) < 1e-9) break;
    u = Math.min(1, Math.max(0, u - (p.x - x) / p.dx));
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const p = cubicAt(b, u);
    if (Math.abs(p.x - x) < 1e-12) break;
    if (p.x < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return u;
}

function cubicBezierY(b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return cubicAt(b, cubicBezierU(b, x)).y;
}

/** Port of evaluateEnvelopeAt (src/sequence/spine_envelope.ts). */
function evalEnvelope(env, offsetMs) {
  const pts = env?.points ?? [];
  if (pts.length === 0) return 0;
  if (offsetMs <= pts[0].offset_ms) return pts[0].value;
  if (offsetMs >= pts[pts.length - 1].offset_ms) return pts[pts.length - 1].value;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (offsetMs >= a.offset_ms && offsetMs <= b.offset_ms) {
      const span = Math.max(1, b.offset_ms - a.offset_ms);
      const t = (offsetMs - a.offset_ms) / span;
      let e = t;
      switch (b.easing) {
        case "ease_in": e = t * t; break;
        case "ease_out": e = 1 - (1 - t) * (1 - t); break;
        case "ease_in_out": e = t * t * (3 - 2 * t); break;
        case "hold": e = offsetMs >= b.offset_ms ? 1 : 0; break;
        case "cubic_bezier": e = b.bezier ? cubicBezierY(b.bezier, t) : t; break;
        default: e = t; break;
      }
      return a.value + (b.value - a.value) * e;
    }
  }
  return pts[pts.length - 1].value;
}

function envValue(envelopes, parameter, offsetMs, fallback) {
  const env = (envelopes ?? []).find((e) => e.parameter === parameter);
  if (!env || !Array.isArray(env.points) || env.points.length === 0) return fallback;
  return evalEnvelope(env, offsetMs);
}

/** Port of buildNormalizedRampSegments + invertClipLocalMsToSourceOffset (src/sequence/spine_time.ts). */
function rampSegments(spanMs, fallbackRate, ramp) {
  const span = Math.max(1, spanMs);
  const base = clamp(fallbackRate, 0.1, 16);
  if (!ramp || ramp.length === 0) return [{ u0: 0, u1: span, r0: base, r1: base, dt: span / base }];
  const sorted = ramp.map((p) => ({ u: clamp(p.source_offset_ms, 0, span), r: clamp(p.rate, 0.1, 16) })).sort((a, b) => a.u - b.u);
  const pts = [];
  if (sorted[0].u > 0) pts.push({ u: 0, r: sorted[0].r });
  for (const p of sorted) {
    if (pts.length > 0 && Math.abs(pts[pts.length - 1].u - p.u) < 1e-6) pts[pts.length - 1].r = p.r;
    else pts.push(p);
  }
  if (pts[pts.length - 1].u < span) pts.push({ u: span, r: pts[pts.length - 1].r });
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const u0 = pts[i].u, u1 = pts[i + 1].u, r0 = pts[i].r, r1 = pts[i + 1].r;
    const du = u1 - u0;
    if (du <= 0) continue;
    const dt = Math.abs(r1 - r0) < 1e-6 ? du / r0 : (du / (r1 - r0)) * Math.log(r1 / r0);
    segs.push({ u0, u1, r0, r1, dt });
  }
  return segs;
}

/** Timeline-local ms -> source offset ms (exact inverse speed-ramp integral). */
function localToSourceOffset(clip, localMs) {
  const span = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  const ramp = clip.playback?.speed_ramp;
  if (!ramp || ramp.length === 0) return clamp(localMs * Math.max(0.01, clip.playback?.rate ?? 1), 0, span);
  const segs = rampSegments(span, clip.playback?.rate ?? 1, ramp);
  let rem = Math.max(0, localMs);
  for (const s of segs) {
    if (rem >= s.dt) rem -= s.dt;
    else {
      if (Math.abs(s.r1 - s.r0) < 1e-6) return s.u0 + s.r0 * rem;
      const k = (s.r1 - s.r0) / (s.u1 - s.u0);
      return s.u0 + (s.r0 / k) * (Math.exp(k * rem) - 1);
    }
  }
  return span;
}

/** Instantaneous playback rate at a source offset (for video.playbackRate). */
function rampRateAt(clip, sourceOffsetMs) {
  const span = Math.max(1, clip.source_out_ms - clip.source_in_ms);
  const base = clamp(clip.playback?.rate ?? 1, 0.1, 16);
  const ramp = clip.playback?.speed_ramp;
  if (!ramp || ramp.length === 0) return base;
  const segs = rampSegments(span, base, ramp);
  const u = clamp(sourceOffsetMs, 0, span);
  for (const s of segs) {
    if (u >= s.u0 && u <= s.u1) {
      const du = s.u1 - s.u0;
      if (du <= 0) return s.r1;
      return s.r0 + ((s.r1 - s.r0) * (u - s.u0)) / du;
    }
  }
  return segs.length ? segs[segs.length - 1].r1 : base;
}

/** Port of resolveCueStartMs (src/core/timeline.ts) incl. cue anchors. */
function cueStartMs(seq, cue, cueById) {
  if (cue.anchor?.ref) {
    const c = (seq.spine?.clips ?? []).find((x) => x.id === cue.anchor.ref);
    if (c) return c.timeline_in_ms + (cue.anchor.offset_ms ?? 0);
  }
  if (cue.cue_anchor?.ref && cueById) {
    const ref = cueById.get(cue.cue_anchor.ref);
    if (ref) return cueStartMs(seq, ref, cueById) + (cue.cue_anchor.offset_ms ?? 0);
  }
  return cue.at_ms ?? 0;
}

function cueCovers(startMs, endMs, t) {
  return t >= startMs && t < endMs;
}

const ADD_CHANNELS = ["x_pct", "y_pct", "rotation_deg"];

/** Layer value on one channel: the entry's own envelope when it has points, else its param, else identity. */
function motionLayerValue(entry, envelopes, fxId, channel, localMs, identity) {
  const env = (envelopes ?? []).find((e) => e.parameter === `fx.${fxId}.${channel}`);
  if (env && Array.isArray(env.points) && env.points.length > 0) return evalEnvelope(env, localMs);
  const raw = entry?.params?.[channel];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return identity;
}

// Mirrors resolvePlacementValuesAt (src/sequence/placement_resolve.ts): the base
// placement (or its placement.<channel> envelope) combined with the item's active
// motion fx entries in list order. Additive channels (x_pct, y_pct, rotation_deg)
// add the layer value; multiplicative channels (scale_x, scale_y, opacity) multiply
// it; opacity is clamped to [0, 1] (a no-op when already inside).
// Exported for tests; the window uses it internally.
export function effectivePlacement(item, localMs) {
  const p = item.placement ?? {};
  const envelopes = item.envelopes ?? [];
  const out = {
    x_pct: envValue(envelopes, "placement.x_pct", localMs, p.x_pct ?? 0),
    y_pct: envValue(envelopes, "placement.y_pct", localMs, p.y_pct ?? 0),
    scale_x: envValue(envelopes, "placement.scale_x", localMs, p.scale_x ?? 1),
    scale_y: envValue(envelopes, "placement.scale_y", localMs, p.scale_y ?? 1),
    rotation_deg: envValue(envelopes, "placement.rotation_deg", localMs, p.rotation_deg ?? 0),
    opacity: envValue(envelopes, "placement.opacity", localMs, p.opacity ?? 1),
  };
  for (const fx of item.fx ?? []) {
    if (!fx || fx.kind !== "motion" || fx.enabled === false) continue;
    for (const channel of ADD_CHANNELS) {
      out[channel] += motionLayerValue(fx, envelopes, fx.id, channel, localMs, 0);
    }
    for (const channel of ["scale_x", "scale_y", "opacity"]) {
      out[channel] *= motionLayerValue(fx, envelopes, fx.id, channel, localMs, 1);
    }
  }
  out.opacity = clamp(out.opacity, 0, 1);
  return {
    ...out,
    fit_mode: p.fit_mode ?? "cover",
    crop: p.crop ?? null,
    mirror_x: !!p.mirror_x,
    mirror_y: !!p.mirror_y,
  };
}

function formatTC(ms, fps) {
  const totalFrames = Math.max(0, Math.floor((ms / 1000) * fps));
  const ff = totalFrames % fps;
  const s = Math.floor(totalFrames / fps);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  return `${hh}:${mm}:${ss}:${String(ff).padStart(2, "0")}`;
}

/** Same-origin seek chain as the coordinate engine (src/compositor/coords_inpage.ts). t in seconds. */
function seekCompWindow(win, tSec) {
  try {
    const player = win.__player;
    if (player && typeof player.renderSeek === "function") {
      player.renderSeek(tSec);
      return;
    }
  } catch {}
  try {
    const hf = win.__hf;
    if (hf && typeof hf.seek === "function") {
      hf.seek(tSec);
      return;
    }
  } catch {}
  try {
    const player = win.__player;
    if (player && typeof player.seek === "function") {
      player.seek(tSec);
      return;
    }
  } catch {}
  try {
    const tls = win.__timelines || {};
    for (const key of Object.keys(tls)) {
      const tl = tls[key];
      if (!tl) continue;
      try {
        if (typeof tl.pause === "function") tl.pause();
      } catch {}
      try {
        if (typeof tl.seek === "function") tl.seek(tSec, false);
      } catch {}
    }
  } catch {}
}

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  const store = ctx.store;
  const api = ctx.api;

  root.innerHTML = `
  <div class="pv-wrap">
    <div class="pv-stage-outer">
      <div class="pv-stage" aria-label="Preview stage">
        <video class="pv-video" playsinline preload="auto"></video>
        <video class="pv-video" playsinline preload="auto" style="visibility:hidden"></video>
        <img class="pv-still" alt="" style="visibility:hidden">
        <img class="pv-still" alt="" style="visibility:hidden">
        <div class="pv-comp-layer"></div>
        <div class="pv-caption-layer"></div>
        <div class="pv-badge" hidden>Approximate</div>
        <button class="pv-exact-btn" hidden>Exact frame</button>
        <img class="pv-exact-img" hidden alt="Exact frame">
        <div class="pv-exact-loading" hidden><span class="pv-spinner" aria-hidden="true"></span>Rendering exact frame…</div>
        <div class="pv-proxy" hidden><span class="pv-proxy-text"></span><span class="pv-proxy-bar"><i></i></span></div>
        <div class="pv-loading">Waiting for sequence…</div>
      </div>
    </div>
    <div class="pv-bar">
      <button class="icon-btn" data-act="play" title="Play / pause (Space)" aria-label="Play or pause"></button>
      <button class="icon-btn" data-act="start" title="Go to start (Home)" aria-label="Go to start"></button>
      <button class="icon-btn" data-act="prev" title="Previous frame (Left)" aria-label="Previous frame"></button>
      <button class="icon-btn" data-act="next" title="Next frame (Right)" aria-label="Next frame"></button>
      <button class="icon-btn" data-act="end" title="Go to end (End)" aria-label="Go to end"></button>
      <span class="pv-time mono">00:00:00:00 / 00:00:00:00</span>
      <span class="pv-spacer"></span>
      <button class="pv-speed" data-act="speed" title="Playback speed">1×</button>
      <button class="icon-btn" data-act="mute" title="Mute" aria-label="Mute" aria-pressed="false"></button>
      <input class="pv-vol" type="range" min="0" max="100" value="100" title="Master volume" aria-label="Master volume">
      <button class="icon-btn" data-act="full" title="Fullscreen" aria-label="Fullscreen"></button>
    </div>
  </div>`;

  const ICONS = {
    play: '<svg class="icon" viewBox="0 0 24 24"><path d="M8 5 L18 12 L8 19 Z"/></svg>',
    pause: '<svg class="icon" viewBox="0 0 24 24"><path d="M8 5 V19 M16 5 V19"/></svg>',
    start: '<svg class="icon" viewBox="0 0 24 24"><path d="M6 5 V19 M18 5 L10 12 L18 19 Z"/></svg>',
    prev: '<svg class="icon" viewBox="0 0 24 24"><path d="M14 6 L8 12 L14 18"/></svg>',
    next: '<svg class="icon" viewBox="0 0 24 24"><path d="M10 6 L16 12 L10 18"/></svg>',
    end: '<svg class="icon" viewBox="0 0 24 24"><path d="M18 5 V19 M6 5 L14 12 L6 19 Z"/></svg>',
    mute: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9 V15 H8 L13 19 V5 L8 9 Z M16 9 L22 15 M22 9 L16 15"/></svg>',
    sound: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9 V15 H8 L13 19 V5 L8 9 Z M16 9 a4 4 0 0 1 0 6 M18.5 6.5 a8 8 0 0 1 0 11"/></svg>',
    full: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9 V4 H9 M20 9 V4 H15 M4 15 V20 H9 M20 15 V20 H15"/></svg>',
  };

  const $ = (sel) => root.querySelector(sel);
  const stageOuter = $(".pv-stage-outer");
  const stage = $(".pv-stage");
  const videos = [...root.querySelectorAll(".pv-video")];
  const compLayer = $(".pv-comp-layer");
  const capLayer = $(".pv-caption-layer");
  const badge = $(".pv-badge");
  const exactBtn = $(".pv-exact-btn");
  const exactImg = $(".pv-exact-img");
  const exactLoading = $(".pv-exact-loading");
  const proxyStrip = $(".pv-proxy");
  const proxyText = $(".pv-proxy-text");
  const proxyBar = $(".pv-proxy-bar i");
  const stillEls = [...root.querySelectorAll(".pv-still")];
  const loading = $(".pv-loading");
  const timeLabel = $(".pv-time");
  const btns = {};
  for (const b of root.querySelectorAll("[data-act]")) btns[b.dataset.act] = b;
  const volSlider = $(".pv-vol");
  btns.play.innerHTML = ICONS.play;
  btns.start.innerHTML = ICONS.start;
  btns.prev.innerHTML = ICONS.prev;
  btns.next.innerHTML = ICONS.next;
  btns.end.innerHTML = ICONS.end;
  btns.mute.innerHTML = ICONS.sound;
  btns.full.innerHTML = ICONS.full;

  // -- state ---------------------------------------------------------------
  let seq = null;
  let cueById = new Map();
  let assetByHandle = new Map();
  let fps = 30, stageW = 1920, stageH = 1080, durationMs = 0;
  let uiRate = 1, muted = false, volume = 1;
  let tempoRate = 1; // sequence tempo from the snapshot (project.tempo); multiplies the preview clock only
  let anchorT = 0, anchorPerf = 0;         // master clock while playing
  let lastT = -1;                          // last rendered time
  let stagePxW = 0, stagePxH = 0;          // measured stage box
  let proxyReady = new Map();              // asset handle -> boolean
  let proxyStat = new Map();               // asset handle -> {status, progress}
  let proxyPollTimer = 0;
  let compSizeCache = new Map();           // cueId -> {w,h[,dir]}, capped (removed cues must not pile up)
  /** Drop cached composition sizes for cues that no longer exist or whose
      composition directory changed (a stale size would misplace the frame). */
  function pruneCompSizeCache() {
    if (compSizeCache.size === 0) return;
    const live = new Map();
    for (const lane of seq?.lanes ?? []) {
      for (const cue of lane.cues ?? []) {
        if ((cue.kind === "composition" || cue.kind === "title") && cue.composition?.composition_dir) {
          live.set(cue.id, String(cue.composition.composition_dir).replace(/\\/g, "/"));
        }
      }
    }
    for (const [id, size] of compSizeCache) {
      const dir = live.get(id);
      if (!dir || (size && size.dir && size.dir !== dir)) compSizeCache.delete(id);
    }
  }
  function compSizeSet(cueId, size) {
    compSizeCache.set(cueId, size);
    if (compSizeCache.size > 40) {
      const firstKey = compSizeCache.keys().next().value;
      if (firstKey !== cueId) compSizeCache.delete(firstKey);
    }
  }
  let compFrames = new Map();              // cueId -> {frame, loaded, cue, held}
  let initialSeekDone = false;           // explicit first-frame seek after the initial snapshot
  // -- watchdog (self-healing preview) -------------------------------------------
  const recentEvents = [];               // last SSE/store event names, newest last (max 20)
  const consoleErrors = [];              // last console.error lines (max 20)
  let lastSeenServerRevision = null;     // newest revision observed in snapshot/delta events
  let lastAppliedRevision = null;        // revision fully applied by takeSequence
  const reloadLog = new Map();           // cueId|global -> timestamps of automatic preview reloads
  let watchdogNotice = null;             // "Preview not responding" badge element
  let watchdogTimer = 0;
  let lastIncidentAt = 0;
  const clockTrack = new Map();          // cueId -> {clock, at} last observed main clock
  function noteEvent(name) {
    recentEvents.push(name);
    if (recentEvents.length > 20) recentEvents.shift();
  }
  function noteConsoleError(args) {
    try {
      const line = [...args].map((a) => (a instanceof Error ? String(a && a.stack || a) : String(a))).join(" ").slice(0, 300);
      consoleErrors.push(line);
      if (consoleErrors.length > 20) consoleErrors.shift();
    } catch {}
  }
  if (typeof window !== "undefined" && !window.__cutholErrWrapped) {
    window.__cutholErrWrapped = true;
    try {
      const origError = window.console.error.bind(window.console);
      window.console.error = (...args) => { noteConsoleError(args); origError(...args); };
    } catch {}
  }
  let cueAudio = new Map();                // cueId -> {el, src, gain}
  let audioCtx = null, masterGain = null;
  let exactVisible = false;

  const slots = videos.map((el) => ({ el, key: null, ready: false }));

  function nowMs() {
    if (!store.state.playing) return clamp(store.state.playheadMs ?? 0, 0, durationMs);
    return clamp(anchorT + (performance.now() - anchorPerf) * uiRate * tempoRate, 0, durationMs);
  }

  // Frame-grid instant the rendered video shows at playhead t: render, draft
  // and monitor frame snap visibility to whole frames (src/core/frame_time.ts),
  // so at an off-grid cue edge the ending cue is still the visible one. Video
  // layers (compositions, captions) use this; audio keeps the continuous clock.
  function quantMs(t) {
    const f = fps > 0 ? fps : 30;
    return (Math.floor((t * f) / 1000) * 1000) / f;
  }

  // Port of isStillGraphic (src/core/schema.ts).
  function isStillAsset(handle) {
    const a = assetByHandle.get(handle);
    return !!a && a.kind === "graphic" && (a.probe?.fps === 0 || a.probe?.duration_ms === 0);
  }

  // -- audio graph ----------------------------------------------------------
  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = muted ? 0 : volume;
      masterGain.connect(audioCtx.destination);
    } catch {}
  }

  function cueGainDb(cue, localMs) {
    const chain = cue.audio_chain ?? {};
    let db = Number(chain.gain_db ?? 0);
    db += envValue(cue.envelopes, "audio_chain.gain_db", localMs, 0);
    const fi = Number(chain.fade_in_ms ?? 0), fo = Number(chain.fade_out_ms ?? 0);
    if (fi > 0 && localMs < fi) db += 20 * Math.log10(Math.max(0.001, localMs / fi));
    if (fo > 0 && localMs > cue.duration_ms - fo) {
      db += 20 * Math.log10(Math.max(0.001, (cue.duration_ms - localMs) / fo));
    }
    return db;
  }

  // Same chain for spine clips (render: compile_audio.ts): mute, base gain,
  // gain envelope and fades drive the <video> volume every frame.
  function spineGainDb(clip, localMs) {
    const chain = clip.audio_chain ?? {};
    if (chain.muted) return -Infinity;
    let db = Number(chain.gain_db ?? 0);
    db += envValue(clip.envelopes, "audio_chain.gain_db", localMs, 0);
    const fi = Number(chain.fade_in_ms ?? 0), fo = Number(chain.fade_out_ms ?? 0);
    const dur = Number(clip.duration_ms ?? 0);
    if (fi > 0 && localMs < fi) db += 20 * Math.log10(Math.max(0.001, localMs / fi));
    if (fo > 0 && dur > 0 && localMs > dur - fo) {
      db += 20 * Math.log10(Math.max(0.001, (dur - localMs) / fo));
    }
    return db;
  }

  // -- sequence model --------------------------------------------------------
  function clipAt(t) {
    const clips = seq?.spine?.clips ?? [];
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      const end = c.timeline_in_ms + c.duration_ms;
      if (t >= c.timeline_in_ms && t < end) return { clip: c, index: i };
    }
    return null;
  }

  /** Visible spine layers at t (1 normally, 2 inside a dissolve). */
  function spineLayers(t) {
    const found = clipAt(t);
    if (!found) return [];
    const { clip, index } = found;
    const clips = seq.spine.clips;
    const localMs = t - clip.timeline_in_ms;
    const sourceMs = clip.source_in_ms + localToSourceOffset(clip, localMs);
    const layers = [{ clip, localMs, sourceMs, opacity: 1, hold: false }];
    // Outgoing dissolve tail of the previous clip (same hold model as the monitor).
    if (index > 0) {
      const prev = clips[index - 1];
      const tr = prev.transition_out;
      const dur = Number(tr?.duration_ms ?? 0);
      if (tr && dur > 0 && t < clip.timeline_in_ms + dur && (typeof tr.kind !== "string" || tr.kind === "dissolve")) {
        const k = 1 - (t - clip.timeline_in_ms) / dur;
        layers[0].opacity = 1 - k;
        layers.push({ clip: prev, localMs: prev.duration_ms, sourceMs: prev.source_out_ms, opacity: k, hold: true });
      }
    }
    // Incoming fade of this clip's own transition_out (dip to backdrop at its tail).
    const out = clip.transition_out;
    if (out && out.kind === "fade" && Number(out.duration_ms ?? 0) > 0) {
      const tail = clip.timeline_in_ms + clip.duration_ms - out.duration_ms;
      if (t >= tail) layers[0].opacity *= 1 - (t - tail) / out.duration_ms;
    }
    return layers;
  }

  function srcForAsset(handle) {
    if (proxyReady.get(handle)) return api.url(`/api/proxy/${encodeURIComponent(handle)}`);
    return api.url(`/media/${encodeURIComponent(handle)}`);
  }

  function applyPlacement(el, item, localMs, baseOpacity) {
    const p = effectivePlacement(item, localMs);
    const sx = (p.mirror_x ? -1 : 1) * (p.scale_x || 1);
    const sy = (p.mirror_y ? -1 : 1) * (p.scale_y || 1);
    const dx = ((p.x_pct || 0) / 100) * stagePxW;
    const dy = ((p.y_pct || 0) / 100) * stagePxH;
    el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${(p.rotation_deg || 0).toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    el.style.opacity = String(clamp((baseOpacity ?? 1) * (p.opacity ?? 1), 0, 1));
    if (p.crop && (p.crop.left_pct || p.crop.right_pct || p.crop.top_pct || p.crop.bottom_pct)) {
      el.style.clipPath = `inset(${p.crop.top_pct ?? 0}% ${p.crop.right_pct ?? 0}% ${p.crop.bottom_pct ?? 0}% ${p.crop.left_pct ?? 0}%)`;
    } else if (el.style.clipPath) {
      el.style.clipPath = "";
    }
    const fit = p.fit_mode === "contain" ? "contain" : p.fit_mode === "fill" || p.fit_mode === "stretch" ? "fill" : "cover";
    if ((el.tagName === "VIDEO" || el.tagName === "IMG") && el.style.objectFit !== fit) el.style.objectFit = fit;
  }

  // Items whose only non-motion fx are Live-shown shaders are not approximate
  // (shaderCovered, filled by maybeShade); everything else keeps today's badge.
  const shaderCovered = new Set();
  function nonShaderApprox(item) {
    if (!item) return false;
    const g = item.treatments?.color_grade;
    if (g && (g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1 || g.temperature_k !== 6500 || g.lut_uri)) return true;
    const t = item.treatments;
    if (t && (t.cutout?.mode !== undefined && t.cutout.mode !== "none" || t.mask || t.motion_blur?.enabled || t.reframe?.enabled)) return true;
    const tr = item.transition_out;
    if (tr && typeof tr.kind === "object") return true;
    if (tr && typeof tr.kind === "string" && !["dissolve", "fade"].includes(tr.kind)) return true;
    return false;
  }
  function fxApprox(item) {
    if (!Array.isArray(item?.fx) || !item.fx.some((e) => e && e.kind !== "motion" && e.enabled !== false)) return false;
    if (shaderCovered.has(item.id)) {
      // A shader running after an unshown ffmpeg fx still shows an approximation.
      return item.fx.some((e) => e && e.enabled !== false && e.kind !== "motion" && !(typeof e.kind === "string" && e.kind.startsWith("ext:")));
    }
    return true;
  }
  function needsApprox(item) {
    if (!item) return false;
    return nonShaderApprox(item) || fxApprox(item);
  }
  function needsExactButton(item) {
    // The Exact-frame button stays available for Live-shown shader items.
    if (!item) return false;
    if (nonShaderApprox(item)) return true;
    return Array.isArray(item.fx) && item.fx.some((e) => e && e.kind !== "motion" && e.enabled !== false);
  }

  // -- spine rendering --------------------------------------------------------
  function loadSlot(slot, layer) {
    const src = srcForAsset(layer.clip.asset_handle);
    const key = `${layer.clip.id}@${src}`;
    // A still spans seconds on the timeline but its media is one frame: never
    // seek past the media end, and never restart ended media (the per-tick
    // play() showed as a `waiting` storm). The frozen last frame is the still.
    const mediaDurMs = Number.isFinite(slot.el.duration) ? slot.el.duration * 1000 : Infinity;
    const targetMs = Math.min(clamp(layer.sourceMs, 0, 1e9), mediaDurMs);
    if (slot.key !== key) {
      slot.key = key;
      slot.ready = false;
      slot.el.style.visibility = "hidden";
      if (slot.el.getAttribute("src") !== src) {
        slot.el.src = src;
        try { slot.el.load(); } catch {}
      }
      slot.el.currentTime = targetMs / 1000;
    } else if (!slot.el.seeking) {
      const driftMs = slot.el.currentTime * 1000 - targetMs;
      const tol = store.state.playing ? (layer.hold ? 120 : 320) : 40;
      if (Math.abs(driftMs) > tol) {
        try { slot.el.currentTime = targetMs / 1000; } catch {}
      }
    }
    if (!slot.ready && slot.el.readyState >= 2) slot.ready = true;
    slot.el.preservesPitch = layer.clip.playback?.preserve_pitch ?? true;
    const wantVol = muted ? 0 : clamp(dbToLin(spineGainDb(layer.clip, layer.localMs)) * volume, 0, 1);
    if (Math.abs(slot.el.volume - wantVol) > 0.002) slot.el.volume = wantVol;
    if (store.state.playing && !layer.hold) {
      const rate = rampRateAt(layer.clip, layer.sourceMs - layer.clip.source_in_ms) * uiRate * tempoRate;
      if (Math.abs(slot.el.playbackRate - rate) > 0.01) slot.el.playbackRate = clamp(rate, 0.1, 16);
      if (!slot.el.ended && slot.el.paused && slot.ready) slot.el.play().catch(() => {});
    } else {
      if (!slot.el.paused) slot.el.pause();
    }
    applyPlacement(slot.el, layer.clip, layer.localMs, layer.opacity);
  }

  // A still without a proxy cannot play in a <video> element (the stage would
  // stay black for minutes); show the source image from /media until the proxy
  // is ready, then hand over to the video slot without a flash.
  function showStill(i, layer) {
    const img = stillEls[i];
    if (!img) return;
    const src = api.url(`/media/${encodeURIComponent(layer.clip.asset_handle)}`);
    if (img.getAttribute("src") !== src) img.src = src;
    img.style.visibility = layer.opacity > 0.001 ? "visible" : "hidden";
    applyPlacement(img, layer.clip, layer.localMs, layer.opacity);
  }

  function renderSpine(t) {
    const layers = spineLayers(t);
    const used = new Set();
    let anyReady = false;
    layers.forEach((layer, li) => {
      const stillFallback = isStillAsset(layer.clip.asset_handle) && !proxyReady.get(layer.clip.asset_handle);
      let slot = slots.find((s) => !used.has(s) && s.key === `${layer.clip.id}@${srcForAsset(layer.clip.asset_handle)}`)
        ?? slots.find((s) => !used.has(s));
      if (!slot) return;
      used.add(slot);
      if (stillFallback) {
        if (!slot.el.paused) slot.el.pause();
        slot.el.style.visibility = "hidden";
        showStill(li, layer);
        anyReady = true;
        return;
      }
      // The video slot takes this layer: its still element must not linger
      // from an earlier still clip (stills paint above the videos).
      if (stillEls[li]) stillEls[li].style.visibility = "hidden";
      loadSlot(slot, layer);
      if (slot.ready || slot.el.readyState >= 2) {
        slot.ready = true;
        anyReady = true;
        slot.el.style.visibility = layer.opacity > 0.001 ? "visible" : "hidden";
      }
    });
    stillEls.forEach((img, i) => {
      if (i >= layers.length) img.style.visibility = "hidden";
    });
    // Preload the next clip into the free slot so cuts never show black.
    const free = slots.find((s) => !used.has(s));
    if (free) {
      const found = clipAt(t);
      const clips = seq?.spine?.clips ?? [];
      const next = found && found.index + 1 < clips.length ? clips[found.index + 1] : null;
      if (next && layers.length > 0) {
        const key = `${next.id}@${srcForAsset(next.asset_handle)}`;
        if (free.key !== key) {
          free.key = key;
          free.ready = false;
          const src = srcForAsset(next.asset_handle);
          if (free.el.getAttribute("src") !== src) {
            free.el.src = src;
            try { free.el.load(); } catch {}
          }
          try { free.el.currentTime = clamp(next.source_in_ms, 0, 1e9) / 1000; } catch {}
        }
        if (free.el.readyState >= 2) free.ready = true;
        free.el.style.visibility = "hidden";
        if (!free.el.paused) free.el.pause();
      } else if (anyReady || layers.length === 0) {
        // Keep the last visible frame until the new clip has data (no black cuts).
        free.el.style.visibility = "hidden";
        if (!free.el.paused) free.el.pause();
      }
    }
    if (layers.length === 0) {
      for (const s of slots) {
        s.key = null;
        s.el.style.visibility = "hidden";
        if (!s.el.paused) s.el.pause();
      }
    }
    return layers;
  }

  // -- composition rendering ----------------------------------------------------
  // A cue longer than its composition holds the composition end state.
  function compSeekMs(cue, localMs) {
    const rec = compFrames.get(cue.id);
    try {
      const doc = rec?.frame?.contentWindow?.document;
      const root = doc ? doc.querySelector("[data-duration]") : null;
      const d = root ? Number(root.getAttribute("data-duration")) : NaN;
      if (Number.isFinite(d) && d > 0) return Math.min(localMs, d * 1000);
    } catch {}
    return localMs;
  }

  function visibleCompCues(t) {
    const tq = quantMs(t);
    const out = [];
    for (const lane of seq?.lanes ?? []) {
      if (lane.muted) continue;
      for (const cue of lane.cues ?? []) {
        if (cue.kind !== "composition" && cue.kind !== "title") continue;
        if (!cue.composition?.composition_dir) continue;
        const start = cueStartMs(seq, cue, cueById);
        if (cueCovers(start, start + cue.duration_ms, tq)) out.push({ cue, start, lane, tq });
      }
    }
    out.sort((a, b) => (a.lane.z_index ?? 0) - (b.lane.z_index ?? 0));
    return out;
  }

  async function compSize(cueId, cue) {
    if (compSizeCache.has(cueId)) return compSizeCache.get(cueId);
    const dir = cue?.composition?.composition_dir ? String(cue.composition.composition_dir).replace(/\\/g, "/") : "";
    const fallback = { w: stageW, h: stageH, dir };
    try {
      const res = await fetch(api.url(`/comp/${encodeURIComponent(cueId)}/hyperframes.json`));
      if (res.ok) {
        const j = await res.json();
        if (j.width > 0 && j.height > 0) {
          const size = { w: j.width, h: j.height, dir };
          compSizeSet(cueId, size);
          return size;
        }
      }
    } catch {}
    compSizeSet(cueId, fallback);
    return fallback;
  }
  /** Full state resync when an event arrives that the current sequence cannot
      explain (a missed delta): fetch a fresh snapshot and apply it. */
  let resyncPending = false;
  function resyncFromServer(reason) {
    if (resyncPending) return;
    resyncPending = true;
    api.get("/api/snapshot").then((s) => {
      resyncPending = false;
      if (!s || typeof s.revision !== "number") return;
      if (s.revision === store.state.revision && s.sequence === store.state.sequence) return;
      try {
        console.warn(`[CUTHOL-G670] Live preview resynced from the server (${reason}) | Suggestion: if this repeats, reopen the window and report the server log tail`);
      } catch {}
      const snap = { sequence: s.sequence, snapshot: s, project: s.project ?? null };
      store.set(
        {
          snapshot: s,
          sequence: s.sequence,
          revision: s.revision,
          scenes: s.scenes ?? [],
          activity: s.activity ?? [],
          lock: s.lock ?? null,
          progress: s.progress ?? null,
          mode: "agent",
        },
        "snapshot"
      );
      takeSequence(snap.sequence, snap.project);
    }).catch(() => { resyncPending = false; });
  }

  // A comp iframe boots its own timelines after its load event (scripts,
  // fonts, HyperFrames init), so a seek issued on load lands on nothing and
  // the cue plays its entry animation instead of the cued state.
  // Pending seeks are retried while paused until the timeline holds the
  // target or a 10 s budget runs out (a comp that plays on its own clock is
  // left alone after that).
  function compTargetSec(rec, cue, localMs) {
    return compSeekMs(cue, localMs) / 1000;
  }
  function compClockSec(rec) {
    try {
      const tls = rec.frame.contentWindow?.__timelines || {};
      const tl = tls.main;
      if (tl && typeof tl.time === "function") {
        const t = tl.time();
        return typeof t === "number" ? t : null;
      }
    } catch {}
    return null;
  }
  function requestCompSeek(rec, cue, localMs) {
    const target = compTargetSec(rec, cue, localMs);
    try {
      seekCompWindow(rec.frame.contentWindow, target);
    } catch {}
    rec.pendingSeek = target;
    rec.nextRetry = 0;
    rec.seekUntil = performance.now() + 10000;
  }
  function settleCompSeeks() {
    if (store.state.playing) return;
    const now = performance.now();
    const all = [...compFrames.values(), ...compPreload.values()];
    for (const rec of all) {
      if (rec.pendingSeek == null || now < rec.nextRetry || now > rec.seekUntil) {
        if (rec.pendingSeek != null && now > rec.seekUntil) rec.pendingSeek = null;
        continue;
      }
      const clock = compClockSec(rec);
      if (clock == null) {
        // Timelines not up yet: re-issue so the first clock starts cued.
        try {
          seekCompWindow(rec.frame.contentWindow, rec.pendingSeek);
        } catch {}
        rec.nextRetry = now + 250;
        continue;
      }
      if (Math.abs(clock - rec.pendingSeek) < 0.15) rec.pendingSeek = null;
      else {
        try {
          seekCompWindow(rec.frame.contentWindow, rec.pendingSeek);
        } catch {}
        rec.nextRetry = now + 250;
      }
    }
    if (!initialSeekDone) {
      let pending = false;
      try {
        const t = clamp(store.state.playheadMs ?? 0, 0, durationMs);
        for (const { cue } of visibleCompCues(t)) {
          const rec = compFrames.get(cue.id);
          if (rec && rec.pendingSeek != null) { pending = true; break; }
        }
      } catch {}
      if (!pending) initialSeekDone = true;
    }
  }
  // Hidden next-cue iframes (at most one per lane): the next composition boots
  // before its boundary so the switch is visibility-only (no backdrop flash).
  let compPreload = new Map();           // cueId -> {frame, loaded, cue}
  const PRELOAD_LOOKAHEAD_MS = 2000;
  const PRELOAD_MAX_DISTANCE_MS = 10000;

  function laneOfCue(cueId) {
    if (!cueId) return null;
    for (const lane of seq?.lanes ?? []) {
      for (const cue of lane.cues ?? []) if (cue.id === cueId) return lane;
    }
    return null;
  }

  function nextCompCues(t, lookaheadMs) {
    const tq = quantMs(t);
    const out = [];
    const seenLane = new Set();
    for (const lane of seq?.lanes ?? []) {
      if (lane.muted) continue;
      let best = null;
      for (const cue of lane.cues ?? []) {
        if (cue.kind !== "composition" && cue.kind !== "title") continue;
        if (!cue.composition?.composition_dir) continue;
        const start = cueStartMs(seq, cue, cueById);
        if (start <= tq) continue;
        if (!best || start < best.start) best = { cue, start, lane };
      }
      if (best && best.start - t <= lookaheadMs && !seenLane.has(lane)) {
        seenLane.add(lane);
        out.push(best);
      }
    }
    return out;
  }

  function makeCompFrame(cue, hidden) {
    const frame = document.createElement("iframe");
    frame.className = "pv-comp-frame";
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("tabindex", "-1");
    frame.style.visibility = "hidden";
    frame.src = api.url(`/comp/${encodeURIComponent(cue.id)}/`);
    frame.__cutholCreatedAt = performance.now();
    frame.addEventListener("error", () => { frame.__cutholLoadError = true; }, { once: true });
    compLayer.appendChild(frame);
    return frame;
  }

  function renderComps(t, seekAll) {
    const visible = visibleCompCues(t);
    const ids = new Set(visible.map((v) => v.cue.id));
    const byLane = new Map(); // lane -> visible cue on that lane
    for (const v of visible) if (!byLane.has(v.lane)) byLane.set(v.lane, v);
    // Successor (visible, not yet loaded) per lane: the old frame is held
    // until the new one can take over, so the backdrop never shows mid-cut.
    const successorLoading = new Set();
    for (const v of visible) {
      const rec = compFrames.get(v.cue.id);
      if (!rec || !rec.loaded) successorLoading.add(v.lane);
    }
    for (const [id, rec] of compFrames) {
      if (ids.has(id)) continue;
      const lane = laneOfCue(rec.cue?.id);
      if (lane && successorLoading.has(lane) && rec.loaded) {
        // Hold the previous frame (seeked to its end below) until the
        // successor iframe reports load.
        rec.held = true;
        continue;
      }
      rec.frame.remove();
      compFrames.delete(id);
    }
    // Preload the next composition per lane while playing or after a seek.
    if (seq && (store.state.playing || seekAll)) {
      const lookahead = PRELOAD_LOOKAHEAD_MS;
      const nexts = nextCompCues(t, lookahead);
      const nextIds = new Set(nexts.map((n) => n.cue.id));
      for (const [id, rec] of compPreload) {
        const stillNext = nextIds.has(id);
        const gone = !cueById.has(id);
        const tooFar = rec.cue && (cueStartMs(seq, rec.cue, cueById) - t > PRELOAD_MAX_DISTANCE_MS);
        if (!stillNext || gone || tooFar) {
          try { rec.frame.remove(); } catch {}
          compPreload.delete(id);
        }
      }
      for (const { cue } of nexts) {
        if (compFrames.has(cue.id) || compPreload.has(cue.id)) continue;
        const frame = makeCompFrame(cue, true);
        const rec = { frame, loaded: false, cue, pendingSeek: null, nextRetry: 0, seekUntil: 0 };
        compPreload.set(cue.id, rec);
        frame.addEventListener("load", () => {
          rec.loaded = true;
          rec.loadedAt = performance.now();
          // Boot cued to the first frame so the boundary switch is instant.
          try { requestCompSeek(rec, cue, 0); } catch {}
        }, { once: true });
      }
    } else {
      for (const [id, rec] of compPreload) {
        try { rec.frame.remove(); } catch {}
        compPreload.delete(id);
      }
    }
    for (const { cue, start, tq } of visible) {
      let rec = compFrames.get(cue.id);
      if (!rec) {
        // Adopt a ready preloaded iframe when the boundary arrives: the page
        // is already booted, so only visibility switches.
        const pre = compPreload.get(cue.id);
        if (pre && pre.loaded) {
          compPreload.delete(cue.id);
          rec = pre;
          compFrames.set(cue.id, rec);
        } else {
          if (pre) {
            try { pre.frame.remove(); } catch {}
            compPreload.delete(cue.id);
          }
          const frame = makeCompFrame(cue, true);
          rec = { frame, loaded: false, cue, pendingSeek: null, nextRetry: 0, seekUntil: 0 };
          compFrames.set(cue.id, rec);
          frame.addEventListener("load", () => {
            rec.loaded = true;
            rec.loadedAt = performance.now();
            try {
              const lt = clamp(quantMs(nowMs()) - start, 0, cue.duration_ms);
              requestCompSeek(rec, cue, lt);
            } catch {}
            frame.style.visibility = "visible";
            lastT = -1; // force a placement refresh once the size is known
          }, { once: true });
        }
      }
      rec.cue = cue;
      rec.held = false;
      const localMs = clamp(tq - start, 0, cue.duration_ms);
      if (seekAll && rec.loaded) requestCompSeek(rec, rec.cue, localMs);
      void compSize(cue.id, cue).then((size) => {
        if (!compFrames.has(cue.id)) return;
        const s = Math.min(stagePxW / size.w, stagePxH / size.h);
        const p = effectivePlacement(cue, localMs);
        const sx = (p.mirror_x ? -1 : 1) * (p.scale_x || 1) * s;
        const sy = (p.mirror_y ? -1 : 1) * (p.scale_y || 1) * s;
        const ox = (stagePxW - size.w * s) / 2 + ((p.x_pct || 0) / 100) * stagePxW;
        const oy = (stagePxH - size.h * s) / 2 + ((p.y_pct || 0) / 100) * stagePxH;
        rec.frame.style.width = `${size.w}px`;
        rec.frame.style.height = `${size.h}px`;
        rec.frame.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px) rotate(${(p.rotation_deg || 0).toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
        rec.frame.style.opacity = String(clamp(p.opacity ?? 1, 0, 1));
        if (rec.loaded) rec.frame.style.visibility = (p.opacity ?? 1) > 0.001 ? "visible" : "hidden";
      });
    }
    // Held previous frames stay on their end state until the successor loads.
    for (const [id, rec] of compFrames) {
      if (ids.has(id) || !rec.held) continue;
      if (rec.loaded) {
        try { requestCompSeek(rec, rec.cue, rec.cue?.duration_ms ?? 0); } catch {}
        if (rec.frame.style.visibility !== "visible") rec.frame.style.visibility = "visible";
      }
    }
    return visible;
  }

  // -- caption rendering --------------------------------------------------------
  // Mirrors the ASS output (src/compositor/ass_generator.ts): centered (an5) at
  // stage-center + placement offset, active word in its own color.
  let capKey = "";
  function renderCaptions(t) {
    const tq = quantMs(t);
    let active = null, activeStart = 0;
    for (const lane of seq?.lanes ?? []) {
      if (lane.muted) continue;
      for (const cue of lane.cues ?? []) {
        if (cue.kind !== "caption" || !cue.typography) continue;
        const start = cueStartMs(seq, cue, cueById);
        if (cueCovers(start, start + cue.duration_ms, tq)) { active = cue; activeStart = start; break; }
      }
      if (active) break;
    }
    if (!active) {
      if (capKey !== "") { capLayer.innerHTML = ""; capKey = ""; }
      return null;
    }
    const typo = active.typography;
    const words = Array.isArray(typo.words) ? typo.words.filter((w) => !w.excised) : [];
    let activeIdx = -1;
    words.forEach((w, i) => {
      if (w.sequence_start_ms != null && tq >= w.sequence_start_ms && tq < (w.sequence_end_ms ?? w.sequence_start_ms + 1)) activeIdx = i;
    });
    const key = `${active.id}:${activeIdx}:${Math.round(stagePxW)}x${Math.round(stagePxH)}`;
    if (key !== capKey) {
      capKey = key;
      capLayer.innerHTML = "";
      const p = effectivePlacement(active, tq - activeStart);
      const s = stagePxH / stageH;
      const div = document.createElement("div");
      div.className = "pv-caption";
      div.dataset.cue = active.id;
      const posX = 50 + (p.x_pct || 0);
      const posY = 50 + (p.y_pct || 0);
      div.style.left = `${posX.toFixed(2)}%`;
      div.style.top = `${posY.toFixed(2)}%`;
      div.style.maxWidth = `${clamp(typo.max_width_pct ?? 80, 15, 95)}%`;
      div.style.fontFamily = `"${typo.font_family ?? "Arial"}", sans-serif`;
      div.style.fontSize = `${Math.max(8, Math.round((typo.font_size_px ?? 42) * s * (p.scale_y || 1)))}px`;
      div.style.fontWeight = String(typo.font_weight ?? 700);
      div.style.textAlign = typo.align ?? "center";
      div.style.opacity = String(clamp(p.opacity ?? 1, 0, 1));
      const strokeW = (typo.stroke_width_px ?? 0) * s;
      // Scale-aware outline mirroring the ASS output (ass_generator.ts renders
      // Outline = max(1, stroke_width_px) at full stage resolution with
      // ScaledBorderAndShadow): whole pixels, stroke behind the fill, and a
      // crisp offset shadow instead of a blurred glow when no stroke applies.
      if ((typo.stroke_width_px ?? 0) > 0 && strokeW >= 1) {
        div.style.webkitTextStroke = `${Math.round(strokeW)}px ${typo.stroke_color_hex ?? "#000"}`;
        div.style.paintOrder = "stroke fill";
      } else if (typo.stroke_color_hex) {
        div.style.textShadow = `0 ${Math.max(1, Math.round(2 * s))}px 0 ${typo.stroke_color_hex}`;
      }
      if (typo.box_color_hex && (typo.box_opacity ?? 0) > 0) {
        div.style.background = typo.box_color_hex;
        div.style.opacity = String(clamp(p.opacity ?? 1, 0, 1) * clamp(typo.box_opacity, 0, 1));
      }
      const tokens = words.length > 0 ? words.map((w) => w.word) : String(typo.text ?? "").split(/\s+/).filter(Boolean);
      tokens.forEach((tok, i) => {
        const span = document.createElement("span");
        span.className = "pv-word" + (i === activeIdx ? " pv-active-word" : "");
        span.textContent = tok;
        span.style.color = i === activeIdx ? (typo.active_word_color_hex ?? "#FACC15") : (typo.color_hex ?? "#FFF");
        div.appendChild(span);
        div.appendChild(document.createTextNode(" "));
      });
      capLayer.appendChild(div);
    }
    return active;
  }

  // -- cue audio (music / voiceover / sfx) ---------------------------------------
  function renderCueAudio(t) {
    const wanted = new Map();
    for (const lane of seq?.lanes ?? []) {
      if (lane.muted) continue;
      for (const cue of lane.cues ?? []) {
        if (cue.kind !== "music" && cue.kind !== "voiceover" && cue.kind !== "sfx") continue;
        if (!cue.asset_handle || cue.audio_chain?.muted) continue;
        const start = cueStartMs(seq, cue, cueById);
        if (cueCovers(start, start + cue.duration_ms, t)) wanted.set(cue.id, { cue, start });
      }
    }
    for (const [id, rec] of cueAudio) {
      if (!wanted.has(id)) {
        try { rec.el.pause(); } catch {}
        rec.el.remove();
        try { rec.gain?.disconnect(); } catch {}
        cueAudio.delete(id);
      }
    }
    ensureAudio();
    for (const [id, { cue, start }] of wanted) {
      const rate = cue.playback?.rate ?? 1;
      const localMs = clamp(t - start, 0, cue.duration_ms);
      const sourceMs = (cue.source_in_ms ?? 0) + localMs / Math.max(0.01, rate);
      let rec = cueAudio.get(id);
      if (!rec) {
        const el = document.createElement("audio");
        el.preload = "auto";
        el.src = api.url(`/media/${encodeURIComponent(cue.asset_handle)}`);
        el.style.display = "none";
        root.appendChild(el);
        let gain = null;
        try {
          if (audioCtx && masterGain) {
            const node = audioCtx.createMediaElementSource(el);
            gain = audioCtx.createGain();
            node.connect(gain);
            gain.connect(masterGain);
          }
        } catch {}
        rec = { el, gain };
        cueAudio.set(id, rec);
        try { el.currentTime = clamp(sourceMs, 0, 1e9) / 1000; } catch {}
      }
      if (!rec.el.seeking && Math.abs(rec.el.currentTime * 1000 - sourceMs) > (store.state.playing ? 350 : 60)) {
        try { rec.el.currentTime = clamp(sourceMs, 0, 1e9) / 1000; } catch {}
      }
      if (rec.gain && audioCtx) {
        const target = muted ? 0 : dbToLin(cueGainDb(cue, localMs)) * volume;
        const cur = rec.gain.gain.value;
        if (Math.abs(cur - target) > 0.002) rec.gain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.05);
      } else {
        rec.el.volume = muted ? 0 : clamp(dbToLin(cueGainDb(cue, localMs)) * volume, 0, 1);
      }
      if (store.state.playing) {
        rec.el.playbackRate = clamp(rate * uiRate * tempoRate, 0.1, 16);
        if (rec.el.paused && rec.el.readyState >= 2) rec.el.play().catch(() => {});
      } else if (!rec.el.paused) {
        rec.el.pause();
      }
    }
  }

  // -- exact frame -----------------------------------------------------------------
  function hideExact() {
    if (!exactVisible) return;
    exactVisible = false;
    exactImg.hidden = true;
    exactImg.removeAttribute("src");
  }

  async function showExact() {
    const t = Math.round(nowMs());
    setPlaying(false);
    exactBtn.disabled = true;
    exactLoading.hidden = false;
    try {
      const res = await fetch(api.url(`/api/frame?at=${t}`));
      if (!res.ok) throw new Error(`frame ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      exactImg.src = url;
      exactImg.hidden = false;
      exactVisible = true;
    } catch {
      exactBtn.disabled = false;
      exactLoading.hidden = true;
      return;
    }
    exactBtn.disabled = false;
    exactLoading.hidden = true;
  }

  // -- master render ------------------------------------------------------------------
  function measureStage() {
    // Fit the project aspect into the available box (explicit px: aspect-ratio
    // alone resolves to 0 with only absolute children). Padding is read from
    // the computed style so the fit tracks the stylesheet instead of a copy.
    const cs = getComputedStyle(stageOuter);
    const padW = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padH = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const availW = Math.max(1, stageOuter.clientWidth - padW);
    const availH = Math.max(1, stageOuter.clientHeight - padH);
    const ar = stageW / Math.max(1, stageH);
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    stagePxW = Math.max(1, Math.floor(w));
    stagePxH = Math.max(1, Math.floor(h));
    stage.style.width = `${stagePxW}px`;
    stage.style.height = `${stagePxH}px`;
  }

  function render(t, seekComps) {
    if (!seq) return;
    measureStage();
    const layers = renderSpine(t);
    const comps = renderComps(t, seekComps);
    const cap = renderCaptions(t);
    renderCueAudio(t);
    const approx = layers.some((l) => needsApprox(l.clip)) || comps.some((c) => needsApprox(c.cue)) || needsApprox(cap);
    const exactable = approx || layers.some((l) => needsExactButton(l.clip));
    badge.hidden = !approx;
    exactBtn.hidden = !exactable;
    timeLabel.textContent = `${formatTC(t, fps)} / ${formatTC(durationMs, fps)}`;
    lastT = t;
  }

  // -- transport -------------------------------------------------------------------------
  // While playing, the window may make no server request for seconds (buffered
  // media), which idle pre-production would read as idle: re-post the advancing
  // playhead so playback keeps holding the gate. Cleared on every pause path.
  let playheadBeat = null;
  function setPlaying(v) {
    v = !!v && !!seq && durationMs > 0;
    if (v && nowMs() >= durationMs - 1) {
      anchorT = 0;
      store.set({ playheadMs: 0 }, "playhead");
    }
    if (v) {
      ensureAudio();
      hideExact();
      anchorT = clamp(store.state.playheadMs ?? 0, 0, durationMs);
      anchorPerf = performance.now();
      store.set({ playheadMs: anchorT, playing: true }, "playhead");
      try {
        if (playheadBeat) clearInterval(playheadBeat);
        playheadBeat = setInterval(() => {
          try {
            const p = api.post("/api/playhead", { ms: Math.round(nowMs()) });
            if (p && typeof p.catch === "function") p.catch(() => {});
          } catch {
            // playhead hint is best-effort
          }
        }, 3000);
      } catch {
        // playhead hint is best-effort
      }
    } else if (store.state.playing) {
      const t = nowMs();
      store.set({ playheadMs: t, playing: false }, "playhead");
      // Pausing settles the playhead: tell the server for idle pre-production.
      try {
        if (playheadBeat) clearInterval(playheadBeat);
        playheadBeat = null;
        const p = api.post("/api/playhead", { ms: Math.round(t) });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        // playhead hint is best-effort
      }
    }
    btns.play.innerHTML = store.state.playing ? ICONS.pause : ICONS.play;
  }

  function seekTo(ms, fromStore) {
    if (!seq) return;
    hideExact();
    const t = clamp(Math.round(ms), 0, durationMs);
    if (store.state.playing) {
      anchorT = t;
      anchorPerf = performance.now();
    }
    if (!fromStore) store.set({ playheadMs: t }, "playhead");
    else if (store.state.playheadMs !== t) store.set({ playheadMs: t }, "playhead");
    lastT = -1;
    render(t, true);
  }

  function stepFrames(n) {
    setPlaying(false);
    seekTo(nowMs() + (n * 1000) / fps);
  }

  // -- sequence intake ----------------------------------------------------------------------
  function takeSequence(sequence, project) {
    const firstIntake = !seq;
    seq = sequence;
    cueById = new Map();
    for (const lane of seq?.lanes ?? []) for (const cue of lane.cues ?? []) cueById.set(cue.id, cue);
    assetByHandle = new Map();
    for (const a of seq?.library ?? []) if (a?.handle) assetByHandle.set(a.handle, a);
    if (project) {
      fps = project.fps ?? 30;
      stageW = project.width ?? 1920;
      stageH = project.height ?? 1080;
      durationMs = project.duration_ms ?? 0;
      tempoRate = project.tempo ?? 1;
      if (btns.speed) { btns.speed.textContent = tempoRate !== 1 ? `${uiRate}× · ${tempoRate}×` : `${uiRate}×`; btns.speed.title = tempoRate !== 1 ? `Preview speed ${uiRate}× · sequence tempo ${tempoRate}× (set with workspace tempo)` : "Preview speed"; }
      stage.style.aspectRatio = `${stageW} / ${stageH}`;
      stage.style.background = project.backdrop ?? "#000";
      stageOuter.style.background = project.backdrop ?? "var(--bg-canvas)";
    }
    loading.hidden = !!seq;
    // Drop proxy state for assets that left the library; the maps would
    // otherwise grow with every ingest/remove cycle of a long session.
    for (const h of [...proxyReady.keys()]) if (!assetByHandle.has(h)) proxyReady.delete(h);
    for (const h of [...proxyStat.keys()]) if (!assetByHandle.has(h)) proxyStat.delete(h);
    // Drop cue audio for cues that no longer exist; keep playing without a flicker.
    for (const [id, rec] of cueAudio) {
      if (!cueById.has(id)) {
        try { rec.el.pause(); } catch {}
        rec.el.remove();
        try { rec.gain?.disconnect(); } catch {}
        cueAudio.delete(id);
      }
    }
    // Drop composition iframes and cached sizes for cues that no longer
    // exist, so a later cue never inherits a stale frame or size. Visible
    // cues keep their loaded iframes (no flicker on unrelated edits).
    for (const [id, rec] of compFrames) {
      if (!cueById.has(id)) {
        try { rec.frame.remove(); } catch {}
        compFrames.delete(id);
      }
    }
    pruneCompSizeCache();
    lastT = -1;
    render(clamp(nowMs(), 0, durationMs), true);
    if (firstIntake && !initialSeekDone) requestInitialSeek();
    void refreshProxyStatus();
  }

  // The window opens at 0:00 on an unseeked composition DOM (all entry states
  // stacked): seek every visible composition to the playhead once, right
  // after the first snapshot. Later loads seek in their load listener and
  // settle through settleCompSeeks.
  function requestInitialSeek() {
    try {
      const t = clamp(nowMs(), 0, durationMs);
      for (const { cue, start, tq } of visibleCompCues(t)) {
        const rec = compFrames.get(cue.id);
        if (!rec || !rec.loaded) continue;
        requestCompSeek(rec, cue, clamp(tq - start, 0, cue.duration_ms));
      }
      if (typeof window !== "undefined") window.__cutholInitialSeek = true;
    } catch {}
  }

  // -- proxy status ------------------------------------------------------------------------------
  // Terminal states need no more polling: the window plays those assets from
  // the original media (video) or the still fallback (images) instead.
  function proxyTerminal(h) {
    const st = proxyStat.get(h)?.status;
    return st === "failed" || st === "missing";
  }

  function updateProxyStrip(handles) {
    const list = [...handles];
    const pending = list.filter((h) => !proxyReady.get(h) && !proxyTerminal(h));
    if (list.length === 0 || pending.length === 0) {
      proxyStrip.hidden = true;
      return;
    }
    const ready = list.length - pending.length - list.filter((h) => !proxyReady.get(h) && proxyTerminal(h)).length;
    let sum = 0;
    for (const h of list) sum += proxyReady.get(h) ? 1 : Number(proxyStat.get(h)?.progress ?? 0);
    proxyText.textContent = `Preparing proxies ${ready}/${list.length}`;
    proxyBar.style.width = `${Math.round((100 * sum) / Math.max(1, list.length))}%`;
    proxyStrip.hidden = false;
  }

  function spineHandles() {
    return new Set(((seq?.spine?.clips ?? []).map((c) => c.asset_handle).filter(Boolean)));
  }

  function proxiesOutstanding() {
    return [...spineHandles()].some((h) => !proxyReady.get(h) && !proxyTerminal(h));
  }

  async function refreshProxyStatus() {
    if (!seq) return;
    const handles = spineHandles();
    // Show the strip before the first status round trip: on a cold boot the
    // status fetches queue behind thumbnail work, and the window would stay
    // silent for seconds while minutes of encoding lie ahead.
    updateProxyStrip(handles);
    let changed = false;
    for (const h of handles) {
      if (proxyReady.get(h)) continue;
      try {
        const res = await fetch(api.url(`/api/proxy/${encodeURIComponent(h)}?status=1`));
        if (!res.ok) continue;
        const st = await res.json();
        proxyStat.set(h, { status: st.status, progress: st.status === "ready" ? 1 : Number(st.progress ?? 0) });
        if (st.status === "ready" && !proxyReady.get(h)) {
          proxyReady.set(h, true);
          changed = true;
        }
      } catch {}
    }
    updateProxyStrip(handles);
    if (changed) {
      // Force slots to pick up proxy URLs (keyed on src, swaps without black).
      for (const s of slots) s.key = null;
      lastT = -1;
      render(nowMs(), false);
    }
    if (proxiesOutstanding() && !proxyPollTimer) {
      proxyPollTimer = window.setInterval(() => {
        if (!proxiesOutstanding()) {
          window.clearInterval(proxyPollTimer);
          proxyPollTimer = 0;
          updateProxyStrip(spineHandles());
          return;
        }
        void refreshProxyStatus();
      }, PROXY_POLL_MS);
    }
  }

  // -- wiring ---------------------------------------------------------------------------------------
  btns.play.addEventListener("click", () => setPlaying(!store.state.playing));
  btns.start.addEventListener("click", () => { setPlaying(false); seekTo(0); });
  btns.end.addEventListener("click", () => { setPlaying(false); seekTo(durationMs); });
  btns.prev.addEventListener("click", () => stepFrames(-1));
  btns.next.addEventListener("click", () => stepFrames(1));
  btns.speed.addEventListener("click", () => {
    const t = nowMs();
    uiRate = SPEEDS[(SPEEDS.indexOf(uiRate) + 1) % SPEEDS.length];
    btns.speed.textContent = tempoRate !== 1 ? `${uiRate}× · ${tempoRate}×` : `${uiRate}×`;
    if (store.state.playing) { anchorT = t; anchorPerf = performance.now(); }
  });
  btns.mute.addEventListener("click", () => {
    muted = !muted;
    btns.mute.innerHTML = muted ? ICONS.mute : ICONS.sound;
    btns.mute.setAttribute("aria-pressed", String(muted));
    if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(muted ? 0 : volume, audioCtx.currentTime, 0.02);
    lastT = -1;
    render(nowMs(), false);
  });
  volSlider.addEventListener("input", () => {
    volume = clamp(Number(volSlider.value) / 100, 0, 1);
    if (masterGain && audioCtx && !muted) masterGain.gain.setTargetAtTime(volume, audioCtx.currentTime, 0.02);
  });
  btns.full.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stageOuter.requestFullscreen?.().catch(() => {});
  });
  exactBtn.addEventListener("click", () => void showExact());
  exactImg.addEventListener("click", hideExact);
  for (const v of videos) {
    for (const ev of ["canplay", "seeked", "loadeddata"]) {
      v.addEventListener(ev, () => { lastT = -1; });
    }
  }

  // All playback keys run through the shared shortcut table (shortcuts.js);
  // the map refreshes when the settings panel saves or the agent changes one.
  let shortcutMap = { ...DEFAULT_SHORTCUTS };
  loadShortcuts(api).then((m) => { shortcutMap = m; }).catch(() => { /* defaults stand */ });
  store.on("settings", (view) => {
    try {
      const entry = (view?.settings ?? []).find((s) => s.key === "live.shortcuts");
      if (entry?.value && typeof entry.value === "object") shortcutMap = resolveShortcuts(entry.value);
    } catch { /* keep the last good map */ }
  });
  window.addEventListener("keydown", (e) => {
    if (matchShortcut(shortcutMap, e, "play-pause")) { e.preventDefault(); setPlaying(!store.state.playing); }
    else if (matchShortcut(shortcutMap, e, "step-forward")) { e.preventDefault(); stepFrames(1); }
    else if (matchShortcut(shortcutMap, e, "step-back")) { e.preventDefault(); stepFrames(-1); }
    else if (matchShortcut(shortcutMap, e, "step-forward-10")) { e.preventDefault(); stepFrames(10); }
    else if (matchShortcut(shortcutMap, e, "step-back-10")) { e.preventDefault(); stepFrames(-10); }
    else if (matchShortcut(shortcutMap, e, "go-start")) { e.preventDefault(); setPlaying(false); seekTo(0); }
    else if (matchShortcut(shortcutMap, e, "go-end")) { e.preventDefault(); setPlaying(false); seekTo(durationMs); }
  });

  // -- colour grade (WebGL2 tetrahedral LUT over the visible video) ---------------
  const grader = createGrader(ctx);
  ctx.colorGrade = grader;
  window.__cutholGrade = grader;
  const shaderFx = createShaderFx(ctx);
  window.__cutholShaderFx = shaderFx;
  let shadeTimer = 0;
  let lastShadeKey = "";
  // Mirrors maybeGrade's slot handling: the shaded picture belongs only to the
  // visible slot's clip; when the visible slot has no shader fx the shader
  // canvas is removed so it never paints over the other slot's clip.
  // The shaded picture belongs only to its own clip's slot: inside a dissolve
  // the outgoing (held) layer keeps its shading on its own slot, like the
  // grade canvas stays on its own slot, while other slots play unshaded.
  function shadePick(t) {
    const layers = spineLayers(t);
    for (const layer of layers) {
      const fxList = (layer.clip?.fx ?? []).filter((e) => e && e.kind !== "motion" && e.enabled !== false);
      if (!fxList.length) continue;
      const wantKey = `${layer.clip.id}@${srcForAsset(layer.clip.asset_handle)}`;
      const slot = slots.find((s) => s.key === wantKey && s.el.style.visibility !== "hidden" && s.el.readyState >= 2)
        ?? slots.find((s) => s.key === wantKey);
      if (!slot) continue;
      return { layer, clip: layer.clip, fxList, slot };
    }
    return null;
  }
  async function maybeShade() {
    if (shadeTimer) return;
    shadeTimer = setTimeout(async () => {
      shadeTimer = 0;
      const t = nowMs();
      const pick = shadePick(t);
      const vis = pick?.slot ?? slots.find((s) => s.el.style.visibility !== "hidden") ?? slots[0];
      const clip = pick?.clip ?? null;
      const fxList = pick?.fxList ?? [];
      const fxIds = fxList.map((e) => e.id).join(",");
      if (!clip || !vis || !fxIds) {
        if (lastShadeKey !== "") { shaderFx.stop(); shaderCovered.clear(); lastShadeKey = ""; }
        return;
      }
      const layer = pick.layer;
      // Refresh every tick: the grader attaches on its own timer, so the
      // grade source may appear after the shader key was first set.
      try {
        const pl = clip.placement ?? {};
        const cr = pl.crop ?? {};
        shaderFx.setGeometry({
          crop: [((cr.left_pct ?? 0) / 100), ((cr.top_pct ?? 0) / 100), ((cr.right_pct ?? 0) / 100), ((cr.bottom_pct ?? 0) / 100)],
          fit: pl.fit_mode === "contain" ? 1 : (pl.fit_mode === "fill" || pl.fit_mode === "stretch" ? 2 : 0),
          mirror: [pl.mirror_x ? -1 : 1, pl.mirror_y ? -1 : 1],
          aspect: (typeof stageW === "number" && typeof stageH === "number" && stageH > 0) ? stageW / stageH : 16 / 9,
        });
        shaderFx.setGradeSource(grader.state.item === clip.id && grader.state.video === vis.el ? grader.state.canvas : null);
      } catch {}
      const key = `${clip.id}|${fxIds}|r${store.state.revision ?? 0}`;
      // A held dissolve layer is frozen at its end frame, like the monitor.
      const frozenSec = layer.hold ? layer.localMs / 1000 : null;
      const timeNow = () => frozenSec ?? (nowMs() - clip.timeline_in_ms) / 1000;
      // A paused seek keeps the same key but a new local time: redraw once.
      if (key === lastShadeKey) {
        if (!store.state.playing && shaderFx.state.video) {
          try {
            shaderFx.drawFrame(timeNow(), fps, clip.envelopes ?? []);
          } catch (e) { console.error("[shader] redraw", e); }
        }
        return;
      }
      lastShadeKey = key;
      try {
        const r = await shaderFx.attach(vis.el, clip.id);
        if (r && r.shaded) {
          shaderCovered.add(clip.id);
          const envs = clip.envelopes ?? [];
          try { shaderFx.drawFrame(timeNow(), fps, envs); } catch (e) { console.error("[shader] draw", e); }
          shaderFx.loop(timeNow, () => fps, () => (clipAt(nowMs())?.clip?.envelopes ?? []));
        }
        else { shaderCovered.delete(clip.id); }
        if (r && r.error) {
          badge.hidden = false;
          badge.textContent = `Approximate — shader ${r.error.fx}: ${String(r.error.detail).slice(0, 160)} [CUTHOL-G732]`;
        }
      } catch (e) { console.error("[shader] attach", e); }
      // The badge depends on shaderCovered / the error notice above, both
      // set here after render() already ran: refresh it on the same frame.
      lastT = -1;
      try { render(nowMs(), false); } catch (e) { console.error("[shader] badge render", e); }
    }, 150);
  }
  store.on("delta", maybeShade);
  store.on("playhead", maybeShade);
  store.on("state", maybeShade);
  const gradeBtn = btns.grade ?? root.querySelector('[data-act="grade"]');
  function colorItemAt(t) {
    if (!seq) return null;
    for (const lane of seq.lanes ?? []) {
      for (const cue of lane.cues ?? []) {
        if (!cue?.asset_handle) continue;
        const start = cueStartMs(seq, cue, cueById);
        if (t >= start && t < start + (cue.duration_ms ?? 0) && cue.color) return cue.id;
      }
    }
    const found = clipAt(t);
    if (found?.clip?.treatments?.color) return found.clip.id;
    return null;
  }
  let gradeTimer = 0;
  let lastGradeKey = "";
  // Throttled, not debounced: playback emits playhead events every frame, and a timer reset on each
  // one never fired while playing (the grade stayed on the previous clip until the next cut).
  async function maybeGrade() {
    if (gradeTimer) return;
    gradeTimer = setTimeout(async () => {
      gradeTimer = 0;
      const vis = slots.find((s) => s.el.style.visibility !== "hidden") ?? slots[0];
      const id = colorItemAt(nowMs());
      if (!id || !vis) { grader.stop(); lastGradeKey = ""; if (gradeBtn) gradeBtn.hidden = true; return; }
      const key = `${id}|r${store.state.revision ?? 0}`;
      if (key === lastGradeKey && grader.state.video === vis.el) return;
      lastGradeKey = key;
      try {
        const r = await grader.attach(vis.el, id, null);
        if (gradeBtn) gradeBtn.hidden = !(r && r.graded);
        window.dispatchEvent(new CustomEvent("cuthol:grade", { detail: { item: id, graded: !!(r && r.graded) } }));
      } catch (e) { console.error("[color] grade attach", e); }
    }, 120);
  }
  store.on("delta", maybeGrade);
  store.on("playhead", maybeGrade);
  store.on("state", maybeGrade);
  if (gradeBtn) gradeBtn.addEventListener("click", () => {
    grader.state.bypass = !grader.state.bypass;
    gradeBtn.setAttribute("aria-pressed", String(!grader.state.bypass));
    gradeBtn.textContent = grader.state.bypass ? "Ungraded" : "Grade";
  });
  store.on("snapshot", (s) => {
    noteEvent("snapshot");
    if (typeof s?.revision === "number") lastSeenServerRevision = s.revision;
    takeSequence(s.sequence, s.snapshot?.project ?? s.project ?? null);
    if (typeof s?.revision === "number") lastAppliedRevision = s.revision;
    maybeGrade();
  });
  store.on("delta", (d) => {
    // New revision at the same time, playback continues without a flicker.
    // Duration comes from the server (spine and lanes); never recompute it here.
    noteEvent("delta");
    if (typeof d?.revision === "number") lastSeenServerRevision = d.revision;
    const snapshotProject = store.state.snapshot?.project ?? null;
    const project = snapshotProject ? { ...snapshotProject } : null;
    if (project && typeof d.duration_ms === "number" && Number.isFinite(d.duration_ms)) {
      project.duration_ms = d.duration_ms;
    }
    takeSequence(d.sequence, project);
    if (typeof d?.revision === "number") lastAppliedRevision = d.revision;
  });
  // Outside composition edits: reload only the affected iframes, then re-seek
  // to the current playhead. Cache-bust so the fresh files load, not the old ones.
  window.__cutholCompReloads = window.__cutholCompReloads ?? 0;
  store.on("comps", (msg) => {
    noteEvent("comps");
    const dirs = new Set(msg?.dirs ?? []);
    if (dirs.size === 0 || !seq) return;
    const t = nowMs();
    let matched = false;
    for (const lane of seq?.lanes ?? []) {
      for (const cue of lane.cues ?? []) {
        const d = cue?.composition?.composition_dir;
        if (typeof d !== "string" || !dirs.has(d.replace(/\\/g, "/"))) continue;
        matched = true;
        // The composition files changed: any cached size may be stale.
        compSizeCache.delete(cue.id);
        const rec = compFrames.get(cue.id);
        if (!rec) continue;
        window.__cutholCompReloads++;
        const start = cueStartMs(seq, cue, cueById);
        try {
          const url = new URL(rec.frame.src, location.href);
          url.searchParams.set("cuthol_comp_rev", String(Date.now()));
          rec.loaded = false;
          rec.frame.style.visibility = "hidden";
          rec.frame.src = url.toString();
          rec.frame.addEventListener("load", () => {
            rec.loaded = true;
            rec.loadedAt = performance.now();
            try {
              requestCompSeek(rec, cue, clamp(quantMs(t) - start, 0, cue.duration_ms));
            } catch {}
            rec.frame.style.visibility = "visible";
            lastT = -1;
          }, { once: true });
        } catch {}
      }
    }
    if (!matched) {
      // Changed directories the current sequence does not reference: the
      // window likely missed a delta (new cue added outside). Resync instead
      // of waiting for a manual reload.
      resyncFromServer("composition change for an unknown cue");
      return;
    }
    // Cues that gained a matching directory but have no iframe yet (added
    // while the window was open) appear on the next render pass.
    lastT = -1;
    render(t, true);
  });
  const onExternalSeek = (patch) => {
    if (!seq || patch?.playheadMs == null) return;
    const want = clamp(patch.playheadMs, 0, durationMs);
    if (store.state.playing) {
      if (Math.abs(want - nowMs()) > 500) seekTo(want, true);
    } else if (Math.abs(want - lastT) > 1) {
      seekTo(want, true);
    }
  };
  store.on("state", onExternalSeek);
  store.on("playhead", onExternalSeek);

  new ResizeObserver(() => {
    if (!seq) return;
    capKey = "";
    lastT = -1;
    render(nowMs(), false);
  }).observe(stageOuter);

  if (store.state.snapshot) takeSequence(store.state.sequence, store.state.snapshot.project);

  // Master loop: advance the clock, publish the playhead, seek comps every frame.
  const tick = () => {
    requestAnimationFrame(tick);
    if (!seq) return;
    if (store.state.playing) {
      const t = nowMs();
      if (t >= durationMs) {
        setPlaying(false);
        return;
      }
      store.set({ playheadMs: t }, "playhead");
      render(t, true);
    } else if (lastT < 0) {
      render(clamp(store.state.playheadMs ?? 0, 0, durationMs), true);
    } else {
      settleCompSeeks();
    }
  };
  requestAnimationFrame(tick);

  // -- watchdog: detect a stuck preview, report it, reload it -------------------------
  // Reasons (LiveIncidentReason in src/live/live_types.ts): a visible iframe
  // with no readable main clock seconds after load (no_frames); playing but
  // the main clock not advancing (clock_stalled); the applied sequence older
  // than the newest revision the window saw (revision_behind); an iframe load
  // error or a load that never finishes (load_failed). On detection the
  // window posts a LiveIncidentReport to POST /api/incident (ignored 404
  // until the server side lands), reloads only the preview (iframes
  // re-created, snapshot re-applied), then posts the outcome with the same
  // id. At most 3 automatic reloads per 10 minutes per cue; past that the
  // window only warns and shows a "Preview not responding" notice.
  const WATCHDOG_MS = 2000;
  const NO_CLOCK_MS = 5000;
  const STALL_MS = 3000;
  const LOAD_TIMEOUT_MS = 15000;
  const MAX_RELOADS = 3;
  const RELOAD_WINDOW_MS = 600000;
  function reloadsInWindow(key) {
    const now = Date.now();
    const list = (reloadLog.get(key) ?? []).filter((t) => now - t < RELOAD_WINDOW_MS);
    reloadLog.set(key, list);
    return list;
  }
  function showWatchdogNotice(text) {
    try {
      if (!watchdogNotice) {
        watchdogNotice = document.createElement("div");
        watchdogNotice.className = "pv-watchdog";
        watchdogNotice.setAttribute("role", "status");
        stage.appendChild(watchdogNotice);
      }
      watchdogNotice.textContent = text;
      watchdogNotice.hidden = false;
    } catch {}
  }
  function hideWatchdogNotice() {
    try { if (watchdogNotice) watchdogNotice.hidden = true; } catch {}
  }
  function postIncident(report) {
    try {
      const p = api.post("/api/incident", report);
      if (p && typeof p.catch === "function") p.catch(() => {});
      else if (p && typeof p.then === "function") p.then(() => {}, () => {});
    } catch {}
  }
  function reloadPreviewOnly() {
    for (const [, rec] of compFrames) { try { rec.frame.remove(); } catch {} }
    compFrames.clear();
    for (const [, rec] of compPreload) { try { rec.frame.remove(); } catch {} }
    compPreload.clear();
    clockTrack.clear();
    window.__cutholCompReloads = (window.__cutholCompReloads ?? 0) + 1;
    takeSequence(store.state.sequence, store.state.snapshot?.project ?? null);
  }
  function checkWatchdog() {
    if (!seq) return;
    const now = performance.now();
    const t = nowMs();
    const problems = [];
    // Revision applied by the window vs newest seen: a delta the preview
    // failed to apply (its handler threw) leaves the stage behind.
    if (typeof lastSeenServerRevision === "number" && typeof lastAppliedRevision === "number"
        && lastAppliedRevision < lastSeenServerRevision) {
      problems.push({ reason: "revision_behind", cue: null, rec: null });
    }
    for (const { cue, start } of visibleCompCues(t)) {
      const rec = compFrames.get(cue.id);
      if (!rec) continue;
      if (rec.frame.__cutholLoadError) {
        problems.push({ reason: "load_failed", cue, rec });
        continue;
      }
      if (!rec.loaded) {
        if (now - (rec.frame.__cutholCreatedAt ?? now) > LOAD_TIMEOUT_MS) {
          problems.push({ reason: "load_failed", cue, rec });
        }
        continue;
      }
      const clock = compClockSec(rec);
      if (clock == null) {
        const age = now - (rec.loadedAt ?? rec.frame.__cutholCreatedAt ?? now);
        if (age > NO_CLOCK_MS) problems.push({ reason: "no_frames", cue, rec });
        continue;
      }
      const prev = clockTrack.get(cue.id);
      clockTrack.set(cue.id, { clock, at: now });
      if (store.state.playing && prev && Math.abs(clock - prev.clock) < 1e-6 && now - prev.at > STALL_MS) {
        problems.push({ reason: "clock_stalled", cue, rec });
      }
    }
    if (problems.length === 0) return;
    const first = problems[0];
    const key = first.cue?.id ?? "global";
    const recent = reloadsInWindow(key);
    const id = `wd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const base = {
      id,
      reason: first.reason,
      at: new Date().toISOString(),
      window_revision: lastAppliedRevision,
      server_revision: lastSeenServerRevision,
      playhead_ms: Math.round(t),
      playing: !!store.state.playing,
      recent_events: [...recentEvents],
      console_errors: [...consoleErrors],
    };
    if (first.cue) {
      base.cue_id = first.cue.id;
      try {
        const u = new URL(first.rec.frame.src, location.href);
        u.searchParams.delete("t");
        base.iframe_url = u.pathname;
      } catch {}
      try { base.comp_clock_sec = compClockSec(first.rec); } catch { base.comp_clock_sec = null; }
    }
    lastIncidentAt = Date.now();
    if (recent.length >= MAX_RELOADS) {
      try { console.warn(`[CUTHOL-G676] Live preview reload cap reached for '${key}' | Suggestion: reload the Live window page manually; the preview keeps running with warnings only.`); } catch {}
      postIncident({ ...base, action: "warned_user" });
      showWatchdogNotice("Preview not responding");
      window.__cutholWatchdog = { lastReason: first.reason, capped: true, at: lastIncidentAt };
      return;
    }
    recent.push(Date.now());
    reloadLog.set(key, recent);
    try { console.warn(`[CUTHOL-G673] Live preview watchdog: ${first.reason}${first.cue ? ` on '${first.cue.id}'` : ""} | Suggestion: the window reloads its preview automatically; if the notice persists, reopen the window and report the incident from 'cuthol live status'.`); } catch {}
    postIncident({ ...base, action: "reloaded_preview" });
    reloadPreviewOnly();
    window.__cutholWatchdog = { lastReason: first.reason, reloadedAt: lastIncidentAt, id };
    // Outcome follow-up: recovered when the next checks pass, still_stuck
    // (plus a full page reload) when the problem persists.
    const followId = id;
    const followReason = first.reason;
    const followCue = first.cue?.id ?? null;
    setTimeout(() => {
      try {
        const still = checkWatchdogQuiet();
        const outcome = still ? "still_stuck" : "recovered";
        try { console.warn(`[CUTHOL-G674] Live preview reloaded (${outcome}). | Suggestion: if the preview keeps stalling, reopen the window and report the incident from 'cuthol live status'.`); } catch {}
        postIncident({ ...base, id: followId, action: "reloaded_preview", outcome });
        if (still) {
          if (outcome === "still_stuck") {
            try { console.error(`[CUTHOL-G675] The Live preview is still stuck${followCue ? ` on '${followCue}'` : ""} after an automatic reload. | Suggestion: reload the Live window page, then report the incident from 'cuthol live status' with the console errors it captured.`); } catch {}
          }
          showWatchdogNotice("Preview not responding");
          window.__cutholWatchdog = { lastReason: followReason, stillStuck: true, at: Date.now() };
          try { location.reload(); } catch {}
        } else {
          hideWatchdogNotice();
        }
      } catch {}
    }, 8000);
  }
  /** Same checks without side effects, for the outcome follow-up. */
  function checkWatchdogQuiet() {
    if (!seq) return false;
    const now = performance.now();
    const t = nowMs();
    if (typeof lastSeenServerRevision === "number" && typeof lastAppliedRevision === "number"
        && lastAppliedRevision < lastSeenServerRevision) return true;
    for (const { cue } of visibleCompCues(t)) {
      const rec = compFrames.get(cue.id);
      if (!rec || rec.frame.__cutholLoadError) return true;
      if (!rec.loaded) {
        if (now - (rec.frame.__cutholCreatedAt ?? now) > LOAD_TIMEOUT_MS) return true;
        continue;
      }
      const clock = compClockSec(rec);
      if (clock == null) {
        if (now - (rec.loadedAt ?? rec.frame.__cutholCreatedAt ?? now) > NO_CLOCK_MS) return true;
        continue;
      }
      const prev = clockTrack.get(cue.id);
      if (store.state.playing && prev && Math.abs(clock - prev.clock) < 1e-6 && now - prev.at > STALL_MS) return true;
    }
    return false;
  }
  watchdogTimer = window.setInterval(() => { try { checkWatchdog(); } catch {} }, WATCHDOG_MS);
  window.__cutholWatchdog = null;

  // Test hook for the headless accuracy check (seek + state readout).
  window.__livePreview = {
    applySnapshot: (s) => takeSequence(s.sequence, s.project ?? null),
    seek: (ms) => seekTo(ms),
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    proxies: () => ({ ready: [...proxyReady.keys()], stat: Object.fromEntries(proxyStat) }),
    state: () => {
      const t = nowMs();
      const found = clipAt(t);
      const layers = spineLayers(t);
      const vis = slots.find((s) => s.el.style.visibility === "visible") ?? slots[0];
      return {
        t: Math.round(t),
        duration: durationMs,
        clipId: found?.clip.id ?? null,
        sourceMs: layers.length ? Math.round(layers[0].sourceMs) : null,
        videoTimeMs: Math.round((vis.el.currentTime || 0) * 1000),
        videoSrc: vis.el.currentSrc ?? "",
        comps: visibleCompCues(t).map((c) => c.cue.id),
        preloads: [...compPreload.keys()],
        initialSeekDone,
        watchdog: window.__cutholWatchdog,
        reloads: window.__cutholCompReloads ?? 0,
        revisions: { seen: lastSeenServerRevision, applied: lastAppliedRevision },
        recentEvents: [...recentEvents],
        notice: !!(watchdogNotice && !watchdogNotice.hidden),
        held: [...compFrames].filter(([, r]) => r.held).map(([id]) => id),
        frames: [...compFrames].map(([id, r]) => ({ id, loaded: !!r.loaded, visible: r.frame.style.visibility })),
        caption: capLayer.querySelector(".pv-caption")?.dataset.cue ?? null,
        activeWord: capLayer.querySelector(".pv-active-word")?.textContent ?? null,
        approx: !badge.hidden,
        playing: store.state.playing,
      };
    },
  };
}
