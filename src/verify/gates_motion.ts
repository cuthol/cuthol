// Motion-layer verify warnings: the combined placement value is what render draws,
// so a combined range the renderer must clamp (opacity above 1) or collapse
// (scale crossing or touching 0) is worth a WARN naming the item, channel, range
// and the layers involved. WARN never stops anything.
import type { CutholDiagnostic } from "../core/diagnostics.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence } from "../core/schema.js";
import {
  placementChannelRange,
  placementLayers,
  type PlacementChannel,
} from "../sequence/placement_resolve.js";

function layerIds(owner: { fx?: Array<{ id: string }> }): string {
  return placementLayers(owner as Parameters<typeof placementLayers>[0])
    .map((l) => l.id)
    .join(", ");
}

function fmtRange(r: { min: number; max: number }): string {
  const f = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
  return `[${f(r.min)}..${f(r.max)}]`;
}

export function verifyMotionLayers(seq: CutholSequence, diagnostics: CutholDiagnostic[]): void {
  const owners: Array<{ id: string; fx?: CutholSequence["spine"]["clips"][number]["fx"]; envelopes: CutholSequence["spine"]["clips"][number]["envelopes"]; placement: CutholSequence["spine"]["clips"][number]["placement"] }> = [
    ...seq.spine.clips,
    ...seq.lanes.flatMap((lane) => lane.cues),
  ];
  for (const owner of owners) {
    const layers = placementLayers(owner);
    if (layers.length === 0) continue;
    const ids = layerIds(owner);
    const opacity = placementChannelRange(owner, "opacity");
    if (opacity.max > 1) {
      diagnostics.push(
        DIAGNOSTICS.MOTION_OPACITY_CLAMPED(owner.id, fmtRange(opacity), ids)
      );
    }
    for (const channel of ["scale_x", "scale_y"] as const satisfies readonly PlacementChannel[]) {
      const r = placementChannelRange(owner, channel);
      if (r.min <= 0 && 0 <= r.max) {
        diagnostics.push(
          DIAGNOSTICS.MOTION_SCALE_ZERO(owner.id, channel, fmtRange(r), ids)
        );
      }
    }
  }
}
