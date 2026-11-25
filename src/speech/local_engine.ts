// Built-in keyless local speech installation (faster-whisper ASR + Piper TTS).
//
// `src/speech/local_engine.ts`: finds the private per-user installation that
// `cuthol setup --local-speech --apply` creates, and runs the bundled bridge
// script (`scripts/local_speech.py`) against it. Explicit `CUTHOL_LOCAL_*_CMD`
// wiring always wins (handled in `providers.ts`); this module is only the
// keyless fallback. Nothing here touches the cloud providers.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";

export const LOCAL_SPEECH_PINNED_PACKAGES = {
  fasterWhisper: "1.2.1",
  piperTts: "1.8.0",
} as const;

export const LOCAL_SPEECH_DEFAULT_MODEL = "small";
export const LOCAL_SPEECH_DEFAULT_VOICE = "tr_TR-dfki-medium";

/**
 * Revision of the chunked keyless local ASR engine (`scripts/local_speech.py`:
 * silence-valley chunking with a per-chunk filler prompt). Bumped whenever the
 * engine's output contract changes; the transcript cache keys the local
 * provider with it so old whole-file transcripts are re-transcribed.
 * Must match `LOCAL_ASR_ENGINE_REVISION` in `scripts/local_speech.py`.
 */
export const LOCAL_ASR_ENGINE_REVISION = "v5";

/** Parallel chunk workers for keyless local ASR (each loads its own model copy). */
export function localAsrJobs(): number {
  const raw = (process.env.CUTHOL_LOCAL_ASR_JOBS ?? "").trim();
  const n = raw ? Number.parseInt(raw, 10) : 4;
  if (!Number.isFinite(n)) return 4;
  return Math.min(8, Math.max(1, Math.floor(n)));
}

/** Threads per keyless local ASR process (0 = faster-whisper default). */
export function localAsrCpuThreads(): number {
  const raw = (process.env.CUTHOL_LOCAL_ASR_THREADS ?? "").trim();
  const n = raw ? Number.parseInt(raw, 10) : 3;
  if (!Number.isFinite(n)) return 3;
  return Math.min(16, Math.max(0, Math.floor(n)));
}

// Measured on this machine (bytes on disk, 2026-11-14): small model dir,
// large-v3-turbo model dir, tr_TR-dfki-medium voice (onnx + json).
export const LOCAL_SPEECH_MODELS = {
  small: { repo: "Systran/faster-whisper-small", downloadBytes: 486213873 },
  "large-v3-turbo": {
    repo: "Systran/faster-whisper-large-v3-turbo",
    downloadBytes: 1621667708,
  },
} as const;

export type LocalSpeechModelName = keyof typeof LOCAL_SPEECH_MODELS;

export const LOCAL_SPEECH_VOICES = {
  "tr_TR-dfki-medium": {
    // rhasspy/piper-voices layout: <lang>/<lang_REGION>/<family>/<quality>/
    hfPath: "tr/tr_TR/dfki/medium/tr_TR-dfki-medium",
    downloadBytes: 63206681,
  },
} as const;

export type LocalSpeechVoiceId = keyof typeof LOCAL_SPEECH_VOICES;

export const LOCAL_SPEECH_CONFIG_FILE = "local-speech.json";

export interface LocalSpeechConfig {
  model: string;
  voice: string;
  fasterWhisper: string;
  piperTts: string;
  installedAt: string;
}

export interface LocalSpeechInstallation {
  root: string;
  pythonExe: string;
  bridgeScript: string;
  modelName: string;
  modelDir: string;
  voiceId: string;
  voiceFile: string;
  config: LocalSpeechConfig;
}

export interface LocalSpeechStatus {
  installed: boolean;
  reason: string;
  installation?: LocalSpeechInstallation;
}

