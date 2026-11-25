/**
 * Cuthol Workspace & Transactional Journal Manager (`JournalGuard`).
 *
 * Manages `cuthol.sequence.json`, `.cuthol/journal/` revision snapshots,
 * and atomic undo/redo operations.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "./diagnostics.js";

// Heavy commit-path modules stay out of the top-level import graph so that
// reading commands (which only use workspace_read.js re-exports) never pay
// for them. They load synchronously on first mutating use via require()
// (supported for ES modules on Node 22.12+), keeping every call site sync.
const requireHeavy = createRequire(import.meta.url);
type BridgeExporter = typeof import("../compositor/bridge_exporter.js");
type ExternalChangesModule = typeof import("./external_changes.js");
type LiveLockModule = typeof import("../live/live_lock.js");
type ExtRegistryModule = typeof import("../extensions/ext_registry.js");
let cachedBridges: BridgeExporter | null = null;
let cachedExtChanges: ExternalChangesModule | null = null;
let cachedLiveLock: LiveLockModule | null = null;
let cachedExtRegistry: ExtRegistryModule | null = null;
function bridges(): BridgeExporter {
  cachedBridges ??= requireHeavy("../compositor/bridge_exporter.js") as BridgeExporter;
  return cachedBridges;
}
function extChanges(): ExternalChangesModule {
  cachedExtChanges ??= requireHeavy("./external_changes.js") as ExternalChangesModule;
  return cachedExtChanges;
}
function liveLock(): LiveLockModule {
  cachedLiveLock ??= requireHeavy("../live/live_lock.js") as LiveLockModule;
  return cachedLiveLock;
}
function extRegistry(): ExtRegistryModule {
  cachedExtRegistry ??= requireHeavy("../extensions/ext_registry.js") as ExtRegistryModule;
  return cachedExtRegistry;
}
import {
  buildEnvelopeState,
  computeSequenceDelta,
  CutholEnvelopeHistory,
  CutholEnvelopeState,
  InverseOperationKind,
} from "./envelope.js";
import { AspectPreset, createEmptySequence, CutholSequence } from "./schema.js";
import { formatTimecode } from "./time.js";
import { computeSequenceDurationMs } from "./timeline.js";
import { audioJoinFadeMsOf, DEFAULT_AUDIO_JOIN_FADE_MS } from "../sequence/tempo.js";
import type { ExternalChanges } from "./external_changes.js";
import {
  buildEnvelopeHistory,
  ensureWorkspaceDirectories,
  ExternalChangesSummary,
  JournalEntry,
  JournalManifest,
  loadJournalManifest,
  loadSequence,
  resolveWorkspacePaths,
  toExternalChangesSummary,
  WorkspacePaths,
} from "./workspace_read.js";

// Lightweight readers live in `./workspace_read.js` so reading commands never
// load this module's heavy commit path; re-exported here for compatibility.
export {
  buildEnvelopeHistory,
  buildWorkspaceEnvelopeHeader,
  ensureWorkspaceDirectories,
  loadJournalManifest,
  loadSequence,
  resolveWorkspacePaths,
  toExternalChangesSummary,
} from "./workspace_read.js";
export type {
  ExternalChangesSummary,
  JournalEntry,
  JournalManifest,
  WorkspacePaths,
} from "./workspace_read.js";
export {
  JOURNAL_INDEX_FILENAME,
  SEQUENCE_FILENAME,
  STATE_DIRNAME,
} from "./workspace_read.js";

function writeJsonAtomically(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp_${process.pid}_${crypto.randomUUID()}`;
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, serialized, "utf8");

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const isTransientLock = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (isTransientLock && attempt < maxAttempts) {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
        } catch {
          // SharedArrayBuffer fallback if unavailable
        }
        continue;
      }
      if (isTransientLock) {
        try {
          fs.copyFileSync(tmpPath, filePath);
          fs.unlinkSync(tmpPath);
          return;
        } catch {
          // Fall through to cleanup and rethrow original error
        }
      }
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup failure
        }
      }
      throw err;
    }
  }
}

export function initWorkspace(options: {
  dir: string;
  title?: string;
  aspect?: AspectPreset;
  fps?: number;
  size?: { width: number; height: number };
  stageExplicit?: boolean;
  adoptFirstSource?: boolean;
}): { paths: WorkspacePaths; sequence: CutholSequence } {
  const paths = resolveWorkspacePaths(options.dir);
  ensureWorkspaceDirectories(paths);

  // Clean up any stale revision snapshots if re-initializing an existing workspace directory
  if (fs.existsSync(paths.journalDir)) {
    for (const file of fs.readdirSync(paths.journalDir)) {
      if (/^rev_\d+\.json$/.test(file)) {
        try {
          fs.unlinkSync(path.join(paths.journalDir, file));
        } catch {
          // Ignore unlink errors
        }
      }
    }
  }

  const projectId = path.basename(paths.rootDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "cuthol_project";
  const explicit = Boolean(options.size ?? options.aspect ?? options.stageExplicit);
  const sequence = createEmptySequence({
    projectId,
    title: options.title ?? path.basename(paths.rootDir),
    aspect: options.aspect ?? "9:16",
    fps: options.fps ?? 30,
    size: options.size,
    stageExplicit: explicit ? true : undefined,
  });
  if (explicit) {
    sequence.stage.set_explicit = true;
  } else if (!options.adoptFirstSource) {
    // Direct initWorkspace() callers without the CLI adoption flag keep today's
    // behaviour: implicit 9:16, never adopted from a later source.
    sequence.stage.set_explicit = true;
  }

  writeJsonAtomically(paths.sequenceFile, sequence);

  const snapName = `rev_0001.json`;
  writeJsonAtomically(path.join(paths.journalDir, snapName), sequence);

  const manifest: JournalManifest = {
    cursor_revision: 1,
    entries: [
      {
        revision: 1,
        timestamp: sequence.meta.created_at,
        operation: "workspace.init",
        tag: "initial",
        snapshot_file: snapName,
      },
    ],
  };
  writeJsonAtomically(paths.journalIndexFile, manifest);
  extChanges().clearExtchangeState(paths);

  return { paths, sequence };
}

/**
 * Executes a mutating operation inside a transactional `JournalGuard`.
 * If the callback throws (or verification fails), the sequence file remains untouched.
 * If it succeeds, the revision increments and a snapshot is recorded in `.cuthol/journal/`.
 */
