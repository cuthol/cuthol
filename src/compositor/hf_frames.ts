// Single and batch composition frames for the monitor, and the alpha bounding-box sidecar (split out of hyperframes_bridge.ts).
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import { isPngSequenceBlobDir, resolveCachedCompositionVideoBlob, stageCompositionRenderDir, isValidVideoBlobOnDisk, inspectPngSequenceDir, readCompositionTimelineSec } from "./hf_blobs.js";
import { syncScalarVarsAndComputeCompositionHash } from "./hf_cache_state.js";
import { copyDirRecursiveSync, findLocalHyperFramesCliMjs, hyperFramesProcessEnv } from "./hf_common.js";
import { renderHyperFramesCompositionToMp4 } from "./hf_render.js";
import { needsLegacyGreenSanitize, sanitizeLegacyGreenBackground, sanitizeStagedEntryHtml, stageSanitizedCopy } from "./hf_transparent.js";

/**
 * Applies render-time scalar variable overrides to a staged composition copy by
 * rewriting the `default` of each matching `data-composition-variables`
 * declaration, mirroring how `hyperframes render --variables-file` merges
 * values over the authored defaults. Only the staged copy is touched.
 */
export function applyScalarVarsToStagedHtml(
  html: string,
  scalarVars: Record<string, string | number | boolean>
): string {
  const keys = Object.keys(scalarVars);
  if (keys.length === 0) return html;
  return html.replace(
    /data-composition-variables\s*=\s*(["'])([\s\S]*?)\1/i,
    (whole: string, quote: string, raw: string) => {
      let decls: Array<{ id?: unknown; type?: unknown; default?: unknown } & Record<string, unknown>>;
      try {
        const decoded = raw.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
        decls = JSON.parse(decoded);
      } catch {
        return whole;
      }
      if (!Array.isArray(decls)) return whole;
      let changed = false;
      for (const decl of decls) {
        if (!decl || typeof decl !== "object" || typeof decl.id !== "string") continue;
        if (!(decl.id in scalarVars)) continue;
        const next = scalarVars[decl.id];
        if (decl.type === "string" && typeof next !== "string") continue;
        if (decl.type === "number" && typeof next !== "number") continue;
        if (decl.type === "boolean" && typeof next !== "boolean") continue;
        if (decl.default !== next) {
          decl.default = next;
          changed = true;
        }
      }
      if (!changed) return whole;
      const serialized = JSON.stringify(decls).replace(/'/g, "&#39;");
      return `data-composition-variables=${quote}${serialized}${quote}`;
    }
  );
}

/**
 * Stages a snapshot source directory that carries the render-time scalar
 * variables: copies the composition and rewrites the variable defaults in the
 * staged entry HTML so `hyperframes snapshot` (which has no variables option)
 * sees the same values the render uses via `--variables-file`.
 * Returns the staged directory, or null when there is nothing to override.
 */
export function stageSnapshotDirWithScalarVars(options: {
  absCompDir: string;
  entryHtml: string;
  blobsDir: string;
  hash: string;
  scalarVars: Record<string, string | number | boolean>;
}): string | null {
  if (Object.keys(options.scalarVars).length === 0) return null;
  const stagedDir = path.join(
    options.blobsDir,
    `hf_snap_vars_${options.hash}_${process.pid}_${Date.now()}`
  );
  fs.rmSync(stagedDir, { recursive: true, force: true });
  copyDirRecursiveSync(options.absCompDir, stagedDir);
  const stagedEntryPath = path.join(stagedDir, options.entryHtml);
  if (fs.existsSync(stagedEntryPath)) {
    const stagedHtml = fs.readFileSync(stagedEntryPath, "utf8");
    const nextHtml = applyScalarVarsToStagedHtml(stagedHtml, options.scalarVars);
    if (nextHtml !== stagedHtml) {
      fs.writeFileSync(stagedEntryPath, nextHtml, "utf8");
    }
  }
  return stagedDir;
}

export function resolveFramePngInPngSequenceDir(dirPath: string, frameIdx: number): string | null {
  try {
    if (!isPngSequenceBlobDir(dirPath) || !fs.existsSync(dirPath)) return null;
    const directCandidate = path.join(dirPath, `frame_${String(frameIdx + 1).padStart(6, "0")}.png`);
    if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).size > 64) {
      return directCandidate;
    }
    const pngNames = fs
      .readdirSync(dirPath)
      .filter((name) => /^frame_\d+\.png$/i.test(name))
      .sort();
    if (pngNames.length === 0) return null;
    const clampedIdx = Math.max(0, Math.min(pngNames.length - 1, frameIdx));
    const fallbackCandidate = path.join(dirPath, pngNames[clampedIdx]);
    return fs.existsSync(fallbackCandidate) && fs.statSync(fallbackCandidate).size > 64
      ? fallbackCandidate
      : null;
  } catch {
    return null;
  }
}

function extractFrameFromVideoBlob(
  videoPath: string,
  frameIdx: number,
  fps: number,
  outPng: string,
  scaleToWidth?: number,
  scaleToHeight?: number
): boolean {
  const tmpPng = `${outPng}.${process.pid}.tmp.png`;

  if (isPngSequenceBlobDir(videoPath)) {
    const srcFramePng = resolveFramePngInPngSequenceDir(videoPath, frameIdx);
    if (!srcFramePng) return false;
    if (!scaleToWidth || !scaleToHeight) {
      try {
        fs.copyFileSync(srcFramePng, tmpPng);
        if (fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 64) {
          fs.renameSync(tmpPng, outPng);
          return true;
        }
      } catch {
        // fall through
      }
    } else {
      const scaleProc = spawnWatchedSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-i",
          srcFramePng,
          "-vf",
          `scale=${scaleToWidth}:${scaleToHeight}:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
          "-frames:v",
          "1",
          tmpPng,
        ],
        {
          encoding: "utf8",
          step: "ffmpeg scale pngseq frame",
          watchedPaths: [tmpPng],
          cleanupPathsOnStall: [tmpPng],
        }
      );
      if (scaleProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 64) {
        fs.renameSync(tmpPng, outPng);
        return true;
      }
    }
    if (fs.existsSync(tmpPng)) {
      try {
        fs.unlinkSync(tmpPng);
      } catch {
        // ignore
      }
    }
    return false;
  }

  const seekSec = (frameIdx / fps).toFixed(6);
  const vfBase =
    scaleToWidth && scaleToHeight
      ? `scale=${scaleToWidth}:${scaleToHeight},format=rgba`
      : "format=rgba";
  const seekProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      seekSec,
      "-i",
      videoPath,
      "-vf",
      vfBase,
      "-frames:v",
      "1",
      tmpPng,
    ],
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (seekProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  const extProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select='eq(n\\,${frameIdx})',${vfBase}`,
      "-frames:v",
      "1",
      tmpPng,
    ],
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (extProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  // Fallback to last frame (`-sseof -0.1`) if `frameIdx` exceeded encoded frame count by 1
  const eofProc = spawnWatchedSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-sseof",
      "-0.1",
      "-i",
      videoPath,
      "-vf",
      vfBase,
      "-frames:v",
      "1",
      tmpPng,
    ],
    {
      encoding: "utf8",
      step: "ffmpeg extract blob frame",
      watchedPaths: [tmpPng],
      cleanupPathsOnStall: [tmpPng],
    }
  );
  if (eofProc.status === 0 && fs.existsSync(tmpPng) && fs.statSync(tmpPng).size > 200) {
    fs.renameSync(tmpPng, outPng);
    return true;
  }
  if (fs.existsSync(tmpPng)) {
    try {
      fs.unlinkSync(tmpPng);
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Captures a single frame-grid-snapped RGBA PNG from a HyperFrames composition for fast `monitor frame --at <ms>`
 * without rendering the entire composition video when uncached.
 */
export function renderHyperFramesSingleFramePng(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  localSec: number;
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): { pngPath: string; snappedSec: number; frameIdx: number } {
  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  const rawHtmlSource = fs.readFileSync(entryPath, "utf8");
  const wantGreenStage =
    options.transparent &&
    mode !== "scene_host" &&
    needsLegacyGreenSanitize(rawHtmlSource);
  const htmlSource = wantGreenStage ? sanitizeLegacyGreenBackground(rawHtmlSource) : rawHtmlSource;

  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  // Past the composition's own timeline the cue holds its last frame.
  const compTimelineSec = readCompositionTimelineSec(htmlSource);
  const totalFrames = Math.max(1, Math.round(Math.min(durationSec, compTimelineSec ?? durationSec) * options.fps));
  const frameIdx = Math.max(
    0,
    Math.min(totalFrames - 1, Math.floor(options.localSec * options.fps + 1e-6))
  );
  const snappedSec = Number((frameIdx / options.fps).toFixed(6));

  const hashInfo = syncScalarVarsAndComputeCompositionHash({
    absCompDir,
    entryHtml: options.entryHtml,
    htmlSource,
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationMs: options.durationMs,
    props: options.props,
    transparent: options.transparent,
    mode,
    backdropVideoPath: options.backdropVideoPath,
    opaqueBackdropColor: options.opaqueBackdropColor,
    backdropImagePath: options.backdropImagePath,
  });
  const { hash, nativeHash, legacyHash, scalarVars, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    hashInfo;

  fs.mkdirSync(options.blobsDir, { recursive: true });
  const outPng = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
  if (fs.existsSync(outPng) && fs.statSync(outPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, outPng);
    }
    return { pngPath: outPng, snappedSec, frameIdx };
  }
  const legPng = path.join(options.blobsDir, `hf_frame_${legacyHash}_f${frameIdx}.png`);
  if (legacyHash !== hash && fs.existsSync(legPng) && fs.statSync(legPng).size > 200) {
    if (options.transparent && !isSceneHost) {
      recordCompositionAlphaBboxSidecar(absCompDir, legPng);
    }
    return { pngPath: legPng, snappedSec, frameIdx };
  }

  for (const candExt of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
    const resolved = resolveCachedCompositionVideoBlob({
      absCompDir,
      entryPath,
      blobsDir: options.blobsDir,
      ext: candExt,
      expectedFrames: candExt === "pngseq" ? totalFrames : undefined,
      durationMs: options.durationMs,
      transparent: candExt !== "mp4",
      mode,
      backdropImagePath: options.backdropImagePath,
      hashInfo,
    });
    if (resolved.cachedBlobPath) {
      const extracted = resolved.isExactTargetRes
        ? extractFrameFromVideoBlob(resolved.cachedBlobPath, frameIdx, options.fps, outPng)
        : extractFrameFromVideoBlob(
            resolved.cachedBlobPath,
            frameIdx,
            options.fps,
            outPng,
            targetWidth,
            targetHeight
          );
      if (extracted) {
        if (options.transparent && !isSceneHost && !resolved.cachedBlobPath.endsWith(".mp4")) {
          recordCompositionAlphaBboxSidecar(absCompDir, outPng);
        }
        return { pngPath: outPng, snappedSec, frameIdx };
      }
    }
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (fs.existsSync(hfBin)) {
    const tmpSnapDir = path.join(
      options.blobsDir,
      `hf_snap_tmp_${hash}_f${frameIdx}_${process.pid}_${Date.now()}`
    );
    const needsStage =
      (isSceneHost && Boolean(options.backdropVideoPath)) ||
      (!options.transparent && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
      targetWidth !== nativeWidth ||
      targetHeight !== nativeHeight;
    let tempSceneHostDir: string | null = null;
    let tempVarsDir: string | null = null;
    let greenStageDir: string | null = null;
    try {
      let targetSnapDir = absCompDir;
      if (needsStage) {
        tempSceneHostDir = stageCompositionRenderDir({
          absCompDir,
          entryHtml: options.entryHtml,
          blobsDir: options.blobsDir,
          hash,
          durationSec,
          nativeWidth,
          nativeHeight,
          targetWidth,
          targetHeight,
          isSceneHost,
          backdropVideoPath: options.backdropVideoPath,
          transparent: options.transparent,
          opaqueBackdropColor: options.opaqueBackdropColor,
          backdropImagePath: options.backdropImagePath,
        });
        targetSnapDir = tempSceneHostDir;
      }
      if (Object.keys(scalarVars).length > 0) {
        if (targetSnapDir === absCompDir) {
          tempVarsDir = stageSnapshotDirWithScalarVars({
            absCompDir,
            entryHtml: options.entryHtml,
            blobsDir: options.blobsDir,
            hash,
            scalarVars,
          });
          if (tempVarsDir) targetSnapDir = tempVarsDir;
        } else {
          const stagedEntryPath = path.join(targetSnapDir, options.entryHtml);
          if (fs.existsSync(stagedEntryPath)) {
            const stagedHtml = fs.readFileSync(stagedEntryPath, "utf8");
            const nextHtml = applyScalarVarsToStagedHtml(stagedHtml, scalarVars);
            if (nextHtml !== stagedHtml) {
              fs.writeFileSync(stagedEntryPath, nextHtml, "utf8");
            }
          }
        }
      }
      if (wantGreenStage) {
        if (targetSnapDir === absCompDir) {
          greenStageDir = stageSanitizedCopy({
            absCompDir,
            entryHtml: options.entryHtml,
            blobsDir: options.blobsDir,
            prefix: "hf_snap_green",
            sanitizedHtml: htmlSource,
          });
          targetSnapDir = greenStageDir;
        } else {
          sanitizeStagedEntryHtml(targetSnapDir, options.entryHtml);
        }
      }
      const snapProc = spawnWatchedSync(
        process.execPath,
        [
          hfBin,
          "snapshot",
          targetSnapDir,
          "--at",
          String(snappedSec),
          "--no-end",
          "--describe",
          "false",
          "--output",
          tmpSnapDir,
        ],
        {
          encoding: "utf8",
          env: hyperFramesProcessEnv(),
          step: "hyperframes snapshot",
          watchedPaths: [tmpSnapDir],
          cleanupPathsOnStall: [tmpSnapDir],
        }
      );
      if (snapProc.status === 0 && fs.existsSync(tmpSnapDir)) {
        const pngFile = fs
          .readdirSync(tmpSnapDir)
          .sort()
          .find((f) => f.startsWith("frame-") && f.endsWith(".png"));
        if (pngFile) {
          const fullPng = path.join(tmpSnapDir, pngFile);
          fs.copyFileSync(fullPng, outPng);
          if (options.transparent && !isSceneHost) {
            recordCompositionAlphaBboxSidecar(absCompDir, outPng);
          }
          return { pngPath: outPng, snappedSec, frameIdx };
        }
      }
    } finally {
      if (fs.existsSync(tmpSnapDir)) {
        try {
          fs.rmSync(tmpSnapDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (tempSceneHostDir && fs.existsSync(tempSceneHostDir)) {
        try {
          fs.rmSync(tempSceneHostDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (tempVarsDir && fs.existsSync(tempVarsDir)) {
        try {
          fs.rmSync(tempVarsDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (greenStageDir && fs.existsSync(greenStageDir)) {
        try {
          fs.rmSync(greenStageDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  // Fallback single-frame synthesis
  const fullBlob = renderHyperFramesCompositionToMp4({
    compositionDir: options.compositionDir,
    entryHtml: options.entryHtml,
    blobsDir: options.blobsDir,
    width: options.width,
    height: options.height,
    fps: options.fps,
    durationMs: options.durationMs,
    props: options.props,
    transparent: options.transparent,
    mode,
    backdropVideoPath: options.backdropVideoPath,
    opaqueBackdropColor: options.opaqueBackdropColor,
    backdropImagePath: options.backdropImagePath,
  });
  extractFrameFromVideoBlob(fullBlob, frameIdx, options.fps, outPng);
  return { pngPath: outPng, snappedSec, frameIdx };
}

function parseSnapshotFrameSecFromFilename(filePath: string): number | null {
  const base = path.basename(filePath);
  const m = /^frame-(?:\d+-at-)?([\d.]+)s\.png$/i.exec(base);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) ? val : null;
}

/**
 * Captures multiple frame-grid-snapped RGBA PNGs from a HyperFrames composition in a single
 * `snapshot --at t1,t2,...` invocation and writes them into the shared `hf_frame_<hash>_f<idx>.png`
 * cache so `renderSingleCompositeFrameRgb24` hits the cache for every cell in `monitor sheet`.
 */
export function renderHyperFramesBatchFramesPng(options: {
  compositionDir: string;
  entryHtml: string;
  blobsDir: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  localSecs: number[];
  props: Record<string, unknown>;
  transparent: boolean;
  mode?: "overlay_alpha" | "scene_host";
  backdropVideoPath?: string;
  opaqueBackdropColor?: string;
  backdropImagePath?: string;
}): Array<{ pngPath: string; snappedSec: number; frameIdx: number }> {
  if (options.localSecs.length === 0) {
    return [];
  }

  const absCompDir = path.resolve(options.compositionDir);
  const entryPath = path.join(absCompDir, options.entryHtml);
  if (!fs.existsSync(entryPath)) {
    throw new CutholError(DIAGNOSTICS.MISSING_FILE_ON_DISK("composition", entryPath));
  }

  const mode = options.mode ?? "overlay_alpha";
  const rawHtmlSource = fs.readFileSync(entryPath, "utf8");
  const wantGreenStage =
    options.transparent &&
    mode !== "scene_host" &&
    needsLegacyGreenSanitize(rawHtmlSource);
  const htmlSource = wantGreenStage ? sanitizeLegacyGreenBackground(rawHtmlSource) : rawHtmlSource;

  const durationSec = Math.max(0.1, Number((options.durationMs / 1000).toFixed(3)));
  // Past the composition's own timeline the cue holds its last frame.
  const compTimelineSec = readCompositionTimelineSec(htmlSource);
  const totalFrames = Math.max(1, Math.round(Math.min(durationSec, compTimelineSec ?? durationSec) * options.fps));

  const { hash, nativeHash, scalarVars, isSceneHost, nativeWidth, nativeHeight, targetWidth, targetHeight } =
    syncScalarVarsAndComputeCompositionHash({
      absCompDir,
      entryHtml: options.entryHtml,
      htmlSource,
      width: options.width,
      height: options.height,
      fps: options.fps,
      durationMs: options.durationMs,
      props: options.props,
      transparent: options.transparent,
      mode,
      backdropVideoPath: options.backdropVideoPath,
      opaqueBackdropColor: options.opaqueBackdropColor,
      backdropImagePath: options.backdropImagePath,
    });

  fs.mkdirSync(options.blobsDir, { recursive: true });

  const requestedItems = options.localSecs.map((localSec) => {
    const frameIdx = Math.max(
      0,
      Math.min(totalFrames - 1, Math.floor(localSec * options.fps + 1e-6))
    );
    const snappedSec = Number((frameIdx / options.fps).toFixed(6));
    const pngPath = path.join(options.blobsDir, `hf_frame_${hash}_f${frameIdx}.png`);
    return { pngPath, snappedSec, frameIdx };
  });

  const uniqueMissingByFrame = new Map<number, { pngPath: string; snappedSec: number; frameIdx: number }>();
  for (const item of requestedItems) {
    if (!fs.existsSync(item.pngPath) || fs.statSync(item.pngPath).size <= 200) {
      uniqueMissingByFrame.set(item.frameIdx, item);
    }
  }

  const missingTargets = [...uniqueMissingByFrame.values()].sort((a, b) => a.frameIdx - b.frameIdx);
  if (missingTargets.length === 0) {
    const bboxSidecarPath = path.join(absCompDir, "assets/cuthol-bbox.json");
    if (options.transparent && !isSceneHost && !fs.existsSync(bboxSidecarPath)) {
      recordCompositionAlphaBboxSidecar(absCompDir, requestedItems[0].pngPath);
    }
    return requestedItems;
  }

  const findValidBlobForHash = (h: string): string | null => {
    for (const ext of ["pngseq", "ffv1.mov", "mov", "mp4"] as const) {
      const cand = path.join(options.blobsDir, `hf_comp_${h}.${ext}`);
      if (isValidVideoBlobOnDisk(cand, ext === "pngseq" ? totalFrames : undefined)) {
        return cand;
      }
    }
    return null;
  };

  let scaleW: number | undefined;
  let scaleH: number | undefined;
  let videoToExtract = findValidBlobForHash(hash);
  if (!videoToExtract && nativeHash !== hash) {
    const nativeBlob = findValidBlobForHash(nativeHash);
    if (nativeBlob) {
      videoToExtract = nativeBlob;
      scaleW = targetWidth;
      scaleH = targetHeight;
    }
  }

  const stillMissing: Array<{ pngPath: string; snappedSec: number; frameIdx: number }> = [];
  if (videoToExtract) {
    for (const target of missingTargets) {
      if (
        !extractFrameFromVideoBlob(
          videoToExtract,
          target.frameIdx,
          options.fps,
          target.pngPath,
          scaleW,
          scaleH
        )
      ) {
        stillMissing.push(target);
      }
    }
  } else {
    stillMissing.push(...missingTargets);
  }

  const hfBin = findLocalHyperFramesCliMjs();
  if (stillMissing.length > 0 && fs.existsSync(hfBin)) {
    const tmpSnapDir = path.join(
      options.blobsDir,
      `hf_snap_batch_${hash}_${process.pid}_${Date.now()}`
    );
    const needsStage =
      (isSceneHost && Boolean(options.backdropVideoPath)) ||
      (!options.transparent && Boolean(options.opaqueBackdropColor || options.backdropImagePath)) ||
      targetWidth !== nativeWidth ||
      targetHeight !== nativeHeight;
    let tempSceneHostDir: string | null = null;
    let tempVarsDir: string | null = null;
    let greenStageDir: string | null = null;
    try {
      let targetSnapDir = absCompDir;
      if (needsStage) {
        tempSceneHostDir = stageCompositionRenderDir({
          absCompDir,
          entryHtml: options.entryHtml,
          blobsDir: options.blobsDir,
          hash,
          durationSec,
          nativeWidth,
          nativeHeight,
          targetWidth,
          targetHeight,
          isSceneHost,
          backdropVideoPath: options.backdropVideoPath,
          transparent: options.transparent,
          opaqueBackdropColor: options.opaqueBackdropColor,
          backdropImagePath: options.backdropImagePath,
        });
        targetSnapDir = tempSceneHostDir;
      }
      if (Object.keys(scalarVars).length > 0) {
        if (targetSnapDir === absCompDir) {
          tempVarsDir = stageSnapshotDirWithScalarVars({
            absCompDir,
            entryHtml: options.entryHtml,
            blobsDir: options.blobsDir,
            hash,
            scalarVars,
          });
          if (tempVarsDir) targetSnapDir = tempVarsDir;
        } else {
          const stagedEntryPath = path.join(targetSnapDir, options.entryHtml);
          if (fs.existsSync(stagedEntryPath)) {
            const stagedHtml = fs.readFileSync(stagedEntryPath, "utf8");
            const nextHtml = applyScalarVarsToStagedHtml(stagedHtml, scalarVars);
            if (nextHtml !== stagedHtml) {
              fs.writeFileSync(stagedEntryPath, nextHtml, "utf8");
            }
          }
        }
      }
      if (wantGreenStage) {
        if (targetSnapDir === absCompDir) {
          greenStageDir = stageSanitizedCopy({
            absCompDir,
            entryHtml: options.entryHtml,
            blobsDir: options.blobsDir,
            prefix: "hf_snap_green",
            sanitizedHtml: htmlSource,
          });
          targetSnapDir = greenStageDir;
        } else {
          sanitizeStagedEntryHtml(targetSnapDir, options.entryHtml);
        }
      }

      const snapProc = spawnWatchedSync(
        process.execPath,
        [
          hfBin,
          "snapshot",
          targetSnapDir,
          "--at",
          stillMissing.map((t) => String(t.snappedSec)).join(","),
          "--no-end",
          "--describe",
          "false",
          "--output",
          tmpSnapDir,
        ],
        {
          encoding: "utf8",
          env: hyperFramesProcessEnv(),
          step: "hyperframes snapshot",
          watchedPaths: [tmpSnapDir],
          cleanupPathsOnStall: [tmpSnapDir],
        }
      );

      if (snapProc.status === 0 && fs.existsSync(tmpSnapDir)) {
        const capturedPngs = fs
          .readdirSync(tmpSnapDir)
          .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
          .map((f) => path.join(tmpSnapDir, f))
          .sort((a, b) => {
            const sa = parseSnapshotFrameSecFromFilename(a);
            const sb = parseSnapshotFrameSecFromFilename(b);
            if (sa !== null && sb !== null) return sa - sb;
            return a.localeCompare(b);
          });

        for (let i = 0; i < stillMissing.length; i++) {
          const target = stillMissing[i];
          let matchedPng: string | undefined;
          let bestDiff = Infinity;
          for (const candidate of capturedPngs) {
            const cSec = parseSnapshotFrameSecFromFilename(candidate);
            if (cSec !== null) {
              const diff = Math.abs(cSec - target.snappedSec);
              if (diff < bestDiff && diff <= Math.max(0.05, 1.5 / options.fps)) {
                bestDiff = diff;
                matchedPng = candidate;
              }
            }
          }
          if (!matchedPng && i < capturedPngs.length) {
            matchedPng = capturedPngs[i];
          }
          if (matchedPng && fs.existsSync(matchedPng)) {
            fs.copyFileSync(matchedPng, target.pngPath);
          }
        }
      }
    } finally {
      if (fs.existsSync(tmpSnapDir)) {
        try {
          fs.rmSync(tmpSnapDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (tempSceneHostDir && fs.existsSync(tempSceneHostDir)) {
        try {
          fs.rmSync(tempSceneHostDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (tempVarsDir && fs.existsSync(tempVarsDir)) {
        try {
          fs.rmSync(tempVarsDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (greenStageDir && fs.existsSync(greenStageDir)) {
        try {
          fs.rmSync(greenStageDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  for (const target of stillMissing) {
    if (!fs.existsSync(target.pngPath) || fs.statSync(target.pngPath).size <= 200) {
      renderHyperFramesSingleFramePng({
        ...options,
        localSec: target.snappedSec,
      });
    }
  }

  if (options.transparent && !isSceneHost && requestedItems.length > 0) {
    const firstValid = requestedItems.find(
      (r) => fs.existsSync(r.pngPath) && fs.statSync(r.pngPath).size > 200
    );
    if (firstValid) {
      recordCompositionAlphaBboxSidecar(absCompDir, firstValid.pngPath);
    }
  }

  return requestedItems;
}

export interface MeasuredAlphaBboxPct {
  left_pct: number;
  top_pct: number;
  right_pct: number;
  bottom_pct: number;
  width_pct: number;
  height_pct: number;
}

/**
 * Measures the actual visible pixel bounding box (alpha > 12) from a rendered RGBA PNG frame
 * or ProRes 4444 .mov video and writes <absCompDir>/assets/cuthol-bbox.json so measureCuePixelBox
 * places the monitor/verification bounding box around the real custom graphic instead of guessing.
 */
function readAlphaSidecarRaw(absCompDir: string): Record<string, unknown> | null {
  try {
    const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
    if (!fs.existsSync(bboxPath)) return null;
    const raw = JSON.parse(fs.readFileSync(bboxPath, "utf8")) as Record<string, unknown>;
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export interface AlphaEmptyRanges {
  emptyRanges: Array<[number, number]>;
  allEmpty: boolean;
  frameCount: number;
}

function mergeEmptyFlagsToRanges(flags: boolean[], fps: number, durationSec: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start < 0) start = i;
    if (!flags[i] && start >= 0) {
      ranges.push([
        Number((start / fps).toFixed(3)),
        Number(Math.min(durationSec, (i) / fps).toFixed(3)),
      ]);
      start = -1;
    }
  }
  if (start >= 0) {
    ranges.push([Number((start / fps).toFixed(3)), Number(durationSec.toFixed(3))]);
  }
  return ranges;
}

/**
 * One ffmpeg pass over every frame of a transparent capture at 64x36,
 * returning per-frame emptiness (max alpha <= 12) merged into cue-local
 * second ranges. `empty: true` only when all frames are empty.
 */
export function probeEveryFrameAlphaEmpty(
  mediaPath: string,
  fps: number,
  durationSec: number
): AlphaEmptyRanges | null {
  try {
    const safeFps = Math.max(1, fps);
    const safeDur = Math.max(0.1, durationSec);
    const probeW = 64;
    const probeH = 36;
    const args: string[] = ["-v", "error"];
    if (isPngSequenceBlobDir(mediaPath)) {
      const info = inspectPngSequenceDir(mediaPath);
      if (!info.valid || info.frameCount <= 0) return null;
      args.push(
        "-framerate", String(safeFps),
        "-start_number", "1",
        "-i", path.join(path.resolve(mediaPath), "frame_%06d.png")
      );
    } else {
      if (!fs.existsSync(mediaPath)) return null;
      args.push("-i", mediaPath);
    }
    args.push(
      "-vf", `scale=${probeW}:${probeH}:flags=neighbor,format=rgba`,
      "-frames:v", "1000000",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1"
    );
    const proc = spawnWatchedSync("ffmpeg", args, {
      maxBuffer: 1024 * 1024 * 256,
      step: "ffmpeg alpha every-frame",
    });
    const buf = proc.stdout as Buffer;
    if (proc.status !== 0 || !buf || buf.length < probeW * probeH * 4) return null;
    const frameBytes = probeW * probeH * 4;
    const frameCount = Math.floor(buf.length / frameBytes);
    if (frameCount <= 0) return null;
    const flags: boolean[] = [];
    for (let f = 0; f < frameCount; f++) {
      let maxA = 0;
      const base = f * frameBytes;
      for (let i = 3; i < frameBytes; i += 4) {
        const a = buf[base + i];
        if (a > maxA) {
          maxA = a;
          if (maxA > 12) break;
        }
      }
      flags.push(maxA <= 12);
    }
    const allEmpty = flags.every(Boolean);
    return {
      emptyRanges: allEmpty ? [[0, Number(safeDur.toFixed(3))]] : mergeEmptyFlagsToRanges(flags, safeFps, safeDur),
      allEmpty,
      frameCount,
    };
  } catch {
    return null;
  }
}

function writeEmptyAlphaSidecar(absCompDir: string): void {
  try {
    // A single-frame probe must never clobber the authoritative 5-sample
    // sidecar (or a drawn bbox) with "empty": one empty instant does not mean
    // the cue draws nothing.
    const existing = readAlphaSidecarRaw(absCompDir);
    if (existing && (existing.left_pct !== undefined || Array.isArray(existing.samples))) return;
    const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
    fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
    fs.writeFileSync(bboxPath, JSON.stringify({ empty: true }, null, 2), "utf8");
  } catch {
    // ignore sidecar write failure
  }
}

function probeSinglePngAlphaBbox(pngPath: string, probeW: number, probeH: number): MeasuredAlphaBboxPct | null {
  try {
    const proc = spawnWatchedSync("ffmpeg", [
      "-v", "error",
      "-i", pngPath,
      "-vf",
      `scale=${probeW}:${probeH}:flags=neighbor:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1",
    ], {
      maxBuffer: probeW * probeH * 4 + 65536,
      step: "ffmpeg alpha bbox",
    });
    const buf = proc.stdout as Buffer;
    if (proc.status !== 0 || !buf || buf.length < probeW * probeH * 4) return null;
    let minX = probeW;
    let minY = probeH;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < probeH; y++) {
      for (let x = 0; x < probeW; x++) {
        if (buf[(y * probeW + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return {
      left_pct: Number((minX / probeW).toFixed(4)),
      top_pct: Number((minY / probeH).toFixed(4)),
      right_pct: Number(((maxX + 1) / probeW).toFixed(4)),
      bottom_pct: Number(((maxY + 1) / probeH).toFixed(4)),
      width_pct: Number(((maxX - minX + 1) / probeW).toFixed(4)),
      height_pct: Number(((maxY - minY + 1) / probeH).toFixed(4)),
    };
  } catch {
    return null;
  }
}

export function recordCompositionAlphaBboxSidecar(
  absCompDir: string,
  mediaPath: string,
  atSec?: number,
  probeCtx?: { fps: number; durationSec: number }
): MeasuredAlphaBboxPct | null {
  try {
    if (!fs.existsSync(mediaPath)) return null;
    const probeW = 320;
    const probeH = 180;
    // Transparent captures: decide emptiness from every frame in one ffmpeg
    // pass at 64x36; the box stays the middle frame's box exactly.
    if (isPngSequenceBlobDir(mediaPath)) {
      const info = inspectPngSequenceDir(mediaPath);
      if (!info.valid || info.frameCount <= 0) return null;
      const n = info.frameCount;
      const middleIdx = Math.floor(n / 2);
      const middlePng = resolveFramePngInPngSequenceDir(mediaPath, middleIdx);
      const middleBox = middlePng ? probeSinglePngAlphaBbox(middlePng, probeW, probeH) : null;
      if (probeCtx) {
        const every = probeEveryFrameAlphaEmpty(mediaPath, probeCtx.fps, probeCtx.durationSec);
        if (!every) return middleBox;
        const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
        fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
        if (every.allEmpty) {
          fs.writeFileSync(bboxPath, JSON.stringify({ empty: true }, null, 2), "utf8");
          return null;
        }
        // The box stays the middle frame's box exactly; only when
        // the middle frame itself is empty, use the nearest non-empty frame
        // so a brief pop is not reported as drawing nothing. `empty: true`
        // is written only when all frames are empty.
        let box = middleBox;
        if (!box) {
          let bestDist = Infinity;
          for (let i = 0; i < n; i++) {
            const png = resolveFramePngInPngSequenceDir(mediaPath, i);
            if (!png) continue;
            const b = probeSinglePngAlphaBbox(png, probeW, probeH);
            if (b && Math.abs(i - middleIdx) < bestDist) {
              bestDist = Math.abs(i - middleIdx);
              box = b;
              if (bestDist === 0) break;
            }
          }
        }
        if (!box) return middleBox;
        fs.writeFileSync(
          bboxPath,
          JSON.stringify(
            every.emptyRanges.length > 0 ? { ...box, empty_ranges: every.emptyRanges } : box,
            null, 2
          ),
          "utf8"
        );
        return box;
      }
      if (!middleBox) {
        writeEmptyAlphaSidecar(absCompDir);
        return null;
      }
      const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
      fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
      const existing = readAlphaSidecarRaw(absCompDir);
      const extra =
        existing && Array.isArray((existing as Record<string, unknown>).empty_ranges)
          ? { empty_ranges: (existing as Record<string, unknown>).empty_ranges }
          : existing && Array.isArray((existing as Record<string, unknown>).samples) && Array.isArray((existing as Record<string, unknown>).emptyAt)
            ? { samples: (existing as Record<string, unknown>).samples, emptyAt: (existing as Record<string, unknown>).emptyAt }
            : {};
      fs.writeFileSync(bboxPath, JSON.stringify({ ...middleBox, ...extra }, null, 2), "utf8");
      return middleBox;
    }
    let effectiveMediaPath = mediaPath;
    // Full-capture callers pass probeCtx: decide emptiness from every frame
    // and measure the box at a drawn instant (middle of the cue, or the
    // middle of the largest drawn span when the middle itself is empty).
    let everyForMov: AlphaEmptyRanges | null = null;
    let boxSecForMov: number | null = null;
    if (probeCtx && !effectiveMediaPath.endsWith(".png")) {
      everyForMov = probeEveryFrameAlphaEmpty(effectiveMediaPath, probeCtx.fps, probeCtx.durationSec);
      if (everyForMov?.allEmpty) {
        const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
        fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
        fs.writeFileSync(bboxPath, JSON.stringify({ empty: true }, null, 2), "utf8");
        return null;
      }
      if (everyForMov) {
        const mid = probeCtx.durationSec / 2;
        const inEmpty = everyForMov.emptyRanges.some(([a, b]) => mid >= a && mid < b);
        if (inEmpty) {
          let best: [number, number] | null = null;
          let prev = 0;
          const bounds = [...everyForMov.emptyRanges].sort((x, y) => x[0] - y[0]);
          for (const [a, b] of [...bounds, [probeCtx.durationSec, probeCtx.durationSec]] as Array<[number, number]>) {
            if (a > prev && (!best || a - prev > best[1] - best[0])) best = [prev, a];
            prev = Math.max(prev, b);
          }
          if (best) boxSecForMov = (best[0] + best[1]) / 2;
        }
      }
    }
    const args: string[] = ["-v", "error"];
    const seekSec = boxSecForMov ?? (atSec !== undefined && atSec > 0 ? atSec : null);
    if (seekSec !== null && seekSec > 0 && !effectiveMediaPath.endsWith(".png")) {
      args.push("-ss", seekSec.toFixed(3));
    }
    args.push(
      "-i",
      effectiveMediaPath,
      "-vf",
      `scale=${probeW}:${probeH}:flags=neighbor:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1"
    );
    const proc = spawnWatchedSync("ffmpeg", args, {
      maxBuffer: probeW * probeH * 4 + 65536,
      step: "ffmpeg alpha bbox",
    });
    const buf = proc.stdout as Buffer;
    if (proc.status !== 0 || !buf || buf.length < probeW * probeH * 4) return null;

    let minX = probeW;
    let minY = probeH;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < probeH; y++) {
      for (let x = 0; x < probeW; x++) {
        const a = buf[(y * probeW + x) * 4 + 3];
        if (a > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      if (probeCtx && everyForMov && !everyForMov.allEmpty) {
        // The probed instant is empty but other frames draw: not an empty
        // cue. Keep any authoritative sidecar; never write {empty:true}.
        return null;
      }
      writeEmptyAlphaSidecar(absCompDir);
      return null;
    }
    const bbox: MeasuredAlphaBboxPct = {
      left_pct: Number((minX / probeW).toFixed(4)),
      top_pct: Number((minY / probeH).toFixed(4)),
      right_pct: Number(((maxX + 1) / probeW).toFixed(4)),
      bottom_pct: Number(((maxY + 1) / probeH).toFixed(4)),
      width_pct: Number(((maxX - minX + 1) / probeW).toFixed(4)),
      height_pct: Number(((maxY - minY + 1) / probeH).toFixed(4)),
    };

    if (probeCtx && !effectiveMediaPath.endsWith(".png")) {
      const every = everyForMov ?? probeEveryFrameAlphaEmpty(effectiveMediaPath, probeCtx.fps, probeCtx.durationSec);
      const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
      fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
      if (every?.allEmpty) {
        fs.writeFileSync(bboxPath, JSON.stringify({ empty: true }, null, 2), "utf8");
        return null;
      }
      if (every && every.emptyRanges.length > 0) {
        fs.writeFileSync(bboxPath, JSON.stringify({ ...bbox, empty_ranges: every.emptyRanges }, null, 2), "utf8");
        return bbox;
      }
    }
    const bboxPath = path.join(path.resolve(absCompDir), "assets/cuthol-bbox.json");
    fs.mkdirSync(path.dirname(bboxPath), { recursive: true });
    const existing = readAlphaSidecarRaw(absCompDir);
    const extra =
      existing && Array.isArray(existing.empty_ranges)
        ? { empty_ranges: existing.empty_ranges }
        : existing && Array.isArray(existing.samples) && Array.isArray(existing.emptyAt)
          ? { samples: existing.samples, emptyAt: existing.emptyAt }
          : {};
    fs.writeFileSync(bboxPath, JSON.stringify({ ...bbox, ...extra }, null, 2), "utf8");
    return bbox;
  } catch {
    return null;
  }
}
