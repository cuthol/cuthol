// Small FFmpeg filter builders: atempo chains, path escaping, envelope expressions, sub-pixel scale/pan, seekable inputs (split out of compiler.ts).
import { ParameterEnvelope } from "../core/schema.js";
import { compileCubicBezierEasedU } from "../core/easing.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { PLACEMENT_LAYER_COMBINE, placementLayerIdentity } from "../effects/effect_types.js";
import {
  placementBaseEnvelope,
  placementChannelHasEnvelopeInput,
  placementChannelRange,
  placementLayers,
  placementStaticValue,
  type PlacementChannel,
  type PlacementOwner,
} from "../sequence/placement_resolve.js";

/** Points per envelope above which the `if` chain becomes a balanced `if` tree. */
export const ENVELOPE_CHAIN_LIMIT = 64;
/** Points per envelope above which even the tree no longer fits the ffmpeg parser budget
 * (measured: the tree fails between 4000 and 4050 points in the isolated probe;
 * the real graph wraps it in longer text, so the cap keeps a 2x margin). */
export const ENVELOPE_TREE_CAP = 2000;

/**
 * Expression of an effective placement channel over `t` (sequence/placement_resolve.ts), or null
 * when the channel does not animate (use the static value). Each animated term (base or layer
 * envelope with points) compiles in raw units and terms combine with `+` / `*`; static terms fold
 * into one constant and identity terms are dropped. With a single animated term and an identity
 * static remainder the term compiles directly in the target mode, so identity base + one layer
 * envelope yields exactly the text the same points give as the base envelope.
 */
export function compilePlacementChannelExpr(
  owner: PlacementOwner,
  channel: PlacementChannel,
  options: {
    timeBaseOffsetMs: number;
    mode: "pixel_offset" | "raw";
    baseCenterPx?: number;
    canvasDimPx?: number;
  }
): string | null {
  const combine = PLACEMENT_LAYER_COMBINE[channel];
  const baseEnv = placementBaseEnvelope(owner, channel);
  const baseAnimates = Boolean(baseEnv && baseEnv.points.length > 0);
  const layers = placementLayers(owner);
  const layerEnvs: ParameterEnvelope[] = [];
  let staticAcc = baseAnimates ? placementLayerIdentity(channel) : owner.placement[channel];
  for (const layer of layers) {
    const entry = layer.channels[channel];
    if (!entry) continue;
    if (entry.envelope && entry.envelope.points.length > 0) {
      layerEnvs.push(entry.envelope);
    } else if (combine === "add") {
      staticAcc += entry.static;
    } else {
      staticAcc *= entry.static;
    }
  }
  const animated: ParameterEnvelope[] = [...(baseAnimates ? [baseEnv!] : []), ...layerEnvs];
  if (animated.length === 0) return null;
  const identity = placementLayerIdentity(channel);
  const staticIsIdentity =
    combine === "add" ? Math.abs(staticAcc - identity) < 1e-9 : Math.abs(staticAcc - identity) < 1e-9;
  const needsClamp =
    channel === "opacity" &&
    (() => {
      const r = placementChannelRange(owner, channel);
      return r.min < 0 || r.max > 1;
    })();
  if (animated.length === 1 && staticIsIdentity && !needsClamp) {
    return compileEnvelopeToFfmpegExpr({ envelope: animated[0], ...options });
  }
  const termExprs = animated.map((env) =>
    compileEnvelopeToFfmpegExpr({ envelope: env, timeBaseOffsetMs: options.timeBaseOffsetMs, mode: "raw" })
  );
  if (termExprs.some((e) => e === null)) return null;
  const parts = [...(termExprs as string[])];
  if (!staticIsIdentity) parts.push(String(Number(staticAcc.toFixed(4))));
  const op = combine === "add" ? "+" : "*";
  let raw = parts.map((p) => `(${p})`).join(op);
  if (channel === "opacity" && needsClamp) raw = `clip((${raw}),0,1)`;
  if (options.mode === "raw") return raw;
  const center = options.baseCenterPx ?? 0;
  const dim = options.canvasDimPx ?? 1000;
  return `(${Number(center.toFixed(4))}+((${raw})/100)*${Number(dim.toFixed(4))})`;
}

export function buildAtempoChain(rate: number): string[] {
  const filters: string[] = [];
  let r = Math.max(0.1, Math.min(16.0, rate));
  while (r > 2.0) {
    filters.push("atempo=2.0");
    r /= 2.0;
  }
  while (r < 0.5) {
    filters.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1.0) > 0.001) {
    filters.push(`atempo=${r.toFixed(4)}`);
  }
  return filters;
}

/**
 * Rate filter of a single audio slice. An `atempo` chain for `preserve_pitch=true`
 * (default), `asetrate`+`aresample` for `false`.
 * Identical to the single-rate logic in `compile_audio.ts`.
 */
