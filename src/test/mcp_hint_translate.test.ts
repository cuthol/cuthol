/**
 * MCP hint translation tests (`src/mcp/mcp_format.ts` `translateCliHint`).
 *
 * Diagnostics and suggestions are written as CLI text; for MCP clients they are
 * rewritten into tool-call form. Positional arguments and multi-word sub-actions
 * must survive the rewrite, and anything that cannot be mapped must stay fully
 * quoted CLI text (never a half-translated call).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_SPECS, buildCliArgv, findActionSpec, TOOL_SPECS } from "../mcp/catalog.js";
import { formatEnvelopeCompact, translateCliHint } from "../mcp/mcp_format.js";

/** Split `tool(action=x, k=v, ...)` into tool + params (handles `"quoted values"`). */
function parseCall(call: string): { tool: string; action: string | null; params: Map<string, string> } {
  const m = /^([a-z_]+)\((.*)\)$/.exec(call.trim());
  assert.ok(m, `not a tool call: ${call}`);
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let cur = "";
  for (const ch of m[2]) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && ch === "(") depth++;
    if (!inQuotes && ch === ")") depth--;
    if (!inQuotes && depth === 0 && ch === ",") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  let action: string | null = null;
  const params = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    assert.ok(eq > 0, `bad call part ${JSON.stringify(part)} in ${call}`);
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === "action") action = value;
    else params.set(key, value);
  }
  return { tool: m[1], action, params };
}

// DIAGNOSTICS is a record of message factories, so examples are extracted from the
// source text (backtick template placeholders like ${x} never occur inside the
// quoted 'cuthol …' commands, which use only literal text and <angle> placeholders).
function diagnosticExamples(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "src", "core", "diagnostics.ts"),
    path.resolve("src", "core", "diagnostics.ts"),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  assert.ok(hit, `diagnostics.ts not found in ${candidates.join(", ")}`);
  const src = fs.readFileSync(hit, "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/'(cuthol [^'`$]+)'/g)) found.add(m[1]);
  return [...found].sort();
}

/** Tokenize like the implementation: whitespace split keeping `"..."` together. */
function tokenize(fragment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out.push(m[1] !== undefined ? m[1] : m[0]);
  return out;
}

