/**
 * Cuthol Speech Transcription Service (`src/speech/transcribe.ts`).
 *
 * Uses content-addressed `.cuthol/ledger.sqlite` (`transcript_cache`) so identical media
 * assets are never transcribed twice. Supports both cloud (`deepgram` Nova-3) and
 * pluggable `local` providers. The default language is auto-detection; records are
 * keyed by the document's real language, and a record filed under a disagreeing
 * language key is skipped on read so the cache heals itself.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { loadDotEnvIfNeeded } from "../core/env.js";
import { TimedWordToken } from "../core/schema.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import { commitSequenceMutation, loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { resolveLibraryItemPath } from "../library/probe.js";
import { analyzeAssetWaveform } from "../library/waveform.js";
import { projectTranscriptAcrossSequence } from "../sequence/spine.js";
import {
  AsrProviderId,
  TranscriptDocument,
  isDeepgramAutoEnglishWithoutFillers,
  isEnglishAsrLanguage,
  transcribeWithDeepgram,
  transcribeWithLocalProvider,
} from "./providers.js";
import { LOCAL_ASR_ENGINE_REVISION, PARAKEET_LANGUAGES, PARAKEET_MODEL_ID, resolveLocalEngine, takeParakeetGapRetry, type LocalAsrEngineId } from "./local_engine.js";

/**
 * Cache namespace of the local ASR path (old `local:*` keys miss). Keyless
 * engine transcripts are namespaced per engine (`local@<rev>+whisper`,
 * `local@<rev>+parakeet`) so one engine never serves the other's transcript;
 * sidecar/custom-cli transcripts stay under the engine-independent base key.
 */
export function localAsrCachePrefix(engine?: string): string {
  const base = `local@${LOCAL_ASR_ENGINE_REVISION}`;
  return engine ? `${base}+${engine}` : base;
}

/**
 * True when a cached keyless-engine transcript was made by a different
 * engine than the request asks for. Records without an engine stamp predate
 * the stamp and are handled by the legacy rule instead.
 */
function isEngineMismatchedTranscript(doc: TranscriptDocument, engine: LocalAsrEngineId | undefined): boolean {
  if (engine === undefined) return false;
  const docEngine = (doc.engine ?? "").trim().toLowerCase();
  if (docEngine !== "whisper" && docEngine !== "parakeet") return false;
  return docEngine !== engine;
}

/**
 * True when a cached record was written by an older keyless local engine:
 * skipped on read so the asset is re-transcribed once with the current
 * engine. Only keyless-engine records (`faster-whisper-*` models and
 * Parakeet records) are stale-checked; sidecar/custom-cli transcripts and
 * cloud records are engine-independent.
 */
export function isStaleLocalEngineRecord(doc: TranscriptDocument): boolean {
  if (doc.provider !== "local" || doc.engineRev === LOCAL_ASR_ENGINE_REVISION) return false;
  if (typeof doc.model === "string" && doc.model.startsWith("faster-whisper-")) return true;
  return doc.engine === "parakeet" || doc.model === PARAKEET_MODEL_ID;
}

/**
 * True when a cached Deepgram record was made with nova-3 for English:
 * nova-3 returns no filler tokens, so an explicit-English `speech
 * transcribe` treats it as a miss and re-transcribes once with nova-2.
 * Only the transcribe lookup applies this rule; every reader
 * (`loadCachedTranscriptForAsset`, captions, cleanup, `library query`,
 * `brief`) keeps returning the existing record. Non-English records never
 * change (shared fixture keys such as `deepgram:tr` keep hitting).
 */
export function isStaleDeepgramNova3Record(doc: TranscriptDocument): boolean {
  return (
    doc.provider === "deepgram" &&
    typeof doc.model === "string" &&
    doc.model !== "nova-2" &&
    isEnglishAsrLanguage(doc.language)
  );
}
import { providerCacheTag, resolveExtensionProvider } from "../extensions/ext_providers.js";
import { transcribeWithExtensionProvider } from "./provider_ext.js";
import { extensionNameOf, resolveAsrProvider } from "./provider_select.js";

