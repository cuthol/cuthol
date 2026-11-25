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
export const LOCAL_ASR_ENGINE_REVISION = "v6";

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
  /**
   * Audio length in ms. Keyless callers through `transcribeWithLocalProvider`
   * hold it but that module is out of scope here, so the Parakeet runner
   * probes it with ffprobe when this is missing.
   */
  durationMs?: number;
}): { language: string; modelName: string; words: LocalBridgeWord[]; droppedSegments: LocalBridgeDroppedSegment[]; engine: LocalAsrEngineId; gapRetry: ParakeetGapRetry; gapRetryNote: string | null } {
  const engine = resolveLocalEngine({ language: options.language, forced: options.engine });
  if (engine === "whisper") {
    lastParakeetGapRetry = null;
  }
  if (engine === "parakeet") {
    return runParakeetBridge({
      audioFilePath: options.audioFilePath,
      language: options.language,
      durationMs: options.durationMs,
    });
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
  return { language, modelName, words, droppedSegments, engine: "whisper" as LocalAsrEngineId, gapRetry: { gaps: 0, words: 0 }, gapRetryNote: null };
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

/**
 * Floor of the Parakeet transcription time limit. The pinned HyperFrames
 * 0.9.15 CLI documents `--timeout` as "applies to the whisper engine only;
 * Parakeet has a separate fixed timeout" — probing confirms it: a 6 min
 * clip transcribes fine with `--timeout 5000`. So the real guard for
 * Parakeet is the `spawnSync` timeout below; the CLI flag is still passed
 * (scaled the same way) in case a later HyperFrames honors it.
 */
export const PARAKEET_TIMEOUT_FLOOR_MS = 280_000;

/** Extra `spawnSync` time over the CLI limit so the CLI reports first. */
export const PARAKEET_SPAWN_SLACK_MS = 10_000;

/**
 * Test-only override of the Parakeet CLI time limit in ms: when
 * `CUTHOL_PARAKEET_TIMEOUT_MS` holds a finite number it is used as the CLI
 * limit directly (the spawn limit adds `PARAKEET_SPAWN_SLACK_MS`). Production
 * code never sets it; it exists so tests can force a fast timeout against a
 * fake HyperFrames bin without waiting minutes.
 */
function parakeetTimeoutOverrideMs(): number | null {
  const raw = (process.env.CUTHOL_PARAKEET_TIMEOUT_MS ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Time limits for one Parakeet run, scaled from the audio length: at least
 * `max(280 s, 1.5 x audio)`, capped at `4 x audio` so a hung process still
 * ends. Unknown durations keep the old fixed 280 s / 290 s pair.
 */
export function parakeetTimeouts(audioDurationMs?: number): {
  cliTimeoutMs: number;
  spawnTimeoutMs: number;
} {
  const override = parakeetTimeoutOverrideMs();
  if (override !== null) {
    return { cliTimeoutMs: override, spawnTimeoutMs: override + PARAKEET_SPAWN_SLACK_MS };
  }
  const audio = typeof audioDurationMs === "number" ? audioDurationMs : NaN;
  if (!Number.isFinite(audio) || audio <= 0) {
    return {
      cliTimeoutMs: PARAKEET_TIMEOUT_FLOOR_MS,
      spawnTimeoutMs: PARAKEET_TIMEOUT_FLOOR_MS + PARAKEET_SPAWN_SLACK_MS,
    };
  }
  const scaled = Math.max(PARAKEET_TIMEOUT_FLOOR_MS, Math.ceil(audio * 1.5));
  const cliTimeoutMs = Math.min(scaled, Math.max(PARAKEET_TIMEOUT_FLOOR_MS, Math.ceil(audio * 4)));
  return { cliTimeoutMs, spawnTimeoutMs: cliTimeoutMs + PARAKEET_SPAWN_SLACK_MS };
}

/** Audio length in ms via ffprobe, or null when it cannot be read. */
export function probeAudioDurationMs(audioFilePath: string): number | null {
  try {
    if (!audioFilePath || !fs.existsSync(audioFilePath)) return null;
    const proc = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "csv=p=0",
        audioFilePath,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 }
    );
    if (proc.status !== 0) return null;
    const seconds = Number.parseFloat(String(proc.stdout ?? "").trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

/**
 * True when a failed Parakeet run ended by timeout: `spawnSync` reports
 * `ETIMEDOUT` (and `SIGTERM`) when its own `timeout` fires, and a future
 * HyperFrames that honors `--timeout` for Parakeet would report its failure
 * as `{"ok":false,...}` or a timeout line — the pinned 0.9.15 prints no
 * such payload for Parakeet (its `--timeout` only guards Whisper), so the
 * spawn side is the reliable signal.
 */
function isParakeetTimeoutFailure(proc: {
  error?: unknown;
  signal?: string | null;
  stdout?: unknown;
}): boolean {
  const err = proc.error as { code?: unknown } | null | undefined;
  if (err && typeof err === "object" && (err as { code?: unknown }).code === "ETIMEDOUT") return true;
  if (proc.signal === "SIGTERM") return true;
  const out = typeof proc.stdout === "string" ? proc.stdout : "";
  if (/timed?\s*out|timeout|exceeded\s+\d+\s*s/i.test(out)) return true;
  return false;
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

/** Words recovered by the single Parakeet dropped-gap retry (ke4). */
export interface ParakeetGapRetry {
  gaps: number;
  words: number;
}

/**
 * Latest Parakeet dropped-gap retry outcome, set by every `runParakeetBridge`
 * call (null for non-Parakeet runs). `transcribe.ts` and `verify_cleanup.ts`
 * take it to report `parakeet_gap_retry`; unit tests read it off the
 * `runLocalAsrBridge` return value instead.
 */
let lastParakeetGapRetry: { retry: ParakeetGapRetry; note: string | null } | null = null;

/** Take (and clear) the latest Parakeet gap-retry outcome. */
export function takeParakeetGapRetry(): { retry: ParakeetGapRetry; note: string | null } | null {
  const taken = lastParakeetGapRetry;
  lastParakeetGapRetry = null;
  return taken;
}

/** Dropped-gap retry tuning: gap length, speech share, slice margins, separator. */
export const PARAKEET_GAP_MIN_MS = 1500;
export const PARAKEET_GAP_SPEECH_SHARE = 0.4;
export const PARAKEET_GAP_MARGIN_MS = 500;
export const PARAKEET_GAP_SEPARATOR_MS = 1000;

function runParakeetOnce(options: {
  bin: string;
  audioFilePath: string;
  lang: string;
  cliTimeoutMs: number;
  spawnTimeoutMs: number;
  audioMin: number | null;
}): LocalBridgeWord[] {
  const args = ["transcribe", options.audioFilePath, "--engine", "parakeet", "--json", "--timeout", String(options.cliTimeoutMs)];
  if (options.lang && options.lang !== "auto") args.push("--language", options.lang);
  const proc = spawnSync(process.execPath, [options.bin, ...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: options.spawnTimeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", HYPERFRAMES_SKILLS_AUTO: "0" },
  });
  if (proc.status !== 0 || proc.error) {
    // HyperFrames reports failures as `{"ok":false,"error":{...}}` on
    // stdout; prefer that message over the bare stderr tail.
    const cliMessage = parseHyperFramesError(proc.stdout ?? "");
    if (isParakeetTimeoutFailure(proc) || (cliMessage !== null && /timed?\s*out|timeout|exceeded\s+\d+\s*s/i.test(cliMessage))) {
      const afterS = Math.round(options.cliTimeoutMs / 1000);
      const onAudio = options.audioMin !== null ? ` on ${options.audioMin.toFixed(1)} min of audio` : "";
      throw new CutholError(
        DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED(
          "parakeet transcribe",
          `Parakeet transcription timed out after ${afterS} s${onAudio}.`,
          "The machine may be busy — retry when it is idle, or use '--engine whisper', which transcribes in chunks and has no single long timeout. The install itself looks fine. (engine parakeet via HyperFrames)"
        )
      );
    }
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
  return parseParakeetTranscriptFile(parsed.transcriptPath);
}

/**
 * Mono 16 kHz PCM of an audio file via ffmpeg on stdout, or null when the
 * decode fails. Small reader, no new dependency.
 */
function decodePcm16kMono(audioFilePath: string): { samples: Int16Array; sampleRate: number } | null {
  try {
    const proc = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-i", audioFilePath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "-"],
      { encoding: "buffer", windowsHide: true, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 }
    );
    if (proc.status !== 0 || !proc.stdout || (proc.stdout as Buffer).length < 2) return null;
    const buf = Buffer.from(proc.stdout as Buffer);
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    return { samples: samples.slice(), sampleRate: 16000 };
  } catch {
    return null;
  }
}

/** dBFS of one frame (RMS), floored at -96 like the waveform analysis. */
function frameDbfs(samples: Int16Array, start: number, end: number): number {
  const n = Math.max(1, end - start);
  let sumSq = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i] / 32768.0;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  return rms > 1e-6 ? 20 * Math.log10(rms) : -96.0;
}

/**
 * Speech threshold for dropped-gap detection: the 20th-percentile 20 ms
 * frame level plus 15 dB, mirroring how the cleanup derives its silence
 * floor from frame levels.
 */
function parakeetGapSpeechThresholdDb(samples: Int16Array, sampleRate: number): number {
  const frameLen = Math.max(1, Math.round(sampleRate * 0.02));
  const count = Math.max(1, Math.ceil(samples.length / frameLen));
  const levels: number[] = new Array(count);
  for (let f = 0; f < count; f++) {
    levels[f] = frameDbfs(samples, f * frameLen, Math.min(samples.length, (f + 1) * frameLen));
  }
  const sorted = levels.slice().sort((a, b) => a - b);
  const p20 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.2))];
  return p20 + 15;
}

/** Share of 20 ms frames in [startMs, endMs) above the speech threshold. */
function gapSpeechShare(samples: Int16Array, sampleRate: number, startMs: number, endMs: number, thresholdDb: number): number {
  const frameLen = Math.max(1, Math.round(sampleRate * 0.02));
  const startSample = Math.max(0, Math.floor((startMs * sampleRate) / 1000));
  const endSample = Math.min(samples.length, Math.ceil((endMs * sampleRate) / 1000));
  if (endSample <= startSample) return 0;
  let total = 0;
  let above = 0;
  for (let s = startSample; s < endSample; s += frameLen) {
    total++;
    if (frameDbfs(samples, s, Math.min(endSample, s + frameLen)) > thresholdDb) above++;
  }
  return total === 0 ? 0 : above / total;
}

interface ParakeetDroppedGap {
  startMs: number;
  endMs: number;
}

/**
 * Spans of at least PARAKEET_GAP_MIN_MS between consecutive words (and
 * before the first / after the last word) whose audio is speech-like: at
 * least PARAKEET_GAP_SPEECH_SHARE of 20 ms frames above threshold.
 */
export function findParakeetDroppedGaps(
  words: LocalBridgeWord[],
  samples: Int16Array,
  sampleRate: number,
  audioDurationMs: number
): ParakeetDroppedGap[] {
  const sorted = words.slice().sort((a, b) => a.source_start_ms - b.source_start_ms || a.source_end_ms - b.source_end_ms);
  const spans: Array<{ startMs: number; endMs: number }> = [];
  let cursor = 0;
  for (const w of sorted) {
    if (w.source_start_ms - cursor >= PARAKEET_GAP_MIN_MS) {
      spans.push({ startMs: cursor, endMs: w.source_start_ms });
    }
    cursor = Math.max(cursor, w.source_end_ms);
  }
  if (audioDurationMs - cursor >= PARAKEET_GAP_MIN_MS) {
    spans.push({ startMs: cursor, endMs: audioDurationMs });
  }
  if (spans.length === 0) return [];
  const thresholdDb = parakeetGapSpeechThresholdDb(samples, sampleRate);
  return spans.filter(
    (s) => gapSpeechShare(samples, sampleRate, s.startMs, s.endMs, thresholdDb) >= PARAKEET_GAP_SPEECH_SHARE
  );
}

/** Write mono 16-bit PCM as a WAV file. */
function writeWavFile(filePath: string, samples: Int16Array, sampleRate: number): void {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);
  fs.writeFileSync(filePath, Buffer.concat([header, body]));
}

export interface ParakeetGapSlice {
  combinedStartMs: number;
  combinedEndMs: number;
  origStartMs: number;
  gapStartMs: number;
  gapEndMs: number;
}

/**
 * One wav of the gap slices (each with PARAKEET_GAP_MARGIN_MS margin on both
 * sides) separated by PARAKEET_GAP_SEPARATOR_MS of digital silence, plus the
 * slice map to translate retry word times back to source times.
 */
function buildGapRetryWav(
  samples: Int16Array,
  sampleRate: number,
  audioDurationMs: number,
  gaps: ParakeetDroppedGap[],
  outPath: string
): ParakeetGapSlice[] {
  const perMs = sampleRate / 1000;
  const sepSamples = Math.round(PARAKEET_GAP_SEPARATOR_MS * perMs);
  const parts: Int16Array[] = [];
  const slices: ParakeetGapSlice[] = [];
  let combinedMs = 0;
  gaps.forEach((gap, index) => {
    if (index > 0) {
      parts.push(new Int16Array(sepSamples));
      combinedMs += PARAKEET_GAP_SEPARATOR_MS;
    }
    const sliceStartMs = Math.max(0, gap.startMs - PARAKEET_GAP_MARGIN_MS);
    const sliceEndMs = Math.min(audioDurationMs, gap.endMs + PARAKEET_GAP_MARGIN_MS);
    const from = Math.max(0, Math.floor(sliceStartMs * perMs));
    const to = Math.min(samples.length, Math.ceil(sliceEndMs * perMs));
    const chunk = samples.slice(from, to);
    parts.push(chunk);
    slices.push({
      combinedStartMs: combinedMs,
      combinedEndMs: combinedMs + (chunk.length / perMs),
      origStartMs: (from / perMs),
      gapStartMs: gap.startMs,
      gapEndMs: gap.endMs,
    });
    combinedMs += chunk.length / perMs;
  });
  const total = parts.reduce((n, p) => n + p.length, 0);
  const combined = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    combined.set(p, at);
    at += p.length;
  }
  writeWavFile(outPath, combined, sampleRate);
  return slices;
}

