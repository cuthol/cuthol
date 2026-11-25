/**
 * Cloud (Deepgram ASR & ElevenLabs TTS) and Pluggable Local Speech Providers (`src/speech/providers.ts`).
 *
 * Architecture:
 * - Default cloud providers use `.env` (`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`).
 * - Open-source local provider doors (`local` ASR & `local` TTS) allow running Cuthol
 *   with local models (`whisper.cpp` / `faster-whisper` / `piper` / `kokoro` via CLI or HTTP)
 *   without changing any downstream Cuthol sequence, caption, or cleanup code.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { requireApiKey } from "../core/env.js";
import { OPEN_STANDARDS } from "../core/standards.js";
import {
  LOCAL_ASR_ENGINE_REVISION,
  LOCAL_SPEECH_DEFAULT_MODEL,
  localSpeechStatus,
  resolveLocalEngine,
  runLocalAsrBridge,
  runLocalTtsBridge,
} from "./local_engine.js";

export type AsrProviderId = "deepgram" | "local" | `ext:${string}`;
export type TtsProviderId = "elevenlabs" | "local" | `ext:${string}`;

export interface RawTranscriptWord {
  word: string;
  punctuated_word: string;
  source_start_ms: number;
  source_end_ms: number;
  confidence: number;
  is_filler: boolean;
  is_repetition: boolean;
}

export interface DetectedDisfluencySpan {
  kind: "pause" | "filler" | "repetition";
  source_start_ms: number;
  source_end_ms: number;
  duration_ms: number;
  label: string;
}

export interface TranscriptDocument {
  provider: AsrProviderId;
  model: string;
  /**
   * Local ASR engine that produced the transcript (`whisper`, `parakeet`,
   * `sidecar`, `custom-cli`; Deepgram records the model id). Present on
   * fresh transcripts; older cached records lack it.
   */
  engine?: string;
  language: string;
  duration_ms: number;
  text: string;
  words: RawTranscriptWord[];
  disfluencies: DetectedDisfluencySpan[];
  /**
   * Keyless local ASR engine revision (`LOCAL_ASR_ENGINE_REVISION`). Present
   * on every transcript the local provider returns; the cache skips local
   * records stamped with an older revision so they are re-transcribed.
   * Cloud providers never set it.
   */
  engineRev?: string;
  /**
   * Hallucinated segments the keyless local engine dropped (source-ms time
   * ranges with reasons), reported next to `words`, never silently.
   * Only the keyless local provider sets it; cloud providers never do.
   */
  local_dropped_segments?: Array<{ start_ms: number; end_ms: number; reason: string }>;
}

export interface TtsSynthesisOutput {
  provider: TtsProviderId;
  voice_id: string;
  model_id: string;
  audio_buffer: Buffer;
  duration_ms: number;
  words: RawTranscriptWord[];
  is_placeholder_audio?: boolean;
  placeholder_warning?: string;
}

export const UNCONDITIONAL_FILLER_TOKENS = new Set([
  // Turkish non-lexical hesitation sounds
  "ıı",
  "ııı",
  "ee",
  "eee",
  // English non-lexical hesitation sounds
  "uh",
  "um",
  "umm",
  "er",
  "ah",
  "hmm",
]);

export const CONTEXTUAL_FILLER_TOKENS = new Set([
  // Turkish discourse words that are meaningful in fluent clauses ("bir şey var", "yani şöyle")
  // and should only be treated as fillers when isolated by hesitation pauses on both sides.
  "şey",
  "yani",
  "hani",
  "acaba",
]);

/**
 * True for Turkish transcript languages (`tr`, `tr-TR`, ...). Only Turkish
 * transcripts use Turkish lowercasing (`I` -> `ı`); every other language
 * uses language-neutral lowercasing (`I` -> `i`). An unknown language falls
 * back to the legacy Turkish rule so callers without language context
 * (TTS doors, extension bridges, old tests) behave exactly as before.
 */
export function isTurkishAsrLanguage(language: string | undefined): boolean {
  const lang = (language ?? "").trim();
  return lang === "" || /^tr([-_]|$)/i.test(lang);
}

