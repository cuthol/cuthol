// CLI 'lane' command group handler (split out of cli.ts).
import fs from "node:fs";
import path from "node:path";
import type { HyperFramesPresetKind } from "./compositor/hyperframes_bridge.js";
import type { scaffoldBeforeCommit } from "./compositor/scaffold_guard.js";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import type {
  CompositionAudioMode,
  HyperFramesCompositeMode,
  LaneCue,
  LaneKind,
} from "./core/schema.js";
import { parseTimeMs } from "./core/time.js";
import type { VerificationReport } from "./verify/gates.js";
import type { LaneExciseRippleAcross } from "./sequence/lanes.js";
import { boolFlag, jsonFixCommand, numFlag, parseExciseRanges, parseJsonFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

function parseCompositionAudioFlag(cueId: string, raw: string | undefined): CompositionAudioMode | undefined {
  if (raw === undefined) return undefined;
  const mode = raw.trim().toLowerCase();
  if (mode !== "mix" && mode !== "off") {
    throw new CutholError(
      DIAGNOSTICS.INVALID_COMPOSITION_AUDIO(cueId, `got '--composition-audio ${raw}', want 'mix' or 'off'`)
    );
  }
  return mode;
}

/** Journaled, undoable `composition_audio` switch on a composition cue. */
async function setCueCompositionAudio(
  workspaceDir: string,
  cueId: string,
  mode: CompositionAudioMode
): Promise<{ cue: LaneCue; revision: number; verification: VerificationReport }> {
  const { commitVerifiedMutation } = await import("./verify/gates.js");
  const { result, revision, verification } = commitVerifiedMutation(workspaceDir, `lane.update-cue(${cueId})`, (seq) => {
    const target = seq.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
    if (!target) {
      throw new CutholError(DIAGNOSTICS.UNKNOWN_HANDLE(cueId));
    }
    if (target.kind !== "composition" || !target.composition) {
      throw new CutholError(
        DIAGNOSTICS.INVALID_COMPOSITION_AUDIO(
          cueId,
          `'composition_audio' applies to composition cues only (kind '${target.kind}')`
        )
      );
    }
    target.composition_audio = mode;
    return target;
  });
  return { cue: result, revision, verification };
}

export async function runLaneCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  const { action, rest, flags, workspaceDir } = ctx;
  if (action === "lock" || action === "unlock") {
    const { setLaneLockStatus } = await import("./core/workspace.js");
    const laneId = strFlag(flags, "lane") ?? rest[0] ?? "ln_titles";
    const res = setLaneLockStatus({
      workspaceDir,
      laneId,
      locked: action === "lock",
    });
    emitEnvelopeJson(workspaceDir, `lane.${action}`, {
      action: `lane.${action}`,
      ...res,
    });
    return;
  }
  if (action === "mute" || action === "unmute") {
    const { setLaneMuteStatus } = await import("./core/workspace.js");
    const laneId = strFlag(flags, "lane") ?? rest[0] ?? "ln_titles";
    const res = setLaneMuteStatus({
      workspaceDir,
      laneId,
      muted: action === "mute",
    });
    emitEnvelopeJson(workspaceDir, `lane.${action}`, {
      action: `lane.${action}`,
      ...res,
    });
    return;
  }

  if (action === "add-cue") {
    const { addLaneCue } = await import("./sequence/lanes.js");
    const laneId = strFlag(flags, "lane", "ln_titles")!;
    const kind = strFlag(flags, "kind") as LaneKind | undefined;
    const durRaw = strFlag(flags, "duration", "3000ms")!;
    const inRaw = strFlag(flags, "in");
    const outRaw = strFlag(flags, "out");
    const rateRaw = strFlag(flags, "rate");
    const rate = rateRaw !== undefined ? Number(rateRaw.replace(/x$/i, "")) : undefined;
    const anchorRef = strFlag(flags, "anchor");
    const offsetRaw = strFlag(flags, "offset", "0ms")!;
    const atRaw = strFlag(flags, "at", "0ms")!;
    const res = addLaneCue({
      workspaceDir,
      laneId,
      kind,
      explicitId: strFlag(flags, "id"),
      assetHandle: strFlag(flags, "asset"),
      anchor: anchorRef ? { ref: anchorRef, offset_ms: parseTimeMs(offsetRaw) } : null,
      atMs: parseTimeMs(atRaw),
      durationMs: parseTimeMs(durRaw),
      explicitDuration: flags["duration"] !== undefined,
      sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
      sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
      rate,
      preservePitch: boolFlag(flags, "preserve-pitch"),
      zIndex: numFlag(flags, "z-index"),
      text: strFlag(flags, "text"),
      fontSizePx: numFlag(flags, "size"),
      colorHex: strFlag(flags, "color"),
      maxWidthPct: numFlag(flags, "max-width"),
      xPct: numFlag(flags, "x"),
      yPct: numFlag(flags, "y"),
      scale: numFlag(flags, "scale"),
      rotationDeg: strFlag(flags, "rotation") ?? strFlag(flags, "rotate"),
      opacity: numFlag(flags, "opacity"),
      gainDb: numFlag(flags, "gain-db"),
      muted: boolFlag(flags, "muted"),
    });
    emitEnvelopeJson(workspaceDir, "lane.add-cue", { action: "lane.add-cue", ...res });
    return;
  }

  if (action === "add-composition") {
    const { loadSequence } = await import("./core/workspace.js");
    const { addLaneCue } = await import("./sequence/lanes.js");
    const { ensureCompositionRuntimeFiles, validateHyperFramesCompositionContract } = await import(
      "./compositor/hyperframes_bridge.js"
    );
    const { attachScaffoldToRevision, scaffoldBeforeCommit } = await import(
      "./compositor/scaffold_guard.js"
    );
    const { readCurrentScriptErrorRecord } = await import("./compositor/coords_extract.js");
    const { probeScriptRecordsChildSync, scriptRecordToDiagnostic } = await import(
      "./compositor/hf_script_errors.js"
    );
    const { syncEnabledExtensionAssetsToComposition } = await import(
      "./compositor/bridge_exporter.js"
    );
    const { bareDurationWarning } = await import("./cli_cmd_composition.js");
    const laneId = strFlag(flags, "lane", "ln_motion")!;
    const compDir =
      strFlag(flags, "comp-dir") ??
      strFlag(flags, "composition-dir") ??
      strFlag(flags, "dir-comp") ??
      rest[0];
    if (!compDir) {
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(
          flags["dir"] ? "--dir (used without --comp-dir)" : "missing --comp-dir",
          "lane.add-composition",
          `cuthol lane add-composition --dir <workspace_dir> --comp-dir ${strFlag(flags, "dir") ?? "./compositions/intro"} --duration 3000ms`
        )
      );
    }
    const entryHtml = strFlag(flags, "entry", "index.html")!;
    const durRaw = strFlag(flags, "duration", "4000ms")!;
    const atRaw = strFlag(flags, "at", "0ms")!;
    const anchorRef = strFlag(flags, "anchor");
    const offsetRaw = strFlag(flags, "offset", "0ms")!;
    const propsRaw = strFlag(flags, "props", "{}")!;
    const compDirFlag =
      strFlag(flags, "comp-dir") !== undefined
        ? `--comp-dir ${compDir}`
        : strFlag(flags, "composition-dir") !== undefined
          ? `--composition-dir ${compDir}`
          : strFlag(flags, "dir-comp") !== undefined
            ? `--dir-comp ${compDir}`
            : `--comp-dir ${compDir}`;
    const props = parseJsonFlag(propsRaw, {
      command: "lane add-composition",
      flag: "props",
      kind: "object",
      fixCommand: jsonFixCommand("lane add-composition", "props", compDirFlag),
    }) as Record<string, unknown>;
    const transparent = boolFlag(flags, "transparent", true) ?? true;
    const mode = (strFlag(flags, "mode", "overlay_alpha") as HyperFramesCompositeMode) ?? "overlay_alpha";
    const durationMs = parseTimeMs(durRaw);

    // If `--scaffold <preset>` is passed or the composition dir does not exist yet, scaffold it deterministically
    const { paths, sequence } = loadSequence(workspaceDir);
    const absCompDir = path.isAbsolute(compDir) ? compDir : path.resolve(workspaceDir, compDir);
    // Edited files in the folder stop the scaffold (G215) unless --force; a forced overwrite rides on
    // the cue's own revision, so one undo removes the cue and brings the edited files back.
    let scaffoldStep: ReturnType<typeof scaffoldBeforeCommit> | null = null;
    if (flags["scaffold"] || !fs.existsSync(path.join(absCompDir, entryHtml))) {
      const preset = (strFlag(flags, "scaffold", "lower_third") as HyperFramesPresetKind) ?? "lower_third";
      scaffoldStep = scaffoldBeforeCommit({
        workspaceDir,
        force: boolFlag(flags, "force", false) ?? false,
        scaffold: {
          targetDir: absCompDir,
          width: sequence.stage.width,
          height: sequence.stage.height,
          fps: sequence.stage.fps,
          durationMs,
          preset,
          props,
          transparent,
        },
      });
    }
    let addCommitted = false;
    try {

    // Place missing runtime files into the folder without touching the
    // agent-written entry HTML (no `composition scaffold` round-trip needed).
    try {
      ensureCompositionRuntimeFiles(absCompDir, {
        width: sequence.stage.width,
        height: sequence.stage.height,
        fps: sequence.stage.fps,
        durationMs,
        props,
      });
    } catch {
      // non-blocking runtime file top-up
    }

    try {
      syncEnabledExtensionAssetsToComposition(sequence, absCompDir, entryHtml, paths);
    } catch {
      // non-blocking extension asset pre-sync
    }

    // Static contract check (entry HTML plus every local script it loads, so
    // a timeline built in a separate JS file passes).
    let contract = validateHyperFramesCompositionContract(absCompDir, entryHtml);

    // A cached run-time record (same file hash) is judged here. A browser probe
    // runs at add time only when the static check fails, because a page whose
    // timeline registers in a real browser passes even when the static text
    // does not name it. Otherwise the probe is left to `verify`, which checks
    // every unprobed composition in one shared browser run.
    const extraDiagnostics: CutholDiagnostic[] = [];
    try {
      let record = readCurrentScriptErrorRecord(workspaceDir, absCompDir, entryHtml);
      if (!record && contract.ok) {
        extraDiagnostics.push(DIAGNOSTICS.COMPOSITIONS_NEVER_PROBED_IN_BROWSER(1));
      }
      if (!record && !contract.ok) {
        probeScriptRecordsChildSync(workspaceDir, [
          {
            cueId: "add-composition",
            absCompDir,
            entryHtml,
            width: Math.max(1, Math.round(sequence.stage.width)),
            height: Math.max(1, Math.round(sequence.stage.height)),
            fps: Math.max(1, sequence.stage.fps),
            durationSec: Math.max(0.1, durationMs / 1000),
          },
        ]);
        record = readCurrentScriptErrorRecord(workspaceDir, absCompDir, entryHtml);
      }
      if (record) {
        if (record.timeline_expected && record.timeline_registered && record.timeline_paused === false) {
          throw new CutholError(
            DIAGNOSTICS.INVALID_COMPOSITION_CONTRACT(
              "composition",
              "timeline is not paused at run time: keep the main timeline paused until Cuthol seeks it"
            )
          );
        }
        if (!contract.ok && record.timeline_registered) {
          const recheck = validateHyperFramesCompositionContract(absCompDir, entryHtml, false, false, {
            timelineRegistered: true,
            timelinePaused: record.timeline_paused ?? null,
          });
          if (recheck.ok) contract = recheck;
        }
        const scriptDiag = scriptRecordToDiagnostic("composition", record);
        if (scriptDiag) {
          if (record.severity === "ERROR") throw new CutholError(scriptDiag);
          extraDiagnostics.push(scriptDiag);
        }
      }
    } catch (err) {
      if (err instanceof CutholError) throw err;
      // probe failure must never fail the add: the static verdict stands
    }

    if (!contract.ok) {
      throw new Error(`HyperFrames composition contract errors: ${contract.findings.join("; ")}`);
    }

    const res = addLaneCue({
      workspaceDir,
      laneId,
      kind: "composition",
      explicitId: strFlag(flags, "id"),
      anchor: anchorRef ? { ref: anchorRef, offset_ms: parseTimeMs(offsetRaw) } : null,
      atMs: parseTimeMs(atRaw),
      durationMs,
      zIndex: numFlag(flags, "z-index"),
      composition: {
        composition_dir: compDir,
        entry_html: entryHtml,
        props,
        transparent,
        mode,
      },
    });
    addCommitted = true;
    if (scaffoldStep?.sidecarFiles) {
      attachScaffoldToRevision({
        workspaceDir,
        absDir: absCompDir,
        revision: res.revision,
        sidecarFiles: scaffoldStep.sidecarFiles,
      });
    }
    // Absent `composition_audio` already means `mix`; only an explicit `off`
    // needs a second journaled write at creation time.
    const addCompAudio = parseCompositionAudioFlag(res.cue.id, strFlag(flags, "composition-audio"));
    let emitted = res;
    if (addCompAudio !== undefined && addCompAudio !== "mix") {
      emitted = await setCueCompositionAudio(workspaceDir, res.cue.id, addCompAudio);
    }
    const durationWarning = bareDurationWarning(strFlag(flags, "duration"));
    const addDiagnostics = [
      ...extraDiagnostics,
      ...(durationWarning ? [durationWarning] : []),
    ];
    emitEnvelopeJson(workspaceDir, "lane.add-composition", {
      action: "lane.add-composition",
      ...emitted,
      ...(scaffoldStep && scaffoldStep.overwritten.length > 0 ? { overwritten: scaffoldStep.overwritten } : {}),
      ...(addDiagnostics.length > 0 ? { diagnostics: addDiagnostics } : {}),
    });
    return;
    } finally {
      if (!addCommitted) scaffoldStep?.rollback();
    }
  }

  if (action === "update-cue") {
    const { updateLaneCue } = await import("./sequence/lanes.js");
    const cueId = strFlag(flags, "cue") ?? strFlag(flags, "id") ?? rest[0];
    if (!cueId) throw new Error("Provide --cue <cue_XX>.");
    const atRaw = strFlag(flags, "at");
    const durRaw = strFlag(flags, "duration");
    const inRaw = strFlag(flags, "in");
    const outRaw = strFlag(flags, "out");
    const rateRaw = strFlag(flags, "rate");
    const rate = rateRaw !== undefined ? Number(rateRaw.replace(/x$/i, "")) : undefined;
    const anchorRef = strFlag(flags, "anchor");
    const offsetRaw = strFlag(flags, "offset", "0ms")!;
    const anchorOpt =
      anchorRef !== undefined
        ? anchorRef === "none" || anchorRef === "null" || anchorRef === ""
          ? null
          : { ref: anchorRef, offset_ms: parseTimeMs(offsetRaw) }
        : undefined;
    const compAudioMode = parseCompositionAudioFlag(cueId, strFlag(flags, "composition-audio"));
    const fadeInRaw = strFlag(flags, "fade-in");
    const fadeOutRaw = strFlag(flags, "fade-out");
    const wantsLaneUpdate =
      compAudioMode === undefined ||
      atRaw !== undefined ||
      durRaw !== undefined ||
      inRaw !== undefined ||
      outRaw !== undefined ||
      rateRaw !== undefined ||
      flags["preserve-pitch"] !== undefined ||
      flags["z-index"] !== undefined ||
      anchorRef !== undefined ||
      flags["x"] !== undefined ||
      flags["y"] !== undefined ||
      flags["scale"] !== undefined ||
      flags["rotation"] !== undefined ||
      flags["rotate"] !== undefined ||
      flags["opacity"] !== undefined ||
      flags["text"] !== undefined ||
      flags["size"] !== undefined ||
      flags["max-width"] !== undefined ||
      flags["gain-db"] !== undefined ||
      flags["muted"] !== undefined ||
      fadeInRaw !== undefined ||
      fadeOutRaw !== undefined;
    let res = wantsLaneUpdate
      ? updateLaneCue({
          workspaceDir,
          cueId,
          atMs: atRaw ? parseTimeMs(atRaw) : undefined,
          durationMs: durRaw ? parseTimeMs(durRaw) : undefined,
          sourceInMs: inRaw ? parseTimeMs(inRaw) : undefined,
          sourceOutMs: outRaw ? parseTimeMs(outRaw) : undefined,
          rate,
          preservePitch: boolFlag(flags, "preserve-pitch"),
          zIndex: numFlag(flags, "z-index"),
          anchor: anchorOpt,
          xPct: strFlag(flags, "x"),
          yPct: strFlag(flags, "y"),
          scale: strFlag(flags, "scale"),
          rotationDeg: strFlag(flags, "rotation") ?? strFlag(flags, "rotate"),
          opacity: strFlag(flags, "opacity"),
          text: strFlag(flags, "text"),
          fontSizePx: numFlag(flags, "size"),
          maxWidthPct: numFlag(flags, "max-width"),
          gainDb: numFlag(flags, "gain-db"),
          muted: boolFlag(flags, "muted"),
          fadeInMs: fadeInRaw !== undefined ? parseTimeMs(fadeInRaw, { allowNegative: true }) : undefined,
          fadeOutMs: fadeOutRaw !== undefined ? parseTimeMs(fadeOutRaw, { allowNegative: true }) : undefined,
        })
      : null;
    if (compAudioMode !== undefined) {
      res = await setCueCompositionAudio(workspaceDir, cueId, compAudioMode);
    }
    emitEnvelopeJson(workspaceDir, "lane.update-cue", { action: "lane.update-cue", ...res });
    return;
  }

  if (action === "excise") {
    const { exciseLaneCueRanges } = await import("./sequence/lanes.js");
    const cueId =
      strFlag(flags, "cue") ?? strFlag(flags, "id") ?? strFlag(flags, "clip") ?? rest[0];
    const rangesRaw = strFlag(flags, "ranges");
    if (!cueId || !rangesRaw) {
      throw new Error("Provide --cue <cue_XX> --ranges <a..b,c..d>.");
    }
    const ranges = parseExciseRanges(rangesRaw);
    const coordFlag = strFlag(flags, "coord") as
      | "source"
      | "sequence"
      | "clip_local"
      | "cue_local"
      | undefined;
    const acrossFlag = strFlag(flags, "across") as LaneExciseRippleAcross | undefined;
    const res = exciseLaneCueRanges({
      workspaceDir,
      cueId,
      ranges,
      coordinateSpace: coordFlag,
      isSourceTime:
        flags["source-time"] !== undefined ? boolFlag(flags, "source-time") : undefined,
      ripple: boolFlag(flags, "ripple", true),
      across: acrossFlag,
    });
    emitEnvelopeJson(workspaceDir, "lane.excise", { action: "lane.excise", ...res });
    return;
  }

  if (action === "remove-cue") {
    const { removeLaneCues } = await import("./sequence/lanes.js");
    const cuesRaw = strFlag(flags, "cues") ?? strFlag(flags, "cue") ?? rest[0];
    if (!cuesRaw) throw new Error("Provide --cues <cue_01,cue_02>.");
    const cueIds = cuesRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const res = removeLaneCues({ workspaceDir, cueIds });
    emitEnvelopeJson(workspaceDir, "lane.remove-cue", { action: "lane.remove-cue", ...res });
    return;
  }
  return CLI_NOT_HANDLED;
}
