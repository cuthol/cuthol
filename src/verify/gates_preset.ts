// Preset binding gate (G369): an fx entry written by a preset records the
// anchors its points were computed from. Recompute the expected points from
// the record with the item's current duration (and the current beat grid)
// and WARN when they no longer match the entry's envelopes. One rule: points
// do not match the record -> WARN. Split/excise drop the record on halves
// whose generated points were sliced, so those halves stay silent; trims
// never drop it, so a trim that cuts generated points warns here.
import { DIAGNOSTICS, type CutholDiagnostic } from "../core/diagnostics.js";
import type { CutholSequence } from "../core/schema.js";
import type { WorkspacePaths } from "../core/workspace.js";
import {
  diffPresetPoints,
  loadBeatGridLocal,
  recomputePresetPoints,
} from "../effects/preset_apply.js";

/**
 * Append preset-drift WARNs. Beat-anchored mismatches on several entries
 * collapse into one WARN suggesting `--reapply --all`; every other mismatch
 * warns per entry suggesting `--reapply`.
 */
export function verifyPresetBindings(
  seq: CutholSequence,
  paths: { rootDir?: string } | WorkspacePaths,
  diagnostics: CutholDiagnostic[]
): void {
  const workspaceDir = paths.rootDir;
  if (!workspaceDir) return;
  const perEntry: Array<{ clipId: string; fxId: string; what: string; beatAnchored: boolean }> = [];
  for (const clip of seq.spine.clips) {
    for (const entry of clip.fx ?? []) {
      if (!entry.preset) continue;
      const recomputed = recomputePresetPoints({ workspaceDir, seq, clip, entry });
      if (!recomputed) continue;
      const diff = recomputed.unresolvable ?? diffPresetPoints(clip, entry.id, recomputed.points);
      if (!diff) continue;
      const beatAnchored = entry.preset.points.some((p) => p.anchor === "beat");
      let what = diff;
      if (beatAnchored && entry.preset.beats) {
        try {
          const grid = loadBeatGridLocal(workspaceDir, seq, clip.id, entry.preset.beats.asset_handle, entry.preset.preset);
          if (grid.hash !== entry.preset.beats.grid_hash) {
            what = `beat grid changed (grid ${entry.preset.beats.grid_hash.slice(0, 8)} -> ${grid.hash.slice(0, 8)}); ${diff}`;
          }
        } catch {
          what = `beat grid '${entry.preset.beats.asset_handle}' no longer resolves; ${diff}`;
        }
      }
      perEntry.push({ clipId: clip.id, fxId: entry.id, what, beatAnchored });
    }
  }
  if (perEntry.length === 0) return;
  const beatOnes = perEntry.filter((e) => e.beatAnchored);
  const rest = perEntry.filter((e) => !e.beatAnchored);
  for (const e of rest) {
    diagnostics.push(DIAGNOSTICS.PRESET_DRIFTED(e.fxId, `${e.clipId}: ${e.what}`, e.clipId));
  }
  if (beatOnes.length === 1) {
    const e = beatOnes[0];
    diagnostics.push(DIAGNOSTICS.PRESET_DRIFTED(e.fxId, `${e.clipId}: ${e.what}`, e.clipId));
  } else if (beatOnes.length > 1) {
    const ids = beatOnes.map((e) => `${e.clipId}/${e.fxId}`).join(", ");
    const first = beatOnes[0];
    diagnostics.push({
      ...DIAGNOSTICS.PRESET_DRIFTED(first.fxId, `beat-anchored entries no longer match their anchors: ${ids} (reapply overwrites hand edits)`, first.clipId),
      suggestion: `Regenerate them with 'cuthol spine fx preset --item ${first.clipId} --reapply --all'.`,
    });
  }
}
