// Copies enabled extension assets into compositions and detects stale copies (split out of bridge_exporter.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CutholSequence
} from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { resolveExtension } from "../extensions/manager.js";
import { findBundledGsapMinJs } from "./bridge_hash.js";
import {
  currentHashGeneration,
  findProjectRoot,
  getPersistedContentMemo,
  hashFileContent,
  readTextFileCached,
  setPersistedContentMemo,
  writeFileCached,
} from "../core/file_hash_index.js";
import { fingerprintCompositionDir, getCompositionDirHashes, invalidateCompositionDirHashes } from "./bridge_hash.js";

/**
 * Content hash of an already-synced copy. Copies live inside composition
 * folders, so they are shared in-process only and always re-read by the next
 * command (never trusted across processes on stat alone).
 */
function syncedCopyHash(absPath: string): string {
  const cached = hashFileContent(absPath);
  if (cached !== null) return cached;
  return sha256Hex(fs.readFileSync(absPath));
}

/**
 * First line prepended to every Cuthol-written helper copy. A helper copy starting
 * with this marker was written by Cuthol (not by the user), so a stale one may be
 * refreshed in place; anything else is left alone and reported as drift (G205).
 */
export const CUTHOL_EXT_HELPER_MARKER =
  `if (typeof window !== "undefined") { window.__cuthol = window.__cuthol || {}; window.__cuthol.ext = window.__cuthol.ext || {}; }`;

const EXT_SYNC_SIDECAR = ".cuthol-ext-sync.json";

