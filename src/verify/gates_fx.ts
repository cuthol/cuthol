// `spine fx` verification (G118 unknown kind / bad params, G119 unsupported envelope, G411 drift).
// The G118/G119 checks reuse the real stage-4 compiler per clip, so verify and render can never disagree:
// whatever the compiler would throw becomes a diagnostic attached to the offending clip. G411 (extension
// version/hash drift) is advisory and never blocks a commit. Clips without fx entries or fx envelopes are
// skipped untouched, so fx-less projects verify byte-identically to before.
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence, ExtensionEffectRef } from "../core/schema.js";
import type { WorkspacePaths } from "../core/workspace.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import {
  buildItemFxStage,
  itemFxNeedsCheck,
} from "../compositor/compile_fx_stage.js";
import { MOTION_FX_KIND } from "../effects/effect_types.js";
import { getSequenceEffectRegistry } from "../extensions/ext_effects.js";
import { verifyMotionLayers } from "./gates_motion.js";

export function verifySpineFx(
  seq: CutholSequence,
  paths: WorkspacePaths | undefined,
  diagnostics: CutholDiagnostic[]
): void {
  const owners: Array<{ id: string; fx?: import("../core/schema.js").ClipFxSpec[]; envelopes: import("../core/schema.js").ParameterEnvelope[] }> = [
    ...seq.spine.clips,
    ...seq.lanes.flatMap((lane) => lane.cues),
  ];
  if (!owners.some((o) => itemFxNeedsCheck(o))) return;
  // The fx stage only validates entry params and envelopes here.
  const ctx = { seq, paths } as VideoGraphCompileContext;
  for (const owner of owners) {
    if (!itemFxNeedsCheck(owner)) continue;
    try {
      buildItemFxStage(ctx, { owner, receivedPixFmt: "yuv420p", itemHasAlpha: false });
    } catch (err) {
      if (err instanceof CutholError && err.diagnostic) {
        diagnostics.push(err.diagnostic);
        continue;
      }
      throw err;
    }
  }
  verifyMotionLayers(seq, diagnostics);
  const rootDir = paths?.rootDir;
  if (!rootDir) return;
  let reg: ReturnType<typeof getSequenceEffectRegistry> | null = null;
  for (const owner of owners) {
    for (const fx of owner.fx ?? []) {
      // Motion entries are placement layers validated against the built-in `motion` definition
      // in `buildItemFxStage` above; they never carry extension drift.
      if (fx.enabled === false || fx.kind === MOTION_FX_KIND || !fx.kind.startsWith("ext:")) continue;
      reg ??= getSequenceEffectRegistry(seq, rootDir);
      const def = reg.fx.get(fx.kind as ExtensionEffectRef);
      if (def && !def.pinned_match) {
        const pinned = (seq.extensions ?? []).find((e) => e.name === def.extension);
        const pinnedLabel = pinned ? `v${pinned.version} (${pinned.content_hash.slice(0, 8)})` : "no record";
        diagnostics.push(
          DIAGNOSTICS.SPINE_FX_EXTENSION_DRIFTED(
            owner.id,
            fx.id,
            def.ref,
            def.extension,
            pinnedLabel,
            `v${def.version} (${def.content_hash.slice(0, 8)})`
          )
        );
      }
    }
  }
}
