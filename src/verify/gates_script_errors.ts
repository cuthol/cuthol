// G4 composition page script errors (CUTHOL-G430..G432): reports the script-error record
// matching the current composition files, WITHOUT a browser. Records are written by
// coordinate measurement (every frame seek), `composition preview` (`hyperframes check`),
// and the monitor probe (page load plus timeline seeks); a record matches only the exact
// files it was measured against, so an unknown composition stays silent (never "clean").
import path from "node:path";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";
import { readCurrentScriptErrorRecord } from "../compositor/coords_extract.js";
import {
  ScriptProbeJob,
  probeScriptRecordsChildSync,
  scriptRecordToDiagnostic,
} from "../compositor/hf_script_errors.js";

/**
 * Probes every composition cue that has no cached script-error record yet, in
 * one shared browser run. Records are keyed by composition content hash, so a
 * clean project pays this cost once and the next verify is fast. Never throws:
 * a probe failure leaves the cue unprobed and `verifyCompositionScripts`
 * reports it with the never-probed notice. Returns the probed cue count.
 */
export function probeUncachedCompositionScripts(
  sequence: CutholSequence,
  paths: WorkspacePaths | undefined
): number {
  if (!paths) return 0;
  const jobs: ScriptProbeJob[] = [];
  for (const lane of sequence.lanes) {
    if (lane.muted) continue;
    if (lane.kind === "music" || lane.kind === "sfx" || lane.kind === "voiceover") continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      let absCompDir: string;
      try {
        absCompDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);
      } catch {
        continue;
      }
      if (readCurrentScriptErrorRecord(paths.rootDir, absCompDir, cue.composition.entry_html)) continue;
      jobs.push({
        cueId: cue.id,
        absCompDir,
        entryHtml: cue.composition.entry_html,
        width: Math.max(1, Math.round(sequence.stage.width)),
        height: Math.max(1, Math.round(sequence.stage.height)),
        fps: Math.max(1, sequence.stage.fps),
        durationSec: Math.max(0.1, (cue.duration_ms || 0) / 1000),
      });
    }
  }
  if (jobs.length === 0) return 0;
  probeScriptRecordsChildSync(paths.rootDir, jobs);
  return jobs.length;
}

export function verifyCompositionScripts(
  sequence: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  if (!paths) return;
  let unprobedCount = 0;
  for (const lane of sequence.lanes) {
    if (lane.muted) continue;
    if (lane.kind === "music" || lane.kind === "sfx" || lane.kind === "voiceover") continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      let absCompDir: string;
      try {
        absCompDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);
      } catch {
        continue;
      }
      const record = readCurrentScriptErrorRecord(paths.rootDir, absCompDir, cue.composition.entry_html);
      if (!record) {
        unprobedCount++;
        continue;
      }
      if (record.timeline_expected && record.timeline_registered && record.timeline_paused === false) {
        diagnostics.push(
          DIAGNOSTICS.INVALID_COMPOSITION_CONTRACT(
            cue.id,
            "timeline is not paused at run time: keep the main timeline paused until Cuthol seeks it"
          )
        );
      }
      const diag = scriptRecordToDiagnostic(cue.id, record);
      if (diag) diagnostics.push(diag);
    }
  }
  if (unprobedCount > 0) {
    diagnostics.push(DIAGNOSTICS.COMPOSITIONS_NEVER_PROBED_IN_BROWSER(unprobedCount));
  }
}
