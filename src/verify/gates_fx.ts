// `spine fx` verification (G118 unknown kind / bad params, G119 unsupported envelope, G411 drift).
// The G118/G119 checks reuse the real stage-4 compiler per clip, so verify and render can never disagree:
// whatever the compiler would throw becomes a diagnostic attached to the offending clip. G411 (extension
// version/hash drift) is advisory and never blocks a commit. Clips without fx entries or fx envelopes are
// skipped untouched, so fx-less projects verify byte-identically to before.
import fs from "node:fs";
import { CutholDiagnostic, CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import type { CutholSequence, ExtensionEffectRef } from "../core/schema.js";
import type { WorkspacePaths } from "../core/workspace.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import {
  buildItemFxStage,
  flattenFxStageParts,
  itemFxNeedsCheck,
} from "../compositor/compile_fx_stage.js";
import { MOTION_FX_KIND } from "../effects/effect_types.js";
import { BUILTIN_FX_KIND } from "../compositor/compile_spine_fx.js";
import { checkFrozenParam, checkFxChain } from "../effects/fx_check.js";
import { checkShaderSourceStatic, lookupShaderCompileResult } from "../effects/shader_def.js";
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
  const rootDirEarly = paths?.rootDir;
  const cueIds = new Set(seq.lanes.flatMap((lane) => lane.cues.map((cue) => cue.id)));
  for (const owner of owners) {
    if (!itemFxNeedsCheck(owner)) continue;
    // [ed G382] orphan `fx.*` envelopes on an item with no fx at all: the
    // stage compiler returns early with no entries and never reports them
    // (older builds wrote them silently). WARN here; orphans on items that
    // do carry fx still surface as G119 ERROR from the stage build below.
    if ((owner.fx ?? []).length === 0) {
      for (const env of owner.envelopes) {
        const m = /^fx\.([^.]+)\.(.+)$/.exec(env.parameter);
        if (m) {
          diagnostics.push(DIAGNOSTICS.VERIFY_FX_ENVELOPE_ORPHAN(owner.id, env.parameter, m[1]));
        }
      }
      continue;
    }
    try {
      const parts = buildItemFxStage(ctx, { owner, receivedPixFmt: "yuv420p", itemHasAlpha: false });
      // Shader fx on a lane cue is an ERROR here too (G709), never silent.
      if (cueIds.has(owner.id) && parts.some((p) => p.type === "shader_cut")) {
        const fxId = (owner.fx ?? []).find((e) => e.enabled !== false && e.kind.startsWith("ext:"))?.id ?? "shader";
        diagnostics.push(DIAGNOSTICS.SHADER_LANE_REJECTED(owner.id, fxId));
        continue;
      }
      // Shader entries compile through the worker at render; the browser
      // compile cache (written by `extension enable`) reports file:line
      // here (G710). A hash with no cached result gets the static scan
      // plus a WARN (G711). No browser ever opens here.
      for (const p of parts) {
        if (p.type !== "shader_cut") continue;
        for (const s of p.cut.steps) {
          if (s.kind !== "shader") continue;
          try {
            const src = fs.readFileSync(s.file, "utf8");
            const cached = lookupShaderCompileResult(rootDirEarly, src);
            if (cached) {
              if (!cached.ok) {
                diagnostics.push(
                  DIAGNOSTICS.SHADER_COMPILE_ERROR(s.file, cached.line ?? 0, cached.detail ?? "unknown error")
                );
              }
              continue;
            }
            const err = checkShaderSourceStatic(src);
            if (err) {
              diagnostics.push(DIAGNOSTICS.SHADER_COMPILE_ERROR(s.file, err.line, err.detail));
            } else {
              diagnostics.push(DIAGNOSTICS.SHADER_NOT_COMPILED_YET(s.file));
            }
          } catch {
            // Unreadable files already fail at compile time (G118 path).
          }
        }
      }
      // [fxcheck:A G320–G329] instance check: run the compiled chain on a card.
      const chain = flattenFxStageParts(parts).join(",");
      if (chain) {
        for (const f of checkFxChain(chain, {
          projectDir: rootDirEarly,
          itemId: owner.id,
          fxId: (owner.fx ?? []).map((e) => e.id).join(",") || "?",
          kind: (owner.fx ?? []).map((e) => e.kind).join(",") || "?",
        })) {
          diagnostics.push(
            f.severity === "ERROR"
              ? DIAGNOSTICS.FX_CHECK_FAILED(owner.id, "fx", "fx", f.filter, f.detail ?? f.message)
              : DIAGNOSTICS.FX_CHECK_PROBE_FAILED("fx", f.message)
          );
        }
        // [fxcheck:A G320–G329] frozen check: one triple-render per changing fx envelope.
        for (const env of owner.envelopes) {
          const em = /^fx\.([^.]+)\.(.+)$/.exec(env.parameter);
          if (!em) continue;
          const entry = (owner.fx ?? []).find((e) => e.id === em[1]);
          if (!entry || entry.enabled === false || entry.kind === MOTION_FX_KIND) continue;
          const vals = (env.points ?? []).map((pt) => pt.value);
          if (vals.length === 0 || !vals.some((v) => v !== vals[0])) continue;
          const staticChain = (value: number): string | null => {
            try {
              return flattenFxStageParts(buildItemFxStage(ctx, {
                owner: {
                  ...owner,
                  fx: [{ ...entry, params: { ...(entry.params as Record<string, unknown>), [em[2]]: value } } as typeof entry],
                  envelopes: [],
                },
                receivedPixFmt: "yuv420p", itemHasAlpha: false,
              })).join(",");
            } catch {
              return null;
            }
          };
          const chainInit = staticChain(vals[0]);
          const chainFinal = staticChain(vals[vals.length - 1]);
          if (!chainInit || !chainFinal) continue;
          let filterName = em[2];
          if (entry.kind === BUILTIN_FX_KIND) {
            const raw = String((entry.params as Record<string, unknown>)?.filter ?? "");
            const fm = /^([a-zA-Z0-9_]+)=/.exec(raw.trim());
            if (fm) filterName = fm[1];
          } else if (entry.kind.startsWith("ext:") && rootDirEarly) {
            const tpl = getSequenceEffectRegistry(seq, rootDirEarly).fx.get(entry.kind as never)?.spec.video_filter;
            const fm = tpl ? /^([a-zA-Z0-9_]+)=/.exec(tpl.trim()) : null;
            if (fm) filterName = fm[1];
          }
          for (const f of checkFrozenParam({
            filterName, chainWithInitial: chainInit, chainWithFinal: chainFinal,
            chainWithEnvelope: chain, frameIndex: 65, envelopeChangesValue: true,
            projectDir: rootDirEarly,
          })) {
            diagnostics.push(
              f.severity === "ERROR"
                ? DIAGNOSTICS.FX_PARAM_FROZEN(f.filter ?? filterName)
                : DIAGNOSTICS.FX_CHECK_PROBE_FAILED(f.filter ?? filterName, f.detail ?? "frame render unavailable")
            );
          }
        }
      }
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
