// Composition directory hashing and data-usage analysis behind the overlay cache key (split out of bridge_exporter.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  currentHashGeneration,
  findProjectRoot,
  getPersistedContentMemo,
  getPersistedDirHashes,
  hashFileContent,
  setPersistedContentMemo,
  setPersistedDirHashes,
} from "../core/file_hash_index.js";
import {
  CUTHOL_BRIDGE_SCHEMA,
  CUTHOL_RUNTIME_VERSION, CutholBridgeV1
} from "./cuthol_runtime.js";
import { readInvokedHyperFramesVersion } from "./hf_common.js";
import { resolveBundledGsapMinJs } from "../core/package_resolve.js";

/** Locates the package-local `gsap.min.js` so compositions never depend on a CDN. */
export function findBundledGsapMinJs(): string | null {
  return resolveBundledGsapMinJs();
}

const IGNORED_COMPOSITION_SUBDIRS = new Set([
  ".hyperframes",
  "snapshots",
  "renders",
  "build",
  "node_modules",
  ".git",
  ".cuthol",
]);

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Identity key for cycle detection. Plain directories use their absolute
 * path (a cycle is impossible without a link); only links pay for
 * `realpathSync`, which dominated profiles on large composition trees.
 */
function dirIdentityKey(fullPath: string, isLink: boolean): string | null {
  if (!isLink) return fullPath;
  try {
    return fs.realpathSync(fullPath);
  } catch {
    return null;
  }
}

const dirHashMemo = new Map<string, { gen: number; fp: string; hash: string }>();
const bundleMemo = new Map<string, { gen: number; fp: string; filesHash: string; legacyHash: string }>();

/**
 * Cheap stat-only fingerprint of everything the composition directory
 * hashers can include (a superset of each walker's inputs: any file a hash
 * covers is covered here, so a fingerprint match implies identical hashes).
 * Format: `rel:size:full-precision-mtimeMs` per file, hashed.
 */
export function fingerprintCompositionDir(rootDir: string): string | null {
  const absRoot = path.resolve(rootDir);
  const parts: string[] = [];
  const visited = new Set<string>();
  try {
    visited.add(fs.realpathSync(absRoot));
  } catch {
    visited.add(absRoot);
  }
  const walk = (currentDir: string, relPrefix: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      const isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (isLink) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const key = dirIdentityKey(fullPath, isLink);
        if (key === null || visited.has(key)) continue;
        visited.add(key);
        if (!walk(fullPath, relPath)) return false;
      } else if (isFile) {
        let st: fs.Stats;
        try {
          st = fs.statSync(fullPath);
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
        parts.push(`${relPath}:${st.size}:${st.mtimeMs}`);
      }
    }
    return true;
  };
  if (!walk(absRoot, "")) return null;
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * Directory-hash memo scoped to one command generation: the first hash of a
 * composition per command walks and reads; repeats only re-walk stats for the
 * fingerprint. A new command generation always recomputes at least once, so
 * an edit between two calls in one long-lived process is never hidden.
 */
export function memoizedCompositionDirHash(kind: string, rootDir: string, compute: () => string): string {
  const gen = currentHashGeneration();
  const absRoot = path.resolve(rootDir);
  const key = `${kind}\n${absRoot}`;
  const fp = getCompositionFingerprint(absRoot);
  const hit = dirHashMemo.get(key);
  if (hit && hit.gen === gen && fp !== null && hit.fp === fp) return hit.hash;
  const hash = compute();
  if (fp !== null) {
    if (dirHashMemo.size > 2000) dirHashMemo.clear();
    dirHashMemo.set(key, { gen, fp, hash });
  }
  return hash;
}