export interface TranscribeResult {
  handle: string;
  sha256: string;
  cached: boolean;
  transcript: TranscriptDocument;
  projected_sequence_words: TimedWordToken[];
  notes?: string[];
  /**
   * Parakeet dropped-gap retry outcome for this transcription: how many
   * speech-like gaps were re-decoded and how many words that recovered.
   * Present only on fresh Parakeet transcripts; absent on cache hits and
   * non-Parakeet paths.
   */
  parakeet_gap_retry?: { gaps: number; words: number };
}

/** Language named by a transcript cache key, or null for generic keys. */
function cacheKeyLanguage(key: string): string | null {
  const norm = key.toLowerCase();
  if (norm === "auto" || norm === "latest") return null;
  const last = norm.split(":").pop() ?? "";
  if (!last || last === "auto" || last === "latest") return null;
  return last;
}

/** True when two language tags name the same language (lenient on empty). */
function sameLanguage(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return true;
  if (x === y) return true;
  return x.split(/[-_]/)[0] === y.split(/[-_]/)[0];
}

/**
 * True when a cached record is filed under a language key that disagrees with
 * the document's own language (a poisoned record): skipped on read so the
 * cache heals itself; the next transcribe overwrites the bad keys.
 */
function isPoisonedCacheRecord(key: string, docLanguage: string | undefined): boolean {
  const keyLang = cacheKeyLanguage(key);
  if (!keyLang) return false;
  return !sameLanguage(keyLang, docLanguage ?? "");
}

/** Trimmed keyterms, or null when none were given (cache keys stay byte-identical). */
function normalizeKeyterms(keyterms: string[] | undefined): string[] | null {
  if (!keyterms) return null;
  const terms = keyterms.map((t) => t.trim()).filter(Boolean);
  return terms.length > 0 ? terms : null;
}

/**
 * A transcript stored by a keyterm-scoped run carries the terms on the
 * document itself (extra JSON property, old records simply lack it). The
 * `latest` pointer is shared by plain and keyterm runs so downstream readers
 * always see the newest transcript, while a plain transcribe lookup skips
 * marked records so a keyterm-biased transcript never serves a request that
 * asked for none.
 */
interface KeytermMarkedTranscript extends TranscriptDocument {
  keyterms?: string[];
}

function isKeytermMarkedTranscript(doc: TranscriptDocument): boolean {
  const marked = doc as KeytermMarkedTranscript;
  return Array.isArray(marked.keyterms) && marked.keyterms.length > 0;
}

function markTranscriptWithKeyterms(doc: TranscriptDocument, keyterms: string[]): TranscriptDocument {
  return { ...doc, keyterms } as TranscriptDocument;
}

/**
 * True when a cached record predates the keyterm stamp: every fresh
 * transcript now carries the keyterms it was made with (possibly none), so
 * a builtin-provider record without the property was made with the old
 * invisible default terms. Skipped on read in the transcribe lookup only,
 * so the asset is re-transcribed once with the current request; every
 * downstream reader keeps serving the stored record. Extension records
 * never had default terms and are exempt.
 */
function isLegacyUnmarkedTranscript(doc: TranscriptDocument): boolean {
  if (doc.provider !== "deepgram" && doc.provider !== "local") return false;
  return !Object.prototype.hasOwnProperty.call(doc, "keyterms");
}

function resolveTranscribeLookupKeys(
  providerSource: string,
  cacheLangKey: string,
  lang: string,
  requestedAuto: boolean,
  hasKeyterms: boolean
): string[] {
  // Legacy whole-file engine keys (`local:*`): read-only fallback so records
  // written before the engine revision still hit; stale keyless-engine
  // documents are skipped by isStaleLocalEngineRecord either way.
  const legacyLocalKey = cacheLangKey.startsWith("local@")
    ? `local:${cacheLangKey.split(":").slice(1).join(":")}`
    : null;
  const ownKeys = legacyLocalKey ? [cacheLangKey, legacyLocalKey] : [cacheLangKey];
  if (hasKeyterms) {
    // Keyterms change the request, so only the keyterm-suffixed record may
    // hit: a transcript cached without keyterms must never be returned.
    return ownKeys;
  }
  if (requestedAuto) {
    // Auto-detection accepts whatever the transcript's language is; `auto` and
    // `latest` always point at the most recent transcript. An explicit provider
    // reads only its own auto record so providers never share transcripts.
    return providerSource !== "builtin"
      ? ownKeys
      : ["auto", "latest", cacheLangKey, "tr", "en", "deepgram:tr", "deepgram:en", `${localAsrCachePrefix()}:tr`, `${localAsrCachePrefix()}:en`, "local:tr", "local:en"];
  }
  // An explicit language searches only that language's keys; generic keys are
  // never consulted, so another language's record cannot leak in.
  return providerSource !== "builtin"
    ? ownKeys
    : [cacheLangKey, lang, `${localAsrCachePrefix()}:${lang}`, `local:${lang}`];
}

