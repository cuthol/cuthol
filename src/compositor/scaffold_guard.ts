// Composition scaffolds never silently overwrite edited files.
//
// A scaffold is first built in a temp folder: that is the plan (every file and its bytes). A file in
// the target conflicts when it differs from the plan, is not a Cuthol-owned bridge file, and is not
// what the previous Cuthol scaffold wrote there (recorded in `.cuthol-scaffold.json`, which the
// external-change walker already ignores). So re-scaffolding an untouched scaffold with new
// arguments just works, while a hand-edited file stops the scaffold with G215.
//
// `--force` overwrites anyway, as one journal revision: the previous and new contents are stored
// as content blobs, a per-revision sidecar records them, and `workspace journal undo` puts the
// edited bytes back (redo re-applies the scaffold). Files above the stored-content limit are
// refused even with `--force`, because their previous content could not be brought back.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import {
  blessCompositionDirAtRevision,
  fileSha,
  isExcludedCompositionPath,
  MAX_STORED_CONTENT_BYTES,
  type ScaffoldSidecarFile,
  storeContentBlob,
  writeScaffoldSidecar,
} from "../core/external_changes.js";
import { commitSequenceMutation, loadJournalManifest, loadSequence, resolveWorkspacePaths } from "../core/workspace.js";
import type { HyperFramesScaffoldOptions } from "./hf_common.js";
import { scaffoldHyperFramesComposition } from "./hf_scaffold.js";

export const SCAFFOLD_MARKER_FILE = ".cuthol-scaffold.json";

interface ScaffoldMarker {
  version: 1;
  /** Bytes (sha256) Cuthol last wrote for each scaffold file. */
  files: Record<string, string>;
}

export interface ScaffoldPlan {
  files: Map<string, Buffer>;
  entryHtml: string;
  compositionId: string;
}

export interface GuardedScaffoldResult {
  compositionDir: string;
  entryHtml: string;
  compositionId: string;
  /** Edited files a forced scaffold overwrote (empty when nothing was edited). */
  overwritten: string[];
  /** Journal revision of a forced overwrite (undoable); absent otherwise. */
  revision?: number;
}

const sha = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Builds the scaffold in a temp folder and returns every file it writes, with its bytes. */
export function planScaffold(options: HyperFramesScaffoldOptions): ScaffoldPlan {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-scaffold-"));
  try {
    const target = path.join(tmp, path.basename(path.resolve(options.targetDir)) || "comp");
    const res = scaffoldHyperFramesComposition({ ...options, targetDir: target });
    const files = new Map<string, Buffer>();
    for (const rel of listFiles(target)) files.set(rel, fs.readFileSync(path.join(target, rel)));
    return { files, entryHtml: res.entryHtml, compositionId: res.compositionId };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readMarker(absDir: string): ScaffoldMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(absDir, SCAFFOLD_MARKER_FILE), "utf8")) as ScaffoldMarker;
    return parsed && parsed.version === 1 && parsed.files ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(absDir: string, plan: ScaffoldPlan): void {
  const files: Record<string, string> = { ...(readMarker(absDir)?.files ?? {}) };
  for (const [rel, buf] of plan.files) files[rel] = sha(buf);
  fs.writeFileSync(path.join(absDir, SCAFFOLD_MARKER_FILE), JSON.stringify({ version: 1, files }, null, 1));
}

/**
 * Files the plan would write (`writes`: missing or different) and, among them, the ones that were
 * edited after Cuthol wrote them (`conflicts`).
 */
export function findScaffoldConflicts(absDir: string, plan: ScaffoldPlan): { writes: string[]; conflicts: string[] } {
  const marker = readMarker(absDir);
  const writes: string[] = [];
  const conflicts: string[] = [];
  for (const [rel, buf] of plan.files) {
    const now = fileSha(path.join(absDir, rel));
    if (now === sha(buf)) continue;
    writes.push(rel);
    if (now === null || isExcludedCompositionPath(rel)) continue;
    if (marker?.files[rel] === now) continue;
    conflicts.push(rel);
  }
  return { writes, conflicts };
}

function writePlanFiles(absDir: string, plan: ScaffoldPlan, rels: string[]): void {
  for (const rel of rels) {
    const full = path.join(absDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, plan.files.get(rel)!);
  }
  writeMarker(absDir, plan);
}

function displayDir(workspaceDir: string, absDir: string): string {
  const rel = path.relative(path.resolve(workspaceDir), absDir);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : absDir;
}

/** Throws G215 when edited files are in the way (and, with `force`, when one is too large to restore). */
function assertScaffoldAllowed(workspaceDir: string, absDir: string, conflicts: string[], force: boolean): void {
  if (conflicts.length === 0) return;
  const shown = displayDir(workspaceDir, absDir);
  if (!force) throw new CutholError(DIAGNOSTICS.COMPOSITION_SCAFFOLD_WOULD_OVERWRITE(shown, conflicts));
  const tooLarge = conflicts.filter((rel) => {
    try {
      return fs.statSync(path.join(absDir, rel)).size > MAX_STORED_CONTENT_BYTES;
    } catch {
      return false;
    }
  });
  if (tooLarge.length > 0) {
    throw new CutholError(
      DIAGNOSTICS.COMPOSITION_SCAFFOLD_WOULD_OVERWRITE(
        shown,
        tooLarge,
        `not even with --force: above ${MAX_STORED_CONTENT_BYTES} bytes their previous content could not be brought back by undo`
      )
    );
  }
}