interface ExtSyncSidecar {
  version: 1;
  extensions: Record<string, { contentHash: string; files: Record<string, string> }>;
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readExtSyncSidecar(assetsDir: string): ExtSyncSidecar {
  try {
    const raw = fs.readFileSync(path.join(assetsDir, EXT_SYNC_SIDECAR), "utf8");
    const parsed = JSON.parse(raw) as Partial<ExtSyncSidecar>;
    if (parsed.version === 1 && parsed.extensions && typeof parsed.extensions === "object") {
      return { version: 1, extensions: parsed.extensions };
    }
  } catch {
    // missing or corrupt sidecar: treat as no records
  }
  return { version: 1, extensions: {} };
}

function writeExtSyncSidecar(assetsDir: string, sidecar: ExtSyncSidecar): void {
  try {
    writeFileCached(path.join(assetsDir, EXT_SYNC_SIDECAR), JSON.stringify(sidecar));
  } catch {
    // sidecar is best-effort bookkeeping; the copies themselves are authoritative
  }
}

/**
 * Synchronizes enabled project extension asset packs (`assets/ext/<name>/`), helper scripts
 * (`assets/cuthol-ext-<name>.js`), and bundled `assets/gsap.min.js` into a composition folder
 * BEFORE HyperFrames contract/lint checks run so `missing_local_asset` never fires a false alarm
 * on extension assets.
 *
 * Refresh rule: after the pinned extension hash changes, Cuthol-written copies are refreshed
 * in place (helper copies carrying the marker line; asset-pack files whose current bytes match
 * the last synced bytes recorded in `assets/.cuthol-ext-sync.json`). A file the user edited
 * inside the composition never matches those proofs, so it is left alone and
 * `detectCompositionExtensionCopyDrift` keeps reporting it (G205).
 */
export const SHARED_PROJECT_DIR_NAME = "shared";
const SHARED_SIDECAR_KEY = "__shared__";

/**
 * Sync results keyed by everything the sync reads (never by command
 * generation alone): the entry HTML content hash, the pinned extension refs
 * plus each enabled extension's content hash, and the shared folder's stat
 * fingerprint. All key parts are re-stated on every call, so an edit between
 * two calls of one process misses and re-syncs; identical inputs reuse the
 * recorded answer without re-walking. (A forged size+mtime that also fools
 * the stat checks is caught across commands instead: every command opens a
 * new hash generation, which re-reads all files on first touch.)
 */
const extSyncMemo = new Map<string, { updated: boolean; updatedFiles: string[] }>();

function extSyncMemoKey(
  seq: CutholSequence,
  absCompDir: string,
  entryHtml: string,
  rootDir: string | null
): string {
  const entryHash = hashFileContent(path.join(absCompDir, entryHtml || "index.html")) ?? "missing";
  const extParts: string[] = [];
  for (const ref of seq.extensions ?? []) {
    const name = (ref as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    try {
      extParts.push(`${name}=${resolveExtension(name, rootDir).contentHash}`);
    } catch {
      extParts.push(`${name}=unresolvable`);
    }
  }
  let sharedFp = "noshared";
  if (rootDir) {
    const sharedDir = path.join(rootDir, SHARED_PROJECT_DIR_NAME);
    if (fs.existsSync(sharedDir)) sharedFp = fingerprintCompositionDir(sharedDir) ?? "unwalkable";
  }
  return `${absCompDir}\n${entryHtml}\n${entryHash}\n${JSON.stringify(seq.extensions ?? [])}\n${extParts.join(",")}\n${sharedFp}`;
}

export function syncEnabledExtensionAssetsToComposition(
  seq: CutholSequence,
  compDir: string,
  entryHtml = "index.html",
  paths?: WorkspacePaths
): { updated: boolean; updatedFiles: string[] } {
  const absCompDir =
    paths && !path.isAbsolute(compDir) ? path.resolve(paths.rootDir, compDir) : path.resolve(compDir);
  if (!fs.existsSync(absCompDir)) return { updated: false, updatedFiles: [] };
  const rootDir = paths ? path.resolve(paths.rootDir) : findProjectRoot(absCompDir);
  const memoKey = extSyncMemoKey(seq, absCompDir, entryHtml, rootDir);
  const memoHit = extSyncMemo.get(memoKey);
  if (memoHit !== undefined) return { updated: memoHit.updated, updatedFiles: [...memoHit.updatedFiles] };

  const assetsDir = path.join(absCompDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  let updated = false;
  const updatedFiles: string[] = [];
  const sidecar = readExtSyncSidecar(assetsDir);
  let sidecarDirty = false;
  const recordSyncedFile = (extName: string, contentHash: string, rel: string, hash: string): void => {
    const prev = sidecar.extensions[extName];
    if (!prev || prev.contentHash !== contentHash || prev.files[rel] !== hash) {
      sidecar.extensions[extName] = {
        contentHash,
        files: { ...(prev?.files ?? {}), [rel]: hash },
      };
      sidecarDirty = true;
    }
  };

  const enabledRefs = seq.extensions ?? [];
  const activeHelperNames: string[] = [];
  if (enabledRefs.length > 0 && paths) {
    for (const extRef of enabledRefs) {
      try {
        const ext = resolveExtension(extRef.name, paths.rootDir);
        const isPinnedMatch =
          ext.contentHash === extRef.content_hash && ext.version === extRef.version;
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
                // Hash first (shared cache: each source read once per command);
                // bytes are read lazily only when a copy must be written.
                const sHash = hashFileContent(sFull) ?? sha256Hex(fs.readFileSync(sFull));
                if (!fs.existsSync(dFull)) {
                  writeFileCached(dFull, fs.readFileSync(sFull));
                  updated = true;
                  updatedFiles.push(relFile);
                  recordSyncedFile(ext.name, ext.contentHash, relFile, sHash);
                } else {
                  const dHash = syncedCopyHash(dFull);
                  if (dHash === sHash) {
                    recordSyncedFile(ext.name, ext.contentHash, relFile, sHash);
                  } else if (sidecar.extensions[ext.name]?.files[relFile] === dHash) {
                    // Cuthol-written copy from an older pinned hash: refresh in place.
                    writeFileCached(dFull, fs.readFileSync(sFull));
                    updated = true;
                    updatedFiles.push(relFile);
                    recordSyncedFile(ext.name, ext.contentHash, relFile, sHash);
                  }
                  // Otherwise the user edited the copy (or it predates sidecar
                  // bookkeeping and differs): leave it alone, drift keeps G205.
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
            // Shared in-process text cache: one read per source per command.
            const rawHelper =
              readTextFileCached(srcHelperPath) ?? fs.readFileSync(srcHelperPath, "utf8");
            const wrappedHelper = CUTHOL_EXT_HELPER_MARKER + "\n" + rawHelper;
            const relHelper = `assets/cuthol-ext-${ext.name}.js`;
            const destHelperPath = path.join(assetsDir, `cuthol-ext-${ext.name}.js`);
            const existingHelper = fs.existsSync(destHelperPath)
              ? (readTextFileCached(destHelperPath) ?? fs.readFileSync(destHelperPath, "utf8"))
              : null;
            const wrappedHash = sha256Hex(wrappedHelper);
            if (existingHelper === null) {
              writeFileCached(destHelperPath, wrappedHelper);
              updated = true;
              updatedFiles.push(relHelper);
              recordSyncedFile(ext.name, ext.contentHash, relHelper, wrappedHash);
            } else if (existingHelper === wrappedHelper) {
              recordSyncedFile(ext.name, ext.contentHash, relHelper, wrappedHash);
            } else if (
              (() => {
                const recorded = sidecar.extensions[ext.name]?.files[relHelper];
                // With a sync record, only the exact bytes Cuthol last wrote count as
                // Cuthol-written; an edit anywhere in the file (marker line kept) is the user's.
                // Without one (copies seeded before the record existed) the marker line is
                // the only proof available.
                return recorded !== undefined
                  ? recorded === sha256Hex(existingHelper)
                  : existingHelper.startsWith(CUTHOL_EXT_HELPER_MARKER);
              })()
            ) {
              // Cuthol-written copy from an older pinned hash: refresh in place.
              writeFileCached(destHelperPath, wrappedHelper);
              updated = true;
              updatedFiles.push(relHelper);
              recordSyncedFile(ext.name, ext.contentHash, relHelper, wrappedHash);
            }
            // Otherwise the user edited the copy: leave it alone, drift keeps G205.
          }
        }
      } catch {
        // Verified by Gate 2 (`verifySequence`)
      }
    }
  }

  const entryHtmlPath = path.join(absCompDir, entryHtml || "index.html");
  if (fs.existsSync(entryHtmlPath)) {
    const html = fs.readFileSync(entryHtmlPath, "utf8");
    const gsapPath = path.join(assetsDir, "gsap.min.js");
    if (/src=["']assets\/gsap\.min\.js["']/i.test(html) && !fs.existsSync(gsapPath)) {
      const bundledGsap = findBundledGsapMinJs();
      if (bundledGsap) {
        fs.copyFileSync(bundledGsap, gsapPath);
        updated = true;
        updatedFiles.push("assets/gsap.min.js");
      }
    }
  }

  const sharedSync = syncSharedProjectAssetsToComposition(absCompDir, entryHtml, paths);
  if (sharedSync.updated) {
    updated = true;
    updatedFiles.push(...sharedSync.updatedFiles);
  }

  if (sidecarDirty) writeExtSyncSidecar(assetsDir, sidecar);
  if (updated || sidecarDirty) invalidateCompositionDirHashes(absCompDir);

  // Memoize only clean no-ops: a recorded `updated: true` would keep
  // reporting work on every repeat call although the bytes were already
  // written, and a dirty sidecar means the next call still has bookkeeping
  // to do. A no-op for identical inputs stays a no-op (any state the key
  // does not cover, such as a user-edited copy, still yields `updated:
  // false` because the sync leaves it alone), so the next identical call
  // can skip the walk.
  if (!updated && !sidecarDirty) {
    if (extSyncMemo.size > 2000) extSyncMemo.clear();
    extSyncMemo.set(memoKey, { updated, updatedFiles: [] });
  }
  return { updated, updatedFiles };
}

/**
 * Returns true when a composition references project shared assets
 * (`assets/shared/...` in its entry HTML or scripts), so only compositions
 * that actually use the shared folder receive copies (and re-render when it changes).
 */
export function compositionReferencesSharedAssets(
  compDir: string,
  entryHtml = "index.html"
): boolean {
  const absCompDir = path.resolve(compDir);
  // Deliberately no in-process memo: the reference scan reads source files
  // that can change between two calls of one process without starting a new
  // command generation. Only the content-derived persisted answer (keyed by
  // the files hash, which provably describes identical bytes) is reused: an
  // edit always misses and re-scans.
  try {
    const filesHash = getCompositionDirHashes(absCompDir).filesHash;
    const rootDir = findProjectRoot(absCompDir);
    if (rootDir) {
      const persisted = getPersistedContentMemo(rootDir, `shared-ref\n${entryHtml}\n${filesHash}`);
      if (typeof persisted === "boolean") return persisted;
    }
  } catch {
    // fall through to the scan
  }
  const remember = (value: boolean): boolean => {
    try {
      const rootDir = findProjectRoot(absCompDir);
      const filesHash = getCompositionDirHashes(absCompDir).filesHash;
      if (rootDir) setPersistedContentMemo(rootDir, `shared-ref\n${entryHtml}\n${filesHash}`, value);
    } catch {
      // persistence is best-effort
    }
    return value;
  };
  const entryPath = path.join(absCompDir, entryHtml || "index.html");
  const probe = (source: string): boolean => /assets\/shared\//.test(source);
  try {
    // Cached reads: within one command repeats hit the shared content cache
    // (exact size + full-precision mtime match), so the scan costs one walk.
    // Reads always go through the cache's stat check, hence an edited file
    // is never masked by a stale memo (there is none here to mask it).
    if (probe(readTextFileCached(entryPath) ?? "")) return remember(true);
  } catch {
    // fall through to script scan
  }
  const scanDir = (dir: string, depth: number): boolean => {
    if (depth > 3) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".cuthol" || ent.name === ".hyperframes") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (scanDir(full, depth + 1)) return true;
      } else if (ent.isFile() && /\.(?:html|js|mjs|css)$/i.test(ent.name)) {
        try {
          if (probe(readTextFileCached(full) ?? "")) return true;
        } catch {
          // ignore unreadable file
        }
      }
    }
    return false;
  };
  return remember(scanDir(absCompDir, 0));
}

