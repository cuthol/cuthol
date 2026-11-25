/**
 * Cuthol 5-Gate Deterministic Sequence Verification Engine (`src/verify/gates.ts`).
 *
 * Gates & Severity Policy:
 * - G1_SCHEMA (ERROR -> Rollback): Schema version, unique handles, asset & anchor reference integrity.
 * - G2_ASSETS (ERROR -> Rollback): Physical file existence on disk and `[source_in_ms, source_out_ms]` media bounds.
 * - G3_TIMING (ERROR -> Rollback): Minimum 2-frame duration budget, magnetic spine continuity, transition overlap bounds, envelope bounds.
 * - G4_STAGE  (WARN -> Commit + Advisory): EBU R95 / SMPTE ST 2046-1 / 9:16 Safe Zones, real typography bounding box (`measureCuePixelBox`),
 *             Netflix Timed Text reading speed (`<= 17 CPS` EN / `<= 19 CPS` TR), and `z_index` layer occlusion.
 * - G5_SIGNAL (WARN -> Commit + Advisory): ITU-R BS.1770-4 True Peak ceiling (`-1.0 dBTP`) and gain clipping checks.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CutholDiagnostic,
  CutholError,
  DIAGNOSTICS,
  VerificationGateId,
} from "../core/diagnostics.js";
import { adoptExternalCompositionEdits } from "../core/external_changes.js";
import { CutholSequence, LaneCue } from "../core/schema.js";
import { commitSequenceMutation, loadSequence, WorkspacePaths } from "../core/workspace.js";
import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { wrapTypographyLines } from "../compositor/ass_generator.js";
import {
  placementAnimatesAny,
  placementChannelRange,
  placementRestingSegments,
  placementStaticValue,
  resolvedPlacementCopyAt,
} from "../sequence/placement_resolve.js";
import { verifyG1Schema, verifyG2Assets, verifyG3Timing } from "./gates_structural.js";
import { verifyEasing } from "./gates_easing.js";
import { verifyG4Stage, verifyG5Signal } from "./gates_stage_signal.js";
import { probeUncachedCompositionScripts, verifyCompositionScripts } from "./gates_script_errors.js";
import { verifyCompositionAudio } from "./gates_hf_audio.js";
import { verifyEdgeMode } from "./gates_edge.js";
import { verifyExtensionTransitions } from "./gates_transition.js";
import { verifySpineFx } from "./gates_fx.js";
import { verifyPresetBindings } from "./gates_preset.js";
import { verifyTransitionBackstop } from "./gates_transitions.js";
import { verifyColorGates } from "./gates_color.js";
import { measureAssetAcousticWindows } from "../library/waveform.js";
import { summarizeJoinEdgeLoudness } from "../speech/cleanup_acoustic.js";

/**
 * Surfaces the cleanup join-edge summary as INFO on `verify` (best effort:
 * skipped when no excise joins exist or acoustic profiles are unmeasurable).
 */
function pushJoinEdgeSummaryInfo(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  if (!paths) return;
  try {
    const byAsset = new Map<string, typeof seq.spine.clips>();
    for (const clip of seq.spine.clips) {
      const list = byAsset.get(clip.asset_handle) ?? [];
      list.push(clip);
      byAsset.set(clip.asset_handle, list);
    }
    let hasJoin = false;
    for (const list of byAsset.values()) {
      const sorted = list.slice().sort((a, b) => a.source_in_ms - b.source_in_ms);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i + 1].source_in_ms >= sorted[i].source_out_ms + 2) {
          hasJoin = true;
          break;
        }
      }
      if (hasJoin) break;
    }
    if (!hasJoin) return;
    const profileByHandle = new Map<string, ReturnType<typeof measureAssetAcousticWindows>>();
    for (const asset of byAsset.keys()) {
      try {
        profileByHandle.set(asset, measureAssetAcousticWindows({ workspaceDir: paths.rootDir, handle: asset }));
      } catch {
        profileByHandle.set(asset, null);
      }
    }
    const summary = summarizeJoinEdgeLoudness({ clips: seq.spine.clips, profileByHandle });
    if (summary.total_joins === 0) return;
    diagnostics.push(DIAGNOSTICS.JOIN_EDGE_SUMMARY(summary.summary_line));
  } catch {
    // Acoustic summary is informational only; never fail verification for it.
  }
}
import { verifyEmptyCompositions } from "./gates_empty_composition.js";
import { verifyBoundaryContinuity } from "./gates_boundary.js";

