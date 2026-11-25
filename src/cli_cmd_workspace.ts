// CLI 'workspace' command group handler (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  adoptExternalChanges,
  buildChangesShow,
  revertExternalChanges,
} from "./core/external_changes.js";
import { AspectPreset, parseStageSize } from "./core/schema.js";
import {
  initWorkspace,
  loadJournalManifest,
  loadSequence,
  openWorkspaceSummary,
  stepJournal,
  tagCurrentRevision,
} from "./core/workspace.js";
import { setStageBackdropColor, setStageTempo } from "./sequence/stage.js";
import { resizeStage } from "./sequence/stage_resize.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
  emitEnvelopeObject,
} from "./cli_output.js";

export function runWorkspaceCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "init") {
    const targetDir = rest[0] ?? workspaceDir;
    const sizeRaw = strFlag(flags, "size");
    const aspectRaw = strFlag(flags, "aspect");
    const hasAspect = aspectRaw !== undefined;
    const aspect = (aspectRaw as AspectPreset) ?? "9:16";
    const fps = numFlag(flags, "fps", 30) ?? 30;
    const title = strFlag(flags, "title");
    let size: { width: number; height: number } | undefined;
    if (sizeRaw) {
      try {
        size = parseStageSize(sizeRaw);
      } catch (err) {
        throw new CutholError(DIAGNOSTICS.INVALID_STAGE_SIZE(sizeRaw));
      }
    }
    const { paths, sequence } = initWorkspace({
      dir: targetDir,
      aspect: size || !hasAspect ? undefined : aspect,
      fps,
      title,
      size,
      stageExplicit: Boolean(sizeRaw ?? (hasAspect ? true : undefined)),
      adoptFirstSource: size || hasAspect ? undefined : true,
    });
    emitEnvelopeJson(targetDir, "workspace.init", {
      action: "workspace.init",
      sequence_file: paths.sequenceFile,
      ledger_file: paths.ledgerFile,
      project_id: sequence.meta.project_id,
      stage: sequence.stage,
    });
    return;
  }

  if (action === "open") {
    const targetDir = rest[0] ?? workspaceDir;
    const res = openWorkspaceSummary(targetDir, {
      verbose: boolFlag(flags, "verbose", false),
    });
    emitEnvelopeJson(targetDir, "workspace.open", {
      action: "workspace.open",
      ...res,
    });
    return;
  }

  if (action === "stage") {
    const sizeRaw = strFlag(flags, "size");
    const stageAspectRaw = strFlag(flags, "aspect");
    const fromRaw = strFlag(flags, "from");
    if (!sizeRaw && !stageAspectRaw && !fromRaw) {
      throw new CutholError(DIAGNOSTICS.INVALID_STAGE_SIZE("(missing --size/--aspect/--from)"));
    }
    let fromAsset: { width: number; height: number } | undefined;
    if (fromRaw && !sizeRaw && !stageAspectRaw) {
      const { sequence: seqForAsset } = loadSequence(workspaceDir);
      const item = seqForAsset.library.find((l) => l.handle === fromRaw);
      if (!item || !item.probe.has_video) {
        throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(fromRaw));
      }
      fromAsset = { width: item.probe.width, height: item.probe.height };
    }
    const res = resizeStage({
      workspaceDir,
      size: sizeRaw ?? undefined,
      aspect: !sizeRaw && !fromAsset && stageAspectRaw ? (stageAspectRaw as AspectPreset) : undefined,
      fromAsset,
    });
    emitEnvelopeJson(workspaceDir, "workspace.stage", {
      action: "workspace.stage",
      previous: res.previous,
      stage: res.next,
      moved: res.moved,
      revision: res.revision,
    });
    return;
  }

  if (action === "backdrop") {
    const color = strFlag(flags, "color") ?? rest[0];
    if (!color) throw new CutholError(DIAGNOSTICS.INVALID_COLOR("(empty / missing --color)"));
    const res = setStageBackdropColor({ workspaceDir, color });
    emitEnvelopeJson(workspaceDir, "workspace.backdrop", {
      action: "workspace.backdrop",
      ...res,
    });
    return;
  }

  if (action === "tempo") {
    const raw = strFlag(flags, "rate") ?? rest[0];
    if (raw == null || String(raw).trim() === "") {
      throw new CutholError(DIAGNOSTICS.INVALID_TEMPO("(empty / missing --rate)"));
    }
    const num = Number(String(raw).trim());
    if (!Number.isFinite(num) || num < 0.5 || num > 2.0) {
      throw new CutholError(DIAGNOSTICS.INVALID_TEMPO(String(raw)));
    }
    const rate = num === 1 ? null : num;
    const res = setStageTempo({ workspaceDir, rate });
    emitEnvelopeJson(workspaceDir, "workspace.tempo", {
      action: "workspace.tempo",
      ...res,
    });
    return;
  }

  if (action === "journal") {
    const sub = rest[0] ?? "list";
    if (sub === "list") {
      const { paths } = loadSequence(workspaceDir);
      const manifest = loadJournalManifest(paths);
      emitEnvelopeJson(workspaceDir, "workspace.journal.list", { ...manifest });
      return;
    }
    if (sub === "undo" || sub === "redo") {
      const allowRaw = strFlag(flags, "allow-protected");
      const allowProtected = allowRaw
        ? allowRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const res = stepJournal(workspaceDir, sub, {
        steps: numFlag(flags, "steps"),
        toRevision: numFlag(flags, "to"),
        expectRevision: numFlag(flags, "expect-rev"),
        dryRun: boolFlag(flags, "dry-run", false),
        allowProtected,
      });
      emitEnvelopeObject(workspaceDir, `workspace.journal.${sub}`, {
        ok: true,
        command: `workspace.journal.${sub}`,
        action: `journal.${sub}`,
        schema_version: "cuthol.envelope/1",
        dry_run: res.dry_run,
        previous_revision: res.previous_revision,
        revision: res.revision,
        operation: res.operation,
        reverted_entries: res.reverted_entries,
        state: res.state,
        delta: {
          summary:
            res.reverted_entries.map((e) => e.inverse_summary).join("; ") || res.operation,
          affected_ids: [...new Set(res.reverted_entries.flatMap((e) => e.affected_ids))],
        },
        history: res.history,
      });
      return;
    }
    if (sub === "tag") {
      const tag = rest[1] ?? strFlag(flags, "name", "checkpoint")!;
      const entry = tagCurrentRevision(workspaceDir, tag);
      emitEnvelopeJson(workspaceDir, "workspace.journal.tag", {
        action: "journal.tag",
        entry,
      });
      return;
    }
  }

  if (action === "changes") {
    const sub = rest[0] ?? "show";
    const comp = strFlag(flags, "comp");
    if (sub === "show") {
      const payload = buildChangesShow(workspaceDir, comp);
      const fileCount = payload.compositions.reduce((n, c) => n + c.files.length, 0);
      emitEnvelopeJson(workspaceDir, "workspace.changes.show", {
        action: "workspace.changes.show",
        ...payload,
        ...(payload.has_changes
          ? {
              diagnostic: DIAGNOSTICS.EXTERNAL_CHANGES_PRESENT(
                `${payload.compositions.length} composition${payload.compositions.length === 1 ? "" : "s"}, ${fileCount} file${fileCount === 1 ? "" : "s"}${payload.sequence ? " + cuthol.sequence.json" : ""}`
              ),
            }
          : {}),
      });
      return;
    }
    if (sub === "adopt") {
      const res = adoptExternalChanges(workspaceDir, comp);
      emitEnvelopeJson(workspaceDir, "workspace.changes.adopt", {
        action: "workspace.changes.adopt",
        ...res,
      });
      return;
    }
    if (sub === "revert") {
      const res = revertExternalChanges(workspaceDir, comp);
      emitEnvelopeJson(workspaceDir, "workspace.changes.revert", {
        action: "workspace.changes.revert",
        ...res,
      });
      return;
    }
  }
  return CLI_NOT_HANDLED;
}
