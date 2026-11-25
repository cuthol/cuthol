// CLI 'verify', 'monitor', 'render', and 'brief' command group handlers (split out of cli.ts).
import { BriefLens, renderSequenceBrief } from "./brief/inspector.js";
import {
  adoptExternalCompositionEdits,
  detectExternalChanges,
  formatExternalNotice,
} from "./core/external_changes.js";
import { RenderPreset } from "./compositor/compiler.js";
import { CutholDiagnostic, CutholError, DIAGNOSTICS, VerificationGateId } from "./core/diagnostics.js";
import { parseTimeMs } from "./core/time.js";
import { computeSequenceDurationMs } from "./core/timeline.js";
import { loadSequence, toExternalChangesSummary } from "./core/workspace.js";
import { captureMonitorFrame, captureMonitorSheet } from "./monitor/preview.js";
import { captureMonitorTimeline } from "./monitor/timeline_view.js";
import { renderSequenceToMp4 } from "./render/renderer.js";
import { runWorkspaceVerification } from "./verify/gates.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

const BARE_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
const BARE_FRACTION = /^[+-]?\d+\.\d+$/;
const NUMBER_WITH_UNIT = /^[+-]?\d+(?:\.\d+)?\s*(?:ms|s|sec|min|us)$/i;

/** A unitless fraction (`21.1`) would read as 21ms; require an explicit unit. */
export function parseMonitorAtMs(raw: string): number {
  if (BARE_FRACTION.test(raw.trim())) {
    throw new CutholError(DIAGNOSTICS.UNITLESS_FRACTION_TIME(raw.trim()));
  }
  return parseTimeMs(raw);
}

/** Warn when several bare numbers are all under 1000 ms on a sequence of at least 10s. */
function unitlessAtWarning(atRaw: string | undefined, sequenceDurationMs: number): CutholDiagnostic | null {
  if (!atRaw || sequenceDurationMs < 10_000) return null;
  const bare: number[] = [];
  for (const token of atRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (token.includes(":") || NUMBER_WITH_UNIT.test(token)) continue;
    if (!BARE_NUMBER.test(token)) continue;
    bare.push(Number(token));
  }
  if (bare.length < 2 || !bare.every((n) => n < 1000)) return null;
  return DIAGNOSTICS.UNITLESS_TIME_AS_MS();
}

function attachAtWarning<T extends { diagnostics: CutholDiagnostic[] }>(
  workspaceDir: string,
  atRaw: string | undefined,
  result: T
): T {
  const durationMs = computeSequenceDurationMs(loadSequence(workspaceDir).sequence);
  const warning = unitlessAtWarning(atRaw, durationMs);
  if (!warning) return result;
  return { ...result, diagnostics: [...result.diagnostics, warning] };
}

export function runVerifyCommand(ctx: CliCommandContext): CliCommandResult {
  const { flags, workspaceDir } = ctx;
  const gatesRaw = strFlag(flags, "gates");
  const gates =
    gatesRaw && gatesRaw !== "all"
      ? (gatesRaw.split(",").map((s) => s.trim()) as VerificationGateId[])
      : undefined;
  // Verify never measures coordinates; it runs one shared script probe for
  // compositions that have no cached probe record (cached on the second run).
  const report = runWorkspaceVerification(workspaceDir, gates);
  emitEnvelopeJson(workspaceDir, "verify", { ...report, ok: report.ok });
  if (!report.ok) {
    process.exitCode = 1;
  }
  return;
}

/**
 * Adopts outside edits that touch only composition folders (the sequence file
 * untouched) before a read command, so the agent's natural "write the file,
 * then look" loop needs no explicit `changes adopt`. Returns the INFO line or null.
 */
function autoAdoptCompositionEdits(workspaceDir: string): { diagnostic: CutholDiagnostic; line: string } | null {
  try {
    const adopted = adoptExternalCompositionEdits(workspaceDir, { automatic: true });
    if (!adopted) return null;
    return {
      diagnostic: DIAGNOSTICS.EXTERNAL_COMPOSITION_EDITS_AUTO_ADOPTED(adopted.adopted_comps),
      line: adopted.summary_line,
    };
  } catch {
    return null;
  }
}

