// `cuthol setup --ffmpeg`: downloads a pinned ffmpeg 8.1 build on request.
//
// The install lives under the Cuthol data dir (`CUTHOL_DATA_DIR` or
// `~/.cuthol`), never in the npm package. At process start
// (`preferCutholFfmpeg` in `src/core/env.ts`) the installed `bin` folder is
// prepended to `PATH` only when the `ffmpeg` on PATH is missing or below
// major 8, so every child process (including HyperFrames) inherits it
// without touching the ~109 bare `ffmpeg`/`ffprobe` call sites.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";
import { parseFfmpegMajorVersion } from "./ffmpeg_version.js";
import { CUTHOL_PROGRESS_PREFIX } from "./progress.js";

export const FFMPEG_PINNED_VERSION = "8.1";
export const FFMPEG_PINNED_MAJOR = 8;

interface PinnedFfmpegBuild {
  version: string;
  url: string;
  bytes: number;
  sha256: string;
  archiveKind: "zip" | "tar.xz";
}

const PINNED: Record<string, PinnedFfmpegBuild> = {
  "win32-x64": {
    version: FFMPEG_PINNED_VERSION,
    url: "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip",
    bytes: 109282242,
    sha256: "6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541",
    archiveKind: "zip",
  },
  "linux-x64": {
    version: FFMPEG_PINNED_VERSION,
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-20-12-40/ffmpeg-n8.1.3-39-g660b5aa7db-linux64-gpl-8.1.tar.xz",
    bytes: 152925712,
    sha256: "1fb59ca0ad9cf1de48e4c7196b245c5e45e9dc1f494ff2e763cfb6a3ab37a347",
    archiveKind: "tar.xz",
  },
};

/** Test-only override of the pinned table (a JSON object keyed like PINNED). */
function pinnedOverride(): Record<string, PinnedFfmpegBuild> | null {
  const raw = (process.env.CUTHOL_FFMPEG_PIN_OVERRIDE ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, PinnedFfmpegBuild>;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    throw new CutholError(DIAGNOSTICS.FFMPEG_SETUP_FAILED("override", "CUTHOL_FFMPEG_PIN_OVERRIDE is not valid JSON."));
  }
  return null;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Per-user Cuthol data dir (same rule as `localSpeechRoot` in speech/local_engine.ts). */
export function cutholDataDir(): string {
  const override = (process.env.CUTHOL_DATA_DIR ?? "").trim();
  if (override) return override;
  return path.join(os.homedir(), ".cuthol");
}

export function ffmpegInstallDir(version: string = FFMPEG_PINNED_VERSION): string {
  return path.join(cutholDataDir(), "tools", `ffmpeg-${version}`);
}

export function ffmpegInstallBinDir(version: string = FFMPEG_PINNED_VERSION): string {
  return path.join(ffmpegInstallDir(version), "bin");
}

export interface FfmpegSetupPlan {
  supported: boolean;
  platform: string;
  url: string | null;
  bytes: number | null;
  sha256: string | null;
  targetDir: string;
  binDir: string;
  alreadyInstalled: boolean;
  installHint: string | null;
}

function macHint(): string {
  return "No static ffmpeg build is pinned for this platform; install with `brew install ffmpeg` and check `ffmpeg -version` shows 8.x.";
}

export function planFfmpegSetup(): FfmpegSetupPlan {
  const key = platformKey();
  const table = pinnedOverride() ?? PINNED;
  const targetDir = ffmpegInstallDir();
  const binDir = ffmpegInstallBinDir();
  const alreadyInstalled = isFfmpegInstalled(binDir);
  const pinned = table[key];
  if (!pinned) {
    return {
      supported: false,
      platform: key,
      url: null,
      bytes: null,
      sha256: null,
      targetDir,
      binDir,
      alreadyInstalled,
      installHint: process.platform === "darwin" ? macHint() : `No pinned ffmpeg build for platform '${key}'.`,
    };
  }
  return {
    supported: true,
    platform: key,
    url: pinned.url,
    bytes: pinned.bytes,
    sha256: pinned.sha256,
    targetDir,
    binDir,
    alreadyInstalled,
    installHint: null,
  };
}

/** Human-readable dry run: exactly what `--apply` would install. */
export function describeFfmpegSetup(plan: FfmpegSetupPlan): string[] {
  if (!plan.supported) {
    return [plan.installHint ?? `No pinned ffmpeg build for platform '${plan.platform}'.`];
  }
  if (plan.alreadyInstalled) {
    return [`ffmpeg ${FFMPEG_PINNED_VERSION} already installed in '${plan.targetDir}'; nothing to do.`];
  }
  return [
    `ffmpeg ${FFMPEG_PINNED_VERSION} would install into '${plan.targetDir}':`,
    `- download ${plan.url} (${formatBytes(plan.bytes ?? 0)}; sha256 verified before extracting)`,
    `- extract with the OS tar into '${plan.binDir}' (ffmpeg/ffprobe)`,
    `re-run with '--apply' to install.`,
  ];
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

function fail(step: string, detail: string): never {
  throw new CutholError(DIAGNOSTICS.FFMPEG_SETUP_FAILED(step, detail));
}

function installedBinary(binDir: string, tool: "ffmpeg" | "ffprobe"): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(binDir, `${tool}.exe`), path.join(binDir, tool), path.join(binDir, `${tool}.cmd`)]
      : [path.join(binDir, tool), path.join(binDir, `${tool}.exe`)];
  for (const cand of candidates) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      // missing: try next
    }
  }
  return candidates[0];
}

