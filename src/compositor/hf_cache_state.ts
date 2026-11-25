// Overlay cache state: per-composition state records, still-backdrop equivalence, composition cache hash (split out of hyperframes_bridge.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import {
  analyzeCompositionDataUsage,
  analyzeCompositionDataUsageCached,
  computeUsedBridgePayloadHashes,
  extractScalarHyperFramesVariables,
  getCompositionDirHashes,
  hashCompositionFilesExcludingBridgeData,
  hashDirectoryRecursive,
  invalidateCompositionDirHashes,
} from "./bridge_exporter.js";
import {
  currentHashGeneration,
  hashFileContentShort,
  readTextIfExists,
  writeFileCached,
} from "../core/file_hash_index.js";
import {
  CutholBridgeV1
} from "./cuthol_runtime.js";
import { readInvokedHyperFramesVersion } from "./hf_common.js";

const FILES_HASH_RENDERER_MARK = "|hf:";

export function filesHashWithRendererVersion(contentHash: string, rendererVersion: string): string {
  return `${contentHash}${FILES_HASH_RENDERER_MARK}${rendererVersion}`;
}

/** Renderer version stored on a files hash, or null when the hash predates that tag. */
export function rendererVersionOfFilesHash(filesHash: string | null | undefined): string | null {
  if (typeof filesHash !== "string" || filesHash.length === 0) return null;
  const idx = filesHash.lastIndexOf(FILES_HASH_RENDERER_MARK);
  if (idx < 0) return null;
  const version = filesHash.slice(idx + FILES_HASH_RENDERER_MARK.length);
  return version.length > 0 ? version : null;
}

function hashFileContentSha256(filePath: string): string {
  // Shared content cache (exact size + full-precision mtime match; files
  // seen before in this process are re-read on a new command generation,
  // only first touches reuse the persisted index). Replaces the old
  // process-lifetime memo, which could hide an edit that preserved size and
  // mtime within one long-lived process.
  return hashFileContentShort(path.resolve(filePath));
}

const stillThumb16x9Memo = new Map<string, Buffer | null>();

function getStillImageThumb16x9Rgb24(pngPath: string): Buffer | null {
  try {
    const abs = path.resolve(pngPath);
    if (!fs.existsSync(abs)) return null;
    const st = fs.statSync(abs);
    const memoKey = `${abs}:${st.size}:${st.mtimeMs}`;
    if (stillThumb16x9Memo.has(memoKey)) {
      return stillThumb16x9Memo.get(memoKey) ?? null;
    }
    const sidecarPath = `${abs}.thumb16x9.rgb`;
    if (fs.existsSync(sidecarPath) && fs.statSync(sidecarPath).size === 16 * 9 * 3) {
      const buf = fs.readFileSync(sidecarPath);
      stillThumb16x9Memo.set(memoKey, buf);
      return buf;
    }
    const proc = spawnWatchedSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        abs,
        "-vf",
        "scale=16:9:flags=area:in_color_matrix=bt709:out_color_matrix=bt709,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { maxBuffer: 65536, step: "ffmpeg still thumb" }
    );
    const out = proc.stdout as Buffer;
    if (proc.status === 0 && out && out.length >= 16 * 9 * 3) {
      const slice = Buffer.from(out.subarray(0, 16 * 9 * 3));
      stillThumb16x9Memo.set(memoKey, slice);
      try {
        fs.writeFileSync(sidecarPath, slice);
      } catch {
        // ignore sidecar write error
      }
      return slice;
    }
    stillThumb16x9Memo.set(memoKey, null);
    return null;
  } catch {
    return null;
  }
}

export function areStillBackdropsVisuallyEquivalent(pngA?: string, pngB?: string): boolean {
  if (!pngA && !pngB) return true;
  if (!pngA || !pngB) return false;
  const absA = path.resolve(pngA);
  const absB = path.resolve(pngB);
  if (absA === absB) return true;
  if (!fs.existsSync(absA) || !fs.existsSync(absB)) return false;
  if (hashFileContentSha256(absA) === hashFileContentSha256(absB)) return true;

  const thumbA = getStillImageThumb16x9Rgb24(absA);
  const thumbB = getStillImageThumb16x9Rgb24(absB);
  if (!thumbA || !thumbB || thumbA.length !== thumbB.length) return false;

  let diffSum = 0;
  let maxDiff = 0;
  for (let i = 0; i < thumbA.length; i++) {
    const d = Math.abs(thumbA[i] - thumbB[i]);
    diffSum += d;
    if (d > maxDiff) maxDiff = d;
  }
  const mae = diffSum / thumbA.length;
  return mae <= 3.5 && maxDiff <= 24;
}