test("hint translation: the five brief strings", () => {
  const cases: Array<[string, string]> = [
    ["Run 'cuthol extension enable karma' first.", "Run extension(action=enable, name=karma) first."],
    ["Use 'cuthol spine split sp_02 --at 1200ms'", "Use spine(action=split, clip=sp_02, at=1200ms)"],
    ["'cuthol library query vid_01'", "library(action=query, handle=vid_01)"],
    [
      "run 'cuthol workspace changes show', then 'cuthol workspace changes adopt'",
      "run workspace(action=changes_show), then workspace(action=changes_adopt)",
    ],
    ["undo with 'cuthol workspace journal undo'", "undo with workspace(action=undo)"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(translateCliHint(input), expected, input);
  }
});

test("hint translation: positional mapping rule (both branches)", () => {
  // Spec-marked positional (`color look` declares `op` positional).
  assert.equal(translateCliHint("'cuthol color look list'"), "color(action=look, op=list)");
  // Single required parameter left unsatisfied by the flags (`extension enable`: only `name`).
  assert.equal(
    translateCliHint("Run 'cuthol extension enable karma' first."),
    "Run extension(action=enable, name=karma) first."
  );
  // `spine split` needs both `clip` and `at`; with no `--at` flag the positional is
  // ambiguous, so the whole CLI text stays untouched.
  assert.equal(translateCliHint("'cuthol spine split sp_02'"), "'cuthol spine split sp_02'");
  // Unknown flags cannot be mapped: keep the whole original text, quotes balanced.
  assert.equal(
    translateCliHint("fix with 'cuthol live stop --dir <project>'"),
    "fix with 'cuthol live stop --dir <project>'"
  );
});

test("hint translation: every diagnostics example is balanced, valid and round-trips", () => {
  const examples = diagnosticExamples();
  assert.ok(examples.length > 10, `expected many diagnostics examples, got ${examples.length}`);
  let translated = 0;
  for (const cli of examples) {
    const out = translateCliHint(`'${cli}'`);
    const quotes = (out.match(/'/g) || []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for ${cli}: ${out}`);
    assert.ok(!/\)\s+[A-Za-z0-9_<]/.test(out), `stray token after call for ${cli}: ${out}`);
    if (out.includes("cuthol ")) continue; // kept as CLI text: nothing more to check
    translated++;
    const { tool, action, params } = parseCall(out.replace(/^'/, "").replace(/'$/, ""));
    assert.ok(TOOL_SPECS.some((t) => t.name === tool), `unknown tool in ${out}`);
    const spec = findActionSpec(tool, action);
    assert.ok(spec, `unknown action in ${out}`);
    assert.ok(
      ACTION_SPECS.some((a) => a.tool === spec.tool && a.action === spec.action),
      `invented action in ${out}`
    );
    // Round-trip: the produced call feeds buildCliArgv (the same function the MCP
    // server uses) and must rebuild the original command with the same values.
    const values: Record<string, unknown> = {};
    for (const prm of spec.params) {
      const v = params.get(prm.name);
      if (v === undefined) continue;
      values[prm.name] = prm.type === "string_list" ? v.split(",") : v;
    }
    const argv = buildCliArgv(spec, values, ".");
    const cliTokens = tokenize(cli);
    assert.deepEqual(argv.slice(0, spec.argv.length), spec.argv, `command mismatch for ${cli}: ${out}`);
    assert.deepEqual(
      cliTokens.slice(1, 1 + spec.argv.length),
      spec.argv,
      `call does not match its CLI command for ${cli}: ${out}`
    );
    const argvValues = argv
      .slice(spec.argv.length)
      .filter((t) => t !== "--dir=.")
      .map((t) => (t.startsWith("--") ? t.slice(t.indexOf("=") + 1) : t))
      .sort();
    const cliValues: string[] = [];
    for (let i = 1 + spec.argv.length; i < cliTokens.length; i++) {
      const tok = cliTokens[i];
      if (tok.startsWith("--")) {
        const body = tok.slice(2);
        const eq = body.indexOf("=");
        if (eq >= 0) cliValues.push(body.slice(eq + 1));
        else if (i + 1 < cliTokens.length && !cliTokens[i + 1].startsWith("--")) cliValues.push(cliTokens[++i]);
        else cliValues.push("true");
      } else {
        cliValues.push(tok);
      }
    }
    cliValues.sort();
    assert.deepEqual(argvValues, cliValues, `value mismatch for ${cli}: ${out}`);
  }
  assert.ok(translated > 10, `expected many translated examples, got ${translated} of ${examples.length}`);
});
/** Backquoted suggestion/what template literals of diagnostics.ts (`${…}` → `x1`). */
function diagnosticTemplates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "src", "core", "diagnostics.ts"),
    path.resolve("src", "core", "diagnostics.ts"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  assert.ok(found, `diagnostics.ts not found in ${candidates.join(", ")}`);
  const src = fs.readFileSync(found, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`/g)) out.push(m[1].replace(/\$\{[^}]*\}/g, "x1"));
  assert.ok(out.length > 100, `expected diagnostics templates, got ${out.length}`);
  return out;
}

test("hint translation: two commands on one line translate cleanly (G152 line)", () => {
  const line =
    "INFO [CUTHOL-G152] First visual source suggests stage 1080x1080 " +
    "(stage is still the default; adopting avoids a rescale of every placed item). " +
    "Run: 'cuthol workspace stage --size 1080x1080'. | Suggestion: Run the suggested " +
    "command to adopt the source size; rule: 'cuthol explain G152'.";
  assert.equal(
    translateCliHint(line),
    "INFO [CUTHOL-G152] First visual source suggests stage 1080x1080 " +
      "(stage is still the default; adopting avoids a rescale of every placed item). " +
      "Run: workspace(action=stage, size=1080x1080). | Suggestion: Run the suggested " +
      "command to adopt the source size; rule: guide(action=explain, query=G152)."
  );

  const unquoted =
    "Run: cuthol workspace stage --size 1080x1080. | Suggestion: x; rule: 'cuthol explain G152'.";
  assert.equal(
    translateCliHint(unquoted),
    "Run: workspace(action=stage, size=1080x1080). | Suggestion: x; rule: guide(action=explain, query=G152)."
  );

  const multi =
    "Do 'cuthol brief --lens overview', then 'cuthol explain G101'; see 'cuthol workspace journal undo'.";
  assert.equal(
    translateCliHint(multi),
    "Do brief(lens=overview), then guide(action=explain, query=G101); see workspace(action=undo)."
  );
});

test("hint translation: every suggestion/what template translates without quote corruption", () => {
  const CALL_RE = /[A-Za-z_][\w]*\(action=[^()\n]*\)/g;
  const SPAN_RE = /'cuthol [^'\n]*?'/g;
  const lits = diagnosticTemplates().filter((t) => t.includes("cuthol"));
  assert.ok(lits.length > 50, `expected many cuthol templates, got ${lits.length}`);
  for (const t of lits) {
    assert.ok(!t.includes("(action="), `template already in MCP form: ${t.slice(0, 80)}`);
    const out = translateCliHint(t);
    assert.ok(!/'[A-Za-z_][\w]*\(action=/.test(out), `stray quote before a call: ${out}`);
    for (const call of out.match(CALL_RE) ?? []) {
      assert.ok(!call.includes("'"), `quote inside call value: ${call}`);
    }
    const quotesIn = (t.match(/'/g) ?? []).length;
    const quotesOut = (out.match(/'/g) ?? []).length;
    const spans = t.match(SPAN_RE) ?? [];
    const gone = spans.filter((s) => !out.includes(s)).length;
    assert.equal(
      quotesIn - quotesOut,
      2 * gone,
      `quote conservation broken (in=${quotesIn} out=${quotesOut} translated=${gone}): ${out}`
    );
    if (quotesIn % 2 === 0) assert.equal(quotesOut % 2, 0, `unbalanced quotes: ${out}`);
  }
});

test("compact hint form: CLI keeps the CLI suggestion, MCP keeps the translation", () => {
  const envelope = {
    ok: false,
    command: "library waveform",
    error: {
      code: "CUTHOL-G999",
      message: "No waveform for handle 'vid_nope'.",
      suggestion: "Inspect it with 'cuthol brief --lens overview'.",
    },
  };
  const cli = formatEnvelopeCompact({ envelope, hintForm: "cli" });
  assert.ok(cli.text.includes("'cuthol brief --lens overview'"), `CLI form lost: ${cli.text}`);
  assert.ok(!cli.text.includes("brief(lens=overview)"), `CLI text was translated: ${cli.text}`);
  const mcp = formatEnvelopeCompact({ envelope });
  assert.ok(mcp.text.includes("brief(lens=overview)"), `MCP form not translated: ${mcp.text}`);
});