export interface CommitSequenceMutationOptions {
  /**
   * Skips the G211 bridge-rewrite guard. Only `workspace changes adopt/revert`
   * set this: they resolve the external change by blessing the post-sync state.
   */
  allowExternalRewrite?: boolean;
}

export function commitSequenceMutation<T>(
  dir: string,
  operation: string,
  mutator: (seq: CutholSequence, paths: WorkspacePaths) => T,
  options: CommitSequenceMutationOptions = {}
): { result: T; sequence: CutholSequence; revision: number } {
  liveLock().assertLiveWriteAllowed(dir, operation);
  const { paths, sequence } = loadSequence(dir);
  const cloned: CutholSequence = structuredClone(sequence);
  const extPrestate = extChanges().captureCommitPrestate(paths, sequence, { stashPending: true });

  const result = mutator(cloned, paths);

  // G211: a Cuthol commit must not silently overwrite externally-changed
  // composition files. Both checks run before any journal write.
  extChanges().assertMutatorKeptExternalFiles(paths, extPrestate);
  if (!options.allowExternalRewrite) {
    extChanges().assertBridgeWontRewriteExternal(paths, cloned, extPrestate);
  }

  const manifest = loadJournalManifest(paths);
  const prunedEntries = manifest.entries.filter((e) => e.revision > manifest.cursor_revision);
  const activeEntries = manifest.entries.filter((e) => e.revision <= manifest.cursor_revision);
  if (activeEntries.length === 0) {
    const baseRev = Math.max(1, sequence.meta.revision || 1);
    const baseSnapName = `rev_${String(baseRev).padStart(4, "0")}.json`;
    const baseSnapPath = path.join(paths.journalDir, baseSnapName);
    if (!fs.existsSync(baseSnapPath)) {
      writeJsonAtomically(baseSnapPath, sequence);
    }
    activeEntries.push({
      revision: baseRev,
      timestamp: sequence.meta.updated_at || new Date().toISOString(),
      operation: "workspace.recover",
      tag: null,
      snapshot_file: baseSnapName,
    });
  }
  const nextRevision = activeEntries[activeEntries.length - 1].revision + 1;

  cloned.meta.revision = nextRevision;
  cloned.meta.updated_at = new Date().toISOString();

  const deltaInfo = computeSequenceDelta(sequence, cloned, operation);

  const snapName = `rev_${String(nextRevision).padStart(4, "0")}.json`;
  const snapPath = path.join(paths.journalDir, snapName);

  writeJsonAtomically(snapPath, cloned);
  writeJsonAtomically(paths.sequenceFile, cloned);

  const absorbedExternalNote = extPrestate.sequenceFolded
    ? "externally-edited cuthol.sequence.json folded into this revision (without adopt)"
    : undefined;
  activeEntries.push({
    revision: nextRevision,
    timestamp: cloned.meta.updated_at,
    operation,
    tag: null,
    snapshot_file: snapName,
    delta_summary: absorbedExternalNote
      ? `${deltaInfo.summary} | ${absorbedExternalNote}`
      : deltaInfo.summary,
    ...(absorbedExternalNote ? { absorbed_external_sequence: absorbedExternalNote } : {}),
    inverse_kind: deltaInfo.inverse_kind,
    inverse_summary: deltaInfo.inverse_summary,
    affected_ids: deltaInfo.affected_ids,
    touches_protected: deltaInfo.touches_protected,
    protected_ids: deltaInfo.protected_ids,
  });

  const nextManifest: JournalManifest = {
    cursor_revision: nextRevision,
    entries: activeEntries,
  };
  writeJsonAtomically(paths.journalIndexFile, nextManifest);

  extChanges().pruneExtchangeRevisions(
    paths,
    prunedEntries.map((e) => e.revision)
  );
  // Remove orphaned redo snapshot files only after new revision and manifest are safely committed
  const activeSnapSet = new Set(activeEntries.map((e) => e.snapshot_file));
  for (const pruned of prunedEntries) {
    if (activeSnapSet.has(pruned.snapshot_file)) continue;
    const orphanPath = path.join(paths.journalDir, pruned.snapshot_file);
    if (fs.existsSync(orphanPath)) {
      try {
        fs.unlinkSync(orphanPath);
      } catch {
        // Ignore orphan cleanup failure
      }
    }
  }

  try {
    bridges().syncAllCompositionBridges(cloned, paths);
  } catch {
    // non-blocking bridge sync
  }

  try {
    extChanges().finalizeCommitManifest(paths, nextRevision, cloned, extPrestate);
  } catch {
    // non-blocking known-state recording (a later detection re-baselines)
  }

  return { result, sequence: cloned, revision: nextRevision };
}