export { verifyG1Schema, verifyG2Assets, verifyG3Timing } from "./gates_structural.js";
export { verifyG4Stage, verifyG5Signal } from "./gates_stage_signal.js";

export interface PixelBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  lines_count?: number;
}

export interface VerificationReport {
  ok: boolean;
  revision: number;
  gates_run: VerificationGateId[];
  error_count: number;
  warning_count: number;
  info_count?: number;
  diagnostics: CutholDiagnostic[];
}

/**
 * Computes the exact pixel bounding box `[left, top, right, bottom]` of a `LaneCue`
 * on the stage canvas (`width x height`), accounting for typography metrics, line wrapping,
 * relative percentage offset (`x_pct`, `y_pct` from stage center), and `scale_x` / `scale_y`.
 */
export function measureCuePixelBox(
  stage: CutholSequence["stage"],
  cue: LaneCue,
  assetAspectRatio?: number,
  rootDir?: string
): PixelBoundingBox {
  // An item whose placement animates (base or motion layers) is measured at its
  // widest over the item: per-channel extremes from `placementChannelRange`.
  // Items that do not animate use the static value exactly as before.
  const animatesPlacement = placementAnimatesAny(cue, ["x_pct", "y_pct", "scale_x", "scale_y", "rotation_deg"]);
  const rangeOf = (c: "x_pct" | "y_pct" | "scale_x" | "scale_y" | "rotation_deg" | "opacity") =>
    placementChannelRange(cue, c);
  const pickX = animatesPlacement ? (rangeOf("x_pct").min + rangeOf("x_pct").max) / 2 : placementStaticValue(cue, "x_pct");
  const pickY = animatesPlacement ? (rangeOf("y_pct").min + rangeOf("y_pct").max) / 2 : placementStaticValue(cue, "y_pct");
  const pickScaleX = animatesPlacement
    ? Math.max(Math.abs(rangeOf("scale_x").min), Math.abs(rangeOf("scale_x").max))
    : Math.abs(placementStaticValue(cue, "scale_x"));
  const pickScaleY = animatesPlacement
    ? Math.max(Math.abs(rangeOf("scale_y").min), Math.abs(rangeOf("scale_y").max))
    : Math.abs(placementStaticValue(cue, "scale_y"));
  const rotRange = rangeOf("rotation_deg");
  const pickRot = animatesPlacement
    ? Math.abs(rotRange.min) >= Math.abs(rotRange.max) ? rotRange.min : rotRange.max
    : placementStaticValue(cue, "rotation_deg");
  let centerX = stage.width * 0.5 + (pickX / 100) * stage.width;
  const centerY = stage.height * 0.5 + (pickY / 100) * stage.height;

  let baseWidth = stage.width * 0.5;
  let baseHeight = stage.height * 0.2;
  let linesCount = 1;
  let effectiveCenterY = centerY;

  if (cue.typography) {
    const typo = cue.typography;
    const avgCharWidthPx = typo.font_size_px * 0.55;

    let longestLinePx = 0;
    let totalLines = 1;

    const activeWords = (typo.words ?? []).filter(
      (w) => !w.excised && w.sequence_start_ms !== null && w.sequence_end_ms !== null
    );
    if (activeWords.length > 0 && typo.active_word_color_hex) {
      const maxBoxWidthPx = stage.width * (Math.max(15, Math.min(95, typo.max_width_pct)) / 100);
      let currentLineLen = activeWords[0].word.length;
      totalLines = 1;
      longestLinePx = currentLineLen * avgCharWidthPx;
      for (let i = 1; i < activeWords.length; i++) {
        const wLen = activeWords[i].word.length;
        if ((currentLineLen + 1 + wLen) * avgCharWidthPx <= maxBoxWidthPx) {
          currentLineLen += 1 + wLen;
        } else {
          longestLinePx = Math.max(longestLinePx, currentLineLen * avgCharWidthPx);
          totalLines++;
          currentLineLen = wLen;
        }
        longestLinePx = Math.max(longestLinePx, currentLineLen * avgCharWidthPx);
      }
    } else {
      const wrapped = wrapTypographyLines(
        typo.text ?? "",
        typo.font_size_px,
        stage.width,
        typo.max_width_pct
      );
      totalLines = wrapped.lines.length;
      longestLinePx = wrapped.maxLineWidthPx;
    }

    linesCount = Math.max(1, totalLines);
    const padX = typo.box_color_hex ? typo.font_size_px * 0.8 : typo.stroke_width_px * 4 + 28;
    const padY = typo.box_color_hex ? typo.font_size_px * 0.5 : typo.stroke_width_px * 4 + 18;
    baseWidth = longestLinePx + padX;
    baseHeight = linesCount * (typo.font_size_px * 1.25) + padY;
  } else if (cue.composition) {
    if (cue.composition.transparent === false || cue.composition.mode === "scene_host") {
      baseWidth = stage.width;
      baseHeight = stage.height;
    } else {
      // Detect actual HyperFrames preset geometry (`title_card`, `stat_callout`, `badge_overlay`, `lower_third`)
      // from props or the HTML file's CSS classes so monitor bounding boxes match the rendered card!
      const baseDir = rootDir ?? process.cwd();
      const compDir = path.isAbsolute(cue.composition.composition_dir)
        ? cue.composition.composition_dir
        : path.resolve(baseDir, cue.composition.composition_dir);
      const bboxSidecarPath = path.join(compDir, "assets/cuthol-bbox.json");

      let detectedPreset = String(cue.composition.props?.preset ?? "");
      if (!detectedPreset) {
        try {
          const htmlPath = path.join(compDir, cue.composition.entry_html);
          if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, "utf8");
            if (html.includes('class="title-banner"')) detectedPreset = "title_card";
            else if (html.includes('class="stat-card"')) detectedPreset = "stat_callout";
            else if (html.includes('class="badge-overlay-box"')) detectedPreset = "badge_overlay";
            else if (html.includes('class="lower-third-box"')) detectedPreset = "lower_third";
          }
        } catch {
          // ignore read error
        }
      }

      // For custom (non-preset) compositions, prefer the real measured alpha-channel bounding box from assets/cuthol-bbox.json!
      let appliedMeasuredAlphaBbox = false;
      if (!detectedPreset && fs.existsSync(bboxSidecarPath)) {
        try {
          const measured = JSON.parse(fs.readFileSync(bboxSidecarPath, "utf8")) as {
            left_pct: number;
            top_pct: number;
            right_pct: number;
            bottom_pct: number;
            width_pct: number;
            height_pct: number;
          };
          if (
            Number.isFinite(measured.width_pct) &&
            Number.isFinite(measured.height_pct) &&
            measured.width_pct > 0 &&
            measured.height_pct > 0
          ) {
            baseWidth = stage.width * measured.width_pct;
            baseHeight = stage.height * measured.height_pct;
            const naturalCenterX = stage.width * ((measured.left_pct + measured.right_pct) / 2);
            const naturalCenterY = stage.height * ((measured.top_pct + measured.bottom_pct) / 2);
            centerX = naturalCenterX + (pickX / 100) * stage.width;
            effectiveCenterY = naturalCenterY + (pickY / 100) * stage.height;
            appliedMeasuredAlphaBbox = true;
          }
        } catch {
          // ignore corrupt sidecar
        }
      }

      if (!appliedMeasuredAlphaBbox) {
        if (detectedPreset === "title_card") {
          baseWidth = stage.width * 0.66;
          baseHeight = stage.height * 0.24;
          effectiveCenterY = centerY;
        } else if (detectedPreset === "stat_callout") {
          baseWidth = stage.width * 0.54;
          baseHeight = stage.height * 0.24;
          effectiveCenterY = centerY;
        } else if (detectedPreset === "badge_overlay") {
          baseWidth = stage.width * 0.36;
          baseHeight = stage.height * 0.08;
          if (pickX === 0 && pickY === 0) {
            centerX = stage.width * 0.76;
            effectiveCenterY = stage.height * 0.09;
          }
        } else {
          // lower_third default (top: 58%, left: 90px)
          baseWidth = stage.width * 0.78;
          baseHeight = stage.height * 0.12;
          effectiveCenterY = stage.height * 0.64 + (pickY / 100) * stage.height;
        }
      }
    }
  } else {
    // Visual B-roll or graphic overlay: width is stage.width, height follows asset aspect ratio
    baseWidth = stage.width;
    const ar = assetAspectRatio && assetAspectRatio > 0 ? assetAspectRatio : stage.width / stage.height;
    baseHeight = baseWidth / ar;
  }

  let finalWidth = baseWidth * pickScaleX;
  let finalHeight = baseHeight * pickScaleY;

  if (Math.abs(pickRot) > 0.01) {
    const rad = (pickRot * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const rotW = finalWidth * cos + finalHeight * sin;
    const rotH = finalWidth * sin + finalHeight * cos;
    finalWidth = rotW;
    finalHeight = rotH;
  }

  if (animatesPlacement) {
    // The box covers the item's whole travel: widen by the position ranges.
    finalWidth += ((rangeOf("x_pct").max - rangeOf("x_pct").min) / 100) * stage.width;
    finalHeight += ((rangeOf("y_pct").max - rangeOf("y_pct").min) / 100) * stage.height;
  }

  const left = Math.round(centerX - finalWidth / 2);
  const right = Math.round(centerX + finalWidth / 2);
  const top = Math.round(effectiveCenterY - finalHeight / 2);
  const bottom = Math.round(effectiveCenterY + finalHeight / 2);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    lines_count: linesCount,
  };
}