export function normalizeTokenForMatch(word: string, language?: string): string {
  const lowered = isTurkishAsrLanguage(language)
    ? word.toLocaleLowerCase("tr-TR")
    : word.toLowerCase();
  return lowered
    .replace(/\u0307/g, "")
    .replace(/[.,!?;:"'()[\]{}…—–-]/g, "")
    .trim();
}

/**
 * Match form of one transcript token in a transcript of `language`:
 * derived from `punctuated_word` (which stored records keep verbatim) so
 * records written with the old Turkish-only rule and records written with
 * the language-aware rule behave the same. Both compared sides must use
 * this helper with the same language.
 */
export function matchWordForLanguage(
  token: { word: string; punctuated_word?: string },
  language?: string
): string {
  const surface = token.punctuated_word || token.word;
  return normalizeTokenForMatch(surface, language) || token.word;
}

export function isContextualFillerToken(word: string, language?: string): boolean {
  return CONTEXTUAL_FILLER_TOKENS.has(normalizeTokenForMatch(word, language));
}

export function isContextualFillerIsolated(gapBeforeMs: number, gapAfterMs: number): boolean {
  const minSideGap = OPEN_STANDARDS.DIALOGUE_CLEANUP.CONTEXTUAL_FILLER_MIN_SIDE_GAP_MS;
  const minDominantGap = OPEN_STANDARDS.DIALOGUE_CLEANUP.CONTEXTUAL_FILLER_MIN_DOMINANT_GAP_MS;
  return (
    gapBeforeMs >= minSideGap &&
    gapAfterMs >= minSideGap &&
    Math.max(gapBeforeMs, gapAfterMs) >= minDominantGap
  );
}

/**
 * Post-processes raw word tokens to annotate fillers, immediate repetitions, and inter-word pauses.
 */
export function annotateWordsAndDisfluencies(
  rawWords: Array<{
    word: string;
    punctuated_word?: string;
    source_start_ms: number;
    source_end_ms: number;
    confidence?: number;
  }>,
  totalDurationMs: number,
  minPauseMs: number = OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS,
  language?: string
): { words: RawTranscriptWord[]; disfluencies: DetectedDisfluencySpan[] } {
  const words: RawTranscriptWord[] = [];
  const disfluencies: DetectedDisfluencySpan[] = [];

  for (let i = 0; i < rawWords.length; i++) {
    const curr = rawWords[i];
    const clean = matchWordForLanguage(curr, language);
    const prevClean = i > 0 ? matchWordForLanguage(rawWords[i - 1], language) : "";
    const gapFromPrev = i > 0 ? curr.source_start_ms - rawWords[i - 1].source_end_ms : curr.source_start_ms;
    const gapToNext =
      i + 1 < rawWords.length
        ? rawWords[i + 1].source_start_ms - curr.source_end_ms
        : totalDurationMs - curr.source_end_ms;

    // Leading silence / inter-word pause check
    if (i === 0 && curr.source_start_ms >= minPauseMs) {
      disfluencies.push({
        kind: "pause",
        source_start_ms: 0,
        source_end_ms: curr.source_start_ms,
        duration_ms: curr.source_start_ms,
        label: `<silence ${curr.source_start_ms}ms>`,
      });
    } else if (i > 0 && gapFromPrev >= minPauseMs) {
      const pStart = rawWords[i - 1].source_end_ms;
      const pEnd = curr.source_start_ms;
      disfluencies.push({
        kind: "pause",
        source_start_ms: pStart,
        source_end_ms: pEnd,
        duration_ms: pEnd - pStart,
        label: `<pause ${pEnd - pStart}ms>`,
      });
    }

    const isFiller =
      UNCONDITIONAL_FILLER_TOKENS.has(clean) ||
      (CONTEXTUAL_FILLER_TOKENS.has(clean) && isContextualFillerIsolated(gapFromPrev, gapToNext));
    const prevPunctuated =
      i > 0 ? String(rawWords[i - 1].punctuated_word ?? rawWords[i - 1].word ?? "").trim() : "";
    const prevEndsSentence = /[.!?…]+['"”’)\]]*$/.test(prevPunctuated);
    const isRepetition = Boolean(
      clean && clean === prevClean && gapFromPrev < 800 && !prevEndsSentence
    );

    if (isFiller) {
      disfluencies.push({
        kind: "filler",
        source_start_ms: curr.source_start_ms,
        source_end_ms: curr.source_end_ms,
        duration_ms: curr.source_end_ms - curr.source_start_ms,
        label: curr.word,
      });
    } else if (isRepetition) {
      disfluencies.push({
        kind: "repetition",
        source_start_ms: curr.source_start_ms,
        source_end_ms: curr.source_end_ms,
        duration_ms: curr.source_end_ms - curr.source_start_ms,
        label: curr.word,
      });
    }

    words.push({
      word: clean || curr.word,
      punctuated_word: curr.punctuated_word ?? curr.word,
      source_start_ms: curr.source_start_ms,
      source_end_ms: curr.source_end_ms,
      confidence: curr.confidence ?? 0.99,
      is_filler: isFiller,
      is_repetition: isRepetition,
    });
  }

  // Trailing silence check
  if (words.length > 0) {
    const lastEnd = words[words.length - 1].source_end_ms;
    if (totalDurationMs - lastEnd >= minPauseMs) {
      disfluencies.push({
        kind: "pause",
        source_start_ms: lastEnd,
        source_end_ms: totalDurationMs,
        duration_ms: totalDurationMs - lastEnd,
        label: `<trailing_silence ${totalDurationMs - lastEnd}ms>`,
      });
    }
  }

  return { words, disfluencies };
}

/**
 * Cloud ASR Provider: Deepgram (`/v1/listen`).
 *
 * Model per language: explicit English (`en` / `en-*`) uses `nova-2`
 * because `nova-3` returns no filler tokens (`filler_words` is accepted
 * but yields none); `nova-2` rejects `keyterm`, so the same terms are sent
 * as `keywords`. Every other explicit language keeps `nova-3` + `keyterm`;
 * `auto` keeps `nova-3` + `detect_language`.
 */
export function isEnglishAsrLanguage(language: string | undefined): boolean {
  const lang = (language ?? "").trim().toLowerCase();
  return lang === "en" || lang.startsWith("en-");
}

export function deepgramModelForLanguage(language: string | undefined): "nova-2" | "nova-3" {
  if (language && language !== "auto" && isEnglishAsrLanguage(language)) return "nova-2";
  return "nova-3";
}

export async function transcribeWithDeepgram(options: {
  audioFilePath: string;
  language?: string;
  durationMs: number;
  keyterms?: string[];
}): Promise<TranscriptDocument> {
  const apiKey = requireApiKey("DEEPGRAM_API_KEY", "Deepgram ASR");
  const audioBuffer = fs.readFileSync(options.audioFilePath);

  const model = deepgramModelForLanguage(options.language);
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    utterances: "true",
    filler_words: "true",
    punctuate: "true",
  });
  if (options.language && options.language !== "auto") {
    params.set("language", options.language);
  } else {
    params.set("detect_language", "true");
  }
  // No default key terms: bias words go on the request only when the caller
  // gives them (`--keyterms`, project setting). Unconditional defaults once
  // made "Cuthol"/"HyperFrames" appear in transcripts that never said them.
  const keytermParam = model === "nova-2" ? "keywords" : "keyterm";
  for (const term of options.keyterms ?? []) {
    if (term.trim()) {
      params.append(keytermParam, term.trim());
    }
  }

  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED("Deepgram API", `HTTP ${response.status}: ${errText.slice(0, 300)}`)
    );
  }

  const payload = (await response.json()) as {
    results?: {
      channels?: Array<{
        detected_language?: string;
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{
            word: string;
            punctuated_word?: string;
            start: number;
            end: number;
            confidence?: number;
          }>;
        }>;
      }>;
    };
  };

  const ch = payload.results?.channels?.[0];
  const alt = ch?.alternatives?.[0];
  const rawWords = (alt?.words ?? []).map((w) => ({
    word: w.word,
    punctuated_word: w.punctuated_word ?? w.word,
    source_start_ms: Math.round(w.start * 1000),
    source_end_ms: Math.round(w.end * 1000),
    confidence: w.confidence ?? 0.98,
  }));

  const docLang = ch?.detected_language ?? options.language ?? "auto";
  const { words, disfluencies } = annotateWordsAndDisfluencies(
    rawWords,
    options.durationMs,
    OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS,
    docLang
  );

  return {
    provider: "deepgram",
    model,
    engine: model,
    language: docLang,
    duration_ms: options.durationMs,
    text: alt?.transcript ?? words.map((w) => w.punctuated_word).join(" "),
    words,
    disfluencies,
  };
}