/**
 * Updates cached metadata (such as `analysis_refs`) in `cuthol.sequence.json` and the active
 * revision snapshot without incrementing `meta.revision` or polluting the undo/redo journal stack.
 */
export function updateSequenceInPlace(
  dir: string,
  mutator: (seq: CutholSequence, paths: WorkspacePaths) => void
): CutholSequence {
  liveLock().assertLiveWriteAllowed(dir, "sequence.update");
  const { paths, sequence } = loadSequence(dir);
  const cloned: CutholSequence = structuredClone(sequence);
  const extPrestate = extChanges().captureCommitPrestate(paths, sequence);
  mutator(cloned, paths);

  writeJsonAtomically(paths.sequenceFile, cloned);

  const manifest = loadJournalManifest(paths);
  const currentEntry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  if (currentEntry) {
    const snapPath = path.join(paths.journalDir, currentEntry.snapshot_file);
    if (fs.existsSync(snapPath)) {
      writeJsonAtomically(snapPath, cloned);
    }
  }

  try {
    bridges().syncAllCompositionBridges(cloned, paths);
  } catch {
    // non-blocking bridge sync
  }

  try {
    extChanges().refreshManifestIfWasClean(paths, cloned, extPrestate);
  } catch {
    // non-blocking known-state refresh
  }

  return cloned;
}