/** Private per-user data folder for the keyless installation. Never the project. */
export function localSpeechRoot(): string {
  const override = (process.env.CUTHOL_DATA_DIR ?? "").trim();
  if (override) return path.join(override, "local-speech");
  return path.join(os.homedir(), ".cuthol", "local-speech");
}

function packageBridgeScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "local_speech.py");
}

export function bridgeScriptPath(): string {
  const override = (process.env.CUTHOL_LOCAL_BRIDGE ?? "").trim();
  if (override) return override;
  return packageBridgeScript();
}

function venvPythonExe(root: string): string {
  const override = (process.env.CUTHOL_LOCAL_SPEECH_PYTHON ?? "").trim();
  if (override) return override;
  return process.platform === "win32"
    ? path.join(root, "venv", "Scripts", "python.exe")
    : path.join(root, "venv", "bin", "python");
}

function readConfig(root: string): LocalSpeechConfig | null {
  try {
    const raw = fs.readFileSync(path.join(root, LOCAL_SPEECH_CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalSpeechConfig>;
    if (typeof parsed.model !== "string" || typeof parsed.voice !== "string") return null;
    return {
      model: parsed.model,
      voice: parsed.voice,
      fasterWhisper: typeof parsed.fasterWhisper === "string" ? parsed.fasterWhisper : "",
      piperTts: typeof parsed.piperTts === "string" ? parsed.piperTts : "",
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
    };
  } catch {
    return null;
  }
}

export function localSpeechStatus(): LocalSpeechStatus {
  const root = localSpeechRoot();
  const config = readConfig(root);
  if (!config) {
    return { installed: false, reason: `no ${LOCAL_SPEECH_CONFIG_FILE} in '${root}'` };
  }
  const pythonExe = venvPythonExe(root);
  if (!fs.existsSync(pythonExe)) {
    return { installed: false, reason: `venv python missing at '${pythonExe}'` };
  }
  const modelName =
    ((process.env.CUTHOL_LOCAL_SPEECH_MODEL ?? "").trim() || config.model).trim() ||
    LOCAL_SPEECH_DEFAULT_MODEL;
  const modelDir = path.join(root, "models", modelName);
  if (!fs.existsSync(path.join(modelDir, "model.bin"))) {
    return { installed: false, reason: `Whisper model missing in '${modelDir}'` };
  }
  const voiceId =
    ((process.env.CUTHOL_LOCAL_SPEECH_VOICE ?? "").trim() || config.voice).trim() ||
    LOCAL_SPEECH_DEFAULT_VOICE;
  const voiceFile = path.join(root, "voices", `${voiceId}.onnx`);
  if (!fs.existsSync(voiceFile)) {
    return { installed: false, reason: `Piper voice missing at '${voiceFile}'` };
  }
  const bridge = bridgeScriptPath();
  if (!fs.existsSync(bridge)) {
    return { installed: false, reason: `bridge script missing at '${bridge}'` };
  }
  return {
    installed: true,
    reason: "installed",
    installation: {
      root,
      pythonExe,
      bridgeScript: bridge,
      modelName,
      modelDir,
      voiceId,
      voiceFile,
      config,
    },
  };
}

export type LocalSpeechInstallState = "installed" | "not-installed" | "broken";

/** installed / never set up (no config) / half-present (config without files). */
export function localSpeechInstallState(): { state: LocalSpeechInstallState; reason: string } {
  const root = localSpeechRoot();
  if (!readConfig(root)) {
    return { state: "not-installed", reason: `no ${LOCAL_SPEECH_CONFIG_FILE} in '${root}'` };
  }
  const status = localSpeechStatus();
  if (status.installed) return { state: "installed", reason: status.reason };
  return { state: "broken", reason: status.reason };
}

export function requireLocalSpeech(): LocalSpeechInstallation {
  const status = localSpeechStatus();
  if (!status.installed || !status.installation) {
    throw new CutholError(DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED(status.reason));
  }
  return status.installation;
}

export interface LocalBridgeWord {
  word: string;
  punctuated_word?: string;
  source_start_ms: number;
  source_end_ms: number;
  confidence?: number;
}

/**
 * Pick the message shown for a failed bridge run. The failure cause is
 * usually an early stderr line naming the error (e.g. a line containing
 * `error:`), while the tail is often a long argv dump — so the message
 * keeps the first cause line(s) plus the tail, and the suggestion fits
 * the failure instead of always pointing at `setup --apply`.
 */
export function selectBridgeFailureDetail(raw: string): { detail: string; suggestion: string } {
  const text = (raw || "failed").replace(/\r\n/g, "\n");
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const causeLines = lines.filter((l) => /error:/i.test(l)).slice(0, 3);
  const tail = lines.slice(-3).join("\n");
  const detail =
    causeLines.length > 0 && !tail.split("\n").every((l) => causeLines.includes(l))
      ? `${causeLines.join("\n")}\n…\n${tail}`
      : text.slice(-500);
  let suggestion = `Re-run 'cuthol setup --local-speech --apply' to repair the installation, then retry.`;
  if (/model|snapshot|huggingface|download/i.test(text)) {
    suggestion = `Check the model path and network access, then re-run 'cuthol setup --local-speech --apply' to re-download the model.`;
  } else if (/voice|onnx|piper/i.test(text)) {
    suggestion = `Check the Piper voice file and the venv Python ('<root>/venv/Scripts/python.exe -m piper --help'), then re-run 'cuthol setup --local-speech --apply' if the install is broken.`;
  } else if (/ffmpeg|decode|codec|invalid data/i.test(text)) {
    suggestion = `Verify the input audio file is a readable media file (ffprobe it), then retry; the install itself looks fine.`;
  } else if (/memory|cuda|out of/i.test(text)) {
    suggestion = `Free memory (or lower '--jobs' / use a smaller model) and retry; the install itself looks fine.`;
  }
  return { detail, suggestion };
}

function runBridge(cmdArgs: string[], op: string): string {
  const installation = requireLocalSpeech();
  const proc = spawnSync(
    installation.pythonExe,
    [installation.bridgeScript, ...cmdArgs],
    {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1" },
    }
  );
  if (proc.status !== 0) {
    const { detail, suggestion } = selectBridgeFailureDetail(
      proc.stderr || (proc.error instanceof Error ? proc.error.message : String(proc.error ?? "")) || "failed"
    );
    throw new CutholError(DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(op, detail, suggestion));
  }
  return proc.stdout ?? "";
}

export interface LocalBridgeDroppedSegment {
  start_ms: number;
  end_ms: number;
  reason: string;
}

export function runLocalAsrBridge(options: {
  audioFilePath: string;
  language?: string;
  modelName?: string;
  keyterms?: string[];
  jobs?: number;
  cpuThreads?: number;
  engine?: LocalAsrEngineId;
}): { language: string; modelName: string; words: LocalBridgeWord[]; droppedSegments: LocalBridgeDroppedSegment[]; engine: LocalAsrEngineId } {
  const engine = resolveLocalEngine({ language: options.language, forced: options.engine });
  if (engine === "parakeet") {
    return runParakeetBridge({ audioFilePath: options.audioFilePath, language: options.language });
  }
  const installation = requireLocalSpeech();
  const modelName = (options.modelName ?? installation.modelName).trim() || installation.modelName;
  const modelDir =
    modelName === installation.modelName
      ? installation.modelDir
      : path.join(installation.root, "models", modelName);
  const keyterms = (options.keyterms ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
  const jobs = options.jobs ?? localAsrJobs();
  const cpuThreads = options.cpuThreads ?? localAsrCpuThreads();
  const out = runBridge(
    [
      "asr",
      options.audioFilePath,
      "--lang",
      (options.language ?? "auto").trim() || "auto",
      "--model",
      modelDir,
      ...(keyterms.length > 0 ? ["--keyterms", keyterms.join(",")] : []),
      "--jobs",
      String(jobs),
      "--cpu-threads",
      String(cpuThreads),
    ],
    "local ASR"
  );
  let parsed: { language?: unknown; words?: unknown; dropped_segments?: unknown };
  try {
    parsed = JSON.parse(out) as { language?: unknown; words?: unknown; dropped_segments?: unknown };
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
        "local ASR output",
        err instanceof Error ? err.message : String(err)
      )
    );
  }
  if (!parsed || !Array.isArray(parsed.words)) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
        "local ASR output",
        "Expected JSON output containing a 'words' array."
      )
    );
  }
  const words = (parsed.words as LocalBridgeWord[]).filter(
    (w) => w && typeof w.word === "string"
  );
  const language =
    typeof parsed.language === "string" && parsed.language.trim()
      ? parsed.language.trim().toLowerCase()
      : (options.language ?? "auto").trim().toLowerCase() || "auto";
  const droppedSegments = Array.isArray(parsed.dropped_segments)
    ? (parsed.dropped_segments as LocalBridgeDroppedSegment[]).filter(
        (d) =>
          d &&
          Number.isFinite(Number((d as LocalBridgeDroppedSegment).start_ms)) &&
          Number.isFinite(Number((d as LocalBridgeDroppedSegment).end_ms))
      )
    : [];
  return { language, modelName, words, droppedSegments, engine: "whisper" as LocalAsrEngineId };
}