/**
 * Synchronizes the project-level `shared/` folder (`<project>/shared/`) into a
 * composition as `assets/shared/...`, but only for compositions that reference
 * `assets/shared/`. Files there are visible to every composition under the
 * same relative path in render, monitor and Live (which all serve the
 * composition directory), and their content is part of the composition hash,
 * so editing a shared file re-renders exactly the compositions that use it.
 *
 * Refresh rule mirrors the extension rule: missing copies are written; a copy
 * whose current bytes match the last synced bytes is refreshed in place; a
 * file the user edited inside the composition is left alone.
 */
export function syncSharedProjectAssetsToComposition(
  compDir: string,
  entryHtml = "index.html",
  paths?: WorkspacePaths
): { updated: boolean; updatedFiles: string[] } {
  if (!paths) return { updated: false, updatedFiles: [] };
  const absCompDir = path.resolve(compDir);
  if (!fs.existsSync(absCompDir)) return { updated: false, updatedFiles: [] };
  if (!compositionReferencesSharedAssets(absCompDir, entryHtml)) {
    return { updated: false, updatedFiles: [] };
  }
  const srcSharedDir = path.join(path.resolve(paths.rootDir), SHARED_PROJECT_DIR_NAME);
  if (!fs.existsSync(srcSharedDir)) return { updated: false, updatedFiles: [] };

  const assetsDir = path.join(absCompDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const sidecar = readExtSyncSidecar(assetsDir);
  const sidecarBefore = JSON.stringify(sidecar);
  let updated = false;
  const updatedFiles: string[] = [];

  const syncDir = (sDir: string, dDir: string, relPref: string): void => {
    fs.mkdirSync(dDir, { recursive: true });
    for (const ent of fs.readdirSync(sDir, { withFileTypes: true })) {
      if (ent.name.startsWith(".tmp") || ent.name === ".DS_Store") continue;
      const sFull = path.join(sDir, ent.name);
      const dFull = path.join(dDir, ent.name);
      const relFile = `${relPref}/${ent.name}`;
      if (ent.isDirectory()) {
        syncDir(sFull, dFull, relFile);
      } else if (ent.isFile()) {
        const sHash = hashFileContent(sFull) ?? sha256Hex(fs.readFileSync(sFull));
        if (!fs.existsSync(dFull)) {
          writeFileCached(dFull, fs.readFileSync(sFull));
          updated = true;
          updatedFiles.push(relFile);
          const prev = sidecar.extensions[SHARED_SIDECAR_KEY];
          sidecar.extensions[SHARED_SIDECAR_KEY] = {
            contentHash: "dir",
            files: { ...(prev?.files ?? {}), [relFile]: sHash },
          };
        } else {
          const dHash = syncedCopyHash(dFull);
          if (dHash === sHash) {
            const prev = sidecar.extensions[SHARED_SIDECAR_KEY];
            if (!prev || prev.files[relFile] !== sHash) {
              sidecar.extensions[SHARED_SIDECAR_KEY] = {
                contentHash: "dir",
                files: { ...(prev?.files ?? {}), [relFile]: sHash },
              };
            }
          } else if (sidecar.extensions[SHARED_SIDECAR_KEY]?.files[relFile] === dHash) {
            writeFileCached(dFull, fs.readFileSync(sFull));
            updated = true;
            updatedFiles.push(relFile);
            const prev = sidecar.extensions[SHARED_SIDECAR_KEY];
            sidecar.extensions[SHARED_SIDECAR_KEY] = {
              contentHash: "dir",
              files: { ...(prev?.files ?? {}), [relFile]: sHash },
            };
          }
          // Otherwise the user edited the copy: leave it alone.
        }
      }
    }
  };
  syncDir(srcSharedDir, path.join(assetsDir, "shared"), "assets/shared");
  if (JSON.stringify(sidecar) !== sidecarBefore) {
    try {
      writeExtSyncSidecar(assetsDir, sidecar);
    } catch {
      // sidecar is best-effort bookkeeping
    }
  }
  if (updated || JSON.stringify(sidecar) !== sidecarBefore) {
    invalidateCompositionDirHashes(absCompDir);
  }
  return { updated, updatedFiles };
}

/**
 * Checks whether any mounted composition's local copy of an enabled extension (`assets/cuthol-ext-<name>.js`
 * or `assets/ext/<name>/...`) differs from the extension's source files on disk.
 */
export function detectCompositionExtensionCopyDrift(
  seq: CutholSequence,
  extName: string,
  paths: WorkspacePaths
): { drifted: boolean; driftedCompositions: string[] } {
  const driftedCompositions: string[] = [];
  let ext;
  try {
    ext = resolveExtension(extName, paths.rootDir);
  } catch {
    return { drifted: false, driftedCompositions };
  }

  const wrappedHelper = (() => {
    if (!ext.helperRelPath) return null;
    const srcHelperPath = path.join(ext.dir, ext.helperRelPath);
    if (!fs.existsSync(srcHelperPath)) return null;
    const rawHelper = readTextFileCached(srcHelperPath) ?? fs.readFileSync(srcHelperPath, "utf8");
    return (
      `if (typeof window !== "undefined") { window.__cuthol = window.__cuthol || {}; window.__cuthol.ext = window.__cuthol.ext || {}; }\n` +
      rawHelper
    );
  })();

  // Byte equality via the shared content-hash cache: each source is read once
  // per command; copies are stat-checked per composition. Hash equality and
  // byte equality agree up to SHA-256 collision resistance.
  const filesEqual = (sFull: string, dFull: string): boolean => {
    if (!fs.existsSync(dFull)) return false;
    const sHash = hashFileContent(sFull);
    if (sHash === null) return Buffer.compare(fs.readFileSync(sFull), fs.readFileSync(dFull)) === 0;
    return syncedCopyHash(dFull) === sHash;
  };

  const checkDirEqual = (sDir: string, dDir: string): boolean => {
    if (!fs.existsSync(sDir)) return true;
    if (!fs.existsSync(dDir)) return false;
    for (const ent of fs.readdirSync(sDir, { withFileTypes: true })) {
      if (ent.name.startsWith(".tmp") || ent.name === ".DS_Store") continue;
      const sFull = path.join(sDir, ent.name);
      const dFull = path.join(dDir, ent.name);
      if (ent.isDirectory()) {
        if (!checkDirEqual(sFull, dFull)) return false;
      } else if (ent.isFile()) {
        if (!filesEqual(sFull, dFull)) return false;
      }
    }
    return true;
  };

  for (const lane of seq.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(paths.rootDir, cue.composition.composition_dir);
      if (!fs.existsSync(compDir)) continue;
      const assetsDir = path.join(compDir, "assets");
      let compDrifted = false;
      if (wrappedHelper !== null) {
        const destHelperPath = path.join(assetsDir, `cuthol-ext-${ext.name}.js`);
        const destHelper =
          readTextFileCached(destHelperPath) ??
          (fs.existsSync(destHelperPath) ? fs.readFileSync(destHelperPath, "utf8") : null);
        if (destHelper === null || destHelper !== wrappedHelper) {
          compDrifted = true;
        }
      }
      if (!compDrifted && ext.assetsRelDir) {
        const srcAssetsDir = path.join(ext.dir, ext.assetsRelDir);
        const destAssetsDir = path.join(assetsDir, "ext", ext.name);
        if (!checkDirEqual(srcAssetsDir, destAssetsDir)) {
          compDrifted = true;
        }
      }
      if (compDrifted && !driftedCompositions.includes(cue.composition.composition_dir)) {
        driftedCompositions.push(cue.composition.composition_dir);
      }
    }
  }

  return { drifted: driftedCompositions.length > 0, driftedCompositions };
}