/**
 * True when an auto-detected Deepgram transcript needs the no-fillers INFO:
 * detection settled on English but the response holds no filler token, so
 * `filler_words` effectively did nothing and `--lang en` would enable them.
 */
export function isDeepgramAutoEnglishWithoutFillers(doc: TranscriptDocument): boolean {
  if (doc.provider !== "deepgram") return false;
  const lang = (doc.language ?? "").trim().toLowerCase();
  if (lang !== "en" && !lang.startsWith("en-")) return false;
  return !doc.words.some((w) => w.is_filler);
}

/**
 * Local ASR Provider Door:
 * - If `CUTHOL_LOCAL_ASR_CMD` is set (e.g. `faster-whisper` or `whisper-cli`), invokes it and parses JSON output.
 *   The JSON may carry an optional top-level `language`; without it, auto-detection asks for an explicit `--lang`.
 * - If a sidecar `<audioFilePath>.transcript.json` exists, loads it directly.
 */
export async function transcribeWithLocalProvider(options: {
  audioFilePath: string;
  language?: string;
  durationMs: number;
  keyterms?: string[];
  modelName?: string;
  engine?: string;
}): Promise<TranscriptDocument> {
  const sidecarPath = `${options.audioFilePath}.transcript.json`;
  if (fs.existsSync(sidecarPath)) {
    let raw: {
      language?: string;
      text?: string;
      words?: Array<{
        word: string;
        punctuated_word?: string;
        source_start_ms: number;
        source_end_ms: number;
        confidence?: number;
      }>;
    };
    try {
      raw = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "local sidecar transcript JSON",
          err instanceof Error ? err.message : String(err)
        )
      );
    }
    if (!raw || !Array.isArray(raw.words)) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "local sidecar transcript JSON",
          "Expected a JSON object with a 'words' array."
        )
      );
    }
    const sanitizedWords = raw.words
      .filter((w) => w && typeof w.word === "string")
      .map((w) => ({
        word: w.word,
        punctuated_word: typeof w.punctuated_word === "string" ? w.punctuated_word : w.word,
        source_start_ms: Number.isFinite(Number(w.source_start_ms)) ? Math.round(Number(w.source_start_ms)) : 0,
        source_end_ms: Number.isFinite(Number(w.source_end_ms)) ? Math.round(Number(w.source_end_ms)) : 100,
        confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : 0.99,
      }));
    const sidecarLang =
      typeof raw.language === "string" && raw.language.trim()
        ? raw.language.trim().toLowerCase()
        : (options.language ?? "auto");
    const { words, disfluencies } = annotateWordsAndDisfluencies(
      sanitizedWords,
      options.durationMs,
      OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS,
      sidecarLang
    );
    return {
      provider: "local",
      model: "local-sidecar",
      engine: "sidecar",
      language: sidecarLang,
      duration_ms: options.durationMs,
      text: raw.text ?? words.map((w) => w.punctuated_word).join(" "),
      words,
      disfluencies,
      engineRev: LOCAL_ASR_ENGINE_REVISION,
    };
  }

  const customCmd = process.env.CUTHOL_LOCAL_ASR_CMD;
  if (customCmd) {
    const quotedAudioPath = `"${options.audioFilePath.replace(/"/g, '\\"')}"`;
    const proc = spawnSync(`${customCmd} ${quotedAudioPath}`, {
      shell: true,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CUTHOL_LOCAL_ASR_AUDIO_FILE: options.audioFilePath },
    });
    if (proc.status !== 0) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED("CUTHOL_LOCAL_ASR_CMD", (proc.stderr || "failed").slice(-300))
      );
    }
    let parsed: {
      language?: string;
      words?: Array<{ word: string; punctuated_word?: string; source_start_ms: number; source_end_ms: number }>;
    };
    try {
      parsed = JSON.parse(proc.stdout);
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "CUTHOL_LOCAL_ASR_CMD JSON",
          err instanceof Error ? err.message : String(err)
        )
      );
    }
    if (!parsed || !Array.isArray(parsed.words)) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "CUTHOL_LOCAL_ASR_CMD JSON",
          "Expected JSON output containing a 'words' array."
        )
      );
    }
    const sanitizedWords = parsed.words
      .filter((w) => w && typeof w.word === "string")
      .map((w) => ({
        word: w.word,
        punctuated_word: typeof w.punctuated_word === "string" ? w.punctuated_word : w.word,
        source_start_ms: Number.isFinite(Number(w.source_start_ms)) ? Math.round(Number(w.source_start_ms)) : 0,
        source_end_ms: Number.isFinite(Number(w.source_end_ms)) ? Math.round(Number(w.source_end_ms)) : 100,
      }));
    const cmdLang =
      typeof parsed.language === "string" && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : (options.language ?? "auto");
    const { words, disfluencies } = annotateWordsAndDisfluencies(
      sanitizedWords,
      options.durationMs,
      OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS,
      cmdLang
    );
    return {
      provider: "local",
      model: "custom-cli",
      engine: "custom-cli",
      language: cmdLang,
      duration_ms: options.durationMs,
      text: words.map((w) => w.punctuated_word).join(" "),
      words,
      disfluencies,
      engineRev: LOCAL_ASR_ENGINE_REVISION,
    };
  }

  // Keyless fallback: the engine is resolved first so a Parakeet-only
  // machine never trips the faster-whisper install gate (runLocalAsrBridge
  // re-resolves from its cache and fails with the install diagnostic when
  // the wanted engine is missing).
  const wantedEngine = resolveLocalEngine({ language: options.language, forced: options.engine });
  if (wantedEngine === "whisper") {
    const localStatus = localSpeechStatus();
    if (!localStatus.installed) {
      throw new CutholError(DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED(localStatus.reason));
    }
  }
  // No default key terms (same reason as the Deepgram path above): the
  // bridge only receives caller-given terms.
  const bridge = runLocalAsrBridge({
    audioFilePath: options.audioFilePath,
    language: options.language,
    modelName: options.modelName ?? LOCAL_SPEECH_DEFAULT_MODEL,
    keyterms: options.keyterms ?? [],
    ...(options.engine !== undefined ? { engine: options.engine as "whisper" | "parakeet" } : {}),
  });
  const sanitizedBridgeWords = bridge.words
    .filter((w) => w && typeof w.word === "string")
    .map((w) => ({
      word: w.word,
      punctuated_word: typeof w.punctuated_word === "string" ? w.punctuated_word : w.word,
      source_start_ms: Number.isFinite(Number(w.source_start_ms)) ? Math.round(Number(w.source_start_ms)) : 0,
      source_end_ms: Number.isFinite(Number(w.source_end_ms)) ? Math.round(Number(w.source_end_ms)) : 100,
      confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : 0.99,
    }));
  const { words, disfluencies } = annotateWordsAndDisfluencies(
    sanitizedBridgeWords,
    options.durationMs,
    OPEN_STANDARDS.DIALOGUE_CLEANUP.DEFAULT_MIN_PAUSE_MS,
    bridge.language
  );
  return {
    provider: "local",
    model: bridge.engine === "parakeet" ? bridge.modelName : `faster-whisper-${bridge.modelName}`,
    engine: bridge.engine,
    language: bridge.language,
    duration_ms: options.durationMs,
    text: words.map((w) => w.punctuated_word).join(" "),
    words,
    disfluencies,
    engineRev: LOCAL_ASR_ENGINE_REVISION,
    local_dropped_segments: bridge.droppedSegments,
  };
}