export function buildAudioRampTempoFilters(
  rate: number,
  preservePitch: boolean | undefined,
  sampleRate?: number | null
): string[] {
  if (preservePitch === false && Math.abs(rate - 1.0) > 0.001) {
    const sr = sampleRate && sampleRate > 0 ? sampleRate : 48000;
    const pitchedRate = Math.max(4000, Math.min(384000, Math.round(sr * rate)));
    return [`asetrate=${pitchedRate}`, `aresample=${sr}`, `asetpts=PTS-STARTPTS`];
  }
  return buildAtempoChain(rate);
}

export function escapeFfmpegFilterPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/([:\\',;[\]])/g, "\\$1");
}

/**
 * Compiles a `ParameterEnvelope` into a deterministic piecewise FFmpeg expression
 * evaluated over `t` (in seconds), supporting `linear`, `ease_in`, `ease_out`, `ease_in_out`, `hold` (step),
 * and `cubic_bezier` (unrolled Newton solver over `st()`/`ld()`).
 */
export function compileEnvelopeToFfmpegExpr(options: {
  envelope: ParameterEnvelope | undefined;
  timeBaseOffsetMs: number;
  mode: "pixel_offset" | "db_to_linear" | "raw";
  baseCenterPx?: number;
  canvasDimPx?: number;
  baseGainDb?: number;
}): string | null {
  const env = options.envelope;
  if (!env || env.points.length === 0) return null;
  if (env.points.length > ENVELOPE_TREE_CAP) {
    throw new Error(DIAGNOSTICS.PLACEMENT_EXPR_TOO_COMPLEX(env.points.length, ENVELOPE_TREE_CAP).formatted);
  }

  const mapVal = (v: number): number => {
    if (options.mode === "db_to_linear") {
      const totalDb = (options.baseGainDb ?? 0) + v;
      return Number(Math.pow(10, totalDb / 20).toFixed(4));
    }
    if (options.mode === "raw") {
      return Number(v.toFixed(4));
    }
    const center = options.baseCenterPx ?? 0;
    const dim = options.canvasDimPx ?? 1000;
    return Number((center + (v / 100) * dim).toFixed(4));
  };

  const pts = env.points.map((p) => ({
    tSec: Number(((options.timeBaseOffsetMs + p.offset_ms) / 1000).toFixed(3)),
    val: mapVal(p.value),
    dbVal: Number(((options.baseGainDb ?? 0) + p.value).toFixed(4)),
    easing: p.easing,
    bezier: p.bezier,
  }));

  if (pts.length === 1) {
    return String(pts[0].val);
  }

  const segExprOf = (i: number): string => {
    const a = pts[i];
    const b = pts[i + 1];
    const dt = Math.max(0.001, Number((b.tSec - a.tSec).toFixed(3)));
    const dv = Number((b.val - a.val).toFixed(4));
    const uExpr = `((t-${a.tSec})/${dt})`;

    let easedU = uExpr;
    if (b.easing === "ease_in") {
      easedU = `pow(${uExpr},2)`;
    } else if (b.easing === "ease_out") {
      easedU = `(1-pow(1-${uExpr},2))`;
    } else if (b.easing === "ease_in_out") {
      easedU = `(pow(${uExpr},2)*(3-2*${uExpr}))`;
    } else if (b.easing === "cubic_bezier" && b.bezier) {
      easedU = compileCubicBezierEasedU(b.bezier, uExpr);
    }

    let segExpr: string;
    if (options.mode === "db_to_linear") {
      const dDb = Number((b.dbVal - a.dbVal).toFixed(4));
      segExpr =
        Math.abs(dDb) < 1e-4
          ? String(a.val)
          : `pow(10,(${a.dbVal}+(${dDb})*${easedU})/20)`;
    } else {
      segExpr =
        Math.abs(dv) < 1e-4
          ? String(a.val)
          : `${a.val}+(${dv})*${easedU}`;
    }
    if (b.easing === "hold") {
      // Step: previous value until t1; the `lt(t,t1)` nesting switches to the new value at t >= t1.
      segExpr = String(a.val);
    }
    return segExpr;
  };

  if (pts.length <= ENVELOPE_CHAIN_LIMIT) {
    // Nested `if(lt(t, t1), easedLerp, ...)` from right to left (easing + dB-space interpolation).
    let expr = String(pts[pts.length - 1].val);
    for (let i = pts.length - 2; i >= 0; i--) {
      expr = `if(lt(t,${pts[i + 1].tSec}),${segExprOf(i)},${expr})`;
    }
    expr = `if(lt(t,${pts[0].tSec}),${pts[0].val},${expr})`;
    return expr;
  }

  // Balanced `if` tree over the segments: same segment per `t` as the chain, logarithmic depth.
  // The rightmost leaf's else branch is the last point value (as in the chain).
  const buildTree = (lo: number, hi: number): string => {
    if (hi - lo === 1) {
      return lo === pts.length - 2
        ? `if(lt(t,${pts[hi].tSec}),${segExprOf(lo)},${pts[hi].val})`
        : segExprOf(lo);
    }
    const mid = (lo + hi) >> 1;
    return `if(lt(t,${pts[mid].tSec}),${buildTree(lo, mid)},${buildTree(mid, hi)})`;
  };
  const tree = pts.length === 2 ? segExprOf(0) : buildTree(0, pts.length - 1);
  return `if(lt(t,${pts[0].tSec}),${pts[0].val},${tree})`;
}

export function buildSubpixelScaleOrPanFilters(options: {
  hasDynamicScale: boolean;
  sxPart: string;
  syPart: string;
  /** The clip or cue whose x/y channels are compiled (static values and envelopes). */
  owner: PlacementOwner;
  baseCenterX: number;
  baseCenterY: number;
  renderWidth: number;
  renderHeight: number;
  localTimeExpr: string;
}): string[] {
  if (options.hasDynamicScale) {
    const sxP = options.sxPart.replace(/\bt\b/g, options.localTimeExpr);
    const syP = options.syPart.replace(/\bt\b/g, options.localTimeExpr);
    const xLocalRaw = compilePlacementChannelExpr(options.owner, "x_pct", {
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: 0,
      canvasDimPx: options.renderWidth,
    });
    const yLocalRaw = compilePlacementChannelExpr(options.owner, "y_pct", {
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: 0,
      canvasDimPx: options.renderHeight,
    });
    const dxP = xLocalRaw
      ? xLocalRaw.replace(/\bt\b/g, options.localTimeExpr)
      : String(Number(((placementStaticValue(options.owner, "x_pct") / 100) * options.renderWidth).toFixed(4)));
    const dyP = yLocalRaw
      ? yLocalRaw.replace(/\bt\b/g, options.localTimeExpr)
      : String(Number(((placementStaticValue(options.owner, "y_pct") / 100) * options.renderHeight).toFixed(4)));

    const x0 = `(W*(1-(${sxP}))/2)+(${dxP})`;
    const x1 = `(W*(1+(${sxP}))/2)+(${dxP})`;
    const y0 = `(H*(1-(${syP}))/2)+(${dyP})`;
    const y2 = `(H*(1+(${syP}))/2)+(${dyP})`;
    return [
      `pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0`,
      `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':sense=destination:interpolation=linear:eval=frame`,
      `crop=w=iw-4:h=ih-4:x=2:y=2`,
    ];
  }

  // An x/y envelope entry with no points also takes this path (its sub-pixel offset is 0).
  if (
    placementChannelHasEnvelopeInput(options.owner, "x_pct") ||
    placementChannelHasEnvelopeInput(options.owner, "y_pct")
  ) {
    const xLocalRaw = compilePlacementChannelExpr(options.owner, "x_pct", {
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: options.baseCenterX,
      canvasDimPx: options.renderWidth,
    });
    const yLocalRaw = compilePlacementChannelExpr(options.owner, "y_pct", {
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: options.baseCenterY,
      canvasDimPx: options.renderHeight,
    });
    const xLocalP = xLocalRaw ? xLocalRaw.replace(/\bt\b/g, options.localTimeExpr) : null;
    const yLocalP = yLocalRaw ? yLocalRaw.replace(/\bt\b/g, options.localTimeExpr) : null;
    const subDx = xLocalP ? `((${xLocalP})-trunc(${xLocalP}))` : "0";
    const subDy = yLocalP ? `((${yLocalP})-trunc(${yLocalP}))` : "0";
    return [
      `pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0`,
      `perspective=x0='${subDx}':y0='${subDy}':x1='W+(${subDx})':y1='${subDy}':x2='${subDx}':y2='H+(${subDy})':x3='W+(${subDx})':y3='H+(${subDy})':sense=destination:interpolation=linear:eval=frame`,
      `crop=w=iw-4:h=ih-4:x=2:y=2`,
    ];
  }

  return [];
}

export function buildSeekableMediaInput(
  absAssetPath: string,
  srcInMs: number,
  srcOutMs: number,
  assetDurationMs: number,
  allowFastInputSeek = true
): {
  inputArgs: string[];
  localSrcInSec: string;
  localSrcOutSec: string;
  seekSec: number;
} {
  if (allowFastInputSeek && srcInMs >= 3000) {
    const seekSec = Math.max(0, Math.floor((srcInMs - 2000) / 1000));
    const readSpanSec = Math.max(1, Math.ceil(srcOutMs / 1000 - seekSec + 3));
    return {
      inputArgs: ["-ss", String(seekSec), "-t", String(readSpanSec), "-i", absAssetPath],
      localSrcInSec: (srcInMs / 1000 - seekSec).toFixed(3),
      localSrcOutSec: (srcOutMs / 1000 - seekSec).toFixed(3),
      seekSec,
    };
  }
  if (allowFastInputSeek && assetDurationMs > 60_000 && srcOutMs + 5000 < assetDurationMs) {
    const readSpanSec = Math.max(1, Math.ceil(srcOutMs / 1000 + 3));
    return {
      inputArgs: ["-t", String(readSpanSec), "-i", absAssetPath],
      localSrcInSec: (srcInMs / 1000).toFixed(3),
      localSrcOutSec: (srcOutMs / 1000).toFixed(3),
      seekSec: 0,
    };
  }
  return {
    inputArgs: ["-i", absAssetPath],
    localSrcInSec: (srcInMs / 1000).toFixed(3),
    localSrcOutSec: (srcOutMs / 1000).toFixed(3),
    seekSec: 0,
  };
}
