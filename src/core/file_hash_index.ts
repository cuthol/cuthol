// Shared file content-hash cache (`src/core/file_hash_index.ts`).
//
// Every mutating command hashed the same composition folders several times
// (pre-check verify, bridge sync, extension asset sync, full verify, lint):
// the same bytes were read and hashed 4-6x per command. This module hashes
// each file once per command generation and shares the result across all
// callers.
//
// Correctness rule: within one command generation a cached entry is reused
// only when the file's current `size` AND full-precision `mtimeMs` both
// match. A new command generation (`beginHashCommandScope`, called once per
// top-level command) re-reads every file on first touch, so a file edited
// between two calls in one long-lived process (MCP server, Live) is always
// seen by the second call -- even when the edit keeps the byte size and
// restores the mtime. Ordinary edits change size or mtime and are re-read
// through the normal stat check as well.
//
// A persisted index under the project's `.cuthol/` reuses hashes across
// processes (warm `verify`, repeat edits). Entries are trusted only on exact
// (size, full-precision mtimeMs) match, and a file the current process has
// already seen is always re-read on a new command generation -- so an edit
// between two calls in one long-lived process is seen even when it forges
// size and mtime, while ordinary edits (which change size or mtime) are
// re-read through the stat check everywhere.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INDEX_FILENAME = "file-hash-index.json";
const INDEX_VERSION = 1;
const MAX_PERSISTED_ENTRIES = 40000;

interface IndexEntry {
  size: number;
  mtimeMs: number;
  sha: string;
}

interface PersistedIndexFile {
  version: number;
  files: Record<string, IndexEntry>;
  /** Content-derived memos keyed by content hash (never by stat): safe to reuse. */
  usage?: Record<string, unknown>;
  /**
   * Directory fingerprint (stat-derived) to directory hashes. Consulted only
   * for paths this process has never touched: a first-touch fingerprint
   * match reuses the hashes without reading; any file this process already
   * saw is always re-hashed on a new command generation.
   */
  dirHashes?: Record<string, { filesHash: string; legacyHash: string }>;
}

interface MemEntry extends IndexEntry {
  generation: number;
}

let generation = 0;
const memCache = new Map<string, MemEntry>();
const persistedUsageByRoot = new Map<string, { values: Map<string, unknown>; dirty: boolean }>();
const persistedDirHashesByRoot = new Map<string, { values: Map<string, { filesHash: string; legacyHash: string }>; dirty: boolean }>();

function dirHashesSlot(rootDir: string): { values: Map<string, { filesHash: string; legacyHash: string }>; dirty: boolean } {
  let slot = persistedDirHashesByRoot.get(rootDir);
  if (!slot) {
    slot = { values: new Map(), dirty: false };
    persistedDirHashesByRoot.set(rootDir, slot);
  }
  return slot;
}

/**
 * Directory hashes for a stat-derived fingerprint. Only files/paths this
 * process has never touched may consult this (see `hashFileContent`'s
 * seen-before rule); the fingerprint match then reuses hashes without
 * reading a single byte.
 */
export function getPersistedDirHashes(rootDir: string, fp: string): { filesHash: string; legacyHash: string } | null {
  return persistedDirHashesByRoot.get(rootDir)?.values.get(fp) ?? null;
}

export function setPersistedDirHashes(rootDir: string, fp: string, value: { filesHash: string; legacyHash: string }): void {
  const slot = dirHashesSlot(rootDir);
  if (slot.values.size > 2000) slot.values.clear();
  slot.values.set(fp, value);
  slot.dirty = true;
}

/** Current command generation (memo key scope). */
export function currentHashGeneration(): number {
  return generation;
}
const persistedByRoot = new Map<string, { files: Map<string, IndexEntry>; dirty: boolean }>();

function normalizeAbs(p: string): string {
  return path.resolve(p);
}

/**
 * Opens a new command scope: files first touched by an older generation are
 * re-read (never stat-trusted across commands in this process). Called once
 * per top-level command by `commitVerifiedMutation` and
 * `runWorkspaceVerification`.
 */
export function beginHashCommandScope(): void {
  generation += 1;
  if (memCache.size > 60000) {
    const keepFrom = generation - 1;
    for (const [k, v] of memCache) {
      if (v.generation < keepFrom) memCache.delete(k);
    }
  }
}

/** Drops all in-process state (tests). The persisted index on disk is kept. */
export function clearInMemoryFileHashes(): void {
  memCache.clear();
  textCache.clear();
  textCacheBytes = 0;
  persistedByRoot.clear();
  persistedUsageByRoot.clear();
  persistedDirHashesByRoot.clear();
  projectRootMemo.clear();
}

const projectRootMemo = new Map<string, string | null>();

/** Project root for `absPath`: nearest ancestor holding `cuthol.sequence.json`. */
export function findProjectRoot(absPath: string): string | null {
  const abs = normalizeAbs(absPath);
  const hit = projectRootMemo.get(abs);
  if (hit !== undefined) return hit;
  // A miss for a path inside a known root reuses the root (sequence files
  // are never created mid-command; a stale null only costs cache reuse,
  // never correctness).
  for (const root of projectRootMemo.values()) {
    if (root && (abs === root || abs.startsWith(root + path.sep))) {
      projectRootMemo.set(abs, root);
      return root;
    }
  }
  let dir = abs;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  let found: string | null = null;
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, "cuthol.sequence.json"))) {
        found = dir;
        break;
      }
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  projectRootMemo.set(abs, found);
  return found;
}