/**
 * Converts ElevenLabs character-level alignment arrays into exact millisecond word tokens.
 */
export function characterAlignmentToWordTokens(alignment: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): RawTranscriptWord[] {
  const chars = alignment.characters ?? [];
  const starts = alignment.character_start_times_seconds ?? [];
  const ends = alignment.character_end_times_seconds ?? [];

  const rawWords: Array<{
    word: string;
    punctuated_word: string;
    source_start_ms: number;
    source_end_ms: number;
  }> = [];

  let currentChars = "";
  let wordStartSec: number | null = null;
  let wordEndSec = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const st = starts[i] ?? wordEndSec;
    const en = ends[i] ?? st;

    if (/\s/.test(ch)) {
      if (currentChars.length > 0 && wordStartSec !== null) {
        rawWords.push({
          word: normalizeTokenForMatch(currentChars) || currentChars,
          punctuated_word: currentChars,
          source_start_ms: Math.round(wordStartSec * 1000),
          source_end_ms: Math.max(Math.round(wordStartSec * 1000) + 20, Math.round(wordEndSec * 1000)),
        });
        currentChars = "";
        wordStartSec = null;
      }
    } else {
      if (wordStartSec === null) {
        wordStartSec = st;
      }
      currentChars += ch;
      wordEndSec = en;
    }
  }

  if (currentChars.length > 0 && wordStartSec !== null) {
    rawWords.push({
      word: normalizeTokenForMatch(currentChars) || currentChars,
      punctuated_word: currentChars,
      source_start_ms: Math.round(wordStartSec * 1000),
      source_end_ms: Math.max(Math.round(wordStartSec * 1000) + 20, Math.round(wordEndSec * 1000)),
    });
  }

  for (let i = 0; i < rawWords.length - 1; i++) {
    if (rawWords[i].source_end_ms > rawWords[i + 1].source_start_ms) {
      rawWords[i].source_end_ms = Math.max(
        rawWords[i].source_start_ms + 1,
        rawWords[i + 1].source_start_ms
      );
    }
    if (rawWords[i + 1].source_start_ms < rawWords[i].source_end_ms) {
      rawWords[i + 1].source_start_ms = rawWords[i].source_end_ms;
      rawWords[i + 1].source_end_ms = Math.max(
        rawWords[i + 1].source_end_ms,
        rawWords[i + 1].source_start_ms + 1
      );
    }
  }

  const totalDur = rawWords.length > 0 ? rawWords[rawWords.length - 1].source_end_ms : 0;
  return annotateWordsAndDisfluencies(rawWords, totalDur).words;
}