function isFfmpegInstalled(binDir: string): boolean {
  try {
    const ffmpeg = installedBinary(binDir, "ffmpeg");
    const ffprobe = installedBinary(binDir, "ffprobe");
    if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return false;
    const info = verifyInstalledBinary(ffmpeg);
    return info !== null && info >= FFMPEG_PINNED_MAJOR;
  } catch {
    return false;
  }
}

function verifyInstalledBinary(ffmpegPath: string): number | null {
  // Never uses `shell: true` (Node DEP0190): a real install is `ffmpeg.exe`
  // and needs no shell. A `.cmd`/`.bat` stub (tests) runs through the
  // command interpreter directly with fixed arguments (no user input).
  const isBatch = /\.cmd$|\.bat$/i.test(ffmpegPath);
  const cmd = isBatch ? (process.env.ComSpec ?? "cmd.exe") : ffmpegPath;
  const args = isBatch ? ["/d", "/s", "/c", "call", ffmpegPath, "-version"] : ["-version"];
  let proc: ReturnType<typeof spawnSync>;
  try {
    proc = spawnSync(cmd, args, { windowsHide: true, encoding: "utf8", shell: false });
  } catch {
    return null;
  }
  if (proc.status !== 0) return null;
  const firstLine = String(proc.stdout || "").split(/\r?\n/)[0] ?? "";
  const parsed = parseFfmpegMajorVersion(firstLine);
  return parsed ? parsed.major : null;
}