function indexFileForRoot(rootDir: string): string {
  return path.join(rootDir, ".cuthol", INDEX_FILENAME);
}

function usageSlot(rootDir: string): { values: Map<string, unknown>; dirty: boolean } {
  let slot = persistedUsageByRoot.get(rootDir);
  if (!slot) {
    slot = { values: new Map(), dirty: false };
    persistedUsageByRoot.set(rootDir, slot);
  }
  return slot;
}

/**
 * Content-derived memo lookup: `key` must be derived from content hashes
 * (never from stat alone), so a hit provably describes identical bytes.
 */
export function getPersistedContentMemo(rootDir: string, key: string): unknown | null {
  const slot = persistedUsageByRoot.get(rootDir);
  if (slot && slot.values.has(key)) return slot.values.get(key) ?? null;
  return null;
}

/** Stores a content-derived memo (see above) for reuse across processes. */
export function setPersistedContentMemo(rootDir: string, key: string, value: unknown): void {
  const slot = usageSlot(rootDir);
  if (slot.values.size > 5000) slot.values.clear();
  slot.values.set(key, value);
  slot.dirty = true;
}

function loadPersistedIndex(rootDir: string): Map<string, IndexEntry> {
  const existing = persistedByRoot.get(rootDir);
  if (existing) return existing.files;
  const files = new Map<string, IndexEntry>();
  try {
    const raw = fs.readFileSync(indexFileForRoot(rootDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedIndexFile>;
    if (parsed && parsed.version === INDEX_VERSION && parsed.files && typeof parsed.files === "object") {
      for (const [rel, entry] of Object.entries(parsed.files)) {
        if (
          entry &&
          typeof entry.size === "number" &&
          typeof entry.mtimeMs === "number" &&
          typeof entry.sha === "string"
        ) {
          files.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs, sha: entry.sha });
          if (files.size >= MAX_PERSISTED_ENTRIES) break;
        }
      }
    }
    if (parsed && parsed.usage && typeof parsed.usage === "object") {
      const slot = usageSlot(rootDir);
      for (const [k, v] of Object.entries(parsed.usage)) {
        slot.values.set(k, v);
        if (slot.values.size >= 5000) break;
      }
      slot.dirty = false;
    }
    if (parsed && parsed.dirHashes && typeof parsed.dirHashes === "object") {
      const slot = dirHashesSlot(rootDir);
      for (const [k, v] of Object.entries(parsed.dirHashes)) {
        if (v && typeof v.filesHash === "string" && typeof v.legacyHash === "string") {
          slot.values.set(k, { filesHash: v.filesHash, legacyHash: v.legacyHash });
          if (slot.values.size >= 2000) break;
        }
      }
      slot.dirty = false;
    }
  } catch {
    // missing or corrupt index: start empty
  }
  persistedByRoot.set(rootDir, { files, dirty: false });
  return files;
}

function rememberPersisted(rootDir: string, rel: string, entry: IndexEntry): void {
  const files = loadPersistedIndex(rootDir);
  const prev = files.get(rel);
  if (prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs && prev.sha === entry.sha) {
    return;
  }
  if (!prev && files.size >= MAX_PERSISTED_ENTRIES) return;
  files.set(rel, entry);
  const slot = persistedByRoot.get(rootDir);
  if (slot) slot.dirty = true;
}