export interface StepJournalOptions {
  steps?: number;
  toRevision?: number;
  expectRevision?: number;
  dryRun?: boolean;
  allowProtected?: string[];
}

export interface StepJournalResult {
  sequence: CutholSequence;
  previous_revision: number;
  revision: number;
  operation: string;
  dry_run: boolean;
  reverted_entries: Array<{
    revision: number;
    operation: string;
    inverse_kind: InverseOperationKind;
    inverse_summary: string;
    affected_ids: string[];
  }>;
  state: CutholEnvelopeState;
  history: CutholEnvelopeHistory;
}

export function stepJournal(
  dir: string,
  direction: "undo" | "redo",
  stepsOrOpts: number | StepJournalOptions = 1
): StepJournalResult {
  const opts: StepJournalOptions =
    typeof stepsOrOpts === "number" ? { steps: stepsOrOpts } : stepsOrOpts;

  if (!opts.dryRun) liveLock().assertLiveWriteAllowed(dir, `journal.${direction}`);
  const { paths, sequence: currentSeq } = loadSequence(dir);
  const manifest = loadJournalManifest(paths);
  const idx = manifest.entries.findIndex((e) => e.revision === manifest.cursor_revision);
  if (idx === -1) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
  }

  if (opts.expectRevision !== undefined && opts.expectRevision !== manifest.cursor_revision) {
    throw new CutholError(
      DIAGNOSTICS.REVISION_MISMATCH(opts.expectRevision, manifest.cursor_revision)
    );
  }

  let targetIdx: number;
  if (opts.toRevision !== undefined) {
    targetIdx = manifest.entries.findIndex((e) => e.revision === opts.toRevision);
    if (
      targetIdx === -1 ||
      (direction === "undo" && targetIdx >= idx) ||
      (direction === "redo" && targetIdx <= idx)
    ) {
      throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
    }
  } else {
    const steps = opts.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1) {
      throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
    }
    targetIdx = direction === "undo" ? idx - steps : idx + steps;
  }

  if (targetIdx < 0 || targetIdx >= manifest.entries.length) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
  }

  const targetEntry = manifest.entries[targetIdx];
  const snapPath = path.join(paths.journalDir, targetEntry.snapshot_file);
  if (!fs.existsSync(snapPath)) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE(direction));
  }
  const restored = JSON.parse(fs.readFileSync(snapPath, "utf8")) as CutholSequence;

  // Compute which entries are being reverted/replayed and check for locked/protected targets
  const traversedEntries =
    direction === "undo"
      ? manifest.entries.slice(targetIdx + 1, idx + 1).reverse()
      : manifest.entries.slice(idx + 1, targetIdx + 1);

  const lockedLaneIds = new Set<string>();
  const lockedCueIds = new Set<string>();
  const cueToLane = new Map<string, string>();
  for (const seqSnap of [currentSeq, restored]) {
    for (const lane of seqSnap.lanes) {
      for (const c of lane.cues) {
        cueToLane.set(c.id, lane.id);
      }
      if (lane.locked) {
        lockedLaneIds.add(lane.id);
        for (const c of lane.cues) {
          lockedCueIds.add(c.id);
        }
      }
    }
  }

  const allowSet = new Set(opts.allowProtected ?? []);
  const isProtectedIdAllowed = (id: string, scopeIds: Iterable<string>): boolean => {
    if (allowSet.has(id)) return true;
    const parentLane = cueToLane.get(id);
    if (parentLane && allowSet.has(parentLane)) return true;
    if (lockedLaneIds.has(id)) {
      const cuesInScope = [...scopeIds].filter((sid) => cueToLane.get(sid) === id);
      if (cuesInScope.length > 0 && cuesInScope.every((cid) => allowSet.has(cid))) {
        return true;
      }
    }
    return false;
  };

  const blockedProtectedIds = new Set<string>();

  const revertedDetails = traversedEntries.map((e) => {
    const aff = e.affected_ids ?? [];
    const scopeProtected = new Set<string>([...aff, ...(e.protected_ids ?? [])]);
    for (const id of aff) {
      if (lockedCueIds.has(id) && !isProtectedIdAllowed(id, scopeProtected)) {
        blockedProtectedIds.add(id);
      }
    }
    for (const pid of e.protected_ids ?? []) {
      if (!isProtectedIdAllowed(pid, scopeProtected)) {
        blockedProtectedIds.add(pid);
      }
    }
    const baseInvKind: InverseOperationKind = e.inverse_kind ?? "modifying";
    const effectiveInvKind: InverseOperationKind =
      direction === "redo"
        ? baseInvKind === "destructive"
          ? "additive"
          : baseInvKind === "additive"
            ? "destructive"
            : "modifying"
        : baseInvKind;
    return {
      revision: e.revision,
      operation: e.operation,
      inverse_kind: effectiveInvKind,
      inverse_summary:
        direction === "undo"
          ? e.inverse_summary ?? `${e.operation} will be undone`
          : e.delta_summary ?? e.operation,
      affected_ids: aff,
    };
  });

  // Also check direct diff between currentSeq and restored on locked lanes
  const directDelta = computeSequenceDelta(currentSeq, restored, `journal.${direction}`);
  if (directDelta.touches_protected) {
    for (const pid of directDelta.protected_ids) {
      if (!isProtectedIdAllowed(pid, directDelta.protected_ids)) {
        blockedProtectedIds.add(pid);
      }
    }
  }

  if (blockedProtectedIds.size > 0 && !opts.dryRun) {
    throw new CutholError(
      DIAGNOSTICS.PROTECTED_TARGET([...blockedProtectedIds], `workspace.journal.${direction}`)
    );
  }

  // G211: the trailing bridge sync must not silently revert the user's own
  // edit to an externally-changed entry HTML (checked before any write).
  if (!opts.dryRun) {
    const extPrestate = extChanges().captureCommitPrestate(paths, currentSeq);
    extChanges().assertBridgeWontRewriteExternal(paths, restored, extPrestate);
  }

  const prevRev = manifest.cursor_revision;
  if (!opts.dryRun) {
    writeJsonAtomically(paths.sequenceFile, restored);
    manifest.cursor_revision = targetEntry.revision;
    writeJsonAtomically(paths.journalIndexFile, manifest);
    try {
      bridges().syncAllCompositionBridges(restored, paths);
    } catch {
      // non-blocking bridge sync
    }
    try {
      const restoreNotes = extChanges().restoreForJournalTraversal(
        paths,
        direction,
        traversedEntries.map((e) => e.revision),
        new Map(traversedEntries.map((e) => [e.revision, e.operation] as [number, string])),
        targetEntry.revision
      );
      if (restoreNotes.length > 0) {
        const byRev = new Map(restoreNotes.map((x) => [x.revision, x.note] as [number, string]));
        for (const rd of revertedDetails) {
          const note = byRev.get(rd.revision);
          if (note) rd.inverse_summary = `${rd.inverse_summary} | ${note}`;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (revertedDetails.length > 0) {
        revertedDetails[0].inverse_summary += ` | file restore error: ${msg}`;
      }
    }
  } else {
    manifest.cursor_revision = targetEntry.revision;
  }

  return {
    sequence: restored,
    previous_revision: prevRev,
    revision: targetEntry.revision,
    operation: targetEntry.operation,
    dry_run: Boolean(opts.dryRun),
    reverted_entries: revertedDetails,
    state: buildEnvelopeState(restored),
    history: buildEnvelopeHistory(manifest, restored),
  };
}

export function setLaneLockStatus(options: {
  workspaceDir: string;
  laneId: string;
  locked: boolean;
}): { laneId: string; locked: boolean; revision: number } {
  const { result, revision } = commitSequenceMutation(
    options.workspaceDir,
    `lane.${options.locked ? "lock" : "unlock"}(${options.laneId})`,
    (seq) => {
      const lane = seq.lanes.find((l) => l.id === options.laneId);
      if (!lane) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.laneId));
      }
      lane.locked = options.locked;
      return { laneId: lane.id, locked: lane.locked };
    }
  );
  return { ...result, revision };
}