/**
 * Sweep-scoped fingerprint sharing. Within one synchronous sweep (one bridge
 * sync pass, one verify run) every caller shares a single stat-only walk per
 * composition; Cuthol's own writes evict that composition through
 * `invalidateCompositionDirHashes`, and synchronous execution means no
 * external edit can interleave. Outside a sweep (tests, Live probes, render
 * pipelines calling leaf functions directly) every call walks fresh, so an
 * edit between two calls of one process is never hidden behind a memo keyed
 * by command generation alone.
 */
let sweepFpCache: Map<string, string | null> | null = null;
let sweepDepth = 0;

/** Opens (or joins, when nested) a fingerprint-sharing sweep. */
export function beginCompositionSweep(): void {
  sweepDepth += 1;
  if (sweepFpCache === null) sweepFpCache = new Map();
}

/** Leaves a sweep opened by `beginCompositionSweep`; the outermost close drops the cache. */
export function endCompositionSweep(): void {
  if (sweepDepth > 0) sweepDepth -= 1;
  if (sweepDepth === 0) sweepFpCache = null;
}

/**
 * Stat-only fingerprint of a composition directory. Shared per sweep when a
 * sweep is active, otherwise walked fresh on every call (no memo).
 */
export function getCompositionFingerprint(rootDir: string): string | null {
  const absRoot = path.resolve(rootDir);
  const cache = sweepFpCache;
  if (cache !== null) {
    const hit = cache.get(absRoot);
    if (hit !== undefined) return hit;
    const fp = fingerprintCompositionDir(absRoot);
    if (cache.size > 2000) cache.clear();
    cache.set(absRoot, fp);
    return fp;
  }
  return fingerprintCompositionDir(absRoot);
}

/**
 * Files hash + legacy directory hash of a composition, sharing one
 * fingerprint walk. Within a command generation each composition is fully
 * hashed at most once per content state; repeats are memo hits.
 */
export function getCompositionDirHashes(rootDir: string, seed = ""): {
  fp: string | null;
  filesHash: string;
  legacyHash: string;
} {
  const absRoot = path.resolve(rootDir);
  return getCompositionDirHashesWithFp(absRoot, getCompositionFingerprint(absRoot), seed);
}

export function getCompositionDirHashesWithFp(
  absRoot: string,
  fp: string | null,
  seed = ""
): {
  fp: string | null;
  filesHash: string;
  legacyHash: string;
} {
  const gen = currentHashGeneration();
  // The raw hashes embed seeds such as the invoked renderer version, so
  // seeded variants are memoized and persisted separately.
  const memoKey = `${seed}\n${absRoot}`;
  const persistedKey = fp !== null ? `${seed}\n${fp}` : null;
  const hit = bundleMemo.get(memoKey);
  if (hit && hit.gen === gen && fp !== null && hit.fp === fp) {
    return { fp, filesHash: hit.filesHash, legacyHash: hit.legacyHash };
  }
  if (fp !== null && persistedKey !== null) {
    // First touch in this process: a fingerprint match in the persisted
    // index reuses both hashes without reading a single byte. Paths this
    // process already saw never reach here with a matching fingerprint
    // unless their bytes were re-read (see `hashFileContent`'s seen-before
    // rule), so a forged size+mtime between two calls of one process still
    // recomputes from disk.
    const projectRoot = findProjectRoot(absRoot);
    if (projectRoot) {
      const persisted = getPersistedDirHashes(projectRoot, persistedKey);
      if (persisted) {
        if (bundleMemo.size > 2000) bundleMemo.clear();
        bundleMemo.set(memoKey, { gen, fp, filesHash: persisted.filesHash, legacyHash: persisted.legacyHash });
        return { fp, filesHash: persisted.filesHash, legacyHash: persisted.legacyHash };
      }
    }
  }
  const filesHash = hashCompositionFilesExcludingBridgeDataUncached(absRoot);
  const legacyHash = hashDirectoryRecursiveUncached(absRoot);
  if (fp !== null && persistedKey !== null) {
    if (bundleMemo.size > 2000) bundleMemo.clear();
    bundleMemo.set(memoKey, { gen, fp, filesHash, legacyHash });
    const projectRoot = findProjectRoot(absRoot);
    if (projectRoot) setPersistedDirHashes(projectRoot, persistedKey, { filesHash, legacyHash });
  }
  return { fp, filesHash, legacyHash };
}