/** Writes dirty persisted indexes atomically. Called at command end (best effort). */
export function flushFileHashIndex(): void {
  for (const [rootDir, slot] of persistedByRoot) {
    const usage = persistedUsageByRoot.get(rootDir);
    const dirH = persistedDirHashesByRoot.get(rootDir);
    if (!slot.dirty && (!usage || !usage.dirty) && (!dirH || !dirH.dirty)) continue;
    try {
      const payload: PersistedIndexFile = {
        version: INDEX_VERSION,
        files: Object.fromEntries(slot.files),
        ...(usage && usage.values.size > 0 ? { usage: Object.fromEntries(usage.values) } : {}),
        ...(dirH && dirH.values.size > 0 ? { dirHashes: Object.fromEntries(dirH.values) } : {}),
      };
      const target = indexFileForRoot(rootDir);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp_${process.pid}_${generation}`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      try {
        fs.renameSync(tmp, target);
      } catch {
        fs.copyFileSync(tmp, target);
        fs.unlinkSync(tmp);
      }
      slot.dirty = false;
      const usageSlotAfter = persistedUsageByRoot.get(rootDir);
      if (usageSlotAfter) usageSlotAfter.dirty = false;
      const dirSlotAfter = persistedDirHashesByRoot.get(rootDir);
      if (dirSlotAfter) dirSlotAfter.dirty = false;
    } catch {
      // cache persistence must never fail a command
    }
  }
}

export interface HashFileOptions {
  /**
   * When false, the entry is shared in-process only and never touches the
   * persisted cross-process index. Defaults to true (persisted reuse on
   * exact size + full-precision mtimeMs match).
   */
  persistAcrossRuns?: boolean;
}

/**
 * SHA-256 hex of a file's bytes, or null when it cannot be read. Within one
 * command generation each file is read at most once no matter how many
 * callers (verify passes, bridge sync, extension sync, lint) ask for it;
 * entries are trusted only on exact (size, full-precision mtimeMs) match.
 */
export function hashFileContent(absPath: string, opts?: HashFileOptions): string | null {
  const abs = normalizeAbs(absPath);
  const persist = opts?.persistAcrossRuns !== false;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
    if (!st.isFile()) {
      memCache.delete(abs);
      return null;
    }
  } catch {
    memCache.delete(abs);
    return null;
  }
  const size = st.size;
  const mtimeMs = st.mtimeMs;

  const memHit = memCache.get(abs);
  // Same-generation entries are safe to stat-trust: nothing else runs
  // between two reads of one command. A file this process has seen before
  // but in an older generation is always re-read: an edit between two calls
  // in one long-lived process (MCP server, Live) must be seen even when it
  // preserves size and mtime. Only files never touched by this process may
  // reuse the persisted cross-process index below.
  if (memHit && memHit.generation === generation && memHit.size === size && memHit.mtimeMs === mtimeMs) {
    return memHit.sha;
  }
  const seenBefore = memHit !== undefined;

  const rootDir = persist && !seenBefore ? findProjectRoot(abs) : null;
  let rel: string | null = null;
  if (rootDir) {
    rel = path.relative(rootDir, abs).split(path.sep).join("/");
    if (rel.startsWith("..")) {
      rel = null;
    } else {
      const persisted = loadPersistedIndex(rootDir).get(rel);
      if (persisted && persisted.size === size && persisted.mtimeMs === mtimeMs) {
        memCache.set(abs, { size, mtimeMs, sha: persisted.sha, generation });
        return persisted.sha;
      }
    }
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  // Size changed between stat and read: trust the bytes just read.
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const entry: IndexEntry = { size: buf.length, mtimeMs, sha };
  memCache.set(abs, { ...entry, generation });
  if (rootDir && rel !== null) rememberPersisted(rootDir, rel, entry);
  return sha;
}

/**
 * Short (16-hex) content digest with the legacy `"missing"` sentinel for
 * unreadable files. Drop-in for the ad-hoc per-module memo helpers.
 */
export function hashFileContentShort(absPath: string, opts?: HashFileOptions): string {
  const full = hashFileContent(absPath, opts);
  return full === null ? "missing" : full.slice(0, 16);
}

interface TextEntry {
  generation: number;
  size: number;
  mtimeMs: number;
  text: string;
}

const textCache = new Map<string, TextEntry>();
let textCacheBytes = 0;
const MAX_TEXT_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * Exact-semantics cached text read: missing file yields null (like an
 * `existsSync` guard), an unreadable file throws exactly as a direct
 * `readFileSync` would. Hits are shared in-process per command generation.
 */
export function readTextIfExists(absPath: string): string | null {
  const abs = normalizeAbs(absPath);
  if (!fs.existsSync(abs)) {
    textCache.delete(abs);
    return null;
  }
  const cached = readTextFileCached(abs);
  if (cached !== null) return cached;
  return fs.readFileSync(abs, "utf8");
}

/**
 * Cuthol's own write path for files covered by the read caches. Removes the
 * cached entries so later reads in the same command observe the new bytes
 * even when the write lands in the same millisecond (unchanged size+mtime
 * would otherwise read stale). Use for every Cuthol write under composition
 * directories and other hashed inputs.
 */
export function writeFileCached(absPath: string, content: string | Buffer): void {
  const abs = normalizeAbs(absPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  memCache.delete(abs);
  textCache.delete(abs);
}

/** UTF-8 file content shared in-process: within one command generation each
 * file is read at most once no matter how many callers (extension sync,
 * drift checks, contract checks) need it. Entries are trusted only on exact
 * (size, full-precision mtimeMs) match and never across generations, so an
 * edit between two calls in one long-lived process is always seen.
 */
export function readTextFileCached(absPath: string): string | null {
  const abs = normalizeAbs(absPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
    if (!st.isFile()) {
      textCache.delete(abs);
      return null;
    }
  } catch {
    textCache.delete(abs);
    return null;
  }
  const hit = textCache.get(abs);
  if (hit && hit.generation === generation && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    return hit.text;
  }
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (text.length * 2 > MAX_TEXT_CACHE_BYTES) return text;
  while (textCacheBytes + text.length * 2 > MAX_TEXT_CACHE_BYTES && textCache.size > 0) {
    const oldest = textCache.keys().next();
    if (oldest.done) break;
    const removed = textCache.get(oldest.value);
    textCache.delete(oldest.value);
    if (removed) textCacheBytes -= removed.text.length * 2;
  }
  textCache.set(abs, { generation, size: st.size, mtimeMs: st.mtimeMs, text });
  textCacheBytes += text.length * 2;
  return text;
}
