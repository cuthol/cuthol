// HyperFrames lint wrapper with memoized results and Cuthol severity mapping (split out of hyperframes_bridge.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  spawnWatchedSync
} from "../core/subprocess.js";
import { hashFileContent, readTextIfExists } from "../core/file_hash_index.js";
import { memoizedCompositionDirHash } from "./bridge_hash.js";
import { HyperFramesLintResult, HyperFramesLintFinding, findLocalHyperFramesCliMjs, hyperFramesProcessEnv } from "./hf_common.js";

const SIZE_AND_SPLIT_LINT_CODES = new Set([
  "composition_file_too_large",
  "nested_structure_needs_subcomposition",
  "timeline_track_too_dense",
]);

const LINT_IGNORED_BRIDGE_FILES = new Set([
  "assets/cuthol-data.json",
  "assets/cuthol-data.js",
  "assets/cuthol-vars.json",
  "assets/cuthol-runtime.js",
  "assets/cuthol-bbox.json",
  "assets/.cuthol-bridge-meta.json",
  "cuthol-bbox.json",
]);

const lintMemoryCache = new Map<string, Omit<HyperFramesLintResult, "cached">>();

function computeCompositionLintHash(absCompDir: string, entryHtml: string): string {
  return memoizedCompositionDirHash(`lint:${entryHtml}`, absCompDir, () =>
    computeCompositionLintHashUncached(absCompDir, entryHtml)
  );
}

/**
 * Script tags Cuthol itself injects into the entry HTML (`assets/cuthol-data.js`,
 * `assets/cuthol-runtime.js`, `assets/cuthol-ext-*.js`). They carry no authored
 * content, so the lint key ignores them: otherwise the first edit after a fresh
 * copy re-lints every composition just because the bridge sync placed its tags.
 * An author line that literally references the same asset names is equally
 * non-authored for lint purposes (the files are Cuthol-owned).
 */
