/**
 * Gate: every `cuthol ...` command quoted in `src/core/diagnostics.ts` or in an
 * explain `fix` line must parse against the action catalog (action exists,
 * every --flag is a flag of that action; `<placeholders>` allowed).
 * Commands that fail today are pinned in `src/explain/command_allowlist.json`,
 * which only shrinks (shared gate contract).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findCliActionSpec, paramFlagName } from "../mcp/catalog.js";
import { ALL_DIAGNOSTIC_DOCS } from "../explain/explain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function collectSnippets(): string[] {
  const out = new Set<string>();
  const files = [path.join(repoRoot, "src", "core", "diagnostics.ts")];
  for (const f of fs.readdirSync(path.join(repoRoot, "src", "explain"))) {
    if (f.endsWith(".ts")) files.push(path.join(repoRoot, "src", "explain", f));
  }
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/'cuthol ([^']*)'/g)) {
      const cmd = m[1].trim();
      if (cmd) out.add(cmd);
    }
  }
  for (const doc of ALL_DIAGNOSTIC_DOCS) {
    for (const fix of doc.fix) {
      for (const m of fix.matchAll(/'cuthol ([^']*)'/g)) {
        const cmd = m[1].trim();
        if (cmd) out.add(cmd);
      }
    }
  }
  return [...out].sort();
}

/** Split on whitespace, keeping quoted segments whole; strips surrounding quotes. */
function tokenize(cmd: string): string[] {
  const toks: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        toks.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) toks.push(cur);
  return toks.map((t) =>
    t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
      ? t.slice(1, -1)
      : t
  );
}

export function validateDiagnosticCommand(cmd: string): string | null {
  const toks = tokenize(cmd).filter((t) => !/^<.*>$/.test(t) && t !== "..." && t !== "…");
  if (toks.length === 0) return "empty command";
  const [group, action, ...rest] = toks;
  if (toks.length === 1) {
    const single = findCliActionSpec(group, null, []);
    return single ? null : `unknown action: '${group}'`;
  }
  // Extra positionals (ids, values): keep only --flags for validation, but let
  // multi-word argv actions match (e.g. `workspace changes show`).
  const words = [group, action, ...rest.filter((t) => !t.startsWith("--") && !t.startsWith("-") && !/=/.test(t))].filter(
    (t): t is string => t !== undefined
  );
  const found =
    findCliActionSpec(words[0], words[1] ?? null, words.slice(2)) ??
    (words[1] ? findCliActionSpec(words[0], null, []) : undefined);
  if (!found) return `unknown action: '${group}${action ? ` ${action}` : ""}'`;
  const known = new Set(found.params.map(paramFlagName));
  // `explain` takes a bare code/lens positional; `help` takes group/action positionals.
  for (const t of toks) {
    if (!t.startsWith("--")) continue;
    const eq = t.indexOf("=");
    const flag = t.slice(2, eq >= 0 ? eq : undefined);
    if (!flag || /^<.*>$/.test(flag)) continue;
    if (!known.has(flag)) return `unknown flag '--${flag}' for '${found.spec.argv.join(" ")}'`;
  }
  return null;
}

describe("diagnostic commands gate", () => {
  it("every 'cuthol ...' suggestion parses against the catalog (or is allowlisted)", () => {
    const allowRaw = fs.readFileSync(path.join(repoRoot, "src", "explain", "command_allowlist.json"), "utf8");
    const allowlisted = new Set<string>((JSON.parse(allowRaw) as { commands: string[] }).commands);
    const failures: string[] = [];
    for (const cmd of collectSnippets()) {
      if (allowlisted.has(cmd)) continue;
      const err = validateDiagnosticCommand(cmd);
      if (err) failures.push(`${cmd}  <-- ${err}`);
    }
    assert.equal(failures.length, 0, `unparsable diagnostic commands:\n${failures.join("\n")}`);
    // The allowlist only shrinks: every listed command must still fail.
    const stale: string[] = [];
    for (const cmd of allowlisted) {
      if (validateDiagnosticCommand(cmd) === null) stale.push(cmd);
    }
    assert.equal(stale.length, 0, `allowlisted commands now parse; remove them:\n${stale.join("\n")}`);
  });
});