export async function transcribeLibraryAsset(options: {
  workspaceDir: string;
  handle: string;
  language?: string;
  provider?: string;
  keyterms?: string[];
  refresh?: boolean;
  engine?: string;
}): Promise<TranscribeResult> {
  const { paths, sequence } = loadSequence(options.workspaceDir);
  loadDotEnvIfNeeded(paths.rootDir);
  const item = sequence.library.find((x) => x.handle === options.handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.handle));
  }
  if (!item.probe.has_audio) {
    throw new CutholError(DIAGNOSTICS.NO_AUDIO_STREAM(options.handle));
  }

  const lang = (options.language ?? "auto").toLowerCase();
  const requestedAuto = lang === "auto";
  const resolvedProvider = resolveAsrProvider({
    workspaceDir: options.workspaceDir,
    explicit: options.provider,
  });
  const provider: AsrProviderId = resolvedProvider.id;
  const extProviderName = extensionNameOf(provider);
  // The keyless local engine is resolved only when a transcription actually
  // has to run, so a request servable from a stored transcript never fails
  // on engine resolution. Sidecar and custom-cli paths are engine-independent
  // and keep the base key.
  const forcedEngineOpt = (options.engine ?? "").trim().toLowerCase();
  const forcedValid =
    forcedEngineOpt === "whisper" || forcedEngineOpt === "parakeet"
      ? (forcedEngineOpt as LocalAsrEngineId)
      : undefined;
  const isKeylessPath =
    provider === "local" &&
    extProviderName === null &&
    !process.env.CUTHOL_LOCAL_ASR_CMD &&
    !fs.existsSync(`${resolveLibraryItemPath(paths.rootDir, item)}.transcript.json`);
  let keylessEngine: LocalAsrEngineId | undefined;
  // Extension transcripts are keyed by provider identity + version + content hash, so the
  // same file transcribed by different providers keeps separate cache records.
  let providerKeyPrefix =
    extProviderName !== null
      ? providerCacheTag(
          resolveExtensionProvider({
            extensionName: extProviderName,
            kind: "asr",
            workspaceDir: options.workspaceDir,
          }).extension
        )
      : provider === "local"
        ? localAsrCachePrefix(keylessEngine)
        : provider;
  // Keyterms are part of the transcription request, so they are part of the
  // cache key: a short hash suffix keeps the `<provider>:<lang>` shape (and
  // its language parsing) intact. Without keyterms every key is exactly as
  // before, so existing cached transcripts keep hitting and are never
  // re-transcribed for money; only an explicit keyterm list makes a new key.
  const keyterms = normalizeKeyterms(options.keyterms);
  const keytermSuffix = keyterms
    ? `:k${createHash("sha256").update(keyterms.join("\0")).digest("hex").slice(0, 12)}`
    : "";
  let cacheProviderPrefix = `${providerKeyPrefix}${keytermSuffix}`;
  const cacheLangKey = `${cacheProviderPrefix}:${lang}`;

  const ledger = new MediaLedger(paths.ledgerFile);

  try {
    let doc: TranscriptDocument | null = null;
    let staleFallback: TranscriptDocument | null = null;
    let gapRetryTaken: { retry: { gaps: number; words: number }; note: string | null } | null = null;
    if (!options.refresh) {
      let lookupKeys = resolveTranscribeLookupKeys(
        resolvedProvider.source,
        cacheLangKey,
        lang,
        requestedAuto,
        keyterms !== null
      );
      if (isKeylessPath && resolvedProvider.source === "builtin") {
        const extra: string[] = [];
        for (const k of lookupKeys) {
          for (const e of ["whisper", "parakeet"] as const) {
            const scoped = k.replace(
              `local@${LOCAL_ASR_ENGINE_REVISION}`,
              `local@${LOCAL_ASR_ENGINE_REVISION}+${e}`
            );
            if (scoped !== k) extra.push(scoped);
          }
        }
        lookupKeys = [...lookupKeys, ...extra];
      }
      for (const k of lookupKeys) {
        const candidate = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, k);
        if (!candidate) continue;
        if (isPoisonedCacheRecord(k, candidate.language)) continue;
        // A record from an older keyless local engine is re-transcribed once
        // with the current engine instead of being served again.
        if (isStaleLocalEngineRecord(candidate)) {
          if (staleFallback === null && keyterms === null) staleFallback = candidate;
          continue;
        }
        // An English Deepgram record made with nova-3 holds no fillers;
        // an explicit-English transcribe re-transcribes it once with
        // nova-2. Auto requests keep nova-3, so the rule never applies.
        if (!requestedAuto && isEnglishAsrLanguage(lang) && isStaleDeepgramNova3Record(candidate)) {
          continue;
        }
        // A plain request never reads a keyterm-made record: when only a
        // keyterm transcript is cached the lookup misses and transcribes.
        if (keyterms === null && isKeytermMarkedTranscript(candidate)) continue;
        // A record made with the old invisible default terms is never
        // served: it is re-transcribed once with the current request.
        if (isLegacyUnmarkedTranscript(candidate)) {
          if (staleFallback === null && keyterms === null) staleFallback = candidate;
          continue;
        }
        // A forced engine never reads the other engine's transcript;
        // without a forced engine any engine's stored transcript serves.
        if (isEngineMismatchedTranscript(candidate, forcedValid)) continue;
        doc = candidate;
        break;
      }
    }
    if (doc === null && staleFallback !== null && isKeylessPath) {
      // Cache first: when no engine can run (uncovered language, nothing
      // installed) a stored transcript is served instead of failing on
      // engine resolution. When an engine can run, the stale record stays
      // a miss and is re-transcribed once below.
      try {
        resolveLocalEngine({ language: lang, forced: options.engine });
      } catch {
        doc = staleFallback;
      }
    }
    let wasCached = Boolean(doc);

    if (doc) {
      // Re-key a cache hit only under the document's own real language, never
      // under the requested one when they differ.
      const hitLang = (doc.language ?? "").trim().toLowerCase();
      if (hitLang && hitLang !== "auto" && hitLang !== "latest") {
        // A keyterm-scoped hit is re-keyed under its own scoped key only,
        // never under a bare key another request could read.
        ledger.setTranscript(
          item.digest_sha256,
          keyterms ? `${cacheProviderPrefix}:${hitLang}` : hitLang,
          doc
        );
      }
    } else {
      wasCached = false;
      if (isKeylessPath) {
        // Only a real run resolves the engine: an uncovered language or a
        // missing install fails here with the specific diagnostic.
        keylessEngine = resolveLocalEngine({ language: lang, forced: options.engine });
        providerKeyPrefix = localAsrCachePrefix(keylessEngine);
        cacheProviderPrefix = `${providerKeyPrefix}${keytermSuffix}`;
      }
      // Pre-compute acoustic 25ms-window silence intervals so ASR word tails stretched across silent pauses are clamped accurately
      let acousticSilenceIntervals: Array<{ start_ms: number; end_ms: number; duration_ms: number }> = [];
      try {
        const wave = analyzeAssetWaveform({
          workspaceDir: options.workspaceDir,
          handle: item.handle,
          bins: 160,
        });
        acousticSilenceIntervals = wave.silence_intervals;
      } catch {
        // ignore if waveform fails
      }

      const absMediaPath = resolveLibraryItemPath(paths.rootDir, item);

      if (extProviderName !== null) {
        doc = (
          await transcribeWithExtensionProvider({
            workspaceDir: options.workspaceDir,
            extensionName: extProviderName,
            audioFilePath: absMediaPath,
            language: lang,
            durationMs: item.probe.duration_ms,
            keyterms: keyterms ?? undefined,
          })
        ).doc;
      } else if (provider === "local") {
        doc = await transcribeWithLocalProvider({
          audioFilePath: absMediaPath,
          language: lang,
          durationMs: item.probe.duration_ms,
          keyterms: keyterms ?? undefined,
          ...(keylessEngine ? { engine: keylessEngine } : {}),
        });
      } else {
        // Extract clean 16 kHz mono WAV into `.cuthol/blobs/` for fast upload to Deepgram
        const wavForAsr = path.join(paths.blobsDir, `asr_input_${item.digest_sha256.slice(0, 12)}.wav`);
        const hasValidWav =
          fs.existsSync(wavForAsr) &&
          (() => {
            try {
              return fs.statSync(wavForAsr).size > 44;
            } catch {
              return false;
            }
          })();

        if (!hasValidWav) {
          const tmpWav = `${wavForAsr}.tmp.${process.pid}.wav`;
          const proc = spawnSync(
            "ffmpeg",
            [
              "-y",
              "-v",
              "error",
              "-i",
              absMediaPath,
              "-vn",
              "-af",
              "aresample=async=1:first_pts=0",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-c:a",
              "pcm_s16le",
              tmpWav,
            ],
            { encoding: "utf8", windowsHide: true }
          );
          const tmpOk =
            proc.status === 0 &&
            fs.existsSync(tmpWav) &&
            (() => {
              try {
                return fs.statSync(tmpWav).size > 44;
              } catch {
                return false;
              }
            })();

          if (!tmpOk) {
            try {
              if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
            } catch {
              // ignore cleanup error
            }
            throw new CutholError(
              DIAGNOSTICS.EXTERNAL_TOOL_FAILED("ffmpeg asr audio extract", (proc.stderr || "").slice(-300))
            );
          }
          fs.renameSync(tmpWav, wavForAsr);
        }

        doc = await transcribeWithDeepgram({
          audioFilePath: wavForAsr,
          language: lang,
          durationMs: item.probe.duration_ms,
          keyterms: keyterms ?? undefined,
        });
      }

      // The Parakeet bridge reports its dropped-gap retry out of band (the
      // local provider return type is owned by providers.ts); consumed here
      // so the transcribe output carries it. Non-Parakeet runs take null.
      gapRetryTaken = takeParakeetGapRetry();

      // Clamp word & disfluency timestamps to [0, item.probe.duration_ms]
      const maxDurMs = item.probe.duration_ms;
      doc.words = doc.words
        .filter((w) => w.source_start_ms < maxDurMs)
        .map((w) => {
          const st = Math.max(0, Math.min(maxDurMs - 1, w.source_start_ms));
          const en = Math.max(st + 1, Math.min(maxDurMs, w.source_end_ms));
          return { ...w, source_start_ms: st, source_end_ms: en };
        });
      doc.disfluencies = doc.disfluencies
        .filter((d) => d.source_start_ms < maxDurMs)
        .map((d) => {
          const st = Math.max(0, Math.min(maxDurMs - 1, d.source_start_ms));
          const en = Math.max(st + 1, Math.min(maxDurMs, d.source_end_ms));
          return { ...d, source_start_ms: st, source_end_ms: en, duration_ms: en - st };
        });

      // Fuse acoustic 25ms-window silence intervals into doc.disfluencies so silent pauses
      // absorbed into stretched ASR word `end` timestamps are detected reliably without ever
      // overlapping or truncating spoken words.
      const minPauseMs = OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS;
      for (const sil of acousticSilenceIntervals) {
        for (let wi = 0; wi < doc.words.length; wi++) {
          const w = doc.words[wi];
          const nextW = wi + 1 < doc.words.length ? doc.words[wi + 1] : null;
          const nextStartsAfterSilStart =
            !nextW || nextW.source_start_ms >= sil.start_ms + minPauseMs * 0.5;
          if (
            w.source_start_ms <= sil.start_ms - 80 &&
            w.source_end_ms > sil.start_ms + 60 &&
            nextStartsAfterSilStart
          ) {
            const oldEnd = w.source_end_ms;
            w.source_end_ms = Math.max(w.source_start_ms + 80, sil.start_ms);
            for (const d of doc.disfluencies) {
              if (
                d.kind === "pause" &&
                (d.source_start_ms === oldEnd ||
                  (nextW && d.source_end_ms === nextW.source_start_ms && d.source_start_ms > w.source_end_ms))
              ) {
                d.source_start_ms = w.source_end_ms;
                d.duration_ms = d.source_end_ms - d.source_start_ms;
              }
            }
          }
        }

        // Subtract all ASR word intervals from [sil.start_ms, sil.end_ms] so acoustic pause
        // candidates never overlap spoken words
        let freeSegments: Array<{ start_ms: number; end_ms: number }> = [
          {
            start_ms: Math.max(0, Math.min(maxDurMs - 1, sil.start_ms)),
            end_ms: Math.max(1, Math.min(maxDurMs, sil.end_ms)),
          },
        ];
        for (const w of doc.words) {
          const nextSegments: Array<{ start_ms: number; end_ms: number }> = [];
          for (const seg of freeSegments) {
            if (w.source_end_ms <= seg.start_ms || w.source_start_ms >= seg.end_ms) {
              nextSegments.push(seg);
            } else {
              if (w.source_start_ms > seg.start_ms) {
                nextSegments.push({ start_ms: seg.start_ms, end_ms: w.source_start_ms });
              }
              if (w.source_end_ms < seg.end_ms) {
                nextSegments.push({ start_ms: w.source_end_ms, end_ms: seg.end_ms });
              }
            }
          }
          freeSegments = nextSegments;
        }

        for (const seg of freeSegments) {
          const dur = seg.end_ms - seg.start_ms;
          if (dur < minPauseMs) continue;
          const overlappingPause = doc.disfluencies.find(
            (d) =>
              d.kind === "pause" &&
              Math.min(d.source_end_ms, seg.end_ms) - Math.max(d.source_start_ms, seg.start_ms) >=
                dur * 0.5
          );
          if (overlappingPause) {
            overlappingPause.source_start_ms = Math.min(overlappingPause.source_start_ms, seg.start_ms);
            overlappingPause.source_end_ms = Math.max(overlappingPause.source_end_ms, seg.end_ms);
            overlappingPause.duration_ms =
              overlappingPause.source_end_ms - overlappingPause.source_start_ms;
          } else {
            doc.disfluencies.push({
              kind: "pause",
              source_start_ms: seg.start_ms,
              source_end_ms: seg.end_ms,
              duration_ms: dur,
              label: `<acoustic_pause ${dur}ms>`,
            });
          }
        }
      }
      doc.disfluencies.sort((a, b) => a.source_start_ms - b.source_start_ms);

      const detectedRaw = (doc.language ?? "").trim().toLowerCase();
      if (requestedAuto && (!detectedRaw || detectedRaw === "auto")) {
        if (keylessEngine === "parakeet") {
          // Parakeet transcribed the audio but never reports the detected
          // language, so `--lang auto` cannot tag the transcript. The generic
          // G213 cannot name the 25 covered languages, so this engine's case
          // fails with the free-form local-speech error carrying the retry.
          throw new CutholError(
            DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
              "local ASR",
              `Parakeet transcribed the audio but does not report the detected language, so '--lang auto' cannot tag this transcript. Parakeet covers 25 European languages (${PARAKEET_LANGUAGES.join(", ")}), not Turkish`,
              `Re-run with an explicit language, e.g. 'cuthol speech transcribe --handle ${item.handle} --lang en --provider local', or install Whisper for auto-detect with 'cuthol setup --local-speech --engine whisper --apply'`
            )
          );
        }
        throw new CutholError(DIAGNOSTICS.ASR_LANGUAGE_REQUIRED(provider));
      }
      const realLang = detectedRaw && detectedRaw !== "auto" ? detectedRaw : lang;
      // Stamp every fresh transcript with the keyterms it was made with
      // (possibly none) so the lookup can spot legacy default-term records.
      doc = markTranscriptWithKeyterms(doc, keyterms ?? []);
      if (keyterms) {
        // Keyterm-scoped transcripts stay under scoped keys only, plus the
        // shared `latest` pointer (marked, so plain transcribe lookups skip
        // it while downstream readers use the newest transcript either way).
        // Bare/auto keys are never written here: a plain request must miss
        // when no plain record exists.
        const marked = markTranscriptWithKeyterms(doc, keyterms);
        ledger.setTranscript(item.digest_sha256, `${cacheProviderPrefix}:${realLang}`, marked);
        ledger.setTranscript(item.digest_sha256, "latest", marked);
        if (requestedAuto) {
          ledger.setTranscript(item.digest_sha256, `${cacheProviderPrefix}:${lang}`, marked);
        }
      } else {
        ledger.setTranscript(item.digest_sha256, `${providerKeyPrefix}:${realLang}`, doc);
        ledger.setTranscript(item.digest_sha256, realLang, doc);
        ledger.setTranscript(item.digest_sha256, "auto", doc);
        ledger.setTranscript(item.digest_sha256, "latest", doc);
        if (requestedAuto) {
          // The provider's own latest auto detection, so an explicit provider
          // hits its own auto cache without ever reading another provider's.
          ledger.setTranscript(item.digest_sha256, `${cacheProviderPrefix}:${lang}`, doc);
        }
      }
    }

    const refId = `asr_${item.digest_sha256.slice(0, 8)}`;
    const current = sequence.library.find((x) => x.handle === item.handle);
    if (current && current.analysis_refs.transcript !== refId) {
      commitSequenceMutation(options.workspaceDir, `speech.transcribe(${item.handle})`, (seq) => {
        const target = seq.library.find((x) => x.handle === item.handle);
        if (target) {
          target.analysis_refs.transcript = refId;
        }
      });
    }

    const latestSeq = loadSequence(options.workspaceDir).sequence;
    const projectedWords = projectTranscriptAcrossSequence(latestSeq, item.handle, doc.words);

    // Auto mode keeps nova-3, which returns no fillers for English: when
    // detection settled on English and the response holds no filler token,
    // attach one INFO note pointing at `--lang en`.
    const notes: string[] =
      requestedAuto && isDeepgramAutoEnglishWithoutFillers(doc)
        ? [DIAGNOSTICS.DEEPGRAM_AUTO_ENGLISH_NO_FILLERS().formatted]
        : [];
    if (gapRetryTaken?.note) {
      notes.push(gapRetryTaken.note);
    }

    return {
      handle: item.handle,
      sha256: item.digest_sha256,
      cached: wasCached,
      transcript: doc,
      projected_sequence_words: projectedWords,
      notes,
      ...(gapRetryTaken !== null ? { parakeet_gap_retry: { ...gapRetryTaken.retry } } : {}),
    };
  } finally {
    ledger.close();
  }
}