/**
 * Cloud TTS Provider: ElevenLabs `/v1/text-to-speech/{voice_id}/with-timestamps`.
 */
export async function synthesizeWithElevenLabs(options: {
  text: string;
  voiceId?: string;
  modelId?: string;
  speed?: number;
}): Promise<TtsSynthesisOutput> {
  const apiKey = requireApiKey("ELEVENLABS_API_KEY", "ElevenLabs TTS");
  // Default Rachel / premade multilingual voice ID
  const voiceId = options.voiceId ?? "21m00Tcm4TlvDq8ikWAM";
  const modelId = options.modelId ?? "eleven_multilingual_v2";

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: options.text,
        model_id: modelId,
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          speed: options.speed ?? 1.0,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new CutholError(
      DIAGNOSTICS.EXTERNAL_TOOL_FAILED("ElevenLabs API", `HTTP ${response.status}: ${errText.slice(0, 300)}`)
    );
  }

  const payload = (await response.json()) as {
    audio_base64: string;
    alignment?: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
    normalized_alignment?: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  const audioBuffer = Buffer.from(payload.audio_base64, "base64");
  const align = payload.alignment ?? payload.normalized_alignment;
  const words = align ? characterAlignmentToWordTokens(align) : [];
  const durationMs = words.length > 0 ? words[words.length - 1].source_end_ms + 120 : 2000;

  return {
    provider: "elevenlabs",
    voice_id: voiceId,
    model_id: modelId,
    audio_buffer: audioBuffer,
    duration_ms: durationMs,
    words,
  };
}