/**
 * Drops memoized fingerprints and directory hashes for one composition
 * directory. Called whenever Cuthol itself writes under it, so later reads
 * in the same command observe the new bytes.
 */
export function invalidateCompositionDirHashes(rootDir: string): void {
  const absRoot = path.resolve(rootDir);
  sweepFpCache?.delete(absRoot);
  bundleMemo.delete(absRoot);
  for (const key of [...dirHashMemo.keys()]) {
    if (key.endsWith(`\n${absRoot}`)) dirHashMemo.delete(key);
  }
}

/**
 * Deterministically hashes an entire composition directory tree (including `assets/`,
 * `compositions/`, fonts, images, CSS, JS, HTML) while ignoring transient output directories.
 * The invoked HyperFrames package version is part of the digest.
 */
export function hashDirectoryRecursive(rootDir: string): string {
  return getCompositionDirHashes(rootDir).legacyHash;
}

function hashDirectoryRecursiveUncached(rootDir: string): string {
  const absRoot = path.resolve(rootDir);
  const visitedDirs = new Set<string>([safeRealpath(absRoot)]);
  const rendererVersion = readInvokedHyperFramesVersion();
  const hash = crypto
    .createHash("sha256")
    .update(`cuthol-runtime-v:${CUTHOL_RUNTIME_VERSION}\n`)
    .update(`hf-renderer-v:${rendererVersion}\n`);

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name.startsWith(".tmp.") ||
        entry.name.startsWith(".cuthol-") ||
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov") ||
        entry.name === "cuthol-bbox.json"
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      const isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (isLink) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const realDir = dirIdentityKey(fullPath, isLink);
        if (realDir === null || visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (isFile) {
        // Shared per-command content cache: each file is read once no matter
        // how many verify/bridge passes hash this directory.
        const fileDigest = hashFileContent(fullPath);
        if (fileDigest !== null) {
          let size = 0;
          try {
            size = fs.statSync(fullPath).size;
          } catch {
            size = 0;
          }
          hash.update(`file:${relPath}:${size}:${fileDigest}\n`);
        }
        // ignore unreadable transient file
      }
    }
  };

  walk(absRoot, "");
  return hash.digest("hex");
}

/**
 * Extracts only scalar variable values (`string`, `number`, `boolean`) compatible with
 * HyperFrames `--variables-file` / `data-composition-variables`.
 */
export function extractScalarHyperFramesVariables(
  props: Record<string, unknown> | undefined
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const key of Object.keys(props).sort()) {
    const val = props[key];
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      out[key] = val;
    }
  }
  return out;
}

const AUDIO_USAGE_REGEX =
  /\b(?:C|__cuthol|global)\s*\.\s*audio\b|\.\s*audio\s*\.\s*(?:low|mid|high)\b|\baudio\s*\(\s*["'](?:low|mid|high)["']/;

export interface CompositionDataUsage {
  usesLocalWords: boolean;
  usesLocalBeats: boolean;
  usesLocalAudio: boolean;
  usesLocalCuts: boolean;
  usesSequenceTiming: boolean;
  usesGlobalWords: boolean;
  usesGlobalBeats: boolean;
  usesGlobalAudio: boolean;
  usesGlobalCuts: boolean;
  usesGlobalTiming: boolean;
  usesAnyGlobal: boolean;
}

function stripCommentsForUsageAnalysis(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<![:\\/])\/\/[^\r\n]*/g, " ");
}

