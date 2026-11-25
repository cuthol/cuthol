// Staging helper for the legacy `#00ff00` composition background: the cleaned
// HTML is written to a work-folder copy so the user's own entry file on disk
// is never rewritten outside the journal.
import fs from "node:fs";
import path from "node:path";
import { copyDirRecursiveSync } from "./hf_common.js";

const LEGACY_GREEN_BG_PATTERN = /(?:body|#root)\s*\{[^}]*?background\s*:\s*#00ff00\b/i;
const LEGACY_GREEN_BG_REPLACE = /((?:body|#root)\s*\{[^}]*?)background\s*:\s*#00ff00\b/gi;

/** True when the composition HTML still carries the legacy green background. */
export function needsLegacyGreenSanitize(html: string): boolean {
  LEGACY_GREEN_BG_PATTERN.lastIndex = 0;
  return LEGACY_GREEN_BG_PATTERN.test(html);
}

/** Returns the HTML with the legacy green background upgraded to transparent. */
export function sanitizeLegacyGreenBackground(html: string): string {
  LEGACY_GREEN_BG_REPLACE.lastIndex = 0;
  return html.replace(LEGACY_GREEN_BG_REPLACE, "$1background: transparent");
}

/**
 * Copies a composition directory and writes the sanitized entry HTML into the
 * copy. Returns the staged directory. The source folder is never touched.
 */
export function stageSanitizedCopy(options: {
  absCompDir: string;
  entryHtml: string;
  blobsDir: string;
  prefix: string;
  sanitizedHtml: string;
}): string {
  const stagedDir = path.join(
    options.blobsDir,
    `${options.prefix}_${process.pid}_${Date.now()}`
  );
  fs.rmSync(stagedDir, { recursive: true, force: true });
  copyDirRecursiveSync(options.absCompDir, stagedDir);
  fs.writeFileSync(path.join(stagedDir, options.entryHtml), options.sanitizedHtml, "utf8");
  return stagedDir;
}

/**
 * Upgrades the legacy green background inside an already-staged directory
 * copy, preserving any other staged rewrites (scalar variables, timeline
 * stretch, backdrops). Returns true when the staged entry was rewritten.
 */
export function sanitizeStagedEntryHtml(stagedDir: string, entryHtml: string): boolean {
  const stagedEntryPath = path.join(stagedDir, entryHtml);
  if (!fs.existsSync(stagedEntryPath)) return false;
  const stagedHtml = fs.readFileSync(stagedEntryPath, "utf8");
  if (!needsLegacyGreenSanitize(stagedHtml)) return false;
  fs.writeFileSync(stagedEntryPath, sanitizeLegacyGreenBackground(stagedHtml), "utf8");
  return true;
}