export function runLocalTtsBridge(options: {
  text: string;
  voiceId?: string;
  outWavPath: string;
}): { durationMs: number; voiceId: string } {
  const installation = requireLocalSpeech();
  const voiceId = (options.voiceId ?? installation.voiceId).trim() || installation.voiceId;
  const voiceFile =
    voiceId === installation.voiceId
      ? installation.voiceFile
      : path.join(installation.root, "voices", `${voiceId}.onnx`);
  if (!fs.existsSync(voiceFile)) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("local TTS", `Piper voice missing at '${voiceFile}'.`)
    );
  }
  const textFile = `${options.outWavPath}.txt`;
  fs.writeFileSync(textFile, options.text, "utf8");
  try {
    const out = runBridge(
      ["tts", "--text-file", textFile, "--voice", voiceFile, "--out", options.outWavPath],
      "local TTS"
    );
    let parsed: { duration_ms?: unknown };
    try {
      parsed = JSON.parse(out) as { duration_ms?: unknown };
    } catch (err) {
      throw new CutholError(
        DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
          "local TTS output",
          err instanceof Error ? err.message : String(err)
        )
      );
    }
    const durationMs =
      typeof parsed.duration_ms === "number" && Number.isFinite(parsed.duration_ms)
        ? Math.round(parsed.duration_ms)
        : 0;
    if (!fs.existsSync(options.outWavPath)) {
      throw new CutholError(
        DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("local TTS", "Piper wrote no output file.")
      );
    }
    return { durationMs, voiceId };
  } finally {
    try {
      fs.unlinkSync(textFile);
    } catch {
      // best-effort cleanup of the sidecar text file
    }
  }
}

