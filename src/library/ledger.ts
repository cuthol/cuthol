/**
 * Content-Addressed SQLite Media Ledger (`.cuthol/ledger.sqlite`).
 *
 * Uses Node.js built-in `node:sqlite` (`DatabaseSync`) to cache expensive media probes,
 * ITU-R BS.1770-4 loudness metrics, STFT spectral/waveform envelopes, onset beats,
 * FFmpeg `scdet` scene boundaries, and speech transcripts keyed by SHA-256 file digest.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  resolveSharedCacheConfig,
  SharedCacheConfig,
  suppressSqliteExperimentalWarning,
} from "../core/env.js";
import { currentHashGeneration } from "../core/file_hash_index.js";

suppressSqliteExperimentalWarning();
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

/**
 * Process-wide analysis write counter. Every `setWaveform/setBeats/setScenes/
 * setTranscript` call on any instance bumps it, so command-scoped read memos
 * held by other instances are dropped on their next read.
 */
let ledgerWriteSeq = 0;

export interface MediaLedgerOptions {
  /** Override user-level shared cache directory, or pass `false` to disable shared cache for this instance. */
  sharedCacheDir?: string | false | null;
}

export class MediaLedger {
  private readonly db: DatabaseSyncType;
  private readonly sqlitePath: string;
  private readonly sharedConfig: SharedCacheConfig;
  private sharedDb: DatabaseSyncType | null = null;
  private sharedDbFailed = false;
  /**
   * Command-scoped memo for the `getLatest*` reads: bridge export asks for
   * the same digests once per composition cue (30x per command on large
   * projects). Entries live only for one command generation and are dropped
   * on any write through this instance, so a transcript/waveform/beats/scenes
   * analysis written mid-command is always seen afterwards. Only active while
   * a command scope is open (`currentHashGeneration() > 0`); without a scope
   * every call reads the database, as before.
   */
  private latestMemoGen = -1;
  private latestMemoWriteSeq = -1;
  private latestMemo = new Map<string, unknown>();

  constructor(sqlitePath: string, options?: MediaLedgerOptions) {
    this.sqlitePath = path.resolve(sqlitePath);
    fs.mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(this.sqlitePath);
    this.initSchemaOn(this.db);
    this.sharedConfig = resolveSharedCacheConfig(options?.sharedCacheDir);
  }