export function setLaneMuteStatus(options: {
  workspaceDir: string;
  laneId: string;
  muted: boolean;
}): { laneId: string; muted: boolean; revision: number } {
  const { result, revision } = commitSequenceMutation(
    options.workspaceDir,
    `lane.${options.muted ? "mute" : "unmute"}(${options.laneId})`,
    (seq) => {
      if (options.laneId === "spine") {
        throw new CutholError(DIAGNOSTICS.LANE_MUTE_SPINE());
      }
      const lane = seq.lanes.find((l) => l.id === options.laneId);
      if (!lane) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(options.laneId));
      }
      lane.muted = options.muted;
      return { laneId: lane.id, muted: lane.muted };
    }
  );
  return { ...result, revision };
}

export function tagCurrentRevision(dir: string, tag: string): JournalEntry {
  const { paths } = loadSequence(dir);
  const manifest = loadJournalManifest(paths);
  const entry = manifest.entries.find((e) => e.revision === manifest.cursor_revision);
  if (!entry) {
    throw new CutholError(DIAGNOSTICS.JOURNAL_REVISION_UNAVAILABLE("undo"));
  }
  entry.tag = tag;
  writeJsonAtomically(paths.journalIndexFile, manifest);
  return entry;
}

export interface WorkspaceOpenExtensionItem {
  name: string;
  enabled: boolean;
  description: string;
}