/**
 * Inspects a composition's HTML and JS files (including injected extension helpers `cuthol-ext-*.js`,
 * excluding generated `cuthol-data.js`, `cuthol-runtime.js`, and `gsap.min.js`) to determine which
 * local and global timeline intelligence slices the composition actually reads.
 * If dynamic/ambiguous access is detected, errs on the safe side and marks the slice as used.
 */
export function analyzeCompositionDataUsage(
  compDir: string,
  entryHtml = "index.html",
  props?: Record<string, unknown>
): CompositionDataUsage {
  const allTrue: CompositionDataUsage = {
    usesLocalWords: true,
    usesLocalBeats: true,
    usesLocalAudio: true,
    usesLocalCuts: true,
    usesSequenceTiming: true,
    usesGlobalWords: true,
    usesGlobalBeats: true,
    usesGlobalAudio: true,
    usesGlobalCuts: true,
    usesGlobalTiming: true,
    usesAnyGlobal: true,
  };

  try {
    const absCompDir = path.resolve(compDir);
    if (!fs.existsSync(absCompDir)) return allTrue;
    const entryPath = path.join(absCompDir, entryHtml || "index.html");
    if (!fs.existsSync(entryPath)) return allTrue;

    const chunks: string[] = [];
    const collectSources = (dir: string, depth: number): void => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(ent.name)) continue;
        if (
          ent.name === "cuthol-data.js" ||
          ent.name === "cuthol-data.json" ||
          ent.name === "cuthol-runtime.js" ||
          ent.name === "cuthol-vars.json" ||
          ent.name === "cuthol-bbox.json" ||
          ent.name.startsWith(".cuthol-") ||
          ent.name === "gsap.min.js"
        ) {
          continue;
        }
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          collectSources(full, depth + 1);
        } else if (ent.isFile() && /\.(?:html|js|mjs)$/i.test(ent.name)) {
          try {
            const raw = fs.readFileSync(full, "utf8");
            if (/\.html$/i.test(ent.name)) {
              const scripts = raw.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [raw];
              chunks.push(stripCommentsForUsageAnalysis(scripts.join("\n")));
            } else {
              chunks.push(stripCommentsForUsageAnalysis(raw));
            }
          } catch {
            // ignore unreadable file
          }
        }
      }
    };
    collectSources(absCompDir, 0);

    const combined = chunks.join("\n");
    const preset = typeof props?.preset === "string" ? props.preset : "";

    // Conservative fallback if dynamic property indexing, raw data access, or eval is present
    const hasAmbiguousDynamicAccess =
      /\beval\s*\(|\bnew\s+Function\b|\b__CUTHOL_DATA__\b|\.\s*data\b|\b(?:C|__cuthol)\s*\[/.test(
        combined
      );
    if (hasAmbiguousDynamicAccess) {
      return allTrue;
    }

    const mentionsGlobalProp = /\.\s*global\b|["']global["']/.test(combined);
    const strippedDirectGlobalMembers = combined.replace(
      /\.\s*global\s*\.\s*(?:word|words|pauses|sentences|beats|beatGrid|bpm|audio|cuts|segments|duration|cueStart|cueEnd|toLocal|toGlobal|drive|value)\b/g,
      ""
    );
    const hasAliasedGlobalObj =
      mentionsGlobalProp && /\.\s*global\b|["']global["']/.test(strippedDirectGlobalMembers);

    const usesGlobalWords =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:word|words|pauses|sentences)\b/.test(combined) ||
        (hasAliasedGlobalObj && /\b(?:word|words|pauses|sentences)\b/.test(combined)));
    const usesGlobalBeats =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:beats|beatGrid|bpm)\b/.test(combined) ||
        (hasAliasedGlobalObj && /\b(?:beats|beatGrid|bpm)\b/.test(combined)));
    const usesGlobalAudio =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*audio\b/.test(combined) ||
        (hasAliasedGlobalObj && /\baudio\b/.test(combined)));
    const usesGlobalCuts =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:cuts|segments)\b/.test(combined) ||
        (hasAliasedGlobalObj && /\b(?:cuts|segments)\b/.test(combined)));
    const usesGlobalTiming =
      mentionsGlobalProp &&
      (/\.\s*global\s*\.\s*(?:duration|cueStart|cueEnd|toLocal|toGlobal)\b/.test(combined) ||
        hasAliasedGlobalObj);

    const anySpecificGlobal =
      usesGlobalWords || usesGlobalBeats || usesGlobalAudio || usesGlobalCuts || usesGlobalTiming;
    const forceAllGlobal = mentionsGlobalProp && !anySpecificGlobal;

    const usesLocalWords =
      preset === "word" ||
      /\.\s*(?:word\s*\(|words\b|sentences\b|pauses\b)/.test(combined);
    const usesLocalBeats =
      preset === "beat_cards" ||
      /\.\s*(?:beats\s*\(|beatGrid\s*\(|beats\b|bpm\b)/.test(combined);
    const usesLocalAudio =
      preset === "audio_glow" ||
      AUDIO_USAGE_REGEX.test(combined) ||
      /\.\s*audio\s*\(/.test(combined);
    const usesLocalCuts =
      preset === "cut_phases" ||
      /\.\s*(?:cuts\s*\(|cuts\b|segments\b)/.test(combined);
    const usesSequenceTiming =
      /\.\s*(?:sequenceStartSec|sequenceDuration|cueStart|cueEnd|toGlobal|toLocal|seq)\b/.test(
        combined
      ) || /clock\s*:\s*["']sequence["']/.test(combined);

    return {
      usesLocalWords,
      usesLocalBeats,
      usesLocalAudio,
      usesLocalCuts,
      usesSequenceTiming,
      usesGlobalWords: usesGlobalWords || forceAllGlobal,
      usesGlobalBeats: usesGlobalBeats || forceAllGlobal,
      usesGlobalAudio: usesGlobalAudio || forceAllGlobal,
      usesGlobalCuts: usesGlobalCuts || forceAllGlobal,
      usesGlobalTiming: usesGlobalTiming || forceAllGlobal,
      usesAnyGlobal: mentionsGlobalProp,
    };
  } catch {
    return allTrue;
  }
}

/**
 * Hashes all files in a composition directory EXCEPT `assets/cuthol-data.json`,
 * `assets/cuthol-data.js`, `assets/cuthol-bbox.json`, and `.cuthol-*` metadata sidecars.
 * The invoked HyperFrames package version is part of the digest.
 */
export function hashCompositionFilesExcludingBridgeData(rootDir: string): string {
  return getCompositionDirHashes(rootDir).filesHash;
}

function hashCompositionFilesExcludingBridgeDataUncached(rootDir: string): string {
  const absRoot = path.resolve(rootDir);
  const visitedDirs = new Set<string>([safeRealpath(absRoot)]);
  const rendererVersion = readInvokedHyperFramesVersion();
  const hash = crypto
    .createHash("sha256")
    .update(`cuthol-comp-files-v:${CUTHOL_RUNTIME_VERSION}\n`)
    .update(`hf-renderer-v:${rendererVersion}\n`);

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name.startsWith(".tmp.") ||
        entry.name.startsWith(".cuthol-") ||
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov") ||
        entry.name === "cuthol-bbox.json"
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (
        relPath === "assets/cuthol-data.json" ||
        relPath === "assets/cuthol-data.js" ||
        relPath === "assets/cuthol-bbox.json"
      ) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);

      const isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (isLink) {
        try {
          const targetStat = fs.statSync(fullPath);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (IGNORED_COMPOSITION_SUBDIRS.has(entry.name)) continue;
        const realDir = dirIdentityKey(fullPath, isLink);
        if (realDir === null || visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (isFile) {
        // Shared per-command content cache: each file is read once no matter
        // how many verify/bridge passes hash this directory.
        const fileDigest = hashFileContent(fullPath);
        if (fileDigest !== null) {
          let size = 0;
          try {
            size = fs.statSync(fullPath).size;
          } catch {
            size = 0;
          }
          hash.update(`file:${relPath}:${size}:${fileDigest}\n`);
        }
        // ignore unreadable transient file
      }
    }
  };

  walk(absRoot, "");
  return hash.digest("hex");
}

/**
 * Memoized used-payload hashes. The result is a pure function of the usage
 * analysis and the bridge payload's own hashes: an identical
 * (`sliceHash`, `globalHash`) pair with the same usage object always yields
 * the same used hashes, so the 60 big payload stringifies per command (two
 * per composition cue) collapse to one. Keyed by usage object identity, so a
 * changed analysis never reuses an older answer.
 */
const usedHashesMemo = new WeakMap<
  CompositionDataUsage,
  Map<string, { usedSliceHash: string; usedGlobalHash: string }>
>();

export function computeUsedBridgePayloadHashes(
  bridgeData: Partial<CutholBridgeV1> | null | undefined,
  usage: CompositionDataUsage
): { usedSliceHash: string; usedGlobalHash: string } {
  const d = bridgeData ?? {};
  // Fast path: the used hashes are fully determined by the payload's own
  // hashes (same slice + global bytes with the same usage ⇒ same answer).
  const payloadKey = `${typeof d.hash === "string" ? d.hash : ""}\n${typeof d.global?.hash === "string" ? d.global.hash : ""}`;
  let inner = usedHashesMemo.get(usage);
  if (inner) {
    const hit = inner.get(payloadKey);
    if (hit) return hit;
  } else {
    inner = new Map();
    usedHashesMemo.set(usage, inner);
  }
  const computed = computeUsedBridgePayloadHashesUncached(d, usage);
  if (inner.size > 200) inner.clear();
  inner.set(payloadKey, computed);
  return computed;
}

function computeUsedBridgePayloadHashesUncached(
  d: Partial<CutholBridgeV1>,
  usage: CompositionDataUsage
): { usedSliceHash: string; usedGlobalHash: string } {
  const comp = d.composition ?? ({} as Partial<CutholBridgeV1["composition"]>);
  const usedLocalPayload: Record<string, unknown> = {
    schema: d.schema ?? CUTHOL_BRIDGE_SCHEMA,
    composition: {
      id: comp.id ?? "main",
      duration: comp.duration ?? 0,
      fps: comp.fps ?? 30,
      width: comp.width ?? 1920,
      height: comp.height ?? 1080,
      ...(usage.usesSequenceTiming ? { sequenceStartSec: comp.sequenceStartSec ?? 0 } : {}),
    },
    props: d.props ?? {},
    safeZone: d.safeZone ?? null,
  };

  if (usage.usesLocalWords) {
    usedLocalPayload.words = d.words ?? [];
    usedLocalPayload.sentences = d.sentences ?? [];
    usedLocalPayload.pauses = d.pauses ?? [];
  }
  if (usage.usesLocalBeats) {
    usedLocalPayload.beats = d.beats ?? null;
  }
  if (usage.usesLocalAudio) {
    usedLocalPayload.audio = d.audio ?? null;
  }
  if (usage.usesLocalCuts) {
    usedLocalPayload.cuts = (d.cuts ?? []).map((c) => ({
      t: c.t,
      ...(c.kind ? { kind: c.kind } : {}),
    }));
    usedLocalPayload.segments = (d.segments ?? []).map((s) => ({
      t0: s.t0,
      t1: s.t1,
      index: s.index,
      duration: s.duration,
    }));
  }

  const usedSliceHash =
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(usedLocalPayload))
      .digest("hex")
      .slice(0, 16);

  if (!usage.usesAnyGlobal || !d.global) {
    return { usedSliceHash, usedGlobalHash: "unused" };
  }

  const g = d.global;
  const usedGlobalPayload: Record<string, unknown> = {};
  if (usage.usesGlobalTiming) {
    usedGlobalPayload.duration = g.duration ?? 0;
    usedGlobalPayload.sequenceStartSec = comp.sequenceStartSec ?? 0;
  }
  if (usage.usesGlobalWords) {
    usedGlobalPayload.words = g.words ?? [];
    usedGlobalPayload.pauses = g.pauses ?? [];
    usedGlobalPayload.sentences = g.sentences ?? [];
  }
  if (usage.usesGlobalBeats) {
    usedGlobalPayload.beats = g.beats ?? null;
  }
  if (usage.usesGlobalAudio) {
    usedGlobalPayload.audio = g.audio ?? null;
  }
  if (usage.usesGlobalCuts) {
    usedGlobalPayload.cuts = (g.cuts ?? []).map((c) => ({
      t: c.t,
      ...(c.kind ? { kind: c.kind } : {}),
    }));
    usedGlobalPayload.segments = (g.segments ?? []).map((s) => ({
      t0: s.t0,
      t1: s.t1,
      index: s.index,
      duration: s.duration,
    }));
  }

  const usedGlobalHash =
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(usedGlobalPayload))
      .digest("hex")
      .slice(0, 16);

  return { usedSliceHash, usedGlobalHash };
}

/**
 * Checks whether a HyperFrames composition directory (entry HTML or user JS files)
 * references `C.audio` / `C.global.audio` / `data.audio`.
 */
const usageMemo = new Map<string, CompositionDataUsage>();

/**
 * Memoized composition data-usage analysis. The result depends only on the
 * composition's authored files (captured by its content hash) and the cue
 * preset, so one analysis per composition is shared by the bridge sync and
 * every verify pass of the command instead of re-reading all sources.
 * Analyses are also persisted across processes keyed by content hash (never
 * by stat), so a repeat run with identical bytes never re-reads: a content
 * hash provably describes identical inputs, so the persisted answer cannot
 * hide an edit.
 */
export function analyzeCompositionDataUsageCached(
  compDir: string,
  entryHtml = "index.html",
  props?: Record<string, unknown>,
  filesHash?: string
): CompositionDataUsage {
  const preset = typeof props?.preset === "string" ? props.preset : "";
  let resolvedHash = filesHash ?? "";
  if (!resolvedHash) {
    try {
      resolvedHash = hashCompositionFilesExcludingBridgeData(compDir);
    } catch {
      resolvedHash = "";
    }
  }
  const absCompDir = path.resolve(compDir);
  const key = `${entryHtml}\n${preset}\n${resolvedHash}`;
  const rootDir = findProjectRoot(absCompDir);
  if (rootDir && resolvedHash) {
    const persisted = getPersistedContentMemo(rootDir, key);
    if (persisted && typeof persisted === "object") {
      const usage = persisted as CompositionDataUsage;
      if (usageMemo.size > 2000) usageMemo.clear();
      usageMemo.set(`${absCompDir}\n${key}`, usage);
      return usage;
    }
  }
  const memKey = `${absCompDir}\n${key}`;
  const hit = usageMemo.get(memKey);
  if (hit) return hit;
  const usage = analyzeCompositionDataUsage(compDir, entryHtml, props);
  if (usageMemo.size > 2000) usageMemo.clear();
  usageMemo.set(memKey, usage);
  if (rootDir && resolvedHash) setPersistedContentMemo(rootDir, key, usage);
  return usage;
}

export function compositionUsesAudio(compDir: string, entryHtml = "index.html"): boolean {
  const usage = analyzeCompositionDataUsageCached(compDir, entryHtml);
  return usage.usesLocalAudio || usage.usesGlobalAudio;
}

export function compositionUsesGlobal(compDir: string, entryHtml = "index.html"): boolean {
  return analyzeCompositionDataUsageCached(compDir, entryHtml).usesAnyGlobal;
}