/** Box of a cue with placement resolved at one cue-local time (resting midpoint). */
export function measureCuePixelBoxAtLocalMs(
  stage: CutholSequence["stage"],
  cue: LaneCue,
  localMs: number,
  assetAspectRatio?: number,
  rootDir?: string
): PixelBoundingBox {
  return measureCuePixelBox(stage, resolvedPlacementCopyAt(cue, localMs), assetAspectRatio, rootDir);
}

/**
 * Safe-zone box of a cue: the union of the boxes measured at the midpoints of the
 * cue's resting segments (resolved values). Falls back to the range box when the cue
 * has no resting segment.
 */
export function measureCueSafeZoneBox(
  stage: CutholSequence["stage"],
  cue: LaneCue,
  assetAspectRatio?: number,
  rootDir?: string
): PixelBoundingBox {
  const resting = placementRestingSegments(cue, cue.duration_ms);
  if (resting.length === 0) return measureCuePixelBox(stage, cue, assetAspectRatio, rootDir);
  let box = measureCuePixelBoxAtLocalMs(stage, cue, (resting[0][0] + resting[0][1]) / 2, assetAspectRatio, rootDir);
  for (let i = 1; i < resting.length; i++) {
    const b = measureCuePixelBoxAtLocalMs(
      stage, cue, (resting[i][0] + resting[i][1]) / 2, assetAspectRatio, rootDir
    );
    box = {
      left: Math.min(box.left, b.left),
      top: Math.min(box.top, b.top),
      right: Math.max(box.right, b.right),
      bottom: Math.max(box.bottom, b.bottom),
      width: Math.max(box.right, b.right) - Math.min(box.left, b.left),
      height: Math.max(box.bottom, b.bottom) - Math.min(box.top, b.top),
    };
  }
  return box;
}

