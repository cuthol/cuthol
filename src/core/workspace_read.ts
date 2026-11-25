/**
 * Lightweight workspace readers (no compositor, render, verify, extension or
 * live-lock code). Reading commands (`settings list`, `library query`,
 * `brief`, `workspace open`) import from here so they never load the heavy
 * commit path in `core/workspace.ts`. `core/workspace.ts` re-exports every
 * symbol below, so existing importers keep working unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";
import {
  buildEnvelopeState,
  CutholEnvelopeHistory,
  CutholEnvelopeState,
  InverseOperationKind,
} from "./envelope.js";
import { CutholSequence } from "./schema.js";
import type { ExternalChanges } from "./external_changes.js";

export const SEQUENCE_FILENAME = "cuthol.sequence.json";
export const STATE_DIRNAME = ".cuthol";
export const JOURNAL_INDEX_FILENAME = "journal.json";

export interface JournalEntry {
  revision: number;
  timestamp: string;
  operation: string;
  tag: string | null;
  snapshot_file: string;
  delta_summary?: string;
  inverse_kind?: InverseOperationKind;
  inverse_summary?: string;
  affected_ids?: string[];
  touches_protected?: boolean;
  protected_ids?: string[];
  /** Set when this commit folded an externally edited `cuthol.sequence.json` without adopt. */
  absorbed_external_sequence?: string;
}

export interface JournalManifest {
  cursor_revision: number;
  entries: JournalEntry[];
}

export interface WorkspacePaths {
  rootDir: string;
  sequenceFile: string;
  stateDir: string;
  ledgerFile: string;
  journalDir: string;
  journalIndexFile: string;
  monitorDir: string;
  blobsDir: string;
}

export function resolveWorkspacePaths(dir: string): WorkspacePaths {
  const rootDir = path.resolve(dir);
  const stateDir = path.join(rootDir, STATE_DIRNAME);
  return {
    rootDir,
    sequenceFile: path.join(rootDir, SEQUENCE_FILENAME),
    stateDir,
    ledgerFile: path.join(stateDir, "ledger.sqlite"),
    journalDir: path.join(stateDir, "journal"),
    journalIndexFile: path.join(stateDir, JOURNAL_INDEX_FILENAME),
    monitorDir: path.join(stateDir, "monitor"),
    blobsDir: path.join(stateDir, "blobs"),
  };
}

export function ensureWorkspaceDirectories(paths: WorkspacePaths): void {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.journalDir, { recursive: true });
  fs.mkdirSync(paths.monitorDir, { recursive: true });
  fs.mkdirSync(paths.blobsDir, { recursive: true });
}

export function loadSequence(dir: string): { paths: WorkspacePaths; sequence: CutholSequence } {
  const paths = resolveWorkspacePaths(dir);
  if (!fs.existsSync(paths.sequenceFile)) {
    throw new CutholError(DIAGNOSTICS.WORKSPACE_NOT_FOUND(paths.rootDir));
  }
  ensureWorkspaceDirectories(paths);
  const raw = fs.readFileSync(paths.sequenceFile, "utf8");
  const sequence = JSON.parse(raw) as CutholSequence;
  return { paths, sequence };
}

export function loadJournalManifest(paths: WorkspacePaths): JournalManifest {
  if (!fs.existsSync(paths.journalIndexFile)) {
    return { cursor_revision: 1, entries: [] };
  }
  return JSON.parse(fs.readFileSync(paths.journalIndexFile, "utf8")) as JournalManifest;
}

export function buildEnvelopeHistory(
  manifest: JournalManifest,
  currentSeq?: CutholSequence
): CutholEnvelopeHistory {
  const idx = manifest.entries.findIndex((e) => e.revision === manifest.cursor_revision);
  const undoDepth = Math.max(0, idx);
  const redoDepth = idx >= 0 ? Math.max(0, manifest.entries.length - 1 - idx) : 0;

  // Check currently locked lanes in `currentSeq` so dynamically locked cues are also marked protected
  const lockedCueIds = new Set<string>();
  if (currentSeq) {
    for (const lane of currentSeq.lanes) {
      if (lane.locked) {
        for (const c of lane.cues) {
          lockedCueIds.add(c.id);
        }
      }
    }
  }

  let undoPreview: CutholEnvelopeHistory["undo_preview"] = null;
  if (idx > 0) {
    const curEntry = manifest.entries[idx];
    const affects = curEntry.affected_ids ?? [];
    const dynamicProtected = affects.some((id) => lockedCueIds.has(id));
    undoPreview = {
      revision: curEntry.revision,
      operation: curEntry.operation,
      delta_summary: curEntry.delta_summary ?? curEntry.operation,
      inverse_kind: curEntry.inverse_kind ?? "modifying",
      inverse_summary: curEntry.inverse_summary ?? `${curEntry.operation} will be undone`,
      affects,
      touches_protected: Boolean(curEntry.touches_protected || dynamicProtected),
    };
  }

  let nextRedo: CutholEnvelopeHistory["next_redo"] = null;
  if (idx >= 0 && idx + 1 < manifest.entries.length) {
    const rEntry = manifest.entries[idx + 1];
    nextRedo = {
      revision: rEntry.revision,
      operation: rEntry.operation,
      delta_summary: rEntry.delta_summary ?? rEntry.operation,
      affects: rEntry.affected_ids ?? [],
    };
  }

  const activeSlice = idx >= 0 ? manifest.entries.slice(Math.max(0, idx - 4), idx + 1) : [];
  const breadcrumb = activeSlice.map(
    (e) => `r${e.revision} ${e.delta_summary ?? e.operation}`
  );

  return {
    undo_depth: undoDepth,
    redo_depth: redoDepth,
    undo_preview: undoPreview,
    next_redo: nextRedo,
    breadcrumb,
  };
}

export function buildWorkspaceEnvelopeHeader(dir: string): {
  schema_version: "cuthol.envelope/1";
  state: CutholEnvelopeState;
  delta?: { summary: string; affected_ids: string[] };
  history: CutholEnvelopeHistory;
} {
  const { paths, sequence } = loadSequence(dir);
  const manifest = loadJournalManifest(paths);
  const curEntry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  return {
    schema_version: "cuthol.envelope/1",
    state: buildEnvelopeState(sequence),
    ...(curEntry
      ? {
          delta: {
            summary: curEntry.delta_summary ?? curEntry.operation,
            affected_ids: curEntry.affected_ids ?? [],
          },
        }
      : {}),
    history: buildEnvelopeHistory(manifest, sequence),
  };
}

export interface ExternalChangesSummary {
  digest: string;
  cursor_revision: number;
  counts: ExternalChanges["counts"];
  sequence: ExternalChanges["sequence"];
  compositions: ExternalChanges["compositions"];
  notice: string;
  diagnostic: ReturnType<typeof DIAGNOSTICS.EXTERNAL_CHANGES_PRESENT>;
}

export function toExternalChangesSummary(
  changes: ExternalChanges,
  notice: string
): ExternalChangesSummary {
  const bits = changes.compositions.map(
    (c) => `${c.key}: ${c.added.length + c.modified.length + c.deleted.length} file${c.added.length + c.modified.length + c.deleted.length === 1 ? "" : "s"}`
  );
  if (changes.sequence) bits.push("cuthol.sequence.json");
  return {
    digest: changes.digest,
    cursor_revision: changes.cursor_revision,
    counts: changes.counts,
    sequence: changes.sequence,
    compositions: changes.compositions,
    notice,
    diagnostic: DIAGNOSTICS.EXTERNAL_CHANGES_PRESENT(bits.join("; ") || "changes"),
  };
}
