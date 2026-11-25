import fs from "node:fs";
import path from "node:path";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { CutholSequence } from "../core/schema.js";
import { WorkspacePaths } from "../core/workspace.js";

function newestCompositionFileMtimeMs(absCompDir: string, excludePath: string): number {
  // Same exclusion set as the overlay cache content hash: bridge-generated
  // files are rewritten by renders and must not count as composition edits.
  const isExcluded = (rel: string, name: string): boolean =>
    name.startsWith(".cuthol-") ||
    name.startsWith(".tmp.") ||
    name === "cuthol-bbox.json" ||
    rel === "assets/cuthol-data.json" ||
    rel === "assets/cuthol-data.js" ||
    rel === "assets/cuthol-bbox.json";
  let newest = 0;
  const stack: Array<{ dir: string; rel: string }> = [{ dir: absCompDir, rel: "" }];
  while (stack.length > 0) {
    const { dir, rel: relPrefix } = stack.pop() as { dir: string; rel: string };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (isExcluded(relPrefix ? `${relPrefix}/${e.name}` : e.name, e.name)) continue;
      const full = path.join(dir, e.name);
      if (full === excludePath) continue;
      try {
        if (e.isDirectory()) {
          if (e.name === ".hyperframes" || e.name === "snapshots" || e.name === "renders") continue;
          stack.push({ dir: full, rel: relPrefix ? `${relPrefix}/${e.name}` : e.name });
        } else if (e.isFile()) {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        }
      } catch {
        continue;
      }
    }
  }
  return newest;
}

export function verifyEmptyCompositions(
  sequence: CutholSequence,
  paths: WorkspacePaths | undefined
): CutholDiagnostic[] {
  const out: CutholDiagnostic[] = [];
  if (!paths) return out;
  for (const lane of sequence.lanes) {
    if (lane.muted) continue;
    for (const cue of lane.cues) {
      if (cue.kind !== "composition" || !cue.composition) continue;
      let absCompDir = "";
      try {
        absCompDir = path.isAbsolute(cue.composition.composition_dir)
          ? cue.composition.composition_dir
          : path.resolve(paths.rootDir, cue.composition.composition_dir);
      } catch {
        continue;
      }
      const sidecar = path.join(absCompDir, "assets/cuthol-bbox.json");
      try {
        if (!fs.existsSync(sidecar)) continue;
        const raw = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { empty?: boolean };
        if (!raw || raw.empty !== true) continue;
        // Only warn when composition files are unchanged since the sidecar
        // was written (mtime proxy for the overlay cache content hash).
        const sidecarMtime = fs.statSync(sidecar).mtimeMs;
        if (newestCompositionFileMtimeMs(absCompDir, sidecar) > sidecarMtime) continue;
        out.push(DIAGNOSTICS.EMPTY_COMPOSITION_VERIFY(cue.id));
      } catch {
        continue;
      }
    }
  }
  return out;
}