function withAdoptNotice<T extends object>(
  result: T,
  adopted: { diagnostic: CutholDiagnostic } | null
): T {
  if (!adopted) return result;
  const prev = (result as { diagnostics?: unknown }).diagnostics;
  const list = Array.isArray(prev) ? (prev as CutholDiagnostic[]) : [];
  return { ...result, diagnostics: [...list, adopted.diagnostic] };
}

/** `--no-hud` (CLI) or `--hud=false` (MCP `hud: false`) hides the top HUD telemetry strip. */
function hideHud(flags: Record<string, string | boolean>): boolean {
  return (boolFlag(flags, "no-hud", false) ?? false) || ((boolFlag(flags, "hud", true) ?? true) === false);
}

export function runMonitorCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  const adopted = action === "frame" || action === "sheet" || action === "timeline"
    ? autoAdoptCompositionEdits(workspaceDir)
    : null;
  if (action === "frame") {
    const atRaw = strFlag(flags, "at") ?? rest[0] ?? "0ms";
    const res = captureMonitorFrame({
      workspaceDir,
      atMs: parseMonitorAtMs(atRaw),
      showBoxes: boolFlag(flags, "boxes", true),
      hideHud: hideHud(flags),
      outputPath: strFlag(flags, "out"),
    });
    emitEnvelopeJson(workspaceDir, "monitor.frame", {
      ...withAdoptNotice(attachAtWarning(workspaceDir, atRaw, res), adopted),
    });
    return;
  }

  if (action === "sheet") {
    const hasExplicitGrid = flags["grid"] !== undefined;
    const gridRaw = strFlag(flags, "grid", "3x3")!;
    const [cStr, rStr] = gridRaw.toLowerCase().split("x");
    const cols = Number(cStr) || 3;
    const rows = Number(rStr) || 3;
    const startRaw = strFlag(flags, "start");
    const endRaw = strFlag(flags, "end");
    const atRaw = strFlag(flags, "at");
    const atTokens = atRaw
      ? atRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (atTokens.length === 1 && (startRaw !== undefined || endRaw !== undefined)) {
      throw new CutholError(
        DIAGNOSTICS.SHEET_AT_WITH_WINDOW(
          `single at '${atTokens[0]}'` +
            (startRaw !== undefined ? ` with start '${startRaw}'` : "") +
            (endRaw !== undefined ? ` with end '${endRaw}'` : "")
        )
      );
    }
    const atWindowWarn =
      atTokens.length > 1 && (startRaw !== undefined || endRaw !== undefined)
        ? DIAGNOSTICS.SHEET_AT_WITH_WINDOW_WARN(
            `${atTokens.length} at values` +
              (startRaw !== undefined ? ` with start '${startRaw}'` : "") +
              (endRaw !== undefined ? ` with end '${endRaw}'` : "")
          )
        : null;
    const atMs = atTokens.length > 0 ? atTokens.map((s) => parseMonitorAtMs(s)) : undefined;
    const res = captureMonitorSheet({
      workspaceDir,
      startMs: startRaw ? parseTimeMs(startRaw) : undefined,
      endMs: endRaw ? parseTimeMs(endRaw) : undefined,
      atMs,
      cols: atMs && !hasExplicitGrid ? undefined : cols,
      rows: atMs && !hasExplicitGrid ? undefined : rows,
      showBoxes: boolFlag(flags, "boxes", true),
      hideHud: hideHud(flags),
      outputPath: strFlag(flags, "out"),
    });
    const warned = withAdoptNotice(attachAtWarning(workspaceDir, atRaw, res), adopted);
    emitEnvelopeJson(workspaceDir, "monitor.sheet", {
      ...warned,
      ...(atWindowWarn ? { diagnostics: [...warned.diagnostics, atWindowWarn] } : {}),
    });
    return;
  }

  if (action === "timeline") {
    const res = captureMonitorTimeline({
      workspaceDir,
      width: numFlag(flags, "width"),
      includeEmptyLanes: boolFlag(flags, "include-empty", false),
      outputPath: strFlag(flags, "out"),
    });
    emitEnvelopeJson(workspaceDir, "monitor.timeline", { ...withAdoptNotice(res, adopted) });
    return;
  }
  return CLI_NOT_HANDLED;
}