  private initSchemaOn(targetDb: DatabaseSyncType): void {
    targetDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS file_digests (
        abs_path TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_probes (
        sha256 TEXT PRIMARY KEY,
        probe_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loudness_cache (
        sha256 TEXT PRIMARY KEY,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waveform_cache (
        cache_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        bins INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS beats_cache (
        cache_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        sensitivity REAL NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scenes_cache (
        cache_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        threshold REAL NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_cache (
        cache_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        lang TEXT NOT NULL,
        transcript_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tts_cache (
        cache_key TEXT PRIMARY KEY,
        audio_path TEXT NOT NULL,
        alignment_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS acoustic_windows_cache (
        cache_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extension_cache (
        cache_key TEXT PRIMARY KEY,
        output_path TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private getSharedDb(): DatabaseSyncType | null {
    if (!this.sharedConfig.enabled || !this.sharedConfig.sqlitePath || this.sharedDbFailed) {
      return null;
    }
    const resolvedShared = path.resolve(this.sharedConfig.sqlitePath);
    if (resolvedShared === this.sqlitePath) {
      return null;
    }
    if (this.sharedDb) {
      return this.sharedDb;
    }
    try {
      fs.mkdirSync(path.dirname(resolvedShared), { recursive: true });
      this.sharedDb = new DatabaseSync(resolvedShared);
      this.initSchemaOn(this.sharedDb);
      return this.sharedDb;
    } catch {
      this.sharedDbFailed = true;
      return null;
    }
  }

  /**
   * Computes or retrieves the SHA-256 digest of a local file using `(abs_path, size_bytes, mtime_ms)` fast-path.
   */
  public resolveFileSha256(filePath: string): { sha256: string; sizeBytes: number; mtimeMs: number } {
    const absPath = path.resolve(filePath);
    const stat = fs.statSync(absPath);
    const sizeBytes = stat.size;
    const mtimeMs = stat.mtimeMs;

    const row = this.db
      .prepare(`SELECT sha256 FROM file_digests WHERE abs_path = ? AND size_bytes = ? AND mtime_ms = ?`)
      .get(absPath, sizeBytes, mtimeMs) as { sha256: string } | undefined;

    if (row?.sha256) {
      return { sha256: row.sha256, sizeBytes, mtimeMs };
    }

    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(absPath, "r");
    try {
      const chunkBuf = Buffer.allocUnsafe(1024 * 1024);
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, null)) > 0) {
        hash.update(chunkBuf.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    const sha256 = hash.digest("hex");

    this.db
      .prepare(
        `INSERT OR REPLACE INTO file_digests (abs_path, size_bytes, mtime_ms, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(absPath, sizeBytes, mtimeMs, sha256, new Date().toISOString());

    return { sha256, sizeBytes, mtimeMs };
  }

  public getProbe<T>(sha256: string): T | null {
    const row = this.db.prepare(`SELECT probe_json FROM media_probes WHERE sha256 = ?`).get(sha256) as
      | { probe_json: string }
      | undefined;
    return row ? (JSON.parse(row.probe_json) as T) : null;
  }

  public setProbe<T>(sha256: string, probe: T): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO media_probes (sha256, probe_json, created_at) VALUES (?, ?, ?)`)
      .run(sha256, JSON.stringify(probe), new Date().toISOString());
  }

  public getLoudness<T>(sha256: string): T | null {
    const row = this.db.prepare(`SELECT metrics_json FROM loudness_cache WHERE sha256 = ?`).get(sha256) as
      | { metrics_json: string }
      | undefined;
    return row ? (JSON.parse(row.metrics_json) as T) : null;
  }

  public setLoudness<T>(sha256: string, metrics: T): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO loudness_cache (sha256, metrics_json, created_at) VALUES (?, ?, ?)`)
      .run(sha256, JSON.stringify(metrics), new Date().toISOString());
  }

  public getWaveform<T>(sha256: string, bins: number): T | null {
    const key = `${sha256}:${bins}`;
    const row = this.db.prepare(`SELECT metrics_json FROM waveform_cache WHERE cache_key = ?`).get(key) as
      | { metrics_json: string }
      | undefined;
    return row ? (JSON.parse(row.metrics_json) as T) : null;
  }

  public setWaveform<T>(sha256: string, bins: number, metrics: T): void {
    this.latestMemoInvalidate();
    const key = `${sha256}:${bins}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO waveform_cache (cache_key, sha256, bins, metrics_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(key, sha256, bins, JSON.stringify(metrics), new Date().toISOString());
  }

  public getBeats<T>(sha256: string, sensitivity: number): T | null {
    const key = `${sha256}:${sensitivity.toFixed(2)}`;
    const row = this.db.prepare(`SELECT metrics_json FROM beats_cache WHERE cache_key = ?`).get(key) as
      | { metrics_json: string }
      | undefined;
    return row ? (JSON.parse(row.metrics_json) as T) : null;
  }

  public setBeats<T>(sha256: string, sensitivity: number, metrics: T): void {
    this.latestMemoInvalidate();
    const key = `${sha256}:${sensitivity.toFixed(2)}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO beats_cache (cache_key, sha256, sensitivity, metrics_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(key, sha256, sensitivity, JSON.stringify(metrics), new Date().toISOString());
  }

  public getScenes<T>(sha256: string, threshold: number): T | null {
    const key = `${sha256}:${threshold.toFixed(2)}`;
    const row = this.db.prepare(`SELECT metrics_json FROM scenes_cache WHERE cache_key = ?`).get(key) as
      | { metrics_json: string }
      | undefined;
    return row ? (JSON.parse(row.metrics_json) as T) : null;
  }

  public setScenes<T>(sha256: string, threshold: number, metrics: T): void {
    this.latestMemoInvalidate();
    const key = `${sha256}:${threshold.toFixed(2)}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scenes_cache (cache_key, sha256, threshold, metrics_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(key, sha256, threshold, JSON.stringify(metrics), new Date().toISOString());
  }

  public getAcousticWindows<T>(cacheKey: string): T | null {
    const row = this.db.prepare(`SELECT metrics_json FROM acoustic_windows_cache WHERE cache_key = ?`).get(cacheKey) as
      | { metrics_json: string }
      | undefined;
    return row ? (JSON.parse(row.metrics_json) as T) : null;
  }

  public setAcousticWindows<T>(cacheKey: string, sha256: string, metrics: T): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO acoustic_windows_cache (cache_key, sha256, metrics_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(cacheKey, sha256, JSON.stringify(metrics), new Date().toISOString());
  }

  public getTranscript<T>(sha256: string, lang: string): T | null {
    const normLang = lang.toLowerCase();
    const key = `${sha256}:${normLang}`;
    const row = this.db
      .prepare(`SELECT transcript_json FROM transcript_cache WHERE cache_key = ?`)
      .get(key) as { transcript_json: string } | undefined;
    if (row) {
      const shared = this.getSharedDb();
      if (shared) {
        try {
          const existingShared = shared
            .prepare(`SELECT 1 FROM transcript_cache WHERE cache_key = ?`)
            .get(key);
          if (!existingShared) {
            shared
              .prepare(
                `INSERT OR REPLACE INTO transcript_cache (cache_key, sha256, lang, transcript_json, created_at)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .run(key, sha256, normLang, row.transcript_json, new Date().toISOString());
          }
        } catch {
          // non-blocking shared cache promotion
        }
      }
      return JSON.parse(row.transcript_json) as T;
    }

    const shared = this.getSharedDb();
    if (shared) {
      try {
        const sharedRow = shared
          .prepare(`SELECT transcript_json FROM transcript_cache WHERE cache_key = ?`)
          .get(key) as { transcript_json: string } | undefined;
        if (sharedRow) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO transcript_cache (cache_key, sha256, lang, transcript_json, created_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(key, sha256, normLang, sharedRow.transcript_json, new Date().toISOString());
          return JSON.parse(sharedRow.transcript_json) as T;
        }
      } catch {
        // non-blocking shared cache read
      }
    }

    return null;
  }

  private latestMemoGet<T>(kind: string, sha256: string): { hit: boolean; value: T | null } {
    const gen = currentHashGeneration();
    if (gen <= 0) return { hit: false, value: null };
    // Any analysis write through any instance of this process invalidates
    // every memo: the writer is usually not the reader (bridge auto-analysis,
    // speech flows, tests), and only the reader's generation is not enough.
    if (this.latestMemoGen !== gen || this.latestMemoWriteSeq !== ledgerWriteSeq) {
      this.latestMemoGen = gen;
      this.latestMemoWriteSeq = ledgerWriteSeq;
      this.latestMemo.clear();
    }
    const key = `${kind}:${sha256}`;
    if (this.latestMemo.has(key)) return { hit: true, value: this.latestMemo.get(key) as T | null };
    return { hit: false, value: null };
  }

  private latestMemoSet(kind: string, sha256: string, value: unknown): void {
    // Misses are memoized too: most digests of a large project have no
    // analysis row, and re-querying every miss once per composition cue
    // dominates the bridge export. Staleness is impossible inside one
    // command: every analysis write through any instance bumps the
    // process-wide counter, which drops all memos on their next read.
    if (this.latestMemoGen !== currentHashGeneration()) return;
    const key = `${kind}:${sha256}`;
    if (this.latestMemo.size > 2000) this.latestMemo.clear();
    this.latestMemo.set(key, value);
  }

  private latestMemoInvalidate(): void {
    ledgerWriteSeq += 1;
    this.latestMemo.clear();
  }

  public getLatestWaveform<T>(sha256: string): T | null {
    const memo = this.latestMemoGet<T>("waveform", sha256);
    if (memo.hit) return memo.value;
    const row = this.db
      .prepare(`SELECT metrics_json FROM waveform_cache WHERE sha256 = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(sha256) as { metrics_json: string } | undefined;
    const value = row ? (JSON.parse(row.metrics_json) as T) : null;
    this.latestMemoSet("waveform", sha256, value);
    return value;
  }

  public getLatestBeats<T>(sha256: string): T | null {
    const memo = this.latestMemoGet<T>("beats", sha256);
    if (memo.hit) return memo.value;
    const row = this.db
      .prepare(`SELECT metrics_json FROM beats_cache WHERE sha256 = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(sha256) as { metrics_json: string } | undefined;
    const value = row ? (JSON.parse(row.metrics_json) as T) : null;
    this.latestMemoSet("beats", sha256, value);
    return value;
  }

  public getLatestScenes<T>(sha256: string): T | null {
    const memo = this.latestMemoGet<T>("scenes", sha256);
    if (memo.hit) return memo.value;
    const row = this.db
      .prepare(`SELECT metrics_json FROM scenes_cache WHERE sha256 = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(sha256) as { metrics_json: string } | undefined;
    const value = row ? (JSON.parse(row.metrics_json) as T) : null;
    this.latestMemoSet("scenes", sha256, value);
    return value;
  }

  public getLatestTranscript<T>(sha256: string): T | null {
    const memo = this.latestMemoGet<T>("transcript", sha256);
    if (memo.hit) return memo.value;
    const row = this.db
      .prepare(`SELECT lang, transcript_json FROM transcript_cache WHERE sha256 = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(sha256) as { lang: string; transcript_json: string } | undefined;
    if (row) {
      const shared = this.getSharedDb();
      if (shared) {
        try {
          const existingShared = shared
            .prepare(`SELECT 1 FROM transcript_cache WHERE sha256 = ? LIMIT 1`)
            .get(sha256);
          if (!existingShared) {
            const allLocal = this.db
              .prepare(`SELECT cache_key, lang, transcript_json FROM transcript_cache WHERE sha256 = ?`)
              .all(sha256) as Array<{ cache_key: string; lang: string; transcript_json: string }>;
            const now = new Date().toISOString();
            for (const r of allLocal) {
              shared
                .prepare(
                  `INSERT OR REPLACE INTO transcript_cache (cache_key, sha256, lang, transcript_json, created_at)
                   VALUES (?, ?, ?, ?, ?)`
                )
                .run(r.cache_key, sha256, r.lang, r.transcript_json, now);
            }
          }
        } catch {
          // non-blocking shared cache promotion
        }
      }
      const value = JSON.parse(row.transcript_json) as T;
      this.latestMemoSet("transcript", sha256, value);
      return value;
    }

    const shared = this.getSharedDb();
    if (shared) {
      try {
        const sharedRow = shared
          .prepare(`SELECT cache_key, lang, transcript_json FROM transcript_cache WHERE sha256 = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get(sha256) as { cache_key: string; lang: string; transcript_json: string } | undefined;
        if (sharedRow) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO transcript_cache (cache_key, sha256, lang, transcript_json, created_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(sharedRow.cache_key, sha256, sharedRow.lang, sharedRow.transcript_json, new Date().toISOString());
          const value = JSON.parse(sharedRow.transcript_json) as T;
          this.latestMemoSet("transcript", sha256, value);
          return value;
        }
      } catch {
        // non-blocking shared cache read
      }
    }

    this.latestMemoSet("transcript", sha256, null);
    return null;
  }

  public setTranscript<T>(sha256: string, lang: string, transcript: T): void {
    this.latestMemoInvalidate();
    const normLang = lang.toLowerCase();
    const key = `${sha256}:${normLang}`;
    const serialized = JSON.stringify(transcript);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO transcript_cache (cache_key, sha256, lang, transcript_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(key, sha256, normLang, serialized, now);

    const shared = this.getSharedDb();
    if (shared) {
      try {
        shared
          .prepare(
            `INSERT OR REPLACE INTO transcript_cache (cache_key, sha256, lang, transcript_json, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(key, sha256, normLang, serialized, now);
      } catch {
        // non-blocking shared cache write
      }
    }
  }

  public getTts<T>(cacheKey: string): { audioPath: string; alignment: T } | null {
    const row = this.db
      .prepare(`SELECT audio_path, alignment_json FROM tts_cache WHERE cache_key = ?`)
      .get(cacheKey) as { audio_path: string; alignment_json: string } | undefined;
    if (row && fs.existsSync(row.audio_path)) {
      const shared = this.getSharedDb();
      if (shared && this.sharedConfig.blobsDir) {
        try {
          const existingShared = shared
            .prepare(`SELECT audio_path FROM tts_cache WHERE cache_key = ?`)
            .get(cacheKey) as { audio_path: string } | undefined;
          if (!existingShared || !fs.existsSync(existingShared.audio_path)) {
            fs.mkdirSync(this.sharedConfig.blobsDir, { recursive: true });
            const ext = path.extname(row.audio_path) || ".mp3";
            const sharedAudioPath = path.join(this.sharedConfig.blobsDir, `tts_${cacheKey.slice(0, 14)}${ext}`);
            if (path.resolve(row.audio_path) !== path.resolve(sharedAudioPath)) {
              fs.copyFileSync(row.audio_path, sharedAudioPath);
            }
            shared
              .prepare(
                `INSERT OR REPLACE INTO tts_cache (cache_key, audio_path, alignment_json, created_at)
                 VALUES (?, ?, ?, ?)`
              )
              .run(cacheKey, sharedAudioPath, row.alignment_json, new Date().toISOString());
          }
        } catch {
          // non-blocking shared cache promotion
        }
      }
      return {
        audioPath: row.audio_path,
        alignment: JSON.parse(row.alignment_json) as T,
      };
    }

    const shared = this.getSharedDb();
    if (shared) {
      try {
        const sharedRow = shared
          .prepare(`SELECT audio_path, alignment_json FROM tts_cache WHERE cache_key = ?`)
          .get(cacheKey) as { audio_path: string; alignment_json: string } | undefined;
        if (sharedRow && fs.existsSync(sharedRow.audio_path)) {
          return {
            audioPath: sharedRow.audio_path,
            alignment: JSON.parse(sharedRow.alignment_json) as T,
          };
        }
      } catch {
        // non-blocking shared cache read
      }
    }

    return null;
  }

  public setTts<T>(cacheKey: string, audioPath: string, alignment: T): void {
    const serialized = JSON.stringify(alignment);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tts_cache (cache_key, audio_path, alignment_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(cacheKey, audioPath, serialized, now);

    const shared = this.getSharedDb();
    if (shared && this.sharedConfig.blobsDir && fs.existsSync(audioPath)) {
      try {
        fs.mkdirSync(this.sharedConfig.blobsDir, { recursive: true });
        const ext = path.extname(audioPath) || ".mp3";
        const sharedAudioPath = path.join(this.sharedConfig.blobsDir, `tts_${cacheKey.slice(0, 14)}${ext}`);
        if (path.resolve(audioPath) !== path.resolve(sharedAudioPath)) {
          fs.copyFileSync(audioPath, sharedAudioPath);
        }
        shared
          .prepare(
            `INSERT OR REPLACE INTO tts_cache (cache_key, audio_path, alignment_json, created_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(cacheKey, sharedAudioPath, serialized, now);
      } catch {
        // non-blocking shared cache write
      }
    }
  }

  public getExtensionProcessorResult<T>(
    cacheKey: string,
    localBlobsDir?: string
  ): { outputPath: string; meta: T } | null {
    const row = this.db
      .prepare(`SELECT output_path, meta_json FROM extension_cache WHERE cache_key = ?`)
      .get(cacheKey) as { output_path: string; meta_json: string } | undefined;
    if (row && fs.existsSync(row.output_path)) {
      const shared = this.getSharedDb();
      if (shared && this.sharedConfig.blobsDir) {
        try {
          const existingShared = shared
            .prepare(`SELECT output_path FROM extension_cache WHERE cache_key = ?`)
            .get(cacheKey) as { output_path: string } | undefined;
          if (!existingShared || !fs.existsSync(existingShared.output_path)) {
            fs.mkdirSync(this.sharedConfig.blobsDir, { recursive: true });
            const ext = path.extname(row.output_path) || ".bin";
            const sharedOutPath = path.join(
              this.sharedConfig.blobsDir,
              `ext_${cacheKey.slice(0, 16)}${ext}`
            );
            if (path.resolve(row.output_path) !== path.resolve(sharedOutPath)) {
              fs.copyFileSync(row.output_path, sharedOutPath);
            }
            shared
              .prepare(
                `INSERT OR REPLACE INTO extension_cache (cache_key, output_path, meta_json, created_at)
                 VALUES (?, ?, ?, ?)`
              )
              .run(cacheKey, sharedOutPath, row.meta_json, new Date().toISOString());
          }
        } catch {
          // non-blocking shared cache promotion
        }
      }
      return {
        outputPath: row.output_path,
        meta: JSON.parse(row.meta_json) as T,
      };
    }

    const shared = this.getSharedDb();
    if (shared) {
      try {
        const sharedRow = shared
          .prepare(`SELECT output_path, meta_json FROM extension_cache WHERE cache_key = ?`)
          .get(cacheKey) as { output_path: string; meta_json: string } | undefined;
        if (sharedRow && fs.existsSync(sharedRow.output_path)) {
          let finalOutPath = sharedRow.output_path;
          if (localBlobsDir) {
            fs.mkdirSync(localBlobsDir, { recursive: true });
            const ext = path.extname(sharedRow.output_path) || ".bin";
            const localCopy = path.join(localBlobsDir, `ext_${cacheKey.slice(0, 16)}${ext}`);
            if (path.resolve(sharedRow.output_path) !== path.resolve(localCopy)) {
              fs.copyFileSync(sharedRow.output_path, localCopy);
            }
            finalOutPath = localCopy;
          }
          this.db
            .prepare(
              `INSERT OR REPLACE INTO extension_cache (cache_key, output_path, meta_json, created_at)
               VALUES (?, ?, ?, ?)`
            )
            .run(cacheKey, finalOutPath, sharedRow.meta_json, new Date().toISOString());
          return {
            outputPath: finalOutPath,
            meta: JSON.parse(sharedRow.meta_json) as T,
          };
        }
      } catch {
        // non-blocking shared cache read
      }
    }

    return null;
  }

  public setExtensionProcessorResult<T>(cacheKey: string, outputPath: string, meta: T): void {
    const serialized = JSON.stringify(meta);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO extension_cache (cache_key, output_path, meta_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(cacheKey, outputPath, serialized, now);

    const shared = this.getSharedDb();
    if (shared && this.sharedConfig.blobsDir && fs.existsSync(outputPath)) {
      try {
        fs.mkdirSync(this.sharedConfig.blobsDir, { recursive: true });
        const ext = path.extname(outputPath) || ".bin";
        const sharedOutPath = path.join(
          this.sharedConfig.blobsDir,
          `ext_${cacheKey.slice(0, 16)}${ext}`
        );
        if (path.resolve(outputPath) !== path.resolve(sharedOutPath)) {
          fs.copyFileSync(outputPath, sharedOutPath);
        }
        shared
          .prepare(
            `INSERT OR REPLACE INTO extension_cache (cache_key, output_path, meta_json, created_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(cacheKey, sharedOutPath, serialized, now);
      } catch {
        // non-blocking shared cache write
      }
    }
  }

  public getStats(): Record<string, number> {
    const tables = [
      "file_digests",
      "media_probes",
      "loudness_cache",
      "waveform_cache",
      "beats_cache",
      "scenes_cache",
      "transcript_cache",
      "tts_cache",
    ];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const r = this.db.prepare(`SELECT COUNT(*) AS cnt FROM ${t}`).get() as { cnt: number };
      counts[t] = r.cnt;
    }
    return counts;
  }

  public close(): void {
    this.db.close();
    if (this.sharedDb) {
      try {
        this.sharedDb.close();
      } catch {
        // ignore close error
      }
      this.sharedDb = null;
    }
  }
}