/**
 * Local TTS Provider Door:
 * Synthesizes deterministic speech-cadence audio and proportional character-weighted word timestamps
 * when `--provider local` is selected (or invokes `CUTHOL_LOCAL_TTS_CMD` if configured).
 */
export async function synthesizeWithLocalProvider(options: {
  text: string;
  voiceId?: string;
  speed?: number;
  tempWavPath: string;
}): Promise<TtsSynthesisOutput> {
  const tokens = options.text.trim().split(/\s+/).filter(Boolean);
  const rawSpeed =
    options.speed !== undefined && Number.isFinite(options.speed) ? options.speed : 1.0;
  const speed = Math.max(0.5, Math.min(2.0, rawSpeed));
  const msPerChar = 62 / speed;
  const interWordGapMs = Math.round(70 / speed);

  const rawWords: Array<{
    word: string;
    punctuated_word: string;
    source_start_ms: number;
    source_end_ms: number;
  }> = [];

  let cursorMs = 80;

  for (const tok of tokens) {
    const wordDurMs = Math.max(160, Math.round(tok.length * msPerChar));
    const startMs = cursorMs;
    const endMs = startMs + wordDurMs;
    rawWords.push({
      word: normalizeTokenForMatch(tok) || tok,
      punctuated_word: tok,
      source_start_ms: startMs,
      source_end_ms: endMs,
    });
    cursorMs = endMs + interWordGapMs;
  }

  let totalDurationMs = Math.max(600, cursorMs + 120);
  let builtInVoiceId: string | null = null;
  let builtInModelId: string | null = null;

  const customTtsCmd = process.env.CUTHOL_LOCAL_TTS_CMD;
  if (customTtsCmd) {
    const quotedOut = `"${options.tempWavPath.replace(/"/g, '\\"')}"`;
    const proc = spawnSync(`${customTtsCmd} ${quotedOut}`, {
      shell: true,
      windowsHide: true,
      input: options.text,
      encoding: "utf8",
      env: {
        ...process.env,
        CUTHOL_LOCAL_TTS_TEXT: options.text,
        CUTHOL_LOCAL_TTS_VOICE: options.voiceId ?? "local_default",
        CUTHOL_LOCAL_TTS_OUT: options.tempWavPath,
      },
    });
    if (proc.status !== 0 || !fs.existsSync(options.tempWavPath)) {
      throw new CutholError(
        DIAGNOSTICS.EXTERNAL_TOOL_FAILED(
          "CUTHOL_LOCAL_TTS_CMD",
          (proc.stderr || "local tts command failed").slice(-300)
        )
      );
    }

    // Measure actual duration of external TTS audio and scale synthetic word timestamps proportionally
    let actualDurationMs = 0;
    const extBuf = fs.readFileSync(options.tempWavPath);
    if (
      extBuf.length >= 44 &&
      extBuf.toString("ascii", 0, 4) === "RIFF" &&
      extBuf.toString("ascii", 8, 12) === "WAVE"
    ) {
      const byteRate = extBuf.readUInt32LE(28);
      if (byteRate > 0) {
        actualDurationMs = Math.max(100, Math.round(((extBuf.length - 44) / byteRate) * 1000));
      }
    }
    if (actualDurationMs > 0 && totalDurationMs > 0 && rawWords.length > 0) {
      const scale = actualDurationMs / totalDurationMs;
      for (let i = 0; i < rawWords.length; i++) {
        const scaledStart = Math.max(0, Math.min(actualDurationMs - 1, Math.round(rawWords[i].source_start_ms * scale)));
        const scaledEnd = Math.max(scaledStart + 1, Math.min(actualDurationMs, Math.round(rawWords[i].source_end_ms * scale)));
        rawWords[i].source_start_ms = scaledStart;
        rawWords[i].source_end_ms = scaledEnd;
      }
      totalDurationMs = actualDurationMs;
    }
  } else if (localSpeechStatus().installed) {
    // Keyless fallback: real speech from the private Piper installation.
    const configuredVoice =
      options.voiceId && options.voiceId !== "local_default" ? options.voiceId : undefined;
    const tts = runLocalTtsBridge({
      text: options.text,
      voiceId: configuredVoice,
      outWavPath: options.tempWavPath,
    });
    builtInVoiceId = `piper-${tts.voiceId}`;
    builtInModelId = "piper-tts";
    const actualMs = Math.max(100, tts.durationMs);
    if (rawWords.length > 0) {
      const scale = actualMs / totalDurationMs;
      for (let i = 0; i < rawWords.length; i++) {
        const scaledStart = Math.max(0, Math.min(actualMs - 1, Math.round(rawWords[i].source_start_ms * scale)));
        const scaledEnd = Math.max(scaledStart + 1, Math.min(actualMs, Math.round(rawWords[i].source_end_ms * scale)));
        rawWords[i].source_start_ms = scaledStart;
        rawWords[i].source_end_ms = scaledEnd;
      }
    }
    totalDurationMs = actualMs;
  } else {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED(localSpeechStatus().reason)
    );
  }

  const audioBuffer = fs.readFileSync(options.tempWavPath);
  const { words } = annotateWordsAndDisfluencies(rawWords, totalDurationMs);

  const isBuiltIn = builtInVoiceId !== null;
  return {
    provider: "local",
    voice_id: builtInVoiceId ?? options.voiceId ?? "local_default",
    model_id: builtInModelId ?? "local-custom-cmd",
    audio_buffer: audioBuffer,
    duration_ms: totalDurationMs,
    words,
    is_placeholder_audio: false,
    placeholder_warning: isBuiltIn
      ? "Word timings are proportional estimates: Piper emits no word timestamps."
      : undefined,
  };
}