/** Map retry words back to source times, keeping margin-duplicate drops. */
export function mapGapRetryWords(
  retryWords: LocalBridgeWord[],
  slices: ParakeetGapSlice[]
): LocalBridgeWord[] {
  const kept: LocalBridgeWord[] = [];
  for (const w of retryWords) {
    const slice = slices.find((s) => w.source_start_ms >= s.combinedStartMs && w.source_start_ms < s.combinedEndMs);
    if (!slice) continue;
    const shift = slice.origStartMs - slice.combinedStartMs;
    const startMs = Math.round(w.source_start_ms + shift);
    const endMs = Math.round(w.source_end_ms + shift);
    if (startMs < slice.gapStartMs || startMs >= slice.gapEndMs) continue;
    kept.push({ ...w, source_start_ms: startMs, source_end_ms: Math.max(startMs + 1, endMs) });
  }
  return kept;
}

function runParakeetBridge(options: {
  audioFilePath: string;
  language?: string;
  durationMs?: number;
}): { language: string; modelName: string; words: LocalBridgeWord[]; droppedSegments: LocalBridgeDroppedSegment[]; engine: LocalAsrEngineId; gapRetry: ParakeetGapRetry; gapRetryNote: string | null } {
  // The HyperFrames CLI has no keyterm/hotword channel: caller keyterms are
  // documented as Whisper/Deepgram-only and ignored here, never failed.
  const bin = hyperframesBin();
  // Scale the limit with the audio so a ~25 min talk no longer dies at the
  // old fixed 280 s: prefer the caller duration, else probe via ffprobe.
  const probedMs =
    typeof options.durationMs === "number" && options.durationMs > 0
      ? options.durationMs
      : probeAudioDurationMs(options.audioFilePath);
  const audioMs = probedMs && probedMs > 0 ? probedMs : undefined;
  const { cliTimeoutMs, spawnTimeoutMs } = parakeetTimeouts(audioMs);
  const audioMin = audioMs !== undefined ? audioMs / 60000 : null;
  const lang = (options.language ?? "auto").trim().toLowerCase();
  const firstWords = runParakeetOnce({ bin, audioFilePath: options.audioFilePath, lang, cliTimeoutMs, spawnTimeoutMs, audioMin });
  const emptyRetry: ParakeetGapRetry = { gaps: 0, words: 0 };
  const finish = (
    words: LocalBridgeWord[],
    gapRetry: ParakeetGapRetry,
    gapRetryNote: string | null
  ): { language: string; modelName: string; words: LocalBridgeWord[]; droppedSegments: LocalBridgeDroppedSegment[]; engine: LocalAsrEngineId; gapRetry: ParakeetGapRetry; gapRetryNote: string | null } => {
    lastParakeetGapRetry = { retry: gapRetry, note: gapRetryNote };
    return {
      // Parakeet detects the language itself but the CLI does not report it:
      // explicit requests keep their tag, `auto` stays `auto` (the transcribe
      // layer asks for `--lang` exactly like the other undetectable paths).
      language: lang && lang !== "auto" ? lang : "auto",
      modelName: PARAKEET_MODEL_ID,
      words,
      droppedSegments: [],
      engine: "parakeet",
      gapRetry,
      gapRetryNote,
    };
  };
  // Dropped-gap retry: one extra CLI call over the speech-like holes, at most
  // one round. A failed retry keeps the first result with a note.
  const durationMs = audioMs ?? (firstWords.length > 0 ? firstWords[firstWords.length - 1].source_end_ms : 0);
  if (durationMs <= 0) {
    throw new CutholError(
      DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("parakeet transcribe output", "Transcript holds no words.")
    );
  }
  const decoded = decodePcm16kMono(options.audioFilePath);
  if (!decoded) {
    return finish(firstWords, emptyRetry, null);
  }
  const gaps = findParakeetDroppedGaps(firstWords, decoded.samples, decoded.sampleRate, durationMs);
  if (gaps.length === 0) {
    return finish(firstWords, emptyRetry, null);
  }
  const gapWavPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-parakeet-gaps-")),
    "gaps.wav"
  );
  try {
    const slices = buildGapRetryWav(decoded.samples, decoded.sampleRate, durationMs, gaps, gapWavPath);
    const combinedMs = Math.ceil(fs.statSync(gapWavPath).size / 32);
    const retryLimits = parakeetTimeouts(combinedMs);
    let retryWords: LocalBridgeWord[];
    try {
      retryWords = runParakeetOnce({ bin, audioFilePath: gapWavPath, lang, cliTimeoutMs: retryLimits.cliTimeoutMs, spawnTimeoutMs: retryLimits.spawnTimeoutMs, audioMin: null });
    } catch (err) {
      const note =
        `parakeet gap retry failed (${gaps.length} speech-like ${gaps.length === 1 ? "gap" : "gaps"} left as-is); ` +
        (err instanceof Error ? err.message.split("\n")[0] : String(err)).slice(0, 200);
      return finish(firstWords, { gaps: gaps.length, words: 0 }, note);
    }
    const recovered = mapGapRetryWords(retryWords, slices);
    const merged = firstWords.concat(recovered).sort((a, b) => a.source_start_ms - b.source_start_ms || a.source_end_ms - b.source_end_ms);
    if (merged.length === 0) {
      throw new CutholError(
        DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("parakeet transcribe output", "Transcript holds no words.")
      );
    }
    return finish(merged, { gaps: gaps.length, words: recovered.length }, null);
  } finally {
    try {
      fs.rmSync(path.dirname(gapWavPath), { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}