async function downloadToFile(url: string, destTmp: string, expectedBytes: number | null, onProgress?: (done: number, total: number | null) => void): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    fail("download", `${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res!.ok) fail("download", `${url}: HTTP ${res!.status}.`);
  const totalHeader = res!.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : expectedBytes;
  const chunks: Buffer[] = [];
  let done = 0;
  const reader = res!.body?.getReader();
  if (!reader) fail("download", `${url}: empty response body.`);
  for (;;) {
    const { done: finished, value } = await reader!.read();
    if (finished) break;
    chunks.push(Buffer.from(value));
    done += value.byteLength;
    onProgress?.(done, Number.isFinite(total) ? total : null);
  }
  const buf = Buffer.concat(chunks);
  if (expectedBytes !== null && buf.length !== expectedBytes) {
    throw new CutholError(DIAGNOSTICS.FFMPEG_SETUP_TRUNCATED(buf.length, expectedBytes));
  }
  fs.writeFileSync(destTmp, buf);
  return buf;
}

function sha256OfFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Extracts with the OS's own `tar` (Windows 10+ tar reads zip; Linux `tar -xJf` reads tar.xz). */
function extractArchive(archive: string, destDir: string, kind: "zip" | "tar.xz"): void {
  fs.mkdirSync(destDir, { recursive: true });
  // Relative paths with cwd: bsdtar on Windows reads `C:\...`/`C:/...` as a remote `host:file`.
  const cwd = path.dirname(archive);
  const args =
    kind === "zip"
      ? ["-xf", path.basename(archive), "-C", path.basename(destDir)]
      : ["-xJf", path.basename(archive), "-C", path.basename(destDir)];
  // Windows: the OS tar (bsdtar, reads zip) by absolute path; a Git-shipped
  // GNU tar earlier on PATH cannot read zip.
  const tarBin =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const proc = spawnSync(tarBin, args, { windowsHide: true, encoding: "utf8", cwd });
  if (proc.status !== 0) {
    fail("extract", `tar ${args.join(" ")} failed: ${(proc.stderr || proc.stdout || "").slice(-500)}`);
  }
}

/** Finds the extracted folder holding ffmpeg/ffprobe (flat layout or a `bin` subfolder, one level deep). */
function findExtractedBin(extractDir: string): string {
  const names = ["ffmpeg", "ffmpeg.exe", "ffmpeg.cmd"];
  const direct = names.some((n) => fs.existsSync(path.join(extractDir, n)));
  if (direct) return extractDir;
  const binDirect = names.some((n) => fs.existsSync(path.join(extractDir, "bin", n)));
  if (binDirect) return path.join(extractDir, "bin");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch {
    fail("extract", `extracted archive is empty: '${extractDir}'.`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(extractDir, entry.name);
    if (names.some((n) => fs.existsSync(path.join(sub, n)))) return sub;
    if (names.some((n) => fs.existsSync(path.join(sub, "bin", n)))) return path.join(sub, "bin");
  }
  fail("extract", `no ffmpeg binary found after extracting to '${extractDir}'.`);
}

export interface FfmpegSetupResult {
  plan: FfmpegSetupPlan;
  noop: boolean;
  seconds: number;
}

/**
 * Throttled `cuthol:progress` emitter for the ffmpeg download (same channel
 * and `cuthol:progress <label> <done>/<total> eta …` format as the
 * render/verify progress lines in `src/core/progress.ts`): at most one line
 * per 5 % of progress or per 2 s, plus a final line from the caller.
 */
export function makeDownloadProgress(
  label = "download",
  write: (line: string) => void = (line) => process.stderr.write(line),
): (done: number, total: number | null) => void {
  const startedAt = Date.now();
  let lastEmitAt = 0;
  let lastPct = -1;
  return (done: number, total: number | null): void => {
    const now = Date.now();
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    const finished = total !== null && done >= total;
    if (!finished && now - lastEmitAt < 2000 && pct - lastPct < 5) return;
    lastEmitAt = now;
    lastPct = pct;
    let eta = "";
    if (total !== null && total > 0 && done > 0 && !finished) {
      const sec = Math.max(0, Math.round(((now - startedAt) / done) * (total - done) / 1000));
      eta = sec < 90 ? ` eta ${sec}s` : ` eta ${Math.round(sec / 60)}m`;
    } else if (finished) {
      eta = " eta 0s";
    }
    write(`${CUTHOL_PROGRESS_PREFIX}${label} ${done}/${total ?? "?"}${eta}\n`);
  };
}

export async function applyFfmpegSetup(startedAt = Date.now()): Promise<FfmpegSetupResult> {
  const plan = planFfmpegSetup();
  if (!plan.supported) {
    throw new CutholError(DIAGNOSTICS.FFMPEG_SETUP_UNSUPPORTED(plan.platform, plan.installHint ?? ""));
  }
  if (plan.alreadyInstalled) return { plan, noop: true, seconds: 0 };

  const table = pinnedOverride() ?? PINNED;
  const pinned = table[platformKey()];
  if (!pinned) fail("plan", `No pinned ffmpeg build for platform '${platformKey()}'.`);

  fs.mkdirSync(plan.targetDir, { recursive: true });
  const suffix = pinned!.archiveKind === "zip" ? ".zip" : ".tar.xz";
  const tmpArchive = path.join(plan.targetDir, `.download-${process.pid}${suffix}`);
  const tmpExtract = path.join(plan.targetDir, `.extract-${process.pid}`);
  const cleanup = (): void => {
    fs.rmSync(tmpArchive, { force: true });
    fs.rmSync(tmpExtract, { recursive: true, force: true });
  };
  try {
    // The throttled emitter above already prints the final
    // `download <total>/<total> eta 0s` line when the last chunk lands.
    await downloadToFile(pinned!.url, tmpArchive, pinned!.bytes, makeDownloadProgress());
    const actualSize = fs.statSync(tmpArchive).size;
    if (actualSize !== pinned!.bytes) {
      throw new CutholError(DIAGNOSTICS.FFMPEG_SETUP_TRUNCATED(actualSize, pinned!.bytes));
    }
    const actualHash = sha256OfFile(tmpArchive);
    if (actualHash !== pinned!.sha256) {
      throw new CutholError(DIAGNOSTICS.FFMPEG_SETUP_HASH_MISMATCH(actualHash, pinned!.sha256));
    }
    extractArchive(tmpArchive, tmpExtract, pinned!.archiveKind);
    const srcBin = findExtractedBin(tmpExtract);
    fs.mkdirSync(plan.binDir, { recursive: true });
    for (const tool of ["ffmpeg", "ffprobe"] as const) {
      const names = [tool, `${tool}.exe`, `${tool}.cmd`];
      let src: string | null = null;
      for (const n of names) {
        if (fs.existsSync(path.join(srcBin, n))) {
          src = path.join(srcBin, n);
          break;
        }
      }
      if (!src) fail("extract", `no ${tool} binary found in the extracted archive.`);
      const dest = path.join(plan.binDir, path.basename(src));
      fs.copyFileSync(src!, dest);
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(dest, 0o755);
        } catch {
          // best effort on non-POSIX filesystems
        }
      }
    }
    const major = verifyInstalledBinary(installedBinary(plan.binDir, "ffmpeg"));
    if (major === null || major < FFMPEG_PINNED_MAJOR) {
      fs.rmSync(plan.binDir, { recursive: true, force: true });
      throw new CutholError(
        DIAGNOSTICS.FFMPEG_SETUP_VERIFY_FAILED(`major ${major ?? "unknown"}; nothing was installed.`)
      );
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  cleanup();
  return { plan, noop: false, seconds: Math.round((Date.now() - startedAt) / 1000) };
}

/** Installed ffmpeg `bin` folder when it exists, else null. Never probes PATH. */
export function installedFfmpegBinDir(): string | null {
  const binDir = ffmpegInstallBinDir();
  try {
    if (fs.existsSync(installedBinary(binDir, "ffmpeg"))) return binDir;
  } catch {
    return null;
  }
  return null;
}