export function verifySequence(
  seq: CutholSequence,
  paths?: WorkspacePaths,
  enabledGates?: VerificationGateId[]
): VerificationReport {
  const gatesToRun: VerificationGateId[] = enabledGates ?? [
    "G1_SCHEMA",
    "G2_ASSETS",
    "G3_TIMING",
    "G4_STAGE",
    "G5_SIGNAL",
  ];
  const gateSet = new Set<VerificationGateId>(gatesToRun);
  const diagnostics: CutholDiagnostic[] = [];

  const libMap = new Map(seq.library.map((item) => [item.handle, item]));
  const spineMap = new Map(seq.spine.clips.map((clip) => [clip.id, clip]));

  // --- Gate 1: Schema & Handle Integrity (G1_SCHEMA) ---
  if (gateSet.has("G1_SCHEMA")) {
    verifyG1Schema(seq, libMap, spineMap, diagnostics);
    verifyEasing(seq, diagnostics);
    verifySpineFx(seq, paths, diagnostics);
    if (paths) verifyPresetBindings(seq, paths, diagnostics);
    verifyTransitionBackstop(seq, paths, diagnostics);
    verifyColorGates(seq, diagnostics, paths?.rootDir);
  }

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  if (gateSet.has("G2_ASSETS")) {
    verifyG2Assets(seq, paths, libMap, diagnostics);
  }

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  if (gateSet.has("G3_TIMING")) {
    verifyG3Timing(seq, diagnostics, paths);
  }

  if (gateSet.has("G1_SCHEMA") || gateSet.has("G4_STAGE")) verifyExtensionTransitions(seq, paths, diagnostics, gateSet);

  // --- Gate 4: Stage Geometry, Safe Zones, Caption CPS & Layer Occlusion (G4_STAGE) ---
  if (gateSet.has("G4_STAGE")) {
    verifyG4Stage(seq, paths, libMap, diagnostics);
    verifyEdgeMode(seq, diagnostics);
    verifyCompositionAudio(seq, paths, diagnostics);
    // Recorded composition page script errors (no browser: reads the content-keyed
    // records that measurement, preview, and the monitor probe wrote).
    verifyCompositionScripts(seq, paths, diagnostics);
    diagnostics.push(...verifyEmptyCompositions(seq, paths));
  }

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  if (gateSet.has("G5_SIGNAL")) {
    verifyG5Signal(seq, paths, libMap, diagnostics);
    verifyBoundaryContinuity(seq, paths, diagnostics);
    pushJoinEdgeSummaryInfo(seq, paths, diagnostics);
  }

  const errorCount = diagnostics.filter((d) => d.severity === "ERROR").length;
  const warningCount = diagnostics.filter((d) => d.severity === "WARN").length;
  const infoCount = diagnostics.filter((d) => d.severity === "INFO").length;

  return {
    ok: errorCount === 0,
    revision: seq.meta.revision,
    gates_run: gatesToRun,
    error_count: errorCount,
    warning_count: warningCount,
    ...(infoCount > 0 ? { info_count: infoCount } : {}),
    diagnostics,
  };
}