// ---------------------------------------------------------------------------
// Local ASR engine choice: faster-whisper (all languages) vs Parakeet (fast,
// European languages) through the pinned HyperFrames CLI (its public
// `transcribe --engine parakeet` / `models install parakeet` commands).
// ---------------------------------------------------------------------------

export type LocalAsrEngineId = "whisper" | "parakeet";

export const PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v3";

/** ~640 MB download for `hyperframes models install parakeet` (int8). */
export const PARAKEET_DOWNLOAD_BYTES = 640_000_000;

/**
 * Languages the Parakeet engine covers, as short codes.
 *
 * Taken from the pinned HyperFrames 0.9.15 CLI itself: forcing an uncovered
 * language reports `Parakeet does not transcribe --language <x>; it covers
 * <list>. Use --engine whisper.` Anything not listed routes to Whisper,
 * which covers all languages including Turkish.
 */
export const PARAKEET_LANGUAGES: readonly string[] = [
  "en",
  "es",
  "fr",
  "de",
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "et",
  "fi",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sv",
  "ru",
  "uk",
];

function shortLangCode(language: string | undefined): string {
  return (language ?? "auto").trim().toLowerCase().split(/[-_]/)[0] ?? "auto";
}

/** True when Parakeet covers the requested language (`auto` is unknown). */
export function isParakeetLanguage(language: string | undefined): boolean {
  const code = shortLangCode(language);
  return code !== "auto" && (PARAKEET_LANGUAGES as readonly string[]).includes(code);
}

