/**
 * Cuthol <-> HyperFrames Window-Local Bridge Exporter & Recursive Directory Hasher
 * (`src/compositor/bridge_exporter.ts`).
 *
 * Key architectural guarantees:
 * 1. Dual-channel data injection:
 *    - Scalar `props` (`string`, `number`, `boolean`) -> `assets/cuthol-vars.json` for `--variables-file`
 *      and `window.__hyperframes.getVariables()`.
 *    - Time-series timeline intelligence (`words`, `beats`, `audio`, `cuts`, `safeZone`) ->
 *      synchronous `assets/cuthol-data.js` (`window.__CUTHOL_DATA__`) + `assets/cuthol-runtime.js` (`window.__cuthol`).
 * 2. Window-local slice hashing (Zero Unnecessary Re-render):
 *    - Global `seq.meta.revision` is NEVER written into `cuthol-data.js`.
 *    - `sliceHash` is computed solely from the normalized local window `[0 .. durationSec]`.
 *    - Conditional disk write: if `assets/cuthol-data.json` already carries the same `hash`,
 *      files on disk are not touched (`mtime` and render cache remain intact).
 * 3. Recursive directory hashing (`hashDirectoryRecursive`):
 *    - Walks `assets/`, `compositions/`, and all nested subdirectories so any asset, font, CSS,
 *      or bridge data change is reflected in the render cache key.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CutholSequence, LaneCue
} from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import {
  CutholBridgeV1, getCutholRuntimeJsSource
} from "./cuthol_runtime.js";
import { resolveExtension } from "../extensions/manager.js";

/**
 * Extension resolution, deliberately unmemoized: the registry inputs live on
 * disk and can change between two calls of one process (tests, Live) without
 * starting a new command generation, so a memoized answer could resolve a
 * stale extension for the rest of the command.
 */
function resolveExtensionCached(
  seq: CutholSequence,
  name: string,
  rootDir: string
): ReturnType<typeof resolveExtension> {
  return resolveExtension(name, rootDir);
}
import { syncSharedProjectAssetsToComposition } from "./bridge_extension_assets.js";
import { exportBridgeDataForCue, isAutoAnalyzingInBridge } from "./bridge_export_cue.js";
import { analyzeCompositionDataUsage, analyzeCompositionDataUsageCached, beginCompositionSweep, computeUsedBridgePayloadHashes, endCompositionSweep, hashDirectoryRecursive, extractScalarHyperFramesVariables, findBundledGsapMinJs, invalidateCompositionDirHashes } from "./bridge_hash.js";
import { currentHashGeneration, hashFileContent, readTextIfExists, writeFileCached } from "../core/file_hash_index.js";
export { hashDirectoryRecursive, extractScalarHyperFramesVariables, analyzeCompositionDataUsage, analyzeCompositionDataUsageCached, hashCompositionFilesExcludingBridgeData, computeUsedBridgePayloadHashes, compositionUsesAudio, getCompositionDirHashes, getCompositionFingerprint, invalidateCompositionDirHashes, memoizedCompositionDirHash } from "./bridge_hash.js";
export type { CompositionDataUsage } from "./bridge_hash.js";
export { syncEnabledExtensionAssetsToComposition, detectCompositionExtensionCopyDrift, syncSharedProjectAssetsToComposition, compositionReferencesSharedAssets } from "./bridge_extension_assets.js";
export { exportBridgeDataForCue } from "./bridge_export_cue.js";


/**
 * Synchronizes `assets/cuthol-data.json`, `assets/cuthol-data.js`, `assets/cuthol-runtime.js`,
 * and `assets/cuthol-vars.json` inside a composition directory using conditional writes:
 * If `sliceHash` has not changed (and during background sync `global` is not needed),
 * `cuthol-data.json` and `cuthol-data.js` are NOT overwritten.
 */