/**
 * Adopts composition-file-only outside edits without throwing. Null when there
 * is nothing composition-only to adopt, or when adoption itself fails (the
 * explicit `changes adopt` / `revert` flow stays responsible then).
 */
function adoptExternalCompositionEditsSafe(
  workspaceDir: string
): { adopted_comps: string[]; revision: number; summary_line: string } | null {
  try {
    return adoptExternalCompositionEdits(workspaceDir, { automatic: true });
  } catch {
    return null;
  }
}

/**
 * Replaces two or more per-range backdrop-gap warnings (CUTHOL-G308) with one
 * summary warning (CUTHOL-G461). Edit commands print the summary; `verify`
 * keeps the full per-range list.
 */
function collapseBackdropGapWarnings(diagnostics: CutholDiagnostic[]): void {
  const gaps = diagnostics.filter((d) => d.code === "CUTHOL-G308");
  if (gaps.length <= 1) return;
  let totalMs = 0;
  for (const g of gaps) {
    const m = /in (\d+)\.\.(\d+)ms/.exec(g.what);
    if (m) totalMs += Number(m[2]) - Number(m[1]);
  }
  const kept = diagnostics.filter((d) => d.code !== "CUTHOL-G308");
  kept.push(DIAGNOSTICS.BACKDROP_GAPS_SUMMARY(gaps.length, totalMs));
  diagnostics.length = 0;
  diagnostics.push(...kept);
}