export function formatWorkspaceOpenSummary(
  seq: CutholSequence,
  options: {
    verbose?: boolean;
    maxItems?: number;
    noticeLine?: string;
    /** Precomputed installed-extension list (same data `extension list` reports).
     * When omitted, only the enabled extensions stored on the sequence are shown. */
    installedExtensions?: WorkspaceOpenExtensionItem[];
  } = {}
): string {
  const maxItems = options.maxItems ?? 3;
  const totalMs = computeSequenceDurationMs(seq);
  const tempoRate = seq.stage.tempo ?? 1;
  const tempoSuffix =
    tempoRate !== 1
      ? ` | Tempo: \`${tempoRate}x\` (output \`${Math.max(1, Math.round(totalMs / tempoRate))}ms\`)`
      : "";
  const joinFadeMs = audioJoinFadeMsOf(seq);
  const fadeSuffix =
    joinFadeMs !== DEFAULT_AUDIO_JOIN_FADE_MS ? ` | Join fade: \`${joinFadeMs}ms\`` : "";
  const totalCues = seq.lanes.reduce((sum, l) => sum + l.cues.length, 0);
  const lines: string[] = [];
  if (options.noticeLine) lines.push(options.noticeLine);

  lines.push(
    `- Project: **${seq.meta.title}** (\`${seq.meta.project_id}\`) | Rev: \`r${seq.meta.revision}\` | Stage: \`${seq.stage.width}x${seq.stage.height}\` (\`${seq.stage.aspect}\`) @ \`${seq.stage.fps}fps\` | Backdrop: \`${seq.stage.backdrop.color}\` | Duration: \`${totalMs}ms\` (\`${formatTimecode(totalMs)}\`)${tempoSuffix}${fadeSuffix}`
  );

  if (seq.library.length === 0) {
    lines.push(`- Library (0 items): _(empty)_`);
  } else if (options.verbose) {
    lines.push(`- Library (${seq.library.length} items):`);
    for (const item of seq.library) {
      const dims = item.probe.has_video
        ? `${item.probe.width}x${item.probe.height}@${item.probe.fps}fps`
        : "audio-only";
      lines.push(
        `  - \`${item.handle}\` (${item.kind}, ${item.probe.duration_ms}ms, ${dims}, uri: \`${item.uri}\`)`
      );
    }
  } else {
    const shownLib = seq.library.slice(0, maxItems).map((item) => {
      return `\`${item.handle}\` (${item.kind}, ${item.probe.duration_ms}ms)`;
    });
    const moreLib =
      seq.library.length > maxItems
        ? ` … (+${seq.library.length - maxItems} more; pass verbose=true or run brief for full table)`
        : "";
    lines.push(`- Library (${seq.library.length} items): ${shownLib.join(", ")}${moreLib}`);
  }

  if (seq.spine.clips.length === 0) {
    lines.push(`- Primary Spine (0 clips): _(empty)_`);
  } else if (options.verbose) {
    lines.push(`- Primary Spine (${seq.spine.clips.length} clips):`);
    for (const clip of seq.spine.clips) {
      const endMs = clip.timeline_in_ms + clip.duration_ms;
      const muteTag = clip.audio_chain.muted ? ", MUTED" : "";
      lines.push(
        `  - \`${clip.id}\` (\`${clip.asset_handle}\`): timeline \`${clip.timeline_in_ms}..${endMs}ms\` | source \`${clip.source_in_ms}..${clip.source_out_ms}ms\`${muteTag}`
      );
    }
  } else {
    const shownClips = seq.spine.clips.slice(0, maxItems).map((clip) => {
      const endMs = clip.timeline_in_ms + clip.duration_ms;
      const muteTag = clip.audio_chain.muted ? ", muted" : "";
      return `\`${clip.id}\` (${clip.asset_handle}, ${clip.timeline_in_ms}..${endMs}ms${muteTag})`;
    });
    const moreClips =
      seq.spine.clips.length > maxItems ? ` … (+${seq.spine.clips.length - maxItems} more)` : "";
    lines.push(`- Primary Spine (${seq.spine.clips.length} clips): ${shownClips.join(", ")}${moreClips}`);
  }

  if (seq.lanes.length === 0) {
    lines.push(`- Parallel Lanes (0 lanes, 0 cues): _(none)_`);
  } else {
    const laneParts = seq.lanes.map((lane) => {
      const firstCues = lane.cues
        .slice(0, 2)
        .map((c) => c.id)
        .join(",");
      const cuePreview =
        lane.cues.length > 0
          ? ` [${firstCues}${lane.cues.length > 2 ? `…+${lane.cues.length - 2}` : ""}]`
          : "";
      return `\`${lane.id}\` (${lane.kind}: ${lane.cues.length} cue${lane.cues.length === 1 ? "" : "s"}${lane.muted ? ", MUTED" : ""}${cuePreview})`;
    });
    lines.push(
      `- Parallel Lanes (${seq.lanes.length} lanes, ${totalCues} cues): ${laneParts.join(", ")}`
    );
  }

  // Installed extensions (name, enabled-for-this-project, one-line description —
  // the same data `extension list` reports). Enabled state comes from the
  // `seq.extensions` name set; anything installed but not mounted is disabled.
  const installed = options.installedExtensions;
  if (installed) {
    if (installed.length === 0) {
      lines.push(`- Extensions (0 installed): _(none)_`);
    } else {
      lines.push(
        `- Extensions (${installed.length} installed): ${installed
          .map(
            (e) =>
              `\`${e.name}\` (${e.enabled ? "enabled" : "disabled"}${e.description ? ` — ${e.description}` : ""})`
          )
          .join(", ")}`
      );
    }
  } else if (seq.extensions && seq.extensions.length > 0) {
    lines.push(
      `- Enabled Extensions (${seq.extensions.length}): ${seq.extensions.map((e) => `\`${e.name}\` v${e.version}`).join(", ")}`
    );
  }

  return lines.join("\n");
}

export function openWorkspaceSummary(
  dir: string,
  options: { verbose?: boolean; maxItems?: number } = {}
): {
  workspace_dir: string;
  project_id: string;
  title: string;
  revision: number;
  duration_ms: number;
  counts: {
    library: number;
    spine_clips: number;
    lanes: number;
    cues: number;
  };
  library_preview: Array<{ handle: string; kind: string; duration_ms: number; uri: string }>;
  library_omitted?: number;
  spine_preview: Array<{
    id: string;
    asset_handle: string;
    timeline_in_ms: number;
    duration_ms: number;
    muted: boolean;
  }>;
  spine_omitted?: number;
  lanes_summary: Array<{ id: string; kind: string; cues_count: number; muted: boolean }>;
  extensions: WorkspaceOpenExtensionItem[];
  summary_text: string;
  external_changes?: ExternalChangesSummary;
} {
  const { paths, sequence } = loadSequence(dir);
  let externalChanges: ExternalChanges | null = null;
  let externalNotice: string | null = null;
  try {
    externalChanges = extChanges().detectExternalChanges(paths.rootDir);
    externalNotice = extChanges().formatExternalNotice(externalChanges, "cli");
  } catch {
    externalChanges = null;
    externalNotice = null;
  }
  const maxItems = options.verbose ? sequence.library.length : (options.maxItems ?? 3);
  const maxSpine = options.verbose ? sequence.spine.clips.length : (options.maxItems ?? 3);
  const totalMs = computeSequenceDurationMs(sequence);
  const totalCues = sequence.lanes.reduce((sum, l) => sum + l.cues.length, 0);

  const libSlice = sequence.library.slice(0, maxItems).map((item) => ({
    handle: item.handle,
    kind: item.kind,
    duration_ms: item.probe.duration_ms,
    uri: item.uri,
  }));
  const libOmitted = Math.max(0, sequence.library.length - libSlice.length);

  const spineSlice = sequence.spine.clips.slice(0, maxSpine).map((clip) => ({
    id: clip.id,
    asset_handle: clip.asset_handle,
    timeline_in_ms: clip.timeline_in_ms,
    duration_ms: clip.duration_ms,
    muted: clip.audio_chain.muted,
  }));
  const spineOmitted = Math.max(0, sequence.spine.clips.length - spineSlice.length);

  // Same data `extension list` reports: every installed extension with its
  // enabled-for-this-project state and one-line description. Never throws:
  // on any listing failure fall back to the enabled refs stored on the sequence.
  let installedExtensions: WorkspaceOpenExtensionItem[];
  try {
    installedExtensions = extRegistry().listExtensions(dir).extensions.map((e) => ({
      name: e.name,
      enabled: e.enabled,
      description: e.description,
    }));
  } catch {
    installedExtensions = (sequence.extensions ?? []).map((e) => ({
      name: e.name,
      enabled: true,
      description: "",
    }));
  }

  return {
    workspace_dir: paths.rootDir,
    project_id: sequence.meta.project_id,
    title: sequence.meta.title,
    revision: sequence.meta.revision,
    duration_ms: totalMs,
    counts: {
      library: sequence.library.length,
      spine_clips: sequence.spine.clips.length,
      lanes: sequence.lanes.length,
      cues: totalCues,
    },
    library_preview: libSlice,
    ...(libOmitted > 0 ? { library_omitted: libOmitted } : {}),
    spine_preview: spineSlice,
    ...(spineOmitted > 0 ? { spine_omitted: spineOmitted } : {}),
    lanes_summary: sequence.lanes.map((l) => ({
      id: l.id,
      kind: l.kind,
      cues_count: l.cues.length,
      muted: l.muted,
    })),
    extensions: installedExtensions,
    summary_text: formatWorkspaceOpenSummary(sequence, {
      ...options,
      installedExtensions,
      ...(externalNotice ? { noticeLine: externalNotice } : {}),
    }),
    ...(externalChanges && externalNotice
      ? { external_changes: toExternalChangesSummary(externalChanges, externalNotice) }
      : {}),
  };
}