export function syncCompositionBridgeFiles(
  seq: CutholSequence,
  cue: LaneCue,
  paths: WorkspacePaths,
  options?: { explicit?: boolean }
): {
  updated: boolean;
  in_sync: boolean;
  sliceHash: string;
  globalHash: string;
  updated_files: string[];
  reason: string;
  dataJsPath: string;
  runtimeJsPath: string;
  varsJsonPath: string;
  bridgeData: CutholBridgeV1;
} | null {
  if (cue.kind !== "composition" || !cue.composition) return null;

  const compDir = path.isAbsolute(cue.composition.composition_dir)
    ? cue.composition.composition_dir
    : path.resolve(paths.rootDir, cue.composition.composition_dir);

  if (!fs.existsSync(compDir)) return null;

  const assetsDir = path.join(compDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const bridgeData = exportBridgeDataForCue(seq, cue, paths) as CutholBridgeV1 & {
    warnings?: string[];
  };
  const dataJsonPath = path.join(assetsDir, "cuthol-data.json");
  const dataJsPath = path.join(assetsDir, "cuthol-data.js");
  const runtimeJsPath = path.join(assetsDir, "cuthol-runtime.js");
  const varsJsonPath = path.join(assetsDir, "cuthol-vars.json");

  let updated = false;
  const updatedFiles: string[] = [];
  const updateReasons: string[] = [];

  // 1. Check if `cuthol-data.json` already has the exact same `sliceHash` (and `global` payload)
  const entryRel = cue.composition.entry_html || "index.html";
  const entryHtmlPath = path.join(compDir, entryRel);
  const existingEntryHtml = readTextIfExists(entryHtmlPath);
  const usage = analyzeCompositionDataUsageCached(compDir, entryRel, cue.composition.props);
  const compUsesGlobal = usage.usesAnyGlobal;

  let existingHash: string | null = null;
  let existingGlobalHash: string | null = null;
  let existingWarningsJson = "[]";
  let existingDataJsonRaw: string | null = null;
  let existingParsedBridge: Partial<CutholBridgeV1> | null = null;
  let hasExistingGlobal = false;
  if (fs.existsSync(dataJsonPath) && fs.existsSync(dataJsPath)) {
    try {
      existingDataJsonRaw = readTextIfExists(dataJsonPath) ?? fs.readFileSync(dataJsonPath, "utf8");
      const parsed = JSON.parse(existingDataJsonRaw) as Partial<CutholBridgeV1> & {
        hash?: string;
        global?: { hash?: string };
        warnings?: string[];
      };
      existingParsedBridge = parsed;
      existingHash = parsed.hash ?? null;
      hasExistingGlobal = parsed.global !== undefined;
      existingGlobalHash = parsed.global?.hash ?? null;
      existingWarningsJson = JSON.stringify(parsed.warnings ?? []);
    } catch {
      existingHash = null;
    }
  }

  const prevUsedHashes = existingParsedBridge
    ? computeUsedBridgePayloadHashes(existingParsedBridge, usage)
    : null;
  const nextUsedHashes = computeUsedBridgePayloadHashes(bridgeData, usage);
  const usedSliceChanged =
    prevUsedHashes !== null && prevUsedHashes.usedSliceHash !== nextUsedHashes.usedSliceHash;
  const usedGlobalChanged =
    prevUsedHashes !== null && prevUsedHashes.usedGlobalHash !== nextUsedHashes.usedGlobalHash;

  const metaSidecarPath = path.join(assetsDir, ".cuthol-bridge-meta.json");
  let existingBridgeMeta: {
    validLegacyDirHashes?: string[];
    usedSliceHash?: string;
    usedGlobalHash?: string;
    lastDataChangeReason?: "slice_changed" | "global_used_changed" | null;
  } = {};
  if (fs.existsSync(metaSidecarPath)) {
    try {
      const metaRaw = readTextIfExists(metaSidecarPath) ?? fs.readFileSync(metaSidecarPath, "utf8");
      existingBridgeMeta = JSON.parse(metaRaw);
    } catch {
      existingBridgeMeta = {};
    }
  }

  const newWarningsJson = JSON.stringify(bridgeData.warnings ?? []);
  const sliceChanged = existingHash !== bridgeData.hash;
  const globalChanged = existingGlobalHash !== (bridgeData.global?.hash ?? null);
  const warningsChanged = existingWarningsJson !== newWarningsJson;

  // The pretty-printed payload is the most expensive value built here (global
  // audio envelopes run to thousands of frames), yet it only matters when an
  // earlier signal already forces a write or an explicit sync compares bytes.
  // Untouched compositions skip the stringify entirely; the write decision is
  // unchanged, so bytes on disk are identical.
  const needsDataWriteEarly =
    sliceChanged ||
    !hasExistingGlobal ||
    warningsChanged ||
    (compUsesGlobal && globalChanged) ||
    usedSliceChanged ||
    usedGlobalChanged;
  let jsonStr = "";
  let fullJsonChanged = false;
  if (needsDataWriteEarly || options?.explicit === true) {
    jsonStr = JSON.stringify(bridgeData, null, 2);
    fullJsonChanged = existingDataJsonRaw !== jsonStr;
  }

  const needsDataWrite = needsDataWriteEarly || (options?.explicit === true && fullJsonChanged);

  let validLegacyDirHashes = Array.isArray(existingBridgeMeta.validLegacyDirHashes)
    ? [...existingBridgeMeta.validLegacyDirHashes]
    : [];
  let lastDataChangeReason = existingBridgeMeta.lastDataChangeReason ?? null;

  if (usedSliceChanged || usedGlobalChanged) {
    validLegacyDirHashes = [];
    lastDataChangeReason = usedSliceChanged ? "slice_changed" : "global_used_changed";
  } else if (needsDataWrite && existingHash !== null) {
    // Capture the pre-write directory hash when only unused bridge fields changed on disk
    // so existing `.cuthol/blobs/hf_comp_<legacyHash>` caches remain valid.
    const preWriteLegacyHash = hashDirectoryRecursive(compDir);
    if (!validLegacyDirHashes.includes(preWriteLegacyHash)) {
      validLegacyDirHashes.push(preWriteLegacyHash);
    }
  }

  if (needsDataWrite) {
    const compactJsPayload = JSON.stringify(bridgeData);
    writeFileCached(dataJsonPath, jsonStr);
    writeFileCached(
      dataJsPath,
      `/* Auto-generated by Cuthol (${bridgeData.hash}) — window-local + global timeline slice */\nwindow.__CUTHOL_DATA__ = ${compactJsPayload};\n`
    );
    updated = true;
    updatedFiles.push("assets/cuthol-data.json", "assets/cuthol-data.js");
    if (existingHash === null) {
      updateReasons.push("initial_bridge_write");
    } else {
      if (sliceChanged) {
        updateReasons.push(`slice_hash_changed (${existingHash} -> ${bridgeData.hash})`);
      }
      if (globalChanged && (compUsesGlobal || options?.explicit)) {
        updateReasons.push(
          `global_hash_changed (${existingGlobalHash ?? "none"} -> ${bridgeData.global?.hash ?? "none"})`
        );
      }
      if (warningsChanged) {
        updateReasons.push("warnings_changed");
      }
      if (!sliceChanged && !globalChanged && !warningsChanged && fullJsonChanged) {
        updateReasons.push("bridge_metadata_changed");
      }
    }
  }

  // Conditional sidecar write: the previous unconditional rewrite touched the
  // mtime of every composition on every sync, invalidating content hashes.
  const nextMetaJson = JSON.stringify(
    {
      usedSliceHash: nextUsedHashes.usedSliceHash,
      usedGlobalHash: nextUsedHashes.usedGlobalHash,
      validLegacyDirHashes,
      lastDataChangeReason,
    },
    null,
    2
  );
  let existingMetaRaw: string | null = null;
  if (fs.existsSync(metaSidecarPath)) {
    try {
      existingMetaRaw = readTextIfExists(metaSidecarPath);
    } catch {
      existingMetaRaw = null;
    }
  }
  if (existingMetaRaw !== nextMetaJson) {
    try {
      writeFileCached(metaSidecarPath, nextMetaJson);
    } catch {
      // ignore sidecar write error
    }
  }

  // 2. Conditionally write `cuthol-runtime.js` only if missing or content differs
  const baseRuntimeSource = getCutholRuntimeJsSource();
  const runtimeSource = baseRuntimeSource
    .replace(
      /var warnings = \[\], errors = \[\];\r?\n\s*var d = rawData \|\| \{\};/,
      "$&\n    if (Array.isArray(d.warnings)) { d.warnings.forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); }); }"
    )
    .replace(
      "if (!audioFps || !arr || !arr.length) return 0;",
      "if (!audioFps || !arr || !arr.length) { var aw = (Array.isArray(d.warnings) && d.warnings[0]) || 'Audio energy (C.audio) data empty — C.audio returns 0'; if (warnings.indexOf(aw) < 0) warnings.push(aw); return 0; }"
    );
  const existingRuntime = readTextIfExists(runtimeJsPath);
  if (existingRuntime !== runtimeSource) {
    writeFileCached(runtimeJsPath, runtimeSource);
    updated = true;
    updatedFiles.push("assets/cuthol-runtime.js");
    updateReasons.push("runtime_updated");
  }

  // 3. Conditionally write `cuthol-vars.json` (scalar variables for `--variables-file`)
  const scalarVars = extractScalarHyperFramesVariables(cue.composition.props);
  const varsJsonStr = JSON.stringify(scalarVars, null, 2);
  const existingVars = readTextIfExists(varsJsonPath);
  if (existingVars !== varsJsonStr) {
    writeFileCached(varsJsonPath, varsJsonStr);
    updated = true;
    updatedFiles.push("assets/cuthol-vars.json");
    updateReasons.push("props_vars_updated");
  }

  // 4. Ensure entry HTML (`index.html`) includes synchronous `<script src="assets/cuthol-data.js">`
  // followed by `<script src="assets/cuthol-runtime.js">` in the proper order, touching ONLY those
  // exact two tags and never modifying any other `<script>` tags in the user's HTML.
  if (existingEntryHtml !== null) {
    const html = existingEntryHtml;
    const dataTag = `<script src="assets/cuthol-data.js"></script>`;
    const runtimeTag = `<script src="assets/cuthol-runtime.js"></script>`;
    const exactDataRe = /<script\s+src=(["'])assets\/cuthol-data\.js\1\s*><\/script>/i;
    const exactRuntimeRe = /<script\s+src=(["'])assets\/cuthol-runtime\.js\1\s*><\/script>/i;
    const dataMatch = exactDataRe.exec(html);
    const runtimeMatch = exactRuntimeRe.exec(html);
    const dataIdx = dataMatch ? dataMatch.index : -1;
    const runtimeIdx = runtimeMatch ? runtimeMatch.index : -1;
    let nextHtml = html;

    if (dataIdx === -1 && runtimeIdx === -1) {
      if (/<template[\s>]/i.test(html) && /<script[\s>]/i.test(html)) {
        nextHtml = html.replace(/<script[\s>]/i, `${dataTag}\n      ${runtimeTag}\n      $&`);
      } else if (/<\/head>/i.test(html)) {
        nextHtml = html.replace(/<\/head>/i, `    ${dataTag}\n    ${runtimeTag}\n  </head>`);
      } else if (/<script[\s>]/i.test(html)) {
        nextHtml = html.replace(/<script[\s>]/i, `${dataTag}\n${runtimeTag}\n$&`);
      }
    } else if (dataIdx === -1 && runtimeIdx !== -1) {
      nextHtml = html.replace(exactRuntimeRe, `${dataTag}\n    $&`);
    } else if (dataIdx !== -1 && runtimeIdx === -1) {
      nextHtml = html.replace(exactDataRe, `$&\n    ${runtimeTag}`);
    } else if (runtimeIdx < dataIdx) {
      const withoutRuntime = html.replace(
        /\s*<script\s+src=(["'])assets\/cuthol-runtime\.js\1\s*><\/script>/i,
        ""
      );
      nextHtml = withoutRuntime.replace(exactDataRe, `$&\n    ${runtimeTag}`);
    }

    // 4b. Sync enabled project extensions (composition helpers & asset packs).
    // If no extensions are enabled and no stale cuthol-ext-* tags exist, `nextHtml` is untouched.
    // When `options.explicit` is not set and an extension on disk drifted from its pinned sequence hash (G205),
    // do not silently overwrite an already-copied helper/asset in the composition until `extension enable` runs.
    const activeHelperNames: string[] = [];
    const enabledRefs = seq.extensions ?? [];
    if (enabledRefs.length > 0) {
      for (const extRef of enabledRefs) {
        try {
          const ext = resolveExtensionCached(seq, extRef.name, paths.rootDir);
          const isPinnedMatch =
            ext.contentHash === extRef.content_hash && ext.version === extRef.version;
          const allowOverwriteExistingCopy = isPinnedMatch && options?.explicit === true;
          if (ext.assetsRelDir) {
            const srcAssetsDir = path.join(ext.dir, ext.assetsRelDir);
            const destAssetsDir = path.join(assetsDir, "ext", ext.name);
            const syncDirConditionally = (sDir: string, dDir: string, relPref: string): void => {
              fs.mkdirSync(dDir, { recursive: true });
              for (const ent of fs.readdirSync(sDir, { withFileTypes: true })) {
                if (ent.name.startsWith(".tmp") || ent.name === ".DS_Store") continue;
                const sFull = path.join(sDir, ent.name);
                const dFull = path.join(dDir, ent.name);
                const relFile = `${relPref}/${ent.name}`;
                if (ent.isDirectory()) {
                  syncDirConditionally(sFull, dFull, relFile);
                } else if (ent.isFile()) {
                  // Hash first; read bytes lazily only when a copy must be
                  // written (copies are virtually always in sync).
                  const dExists = fs.existsSync(dFull);
                  const needsWrite =
                    !dExists ||
                    (allowOverwriteExistingCopy &&
                      hashFileContent(sFull) !== hashFileContent(dFull));
                  if (needsWrite) {
                    const sBuf = fs.readFileSync(sFull);
                    if (
                      !dExists ||
                      (allowOverwriteExistingCopy && Buffer.compare(sBuf, fs.readFileSync(dFull)) !== 0)
                    ) {
                      writeFileCached(dFull, sBuf);
                      updated = true;
                      updatedFiles.push(relFile);
                      if (!updateReasons.includes("extension_assets_updated")) {
                        updateReasons.push("extension_assets_updated");
                      }
                    }
                  }
                }
              }
            };
            if (fs.existsSync(srcAssetsDir)) {
              syncDirConditionally(srcAssetsDir, destAssetsDir, `assets/ext/${ext.name}`);
            }
          }
          if (ext.helperRelPath) {
            const srcHelperPath = path.join(ext.dir, ext.helperRelPath);
            if (fs.existsSync(srcHelperPath)) {
              activeHelperNames.push(ext.name);
              const rawHelper =
                readTextIfExists(srcHelperPath) ?? fs.readFileSync(srcHelperPath, "utf8");
              const wrappedHelper =
                `if (typeof window !== "undefined") { window.__cuthol = window.__cuthol || {}; window.__cuthol.ext = window.__cuthol.ext || {}; }\n` +
                rawHelper;
              const destHelperPath = path.join(assetsDir, `cuthol-ext-${ext.name}.js`);
              const existingHelper = readTextIfExists(destHelperPath);
              if (
                existingHelper === null ||
                (allowOverwriteExistingCopy && existingHelper !== wrappedHelper)
              ) {
                writeFileCached(destHelperPath, wrappedHelper);
                updated = true;
                updatedFiles.push(`assets/cuthol-ext-${ext.name}.js`);
                if (!updateReasons.includes("extension_helper_updated")) {
                  updateReasons.push("extension_helper_updated");
                }
              }
            }
          }
        } catch {
          // Verified by Gate 2 (`verifySequence`)
        }
      }
    }

    // Remove any stale exact `<script src="assets/cuthol-ext-<name>.js"></script>` tags for disabled extensions
    const activeSet = new Set(activeHelperNames);
    nextHtml = nextHtml.replace(
      /[ \t]*<script\s+src=(["'])assets\/cuthol-ext-([a-z0-9_-]+)\.js\1\s*><\/script>\r?\n?/gi,
      (fullMatch, _q: string, extName: string) => {
        if (activeSet.has(extName)) return fullMatch;
        const staleFile = path.join(assetsDir, `cuthol-ext-${extName}.js`);
        if (fs.existsSync(staleFile)) {
          try {
            fs.unlinkSync(staleFile);
            updated = true;
            updatedFiles.push(`assets/cuthol-ext-${extName}.js (removed)`);
            if (!updateReasons.includes("stale_extension_removed")) {
              updateReasons.push("stale_extension_removed");
            }
          } catch {
            // ignore
          }
        }
        return "";
      }
    );

    // Ensure each active helper script tag is injected right after `assets/cuthol-runtime.js`
    if (activeHelperNames.length > 0) {
      let anchorRe = exactRuntimeRe;
      for (const extName of activeHelperNames) {
        const extTag = `<script src="assets/cuthol-ext-${extName}.js"></script>`;
        const exactExtRe = new RegExp(
          `<script\\s+src=(["'])assets\\/cuthol-ext-${extName}\\.js\\1\\s*><\\/script>`,
          "i"
        );
        if (!exactExtRe.test(nextHtml)) {
          nextHtml = nextHtml.replace(anchorRe, `$&\n    ${extTag}`);
        }
        anchorRe = exactExtRe;
      }
    }

    if (nextHtml !== html) {
      writeFileCached(entryHtmlPath, nextHtml);
      updated = true;
      updatedFiles.push(entryRel);
      updateReasons.push("entry_html_scripts_injected");
    }

    // 4c. Sync the project-level `shared/` folder into compositions that reference it.
    const sharedSync = syncSharedProjectAssetsToComposition(compDir, entryRel, paths);
    if (sharedSync.updated) {
      updated = true;
      updatedFiles.push(...sharedSync.updatedFiles);
      if (!updateReasons.includes("shared_assets_updated")) {
        updateReasons.push("shared_assets_updated");
      }
    }

    // 5. Hand-written compositions that reference `assets/gsap.min.js` get the bundled copy;
    // without it the timeline script throws and the overlay renders fully transparent.
    const gsapPath = path.join(assetsDir, "gsap.min.js");
    if (/src=["']assets\/gsap\.min\.js["']/i.test(nextHtml) && !fs.existsSync(gsapPath)) {
      const bundledGsap = findBundledGsapMinJs();
      if (bundledGsap) {
        fs.copyFileSync(bundledGsap, gsapPath);
        invalidateCompositionDirHashes(compDir);
        updated = true;
        updatedFiles.push("assets/gsap.min.js");
        updateReasons.push("gsap_injected");
      }
    }
  }

  const globalHash = bridgeData.global?.hash ?? "";
  const reason = updated
    ? updateReasons.join(", ")
    : "already_in_sync (bridge files on disk already match current sequence state; Cuthol auto-syncs on edits and media analysis)";

  // Every write above changed bytes under this composition: drop memoized
  // fingerprints/hashes so later reads in the same command see the new state.
  if (updated) invalidateCompositionDirHashes(compDir);

  return {
    updated,
    in_sync: true,
    sliceHash: bridgeData.hash,
    globalHash,
    updated_files: updatedFiles,
    reason,
    dataJsPath,
    runtimeJsPath,
    varsJsonPath,
    bridgeData,
  };
}

/**
 * Synchronizes all mounted HyperFrames compositions in the sequence using window-local conditional writes.
 */
export function syncAllCompositionBridges(
  seq: CutholSequence,
  paths: WorkspacePaths,
  options?: { explicit?: boolean }
): Array<{
  cueId: string;
  compositionDir: string;
  updated: boolean;
  in_sync: boolean;
  sliceHash: string;
  globalHash: string;
  updated_files: string[];
  reason: string;
}> {
  if (isAutoAnalyzingInBridge) return [];
  const results: Array<{
    cueId: string;
    compositionDir: string;
    updated: boolean;
    in_sync: boolean;
    sliceHash: string;
    globalHash: string;
    updated_files: string[];
    reason: string;
  }> = [];

  // One fingerprint-sharing sweep for the whole pass: every composition is
  // stat-walked once no matter how many cues and callers touch it. Cuthol's
  // own writes evict per composition; synchronous execution means no
  // external edit can interleave.
  beginCompositionSweep();
  try {
    for (const lane of seq.lanes) {
      for (const cue of lane.cues) {
        if (cue.kind === "composition" && cue.composition) {
          const res = syncCompositionBridgeFiles(seq, cue, paths, options);
          if (res) {
            results.push({
              cueId: cue.id,
              compositionDir: cue.composition.composition_dir,
              updated: res.updated,
              in_sync: res.in_sync,
              sliceHash: res.sliceHash,
              globalHash: res.globalHash,
              updated_files: res.updated_files,
              reason: res.reason,
            });
          }
        }
      }
    }
  } finally {
    endCompositionSweep();
  }
  return results;
}
