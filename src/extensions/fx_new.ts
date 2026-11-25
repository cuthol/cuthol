// `extension fx-new`: append an fx skeleton to an extension manifest without
// touching any other byte: the new entry is inserted textually (other entries
// stay byte-identical), then the file is re-parsed to prove it still loads.
import fs from "node:fs";
import path from "node:path";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { resolveExtension } from "./manager.js";
import { EFFECT_NAME_RE } from "./ext_fx.js";

export type FxNewRole = "clip" | "transition" | "motion";

export const FX_NEW_ROLES: ReadonlyArray<FxNewRole> = ["clip", "transition", "motion"];

function sectionForRole(role: FxNewRole): string {
  return role === "clip" ? "fx" : role === "transition" ? "transitions" : "presets";
}

export function clipSkeleton(fxName: string, extName: string): Record<string, unknown> {
  return {
    description: `Skeleton clip effect '${fxName}' of extension '${extName}': brightness offset, replace the filter with the real one.`,
    params: {
      amount: {
        type: "number",
        default: 0.2,
        min: -1,
        max: 1,
        neutral: 0,
        description: "Brightness offset (-1 .. 1); 0 renders like no fx.",
      },
    },
    video_filter: "eq=brightness={{amount}}:eval=frame",
    animatable: ["amount"],
  };
}

export function transitionSkeleton(fxName: string, extName: string): Record<string, unknown> {
  return {
    description: `Skeleton transition '${fxName}' of extension '${extName}': sideways slide, tune the position templates.`,
    params: {
      distance: {
        type: "number",
        default: 0.25,
        min: 0,
        max: 1,
        description: "Slide distance as a fraction of the stage width.",
      },
    },
    hold_outgoing: true,
    incoming_x: "x+'{{p}}'*W*{{distance}}",
    outgoing_x: "x-'{{p}}'*W*{{distance}}",
  };
}

export function motionSkeleton(fxName: string, extName: string): Record<string, unknown> {
  return {
    description: `Skeleton motion preset '${fxName}' of extension '${extName}': scale punch over the whole clip, retune the anchors.`,
    params: {
      amount: {
        type: "number",
        default: 1,
        min: 0,
        max: 2,
        description: "Punch strength multiplier.",
      },
    },
    entries: [
      {
        kind: "motion",
        keys: {
          scale_x: [
            { at: "start", value: 1 },
            { at: "end", value: "1+0.2*amount" },
          ],
        },
      },
    ],
  };
}

function skeletonFor(role: FxNewRole, fxName: string, extName: string): Record<string, unknown> {
  if (role === "clip") return clipSkeleton(fxName, extName);
  if (role === "transition") return transitionSkeleton(fxName, extName);
  return motionSkeleton(fxName, extName);
}

function detectIndentUnit(rawText: string): string {
  const m = /^( +)"[^"\n]+"\s*:/m.exec(rawText);
  if (m) return m[1];
  return "  ";
}