/** Path of the pinned HyperFrames CLI (`CUTHOL_HYPERFRAMES_BIN` wins). */
export function hyperframesBin(): string {
  const override = (process.env.CUTHOL_HYPERFRAMES_BIN ?? "").trim();
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "node_modules", "hyperframes", "bin", "hyperframes.mjs");
}

let parakeetProbeCache: { installed: boolean; reason: string } | null = null;

/** Test hook: forget the cached Parakeet probe result. */
export function resetParakeetProbeCache(): void {
  parakeetProbeCache = null;
}

/**
 * Model files the pinned HyperFrames 0.9.15 CLI downloads for
 * `hyperframes models install parakeet` (name and exact byte size, as its
 * own `sherpaParakeetInstalled` check requires). Kept in sync with
 * `node_modules/hyperframes`.
 */
export const PARAKEET_MODEL_FILES: ReadonlyArray<{ name: string; bytes: number }> = [
  { name: "encoder.int8.onnx", bytes: 652184281 },
  { name: "decoder.int8.onnx", bytes: 11845275 },
  { name: "joiner.int8.onnx", bytes: 6355277 },
  { name: "tokens.txt", bytes: 93939 },
];

/**
 * HyperFrames cache folder: `HYPERFRAMES_CACHE_DIR` when set, else
 * `<home>/.cache/hyperframes` — the same rule its own `hyperframesCacheDir`
 * uses. Read-only lookups must follow this rule instead of spawning the
 * HyperFrames CLI: even `models list` writes its first-run config into the
 * home folder.
 */
export function hyperframesCacheDir(): string {
  const named = (process.env.HYPERFRAMES_CACHE_DIR ?? "").trim();
  if (named) return path.resolve(named);
  return path.join(os.homedir(), ".cache", "hyperframes");
}

/** Folder holding the downloaded Parakeet model inside the HyperFrames cache. */
export function parakeetModelDir(): string {
  return path.join(hyperframesCacheDir(), "parakeet", "parakeet-tdt-0.6b-v3-int8");
}

/**
 * True when `hyperframes models install parakeet` has run, detected by
 * reading the model files in the HyperFrames cache folder (never by
 * spawning the HyperFrames CLI, which writes first-run state into the
 * home folder). Probed once per process.
 */
export function parakeetInstallState(): { installed: boolean; reason: string } {
  if (parakeetProbeCache) return parakeetProbeCache;
  const dir = parakeetModelDir();
  const missing = PARAKEET_MODEL_FILES.filter((f) => {
    try {
      return fs.statSync(path.join(dir, f.name)).size !== f.bytes;
    } catch {
      return true;
    }
  }).map((f) => f.name);
  const probe =
    missing.length === 0
      ? { installed: true, reason: `HyperFrames Parakeet (${PARAKEET_MODEL_ID}) installed` }
      : {
          installed: false,
          reason: `Parakeet not installed (missing ${missing.join(", ")} in '${dir}'; run 'cuthol setup --local-speech --engine parakeet --apply')`,
        };
  parakeetProbeCache = probe;
  return probe;
}