/** Stores the before/after contents of every file the plan writes; the sidecar file list. */
function stashScaffoldWrites(workspaceDir: string, absDir: string, plan: ScaffoldPlan, writes: string[]): ScaffoldSidecarFile[] {
  const paths = resolveWorkspacePaths(workspaceDir);
  return writes.map((rel) => {
    const full = path.join(absDir, rel);
    const before = fs.existsSync(full) ? fs.readFileSync(full) : null;
    return {
      rel,
      kind: before ? "modified" : "added",
      pre_sha: before ? storeContentBlob(paths, before) : null,
      post_sha: storeContentBlob(paths, plan.files.get(rel)!),
    };
  });
}

/**
 * `composition scaffold`: writes the scaffold unless edited files are in the way (G215). With
 * `force`, overwrites them as one undoable journal revision.
 */
export function scaffoldCompositionGuarded(options: {
  workspaceDir: string;
  scaffold: HyperFramesScaffoldOptions;
  force?: boolean;
}): GuardedScaffoldResult {
  const absDir = path.resolve(options.scaffold.targetDir);
  const plan = planScaffold(options.scaffold);
  const { writes, conflicts } = findScaffoldConflicts(absDir, plan);
  assertScaffoldAllowed(options.workspaceDir, absDir, conflicts, Boolean(options.force));
  const base = { compositionDir: absDir, entryHtml: plan.entryHtml, compositionId: plan.compositionId };
  if (conflicts.length === 0) {
    fs.mkdirSync(absDir, { recursive: true });
    writePlanFiles(absDir, plan, writes);
    return { ...base, overwritten: [] };
  }

  const paths = resolveWorkspacePaths(options.workspaceDir);
  const files = stashScaffoldWrites(options.workspaceDir, absDir, plan, writes);
  const dir = displayDir(options.workspaceDir, absDir);
  const operation = `composition.scaffold(${dir}): overwrote ${conflicts.length} edited file(s) (--force)`;
  const { revision, sequence } = commitSequenceMutation(options.workspaceDir, operation, () => ({ scaffolded: true }));
  // Sidecar before the copy: a copy that stops halfway (locked file) is still undoable.
  writeScaffoldSidecar(paths, { version: 1, revision, operation, dir, files });
  writePlanFiles(absDir, plan, writes);
  blessCompositionDirAtRevision(paths, sequence, revision, absDir);
  return { ...base, overwritten: conflicts, revision };
}

/**
 * First half of a scaffold that rides on another journaled command (`lane add-composition
 * --scaffold`): checks for edited files (G215 unless `force`), writes the scaffold, and returns what
 * the second half needs. Call `rollback()` if the command then fails.
 */
export function scaffoldBeforeCommit(options: {
  workspaceDir: string;
  scaffold: HyperFramesScaffoldOptions;
  force?: boolean;
}): {
  overwritten: string[];
  sidecarFiles: ScaffoldSidecarFile[] | null;
  rollback: () => void;
} {
  const absDir = path.resolve(options.scaffold.targetDir);
  const plan = planScaffold(options.scaffold);
  const { writes, conflicts } = findScaffoldConflicts(absDir, plan);
  assertScaffoldAllowed(options.workspaceDir, absDir, conflicts, Boolean(options.force));
  fs.mkdirSync(absDir, { recursive: true });
  const markerBefore = fs.existsSync(path.join(absDir, SCAFFOLD_MARKER_FILE))
    ? fs.readFileSync(path.join(absDir, SCAFFOLD_MARKER_FILE))
    : null;
  const before = new Map<string, Buffer | null>();
  for (const rel of writes) {
    const full = path.join(absDir, rel);
    before.set(rel, fs.existsSync(full) ? fs.readFileSync(full) : null);
  }
  const sidecarFiles = conflicts.length > 0 ? stashScaffoldWrites(options.workspaceDir, absDir, plan, writes) : null;
  writePlanFiles(absDir, plan, writes);
  return {
    overwritten: conflicts,
    sidecarFiles,
    rollback: () => {
      for (const [rel, buf] of before) {
        const full = path.join(absDir, rel);
        try {
          if (buf) fs.writeFileSync(full, buf);
          else fs.rmSync(full, { force: true });
        } catch {
          // best effort: the stored blobs still hold the previous content
        }
      }
      const markerPath = path.join(absDir, SCAFFOLD_MARKER_FILE);
      if (markerBefore) fs.writeFileSync(markerPath, markerBefore);
      else fs.rmSync(markerPath, { force: true });
    },
  };
}

/** Second half: binds the forced overwrite to the revision the command committed (undoable). */
export function attachScaffoldToRevision(options: {
  workspaceDir: string;
  absDir: string;
  revision: number;
  sidecarFiles: ScaffoldSidecarFile[];
}): void {
  const paths = resolveWorkspacePaths(options.workspaceDir);
  const entry = loadJournalManifest(paths).entries.find((e) => e.revision === options.revision);
  if (!entry) return;
  writeScaffoldSidecar(paths, {
    version: 1,
    revision: options.revision,
    operation: entry.operation,
    dir: displayDir(options.workspaceDir, options.absDir),
    files: options.sidecarFiles,
  });
  const { sequence } = loadSequence(options.workspaceDir);
  blessCompositionDirAtRevision(paths, sequence, options.revision, options.absDir);
}