export function loadCachedTranscriptForAsset(
  workspaceDir: string,
  handle: string,
  language = "auto"
): TranscriptDocument {
  const { paths, sequence } = loadSequence(workspaceDir);
  const item = sequence.library.find((x) => x.handle === handle);
  if (!item) {
    throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(handle));
  }

  const normLang = language.toLowerCase();
  const ledger = new MediaLedger(paths.ledgerFile);
  try {
    // Downstream readers prefer the requested language but stay lenient: any
    // recorded transcript of the asset is usable dialogue data. Poisoned
    // records (key language vs doc.language mismatch) are skipped everywhere.
    const candidateKeys =
      normLang === "auto"
        ? ["latest", "auto", "tr", "en", "deepgram:tr", "deepgram:en", `${localAsrCachePrefix()}:tr`, `${localAsrCachePrefix()}:en`, "local:tr", "local:en"]
        : [
            normLang,
            `deepgram:${normLang}`,
            `${localAsrCachePrefix()}:${normLang}`,
            `local:${normLang}`,
            "latest",
            "auto",
            "en",
            "tr",
            "deepgram:en",
            "local:en",
          ];

    // Newest-first: when the shared `latest` pointer names a transcript in the
    // requested language it is the newest transcript of the asset, so it
    // wins over older language-keyed records (e.g. plain then keyterm fix).
    // Poisoned records are still skipped; other languages never match here.
    if (normLang !== "auto") {
      const newest = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, "latest");
      if (newest && !isPoisonedCacheRecord("latest", newest.language)) {
        if (sameLanguage((newest.language ?? "").trim().toLowerCase(), normLang)) {
          return newest;
        }
      }
    }
    for (const key of candidateKeys) {
      const candidate = ledger.getTranscript<TranscriptDocument>(item.digest_sha256, key);
      if (!candidate) continue;
      if (isPoisonedCacheRecord(key, candidate.language)) continue;
      return candidate;
    }

    throw new CutholError(DIAGNOSTICS.TRANSCRIPT_NOT_FOUND(handle));
  } finally {
    ledger.close();
  }
}