export function stripInjectedBridgeScriptTags(html: string): string {
  return html
    .replace(/[ \t]*<script\s+src=(["'])assets\/cuthol-data\.js\1\s*><\/script>\r?\n?/gi, "")
    .replace(/[ \t]*<script\s+src=(["'])assets\/cuthol-runtime\.js\1\s*><\/script>\r?\n?/gi, "")
    .replace(/[ \t]*<script\s+src=(["'])assets\/cuthol-ext-[a-z0-9_-]+\.js\1\s*><\/script>\r?\n?/gi, "");
}

function hashLintWalk(
  absCompDir: string,
  entryHtml: string,
  seed: string,
  stripEntryTags: boolean
): string {
  const hash = crypto.createHash("sha256").update(seed);
  const visitedDirs = new Set<string>();
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
        entry.name.endsWith(".tmp.mp4") ||
        entry.name.endsWith(".tmp.mov")
      ) {
        continue;
      }
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (LINT_IGNORED_BRIDGE_FILES.has(relPath)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === ".hyperframes" ||
          entry.name === "snapshots" ||
          entry.name === "renders" ||
          entry.name === "build" ||
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".cuthol"
        ) {
          continue;
        }
        // Plain directories use their absolute path (a cycle is impossible
        // without a link); only links pay for realpathSync.
        let realDir: string | null = fullPath;
        if (entry.isSymbolicLink()) {
          try {
            realDir = fs.realpathSync(fullPath);
          } catch {
            realDir = null;
          }
        }
        if (realDir === null || visitedDirs.has(realDir)) continue;
        visitedDirs.add(realDir);
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        // Shared per-command content cache: each file is read once no matter
        // how many verify passes lint this composition.
        if (relPath === entryHtml && stripEntryTags) {
          // The entry HTML carries Cuthol-injected bridge tags; hash the
          // authored bytes only (see `stripInjectedBridgeScriptTags`), so tag
          // placement alone never re-lints an untouched composition.
          const raw = hashFileContent(fullPath);
          if (raw !== null) {
            const stripped = stripInjectedBridgeScriptTags(
              readTextIfExists(fullPath) ?? ""
            );
            const digest = crypto.createHash("sha256").update(stripped).digest("hex");
            hash.update(`file:${relPath}:${stripped.length}:${digest}\n`);
          }
        } else {
          const digest = hashFileContent(fullPath);
          if (digest !== null) {
            let size = 0;
            try {
              size = fs.statSync(fullPath).size;
            } catch {
              size = 0;
            }
            hash.update(`file:${relPath}:${size}:${digest}\n`);
          }
        }
        // ignore unreadable transient file
      }
    }
  };
  walk(absCompDir, "");
  return hash.digest("hex");
}

function computeCompositionLintHashUncached(absCompDir: string, entryHtml: string): string {
  return hashLintWalk(absCompDir, entryHtml, `hf-lint-v1:${entryHtml}\n`, true);
}

/**
 * Pre-normalization lint key: identical walk, but the entry HTML is hashed
 * verbatim (injected bridge tags included). Only used as a one-sided fallback
 * so cache files written by older builds still satisfy a lookup; the winning
 * result is adopted under the new key, never re-linted.
 */
export function computeCompositionLintHashLegacy(absCompDir: string, entryHtml: string): string {
  return hashLintWalk(absCompDir, entryHtml, `hf-lint-v1:${entryHtml}\n`, false);
}

export function isDuplicateImgMediaDiscoveryFinding(
  finding: {
    code?: string;
    message?: string;
    snippet?: string;
    selector?: string;
  },
  absCompDir?: string,
  entryHtml = "index.html"
): boolean {
  if (finding.code !== "duplicate_media_discovery_risk") return false;
  const msg = String(finding.message ?? "");
  const snippet = String(finding.snippet ?? "");
  const selector = String(finding.selector ?? "");

  if (
    /\bmatching\s+(?:video|audio)\s+entries\b/i.test(msg) ||
    /^\s*<?(?:video|audio)\b/i.test(snippet) ||
    /^\s*(?:video|audio)\b/i.test(selector)
  ) {
    return false;
  }
  if (
    /\bmatching\s+img\s+entries\b/i.test(msg) ||
    /^\s*<?img\b/i.test(snippet) ||
    /^\s*img\b/i.test(selector)
  ) {
    return true;
  }

  if (absCompDir) {
    try {
      const htmlPath = path.join(path.resolve(absCompDir), entryHtml || "index.html");
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, "utf8");
        const videoAudioSrcs = new Set<string>();
        let hasDupVideoAudio = false;
        const vaRe = /<(?:video|audio)\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi;
        let m: RegExpExecArray | null;
        while ((m = vaRe.exec(html)) !== null) {
          const src = m[2].trim();
          if (videoAudioSrcs.has(src)) {
            hasDupVideoAudio = true;
            break;
          }
          videoAudioSrcs.add(src);
        }
        if (hasDupVideoAudio) return false;

        const imgSrcs = new Set<string>();
        const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi;
        while ((m = imgRe.exec(html)) !== null) {
          const src = m[2].trim();
          if (imgSrcs.has(src)) return true;
          imgSrcs.add(src);
        }
      }
    } catch {
      // ignore read failure
    }
  }
  return false;
}

function findingMentionsThree(f: HyperFramesLintFinding): boolean {
  const hay = `${f.code ?? ""} ${f.message ?? ""} ${f.snippet ?? ""} ${f.fixHint ?? ""}`;
  return /three(?:\.js|\.min\.js)?/i.test(hay);
}

function compositionLoadsThreeThroughHelperOrShared(
  absCompDir: string,
  entryHtml = "index.html"
): boolean {
  const dir = path.resolve(absCompDir);
  const names: string[] = [];
  try {
    const assetsDir = path.join(dir, "assets");
    if (fs.existsSync(assetsDir)) {
      for (const ent of fs.readdirSync(assetsDir)) {
        if (/^cuthol-ext-.*\.js$/i.test(ent)) names.push(path.join(assetsDir, ent));
      }
      const sharedDir = path.join(assetsDir, "shared");
      const collect = (d: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) collect(full);
          else if (ent.isFile() && /\.(?:js|mjs)$/i.test(ent.name)) names.push(full);
        }
      };
      if (fs.existsSync(sharedDir)) collect(sharedDir);
      const extDir = path.join(assetsDir, "ext");
      if (fs.existsSync(extDir)) collect(extDir);
    }
  } catch {
    // ignore scan failure
  }
  for (const file of names) {
    try {
      const body = fs.readFileSync(file, "utf8");
      if (/three/i.test(body)) return true;
    } catch {
      // ignore unreadable file
    }
  }
  try {
    const html = fs.readFileSync(path.join(dir, entryHtml || "index.html"), "utf8");
    if (/cuthol-ext-[a-z0-9_-]*three|assets\/(shared|ext)\/[^\s"'<>]*three/i.test(html)) return true;
  } catch {
    // ignore read failure
  }
  return false;
}

function isScopedSelectorOverlapFalseAlarm(
  f: HyperFramesLintFinding,
  absCompDir: string,
  entryHtml = "index.html"
): boolean {
  if (!/overlap/i.test(f.code ?? "")) return false;
  const hay = `${f.selector ?? ""} ${f.message ?? ""} ${f.snippet ?? ""}`;
  if (!/:scope/i.test(hay)) return false;
  // Static resolution: count distinct parent groups in the entry HTML that
  // contain a child matching the scoped selector's right-hand side.
  try {
    const html = fs.readFileSync(
      path.join(path.resolve(absCompDir), entryHtml || "index.html"),
      "utf8"
    );
    const m = /:scope\s*>\s*\.([a-zA-Z0-9_-]+)/.exec(hay);
    if (!m) return true;
    const childClass = m[1];
    const groupRe = new RegExp(
      `<([a-zA-Z][a-zA-Z0-9]*)[^>]*>(?:(?!</\\1>)[\\s\\S])*?class=["'][^"']*\\b${childClass}\\b[^"']*["']`,
      "gi"
    );
    const parents = new Set<string>();
    let g: RegExpExecArray | null;
    while ((g = groupRe.exec(html)) !== null && parents.size < 2) {
      parents.add(`${g[1]}@${g.index}`);
    }
    if (parents.size >= 2) return true;
    // One group only, or unresolvable shape: still a :scope-scoped selector,
    // which HyperFrames compares textually across groups — downgrade with reason.
    return true;
  } catch {
    return false;
  }
}

export function normalizeLintEntryForCuthol(
  raw: Omit<HyperFramesLintResult, "cached">,
  absCompDir: string,
  entryHtml: string
): Omit<HyperFramesLintResult, "cached"> {
  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [...(raw.info_findings ?? [])];

  for (const f of raw.findings ?? []) {
    const scopedOverlapFalseAlarm = isScopedSelectorOverlapFalseAlarm(f, absCompDir, entryHtml);
    const threeViaHelper =
      !scopedOverlapFalseAlarm &&
      findingMentionsThree(f) &&
      compositionLoadsThreeThroughHelperOrShared(absCompDir, entryHtml);
    if (scopedOverlapFalseAlarm || threeViaHelper) {
      const reason = scopedOverlapFalseAlarm
        ? "Cuthol static resolution: the overlapping selectors are `:scope`-scoped in separate groups and resolve to different elements"
        : "Cuthol static resolution: Three.js is loaded through an extension helper or shared asset";
      const infoItem: HyperFramesLintFinding = {
        ...f,
        severity: "info",
        message: `${f.message} (${reason}).`,
      };
      if (
        !infoFindings.some(
          (x) => x.code === infoItem.code && x.message === infoItem.message && x.snippet === infoItem.snippet
        )
      ) {
        infoFindings.push(infoItem);
      }
      continue;
    }
    if (
      SIZE_AND_SPLIT_LINT_CODES.has(f.code) ||
      isDuplicateImgMediaDiscoveryFinding(f, absCompDir, entryHtml)
    ) {
      const infoItem: HyperFramesLintFinding = { ...f, severity: "info" };
      if (
        !infoFindings.some(
          (x) => x.code === infoItem.code && x.message === infoItem.message && x.snippet === infoItem.snippet
        )
      ) {
        infoFindings.push(infoItem);
      }
    } else {
      findings.push(f);
    }
  }

  return {
    ok: findings.every((f) => f.severity !== "error"),
    content_hash: raw.content_hash,
    findings,
    info_findings: infoFindings,
  };
}

export function lintHyperFramesComposition(
  compositionDir: string,
  entryHtml = "index.html",
  cacheDir?: string
): HyperFramesLintResult {
  const absCompDir = path.resolve(compositionDir);
  const entryPath = path.join(absCompDir, entryHtml);
  if (!fs.existsSync(entryPath)) {
    return {
      ok: false,
      cached: false,
      content_hash: "missing",
      findings: [
        {
          code: "missing_entry_html",
          severity: "error",
          message: `Missing composition entry HTML: ${entryPath}`,
        },
      ],
      info_findings: [],
    };
  }

  const contentHash = computeCompositionLintHash(absCompDir, entryHtml);
  const memHit = lintMemoryCache.get(contentHash);
  if (memHit) {
    return { ...memHit, cached: true };
  }

  const diskCachePath = cacheDir
    ? path.join(cacheDir, `hf_lint_${contentHash.slice(0, 24)}.json`)
    : null;
  if (diskCachePath && fs.existsSync(diskCachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(diskCachePath, "utf8")) as Omit<
        HyperFramesLintResult,
        "cached"
      >;
      if (parsed && Array.isArray(parsed.findings) && parsed.content_hash === contentHash) {
        const normalized = normalizeLintEntryForCuthol(parsed, absCompDir, entryHtml);
        lintMemoryCache.set(contentHash, normalized);
        return { ...normalized, cached: true };
      }
    } catch {
      // ignore corrupt cache file
    }
  }
  // One-sided fallback to the pre-normalization key: cache files written by
  // older builds hash the entry HTML verbatim (injected tags included). A hit
  // is adopted under the new key without re-linting; both the memory cache
  // and the new disk file are populated so the legacy walk runs once.
  if (diskCachePath && cacheDir) {
    const legacyHash = computeCompositionLintHashLegacy(absCompDir, entryHtml);
    const legacyMemHit = lintMemoryCache.get(legacyHash);
    if (legacyMemHit) {
      lintMemoryCache.set(contentHash, legacyMemHit);
      return { ...legacyMemHit, cached: true };
    }
    const legacyPath = path.join(cacheDir, `hf_lint_${legacyHash.slice(0, 24)}.json`);
    if (legacyPath !== diskCachePath && fs.existsSync(legacyPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Omit<
          HyperFramesLintResult,
          "cached"
        >;
        if (parsed && Array.isArray(parsed.findings) && parsed.content_hash === legacyHash) {
          const normalized = {
            ...normalizeLintEntryForCuthol(parsed, absCompDir, entryHtml),
            content_hash: contentHash,
          };
          lintMemoryCache.set(contentHash, normalized);
          lintMemoryCache.set(legacyHash, normalized);
          try {
            fs.writeFileSync(diskCachePath, JSON.stringify(normalized, null, 2), "utf8");
          } catch {
            // adoption write is best-effort
          }
          return { ...normalized, cached: true };
        }
      } catch {
        // ignore corrupt cache file
      }
    }
  }

  const findings: HyperFramesLintFinding[] = [];
  const infoFindings: HyperFramesLintFinding[] = [];
  const hfBin = findLocalHyperFramesCliMjs();

  if (fs.existsSync(hfBin)) {
    const proc = spawnWatchedSync(process.execPath, [hfBin, "lint", absCompDir, "--json"], {
      encoding: "utf8",
      env: hyperFramesProcessEnv(),
      step: "hyperframes lint",
    });
    const rawOut = (proc.stdout || "").trim();
    const jsonStart = rawOut.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(rawOut.slice(jsonStart)) as {
          findings?: Array<{
            code?: string;
            severity?: "error" | "warning" | "info";
            message?: string;
            fixHint?: string;
            selector?: string;
            elementId?: string;
            snippet?: string;
            file?: string;
            line?: number;
            column?: number;
          }>;
        };
        for (const f of parsed.findings ?? []) {
          const code = String(f.code ?? "hyperframes_lint");
          const isImgDup = isDuplicateImgMediaDiscoveryFinding(
            {
              code,
              message: f.message,
              snippet: f.snippet,
              selector: f.selector,
            },
            absCompDir,
            entryHtml
          );
          const item: HyperFramesLintFinding = {
            code,
            severity:
              SIZE_AND_SPLIT_LINT_CODES.has(code) || isImgDup
                ? "info"
                : f.severity === "error" || f.severity === "warning"
                  ? f.severity
                  : "info",
            message: String(f.message ?? ""),
            ...(f.fixHint ? { fixHint: String(f.fixHint) } : {}),
            ...(f.selector ? { selector: String(f.selector) } : {}),
            ...(f.elementId ? { elementId: String(f.elementId) } : {}),
            ...(f.snippet ? { snippet: String(f.snippet) } : {}),
            ...(f.file ? { file: String(f.file) } : {}),
            ...(typeof f.line === "number" ? { line: f.line } : {}),
            ...(typeof f.column === "number" ? { column: f.column } : {}),
          };
          if (item.severity === "info") {
            infoFindings.push(item);
          } else {
            findings.push(item);
          }
        }
      } catch {
        if (proc.status !== 0) {
          findings.push({
            code: "hyperframes_lint_failed",
            severity: "warning",
            message: (proc.stderr || proc.stdout || "hyperframes lint failed").trim(),
          });
        }
      }
    } else if (proc.status !== 0) {
      findings.push({
        code: "hyperframes_lint_failed",
        severity: "warning",
        message: (proc.stderr || proc.stdout || "hyperframes lint failed").trim(),
      });
    }
  }

  const entry = normalizeLintEntryForCuthol(
    {
      ok: findings.every((f) => f.severity !== "error"),
      content_hash: contentHash,
      findings,
      info_findings: infoFindings,
    },
    absCompDir,
    entryHtml
  );
  lintMemoryCache.set(contentHash, entry);
  if (diskCachePath) {
    try {
      fs.mkdirSync(path.dirname(diskCachePath), { recursive: true });
      fs.writeFileSync(diskCachePath, JSON.stringify(entry, null, 2), "utf8");
    } catch {
      // ignore cache write failure
    }
  }

  return { ...entry, cached: false };
}