export function runRenderCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, rest, flags, workspaceDir } = ctx;
  const isActionPreset =
    action === "draft_480p" ||
    action === "master_1080p" ||
    action === "master_2160p" ||
    action === "master_alpha";
  const preset =
    (strFlag(flags, "preset", isActionPreset ? (action as RenderPreset) : "master_1080p") as RenderPreset) ??
    "master_1080p";
  const outPath = strFlag(flags, "out") ?? (isActionPreset ? rest[0] : action ?? rest[0]);
  const workers = numFlag(flags, "workers");
  const encoderRaw = strFlag(flags, "encoder") as "auto" | "nvenc" | "libx264" | undefined;
  const overlayRes = strFlag(flags, "overlay-res");
  const profile = boolFlag(flags, "profile", false) ?? false;
  const adopted = autoAdoptCompositionEdits(workspaceDir);
  const res = renderSequenceToMp4({
    workspaceDir,
    preset,
    outputPath: outPath,
    workers,
    encoder: encoderRaw,
    overlayRes,
    profile,
  });
  emitEnvelopeJson(workspaceDir, "render", { ...withAdoptNotice(res, adopted) });
  return;
}

export function runBriefCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, flags, workspaceDir, formatFlag } = ctx;
  // Brief stays read-only: it reports outside edits (file names) instead of adopting them.
  const { sequence } = loadSequence(workspaceDir);
  // External-change top line (null when clean: outputs stay byte-identical).
  let extChanges: ReturnType<typeof detectExternalChanges> | null = null;
  let extNotice: string | null = null;
  try {
    extChanges = detectExternalChanges(workspaceDir);
    extNotice = formatExternalNotice(extChanges, "cli");
  } catch {
    extChanges = null;
    extNotice = null;
  }
  const LENSES: BriefLens[] = ["overview", "flow", "canvas", "detail"];
  const lensRaw = strFlag(flags, "lens") ?? (action || undefined);
  const lensExplicit = lensRaw !== undefined;
  if (lensRaw !== undefined && !(LENSES as string[]).includes(lensRaw)) {
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--lens ${lensRaw}`,
        "brief",
        "cuthol brief --lens overview|flow|canvas|detail"
      )
    );
  }
  const lens = (lensRaw as BriefLens | undefined) ?? "overview";
  const idRaw = strFlag(flags, "id");
  const targetIds = idRaw ? idRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

  let windowStartMs: number | undefined;
  let windowEndMs: number | undefined;
  const winRaw = strFlag(flags, "window");
  if (winRaw && winRaw.includes("..")) {
    const [a, b] = winRaw.split("..");
    if (a) windowStartMs = parseTimeMs(a);
    if (b) windowEndMs = parseTimeMs(b);
  }

  if (flags["json"] || formatFlag === "json") {
    if (lensExplicit) {
      // A lens is token-efficient text: with --json return exactly that markdown, not the whole sequence.
      // Render without draining: emitEnvelopeJson attaches the notes as live_notes exactly once.
      const md = renderSequenceBrief(sequence, {
        lens,
        targetIds,
        windowStartMs,
        windowEndMs,
        ...(extNotice ? { noticeLine: extNotice } : {}),
        includeLiveNotes: false,
      });
      emitEnvelopeJson(workspaceDir, "brief", {
        lens,
        markdown: md,
        ...(windowStartMs !== undefined || windowEndMs !== undefined
          ? { window_ms: [windowStartMs ?? null, windowEndMs ?? null] }
          : {}),
        ...(targetIds.length ? { target_ids: targetIds } : {}),
        ...(extChanges && extNotice ? { external_changes: toExternalChangesSummary(extChanges, extNotice) } : {}),
      });
      return;
    }
    emitEnvelopeJson(workspaceDir, "brief", {
      lens,
      sequence,
      ...(extChanges && extNotice ? { external_changes: toExternalChangesSummary(extChanges, extNotice) } : {}),
    });
    return;
  }

  const md = renderSequenceBrief(sequence, {
    lens,
    targetIds,
    windowStartMs,
    windowEndMs,
    ...(extNotice ? { noticeLine: extNotice } : {}),
  });
  console.log(md);
  return;
}