function indentBlock(text: string, unit: string, depth: number): string {
  const pad = unit.repeat(depth);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/**
 * Insert `"entryName": <entry>` as the first key of the `section` object (or
 * of a new `section` object as the first root key). Returns the new text;
 * throws when the section cannot be located textually.
 */
/** Index of the closing brace matching the object opened at `openIdx`, or -1. */
function matchingClose(rawText: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = openIdx; j < rawText.length; j++) {
    const ch = rawText[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export function insertManifestEntry(
  rawText: string,
  section: string,
  entryName: string,
  entry: Record<string, unknown>
): string {
  const unit = detectIndentUnit(rawText);
  const entryJson = JSON.stringify(entry, null, 2);
  const openRe = new RegExp(`"${section}"\\s*:\\s*\\{`);
  const openMatch = openRe.exec(rawText);
  if (openMatch) {
    const openIdx = openMatch.index + openMatch[0].length - 1;
    const closeIdx = matchingClose(rawText, openIdx);
    if (closeIdx === -1) throw new Error(`section '${section}' is not closed.`);
    const body = rawText.slice(openIdx + 1, closeIdx);
    if (body.trim() === "") {
      const replacement = `"${section}": {\n${indentBlock(`"${entryName}": ${entryJson}`, unit, 2)}\n${unit}}`;
      return rawText.slice(0, openMatch.index) + replacement + rawText.slice(closeIdx + 1);
    }
    const insertion = `\n${indentBlock(`"${entryName}": ${entryJson},`, unit, 2)}`;
    return rawText.slice(0, openIdx + 1) + insertion + rawText.slice(openIdx + 1);
  }
  const rootOpen = rawText.indexOf("{");
  if (rootOpen === -1) throw new Error("manifest has no root object.");
  const insertion =
    `\n${unit}"${section}": {\n` +
    `${indentBlock(`"${entryName}": ${entryJson}`, unit, 2)}\n` +
    `${unit}},`;
  return rawText.slice(0, rootOpen + 1) + insertion + rawText.slice(rootOpen + 1);
}

const TRY_IT_HEADER = "## How to try it";

function tryItSection(extName: string, fxName: string, role: FxNewRole): string {
  const kind = role === "motion" ? `preset ext:${extName}/${fxName}` : `kind ext:${extName}/${fxName}`;
  return [
    ``,
    `${TRY_IT_HEADER}`,
    ``,
    `Skeleton '${fxName}' (role ${role}, ${role === "clip" ? `kind ext:${extName}/${fxName}` : kind}).`,
    ``,
    `- \`cuthol spine fx try --kind ext:${extName}/${fxName}\` (clip effects: one PNG grid through the sandbox).`,
    `- \`cuthol spine fx check --kind ext:${extName}/${fxName}\` (clip effects: definition check on a card).`,
    `- \`cuthol spine fx check --kind ext:${extName}/${fxName} --full\` (clip effects: delivery check through the real chain).`,
    `- \`cuthol spine fx preset --item <sp_XX> --preset ext:${extName}/${fxName}\` (motion presets: apply the template).`,
    ``,
  ].join("\n");
}

export function addFxSkeleton(options: {
  workspaceDir: string | null;
  extName: string;
  fxName: string;
  role: string;
}): { manifest_path: string; section: string; name: string; readme: string } {
  const { workspaceDir, extName, fxName, role } = options;
  if (role !== "clip" && role !== "transition" && role !== "motion") {
    throw new CutholError(DIAGNOSTICS.FX_NEW_UNKNOWN_ROLE(role));
  }
  if (!EFFECT_NAME_RE.test(fxName)) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `'${fxName}' is an invalid name (lowercase, [a-z0-9_-]).`)
    );
  }
  const ext = resolveExtension(extName, workspaceDir);
  if (!ext) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `extension '${extName}' was not found.`)
    );
  }
  const section = sectionForRole(role);
  const rawText = fs.readFileSync(ext.manifestPath, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText) as Record<string, unknown>;
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `manifest is not valid JSON (${err instanceof Error ? err.message : String(err)}).`)
    );
  }
  const sectionObj = parsed[section];
  if (sectionObj && typeof sectionObj === "object" && !Array.isArray(sectionObj)) {
    if (Object.prototype.hasOwnProperty.call(sectionObj, fxName)) {
      throw new CutholError(DIAGNOSTICS.FX_NEW_EXISTS(extName, fxName));
    }
  }
  const entry = skeletonFor(role, fxName, extName);
  const nextText = insertManifestEntry(rawText, section, fxName, entry);
  try {
    JSON.parse(nextText);
  } catch (err) {
    throw new CutholError(
      DIAGNOSTICS.INVALID_EXTENSION_MANIFEST(extName, `skeleton insert produced invalid JSON (${err instanceof Error ? err.message : String(err)}).`)
    );
  }
  fs.writeFileSync(ext.manifestPath, nextText, "utf8");

  const readmeName = typeof ext.manifest.guide === "string" ? ext.manifest.guide : "README.md";
  const readmePath = path.join(ext.dir, readmeName);
  let readmeText = "";
  if (fs.existsSync(readmePath)) readmeText = fs.readFileSync(readmePath, "utf8");
  if (!readmeText.includes(TRY_IT_HEADER)) {
    if (readmeText.length > 0 && !readmeText.endsWith("\n")) readmeText += "\n";
    readmeText += tryItSection(extName, fxName, role);
    fs.writeFileSync(readmePath, readmeText, "utf8");
  }
  return { manifest_path: ext.manifestPath, section, name: fxName, readme: readmePath };
}