/** True when the faster-whisper keyless installation is usable. */
export function whisperInstallState(): { installed: boolean; reason: string } {
  const status = localSpeechStatus();
  return status.installed
    ? { installed: true, reason: status.reason }
    : { installed: false, reason: status.reason };
}

const LOCAL_ENGINE_VALID_LIST = "whisper, parakeet";

function uncoveredLanguageError(lang: string): CutholError {
  return new CutholError(
    DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED(
      `language '${lang}' is not covered by the installed Parakeet engine ` +
        `(European languages only: ${PARAKEET_LANGUAGES.join(", ")}); run ` +
        `'cuthol setup --local-speech --engine whisper --apply' to install Whisper, ` +
        `which covers all languages including Turkish`
    )
  );
}

function failNoEngine(installed: LocalAsrEngineId[], want: LocalAsrEngineId): never {
  const names = installed.length > 0 ? installed.join(" + ") : "none";
  const need =
    want === "whisper"
      ? "run 'cuthol setup --local-speech --engine whisper --apply' to install it"
      : "run 'cuthol setup --local-speech --engine parakeet --apply' to install it";
  throw new CutholError(
    DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED(
      `local ${want} engine is not installed (installed: ${names}); ${need}`
    )
  );
}

/**
 * Pick the keyless local ASR engine for one request.
 *
 * - `forced` (`--engine`) must name an installed engine; otherwise the
 *   failure names the wanted engine, what is installed, and the setup
 *   command (no silent fallback).
 * - Without `forced`: Parakeet when it is installed and covers the
 *   requested language, else Whisper when installed. `auto` (unknown
 *   language) uses Whisper when both are installed, since only Whisper
 *   covers every language; with Parakeet alone, `auto` uses Parakeet and
 *   the transcript keeps language `auto` (pass `--lang` for a tag).
 * - Turkish (or any uncovered language) with only Parakeet fails with a
 *   diagnostic naming the language, the installed engine and the Whisper
 *   setup command.
 */
export function resolveLocalEngine(options: {
  language?: string;
  forced?: string;
}): LocalAsrEngineId {
  const forcedRaw = (options.forced ?? "").trim().toLowerCase();
  const whisper = whisperInstallState();
  const parakeet = parakeetInstallState();
  const installed: LocalAsrEngineId[] = [
    ...(whisper.installed ? (["whisper"] as const) : []),
    ...(parakeet.installed ? (["parakeet"] as const) : []),
  ];
  if (forcedRaw) {
    if (forcedRaw !== "whisper" && forcedRaw !== "parakeet") {
      throw new CutholError(DIAGNOSTICS.PROVIDER_UNKNOWN("asr", options.forced ?? "", LOCAL_ENGINE_VALID_LIST));
    }
    const want = forcedRaw as LocalAsrEngineId;
    if (want === "whisper" && !whisper.installed) failNoEngine(installed, "whisper");
    if (want === "parakeet" && !parakeet.installed) failNoEngine(installed, "parakeet");
    if (want === "parakeet" && parakeet.installed) {
      // A forced engine that cannot do the requested language fails here
      // with the specific diagnostic instead of the CLI's runtime error.
      const code = shortLangCode(options.language);
      if (code !== "auto" && !isParakeetLanguage(options.language)) {
        throw uncoveredLanguageError(code);
      }
    }
    return want;
  }
  const lang = shortLangCode(options.language);
  const covered = isParakeetLanguage(options.language);
  if (covered && parakeet.installed) return "parakeet";
  if (whisper.installed) return "whisper";
  if (parakeet.installed) {
    if (lang !== "auto") {
      throw uncoveredLanguageError(lang);
    }
    return "parakeet";
  }
  throw new CutholError(DIAGNOSTICS.LOCAL_SPEECH_NOT_INSTALLED(whisper.reason));
}

/**
 * The `message` of a HyperFrames `{"ok":false,"error":{...}}` payload, if
 * the CLI reported its failure that way; null otherwise.
 */