interface CompositionCacheStateRecord {
  compositionDir: string;
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  durationMs: number;
  transparent: boolean;
  mode: string;
  backdropDigest: string;
  backdropImagePath?: string;
  cachedBlobs: Record<string, string>;
}

function getCompositionStateFilePath(blobsDir: string, absCompDir: string): string {
  const compKey = crypto.createHash("sha256").update(path.resolve(absCompDir)).digest("hex").slice(0, 16);
  return path.join(blobsDir, `hf_state_${compKey}.json`);
}

export function readCompositionCacheState(blobsDir: string, absCompDir: string): CompositionCacheStateRecord | null {
  const statePath = getCompositionStateFilePath(blobsDir, absCompDir);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as CompositionCacheStateRecord;
  } catch {
    return null;
  }
}

export function writeCompositionCacheState(
  blobsDir: string,
  absCompDir: string,
  state: CompositionCacheStateRecord
): void {
  try {
    fs.mkdirSync(blobsDir, { recursive: true });
    const statePath = getCompositionStateFilePath(blobsDir, absCompDir);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // ignore state write error
  }
}

export function clearBridgeMetaLastDataChangeReason(absCompDir: string): void {
  const metaPath = path.join(absCompDir, "assets/.cuthol-bridge-meta.json");
  if (!fs.existsSync(metaPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (parsed && parsed.lastDataChangeReason) {
      parsed.lastDataChangeReason = null;
      fs.writeFileSync(metaPath, JSON.stringify(parsed, null, 2), "utf8");
    }
  } catch {
    // ignore
  }
}

function compositionOccludesHtmlBackdrop(absCompDir: string, htmlSource: string): boolean {
  // Only an explicit author declaration on the composition root counts: `data-cuthol-opaque="true"`
  // means the composition paints its own opaque full-frame surface for its whole duration,
  // so the stage backdrop underneath can never show through.
  const declared =
    /<[^>]*\bdata-composition-id\b[^>]*\bdata-cuthol-opaque\s*=\s*["']?true\b|<[^>]*\bdata-cuthol-opaque\s*=\s*["']?true\b[^>]*\bdata-composition-id\b/i.test(
      htmlSource
    );
  if (!declared) return false;
  // Safety: transparent root or masks can still reveal the backdrop.
  if (/#root\s*\{[^}]*\bbackground(?:-color)?\s*:\s*transparent\b/i.test(htmlSource)) {
    return false;
  }
  if (/\bmask-composite\b|\b-webkit-mask\b/i.test(htmlSource)) {
    return false;
  }
  return true;
}

type ScalarVarsHashResult = {
  hash: string;
  nativeHash: string;
  legacyHash: string;
  legacyNativeHash: string;
  filesHash: string;
  usedSliceHash: string;
  usedGlobalHash: string;
  propsHash: string;
  backdropDigest: string;
  legacyBackdropDigest: string;
  legacyDirHash: string;
  validLegacyDirHashes: string[];
  lastDataChangeReason: "slice_changed" | "global_used_changed" | null;
  scalarVars: Record<string, string | number | boolean>;
  isSceneHost: boolean;
  nativeWidth: number;
  nativeHeight: number;
  targetWidth: number;
  targetHeight: number;
  computeCandidateKey: (dirH: string, w: number, h: number, bd: string) => string;
};

const scalarVarsMemo = new Map<string, { fp: string | null; result: ScalarVarsHashResult }>();

function backdropStatKey(absCompDir: string, backdropVideoPath?: string, backdropImagePath?: string): string {
  const parts: string[] = [];
  for (const p of [backdropVideoPath, backdropImagePath]) {
    if (!p) {
      parts.push("-");
      continue;
    }
    try {
      const abs = path.isAbsolute(p) ? p : path.resolve(absCompDir, p);
      const st = fs.statSync(abs);
      parts.push(st.isFile() ? `${st.size}:${st.mtimeMs}` : "missing");
    } catch {
      parts.push("missing");
    }
  }
  return parts.join("|");
}

export function syncScalarVarsAndComputeCompositionHash(options: {
  absCompDir: string;
  entryHtml: string;
  htmlSource: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): ScalarVarsHashResult {
  // One composition is hashed up to four times per verify (two dimension
  // sets, two backdrop variants). The inputs beyond the composition's own
  // files are all in this key; the fingerprint (memoized, no walk on hit)
  // covers the files. A hit skips all reads and recomputation, including the
  // vars.json write, which would be a byte-identical no-op under a matching
  // fingerprint.
  const absDir = path.resolve(options.absCompDir);
  const paramKey = [
    absDir,
    options.entryHtml,
    options.width,
    options.height,
    options.fps,
    options.durationMs,
    JSON.stringify(options.props ?? {}),
    options.transparent,
    options.mode,
    options.backdropVideoPath ?? "",
    options.opaqueBackdropColor ?? "",
    options.backdropImagePath ?? "",
    options.htmlSource.length,
    // The result embeds the invoked HyperFrames version (files hash tag,
    // effective dir hash), so a version change must not reuse it.
    readInvokedHyperFramesVersion(),
  ].join("\n");
  const key = `${currentHashGeneration()}\n${paramKey}\n${backdropStatKey(absDir, options.backdropVideoPath, options.backdropImagePath)}`;
  // The fingerprint is memoized per command generation (one stat-only
  // walk per composition per command); a new generation always walks again,
  // so an external edit between two calls of one process is always observed
  // here. The bundle is seeded with the renderer version because the raw
  // hashes embed it.
  const dirHashes = getCompositionDirHashes(absDir, readInvokedHyperFramesVersion());
  const hit = scalarVarsMemo.get(key);
  if (hit && dirHashes.fp !== null && hit.fp === dirHashes.fp) return hit.result;
  const result = syncScalarVarsAndComputeCompositionHashUncached(options, dirHashes);
  if (dirHashes.fp !== null) {
    if (scalarVarsMemo.size > 2000) scalarVarsMemo.clear();
    scalarVarsMemo.set(key, { fp: dirHashes.fp, result });
  }
  return result;
}

function syncScalarVarsAndComputeCompositionHashUncached(
  options: {
    absCompDir: string;
    entryHtml: string;
    htmlSource: string;
    width: number;
    height: number;
    fps: number;
    durationMs: number;
    props: Record<string, unknown>;
    transparent: boolean;
    mode: "overlay_alpha" | "scene_host";
    backdropVideoPath?: string;
    opaqueBackdropColor?: string;
    backdropImagePath?: string;
  },
  dirHashes: { fp: string | null; filesHash: string; legacyHash: string }
): ScalarVarsHashResult {
  // Synchronize `assets/cuthol-vars.json` BEFORE hashing so the cache key is never computed against stale variables.
  const varsFile = path.join(options.absCompDir, "assets/cuthol-vars.json");
  const scalarVars = extractScalarHyperFramesVariables(options.props);
  const nextVarsJson = JSON.stringify(scalarVars, null, 2);
  let currentVarsJson = "";
  if (fs.existsSync(varsFile)) {
    try {
      currentVarsJson = readTextIfExists(varsFile) ?? "";
    } catch {
      currentVarsJson = "";
    }
  }
  if (currentVarsJson !== nextVarsJson && (Object.keys(scalarVars).length > 0 || fs.existsSync(varsFile))) {
    writeFileCached(varsFile, nextVarsJson);
    invalidateCompositionDirHashes(options.absCompDir);
  }

  const wMatch = /\bdata-width\s*=\s*(["'])(\d+)\1/i.exec(options.htmlSource);
  const hMatch = /\bdata-height\s*=\s*(["'])(\d+)\1/i.exec(options.htmlSource);
  const nativeWidth = wMatch ? Math.max(16, Number(wMatch[2])) : options.width;
  const nativeHeight = hMatch ? Math.max(16, Number(hMatch[2])) : options.height;
  const targetWidth = Math.max(16, Math.round(options.width / 2) * 2);
  const targetHeight = Math.max(16, Math.round(options.height / 2) * 2);

  const isSceneHost =
    options.mode === "scene_host" &&
    Boolean(options.backdropVideoPath && fs.existsSync(options.backdropVideoPath));

  const rendererVersion = readInvokedHyperFramesVersion();
  // Directory hashes ride along from the wrapper's single fingerprint walk.
  const filesHash = filesHashWithRendererVersion(dirHashes.filesHash, rendererVersion);
  const usage = analyzeCompositionDataUsageCached(
    options.absCompDir,
    options.entryHtml,
    options.props,
    dirHashes.filesHash
  );
  const dataJsonPath = path.join(options.absCompDir, "assets/cuthol-data.json");
  let parsedBridge: Partial<CutholBridgeV1> | null = null;
  if (fs.existsSync(dataJsonPath)) {
    try {
      const dataRaw = readTextIfExists(dataJsonPath) ?? fs.readFileSync(dataJsonPath, "utf8");
      parsedBridge = JSON.parse(dataRaw) as Partial<CutholBridgeV1>;
    } catch {
      parsedBridge = null;
    }
  }
  const { usedSliceHash, usedGlobalHash } = computeUsedBridgePayloadHashes(parsedBridge, usage);
  const propsHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(options.props ?? {}))
    .digest("hex")
    .slice(0, 16);

  const effectiveDirHash = crypto
    .createHash("sha256")
    .update(
      `files:${filesHash}\nslice:${usedSliceHash}\nglobal:${usedGlobalHash}\nrenderer:${rendererVersion}\n`
    )
    .digest("hex");

  const legacyDirHash = dirHashes.legacyHash;

  let validLegacyDirHashes: string[] = [];
  let lastDataChangeReason: "slice_changed" | "global_used_changed" | null = null;
  const metaSidecarPath = path.join(options.absCompDir, "assets/.cuthol-bridge-meta.json");
  if (fs.existsSync(metaSidecarPath)) {
    try {
      const metaRaw = readTextIfExists(metaSidecarPath) ?? fs.readFileSync(metaSidecarPath, "utf8");
      const meta = JSON.parse(metaRaw);
      if (Array.isArray(meta.validLegacyDirHashes)) {
        validLegacyDirHashes = meta.validLegacyDirHashes;
      }
      if (
        meta.lastDataChangeReason === "slice_changed" ||
        meta.lastDataChangeReason === "global_used_changed"
      ) {
        lastDataChangeReason = meta.lastDataChangeReason;
      }
    } catch {
      // ignore
    }
  }

  let backdropDigest = "";
  let legacyBackdropDigest = "";
  const selfOccludesBackdrop =
    !options.transparent &&
    !isSceneHost &&
    compositionOccludesHtmlBackdrop(options.absCompDir, options.htmlSource);
  if (isSceneHost && options.backdropVideoPath) {
    backdropDigest = `video-sha256:${hashFileContentSha256(options.backdropVideoPath)}`;
    try {
      const st = fs.statSync(options.backdropVideoPath);
      legacyBackdropDigest = `${path.basename(options.backdropVideoPath)}:${st.size}:${st.mtimeMs}`;
    } catch {
      legacyBackdropDigest = "none";
    }
  } else if (!options.transparent && selfOccludesBackdrop) {
    backdropDigest = "self-opaque";
    if (options.backdropImagePath) {
      try {
        const st = fs.statSync(options.backdropImagePath);
        legacyBackdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
      } catch {
        legacyBackdropDigest = "still:none";
      }
    } else if (options.opaqueBackdropColor) {
      legacyBackdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
    }
  } else if (!options.transparent && options.backdropImagePath) {
    backdropDigest = `still-sha256:${hashFileContentSha256(options.backdropImagePath)}`;
    try {
      const st = fs.statSync(options.backdropImagePath);
      legacyBackdropDigest = `still:${path.basename(options.backdropImagePath)}:${st.size}`;
    } catch {
      legacyBackdropDigest = "still:none";
    }
  } else if (!options.transparent && options.opaqueBackdropColor) {
    backdropDigest = `color:${options.opaqueBackdropColor.trim().toLowerCase()}`;
    legacyBackdropDigest = backdropDigest;
  }

  const computeCandidateKey = (dirH: string, w: number, h: number, bd: string): string =>
    crypto
      .createHash("sha256")
      .update(dirH)
      .update(
        JSON.stringify({
          entry: options.entryHtml,
          w,
          h,
          fps: options.fps,
          dur: options.durationMs,
          props: options.props,
          transparent: options.transparent,
          mode: options.mode,
          backdropDigest: bd,
          renderer: rendererVersion,
        })
      )
      .digest("hex")
      .slice(0, 16);

  // Resolution-specific cache key: composition files, used slice, used global data, and the invoked HyperFrames version.
  const hash = computeCandidateKey(effectiveDirHash, targetWidth, targetHeight, backdropDigest);
  const nativeHash = computeCandidateKey(effectiveDirHash, nativeWidth, nativeHeight, backdropDigest);
  const legacyHash = computeCandidateKey(legacyDirHash, targetWidth, targetHeight, legacyBackdropDigest);
  const legacyNativeHash = computeCandidateKey(legacyDirHash, nativeWidth, nativeHeight, legacyBackdropDigest);

  return {
    hash,
    nativeHash,
    legacyHash,
    legacyNativeHash,
    filesHash,
    usedSliceHash,
    usedGlobalHash,
    propsHash,
    backdropDigest,
    legacyBackdropDigest,
    legacyDirHash,
    validLegacyDirHashes,
    lastDataChangeReason,
    scalarVars,
    isSceneHost,
    nativeWidth,
    nativeHeight,
    targetWidth,
    targetHeight,
    computeCandidateKey,
  };
}