/**
 * Executes a sequence mutation inside `JournalGuard` and runs the 5-Gate Verification Engine
 * before committing to disk. If any `ERROR`-level diagnostic is detected, throws `CutholError`
 * so `JournalGuard` automatically aborts and leaves `cuthol.sequence.json` untouched.
 */
export function commitVerifiedMutation<T>(
  workspaceDir: string,
  operation: string,
  mutator: (seq: CutholSequence, paths: WorkspacePaths) => T
): { result: T; sequence: CutholSequence; revision: number; verification: VerificationReport } {
  let verificationReport!: VerificationReport;
  const autoAdopted = adoptExternalCompositionEditsSafe(workspaceDir);

  const { result, sequence, revision } = commitSequenceMutation(
    workspaceDir,
    operation,
    (seq, paths) => {
      const out = mutator(seq, paths);
      const preCheck = verifySequence(seq, paths, ["G1_SCHEMA", "G2_ASSETS", "G3_TIMING"]);
      if (!preCheck.ok) {
        const firstError = preCheck.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstError, preCheck.diagnostics);
      }
      try {
        syncAllCompositionBridges(seq, paths);
      } catch {
        // non-blocking bridge sync
      }
      verificationReport = verifySequence(seq, paths);
      if (!verificationReport.ok) {
        const firstError = verificationReport.diagnostics.find((d) => d.severity === "ERROR")!;
        throw new CutholError(firstError, verificationReport.diagnostics);
      }
      return out;
    }
  );

  collapseBackdropGapWarnings(verificationReport.diagnostics);
  if (autoAdopted) {
    verificationReport.diagnostics.push(
      DIAGNOSTICS.EXTERNAL_COMPOSITION_EDITS_AUTO_ADOPTED(autoAdopted.adopted_comps)
    );
  }
  verificationReport.error_count = verificationReport.diagnostics.filter((d) => d.severity === "ERROR").length;
  verificationReport.warning_count = verificationReport.diagnostics.filter((d) => d.severity === "WARN").length;
  verificationReport.info_count = verificationReport.diagnostics.filter((d) => d.severity === "INFO").length;

  return { result, sequence, revision, verification: verificationReport };
}

export function runWorkspaceVerification(
  workspaceDir: string,
  gates?: VerificationGateId[]
): VerificationReport {
  const auto = adoptExternalCompositionEditsSafe(workspaceDir);
  const { paths, sequence } = loadSequence(workspaceDir);
  // Compositions never opened in a browser get one shared probe run here, so
  // a real script error surfaces in verify (G430–G432) instead of only at the
  // first monitor call. Cached records make the second verify fast.
  probeUncachedCompositionScripts(sequence, paths);
  const report = verifySequence(sequence, paths, gates);
  if (auto) {
    report.diagnostics.push(DIAGNOSTICS.EXTERNAL_COMPOSITION_EDITS_AUTO_ADOPTED(auto.adopted_comps));
    report.info_count = (report.info_count ?? 0) + 1;
  }
  return report;
}