function parseHyperFramesError(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { ok?: unknown; error?: { message?: unknown } };
    if (parsed && parsed.ok === false && typeof parsed.error?.message === "string") {
      const message = parsed.error.message.trim();
      return message ? message : null;
    }
  } catch {
    // not a JSON error payload; the caller falls back to stderr
  }
  return null;
}

function parseParakeetTranscriptFile(transcriptPath: string): LocalBridgeWord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
        "parakeet transcript",
        err instanceof Error ? err.message : String(err)
      )
    );
  }
  const entries = Array.isArray(raw) ? raw : (raw as { words?: unknown })?.words;
  if (!Array.isArray(entries)) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
        "parakeet transcript",
        "Expected a JSON word array with {text,start,end}."
      )
    );
  }
  const words: LocalBridgeWord[] = [];
  for (const e of entries as Array<{ text?: unknown; start?: unknown; end?: unknown }>) {
    if (!e || typeof e.text !== "string" || !e.text.trim()) continue;
    const startMs = Math.round(Number(e.start) * 1000);
    const endMs = Math.round(Number(e.end) * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    words.push({
      word: e.text,
      punctuated_word: e.text,
      source_start_ms: Math.max(0, startMs),
      source_end_ms: Math.max(startMs + 1, endMs),
      confidence: 0.99,
    });
  }
  return words;
}

function runParakeetBridge(options: {
  audioFilePath: string;
  language?: string;
}): { language: string; modelName: string; words: LocalBridgeWord[]; droppedSegments: LocalBridgeDroppedSegment[]; engine: LocalAsrEngineId } {
  // The HyperFrames CLI has no keyterm/hotword channel: caller keyterms are
  // documented as Whisper/Deepgram-only and ignored here, never failed.
  const bin = hyperframesBin();
  const args = ["transcribe", options.audioFilePath, "--engine", "parakeet", "--json", "--timeout", "280000"];
  const lang = (options.language ?? "auto").trim().toLowerCase();
  if (lang && lang !== "auto") args.push("--language", lang);
  const proc = spawnSync(process.execPath, [bin, ...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 290_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", HYPERFRAMES_SKILLS_AUTO: "0" },
  });
  if (proc.status !== 0 || proc.error) {
    // HyperFrames reports failures as `{"ok":false,"error":{...}}` on
    // stdout; prefer that message over the bare stderr tail.
    const cliMessage = parseHyperFramesError(proc.stdout ?? "");
    const { detail, suggestion } = selectBridgeFailureDetail(
      cliMessage ??
        (proc.stderr || (proc.error instanceof Error ? proc.error.message : String(proc.error ?? "")) || "failed")
    );
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("parakeet transcribe", detail, `${suggestion} (engine parakeet via HyperFrames)`)
    );
  }
  let parsed: { transcriptPath?: unknown };
  try {
    parsed = JSON.parse(proc.stdout ?? "") as { transcriptPath?: unknown };
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
        "parakeet transcribe output",
        err instanceof Error ? err.message : String(err)
      )
    );
  }
  if (!parsed || typeof parsed.transcriptPath !== "string" || !parsed.transcriptPath) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
        "parakeet transcribe output",
        "Expected JSON output containing 'transcriptPath'."
      )
    );
  }
  const words = parseParakeetTranscriptFile(parsed.transcriptPath);
  if (words.length === 0) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("parakeet transcribe output", "Transcript holds no words.")
    );
  }
  return {
    // Parakeet detects the language itself but the CLI does not report it:
    // explicit requests keep their tag, `auto` stays `auto` (the transcribe
    // layer asks for `--lang` exactly like the other undetectable paths).
    language: lang && lang !== "auto" ? lang : "auto",
    modelName: PARAKEET_MODEL_ID,
    words,
    droppedSegments: [],
    engine: "parakeet",
  };
}
