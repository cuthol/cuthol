import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ACTION_SPECS, TOOL_SPECS, actionsForTool, buildToolDefinition, findActionSpec } from "../mcp/catalog.js";

const ROOT = process.cwd();

function readTracked(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// Mirrors test-workspace/sk/data/katalog_bayrak.py, but reads the declared side
// from the built catalog (so it fails on builds without the new entries).
test("every flag the handlers read is declared by the catalog", () => {
  const cat = new Map<string, Set<string>>();
  const add = (g: string, f: string) => {
    if (!cat.has(g)) cat.set(g, new Set());
    cat.get(g)!.add(f);
  };
  for (const a of ACTION_SPECS) {
    if (!a.argv.length) continue;
    for (const prm of a.params) add(a.argv[0], prm.flag ?? prm.name.replace(/_/g, "-"));
  }
  const keyOf = (f: string): string[] =>
    ({ spine_treatments: ["spine"], output: ["render", "monitor", "brief", "verify"] })[f] ?? [f];
  const GLOBAL = new Set(["dir", "json", "compact", "format", "verbose", "help"]);
  const missing: string[] = [];
  for (const f of fs.globSync("src/cli_cmd_*.ts")) {
    const g = path.basename(f).slice("cli_cmd_".length, -3);
    const text = readTracked(f);
    const reads = new Set<string>();
    for (const m of text.matchAll(/(?:str|num|bool|strList|time)\w*Flag\(\s*flags\s*,\s*"([a-z0-9-]+)"/g)) reads.add(m[1]);
    for (const m of text.matchAll(/flags\[\s*"([a-z0-9-]+)"\s*\]/g)) reads.add(m[1]);
    const declared = new Set<string>();
    for (const k of keyOf(g)) for (const v of cat.get(k) ?? []) declared.add(v);
    for (const flag of [...reads].sort()) {
      if (!GLOBAL.has(flag) && !declared.has(flag)) missing.push(`${g}: --${flag}`);
    }
  }
  assert.deepEqual(missing, [], `flags read but undeclared: ${missing.join(", ")}`);
});

test("color block flags parsed outside cli_cmd files are declared too", () => {
  const cliParse = readTracked("src/color/cli_parse.ts");
  const keys = [...(cliParse.match(/^\s*(wb|exposure|tone|curve|wheel|hsl|sat|vibrance|look|amount|remove|patch)\?:/gm) ?? [])].map(
    (line) => line.trim().replace(/\?:$/, ""),
  );
  assert.ok(keys.length >= 10, `expected ColorFlagInput keys, got ${keys.join(",")}`);
  const specs = ACTION_SPECS.filter((a) => a.tool === "color" && a.action === "set");
  const declared = new Set(specs.flatMap((a) => a.params.map((prm) => prm.flag ?? prm.name.replace(/_/g, "-"))));
  for (const k of keys) assert.ok(declared.has(k), `color set lacks --${k}`);
});

test("cliOnly actions never reach the MCP surface", () => {
  const cliOnly = ACTION_SPECS.filter((a) => a.cliOnly);
  assert.ok(cliOnly.length > 10, `expected cliOnly actions, got ${cliOnly.length}`);
  for (const tool of TOOL_SPECS) {
    for (const a of actionsForTool(tool.name)) assert.ok(!a.cliOnly, `${tool.name}.${a.action} leaks`);
    const def = buildToolDefinition(tool);
    const schema = JSON.stringify(def.inputSchema);
    if (tool.name !== "guide") assert.ok(!schema.includes("explain"), `${tool.name} schema mentions explain`);
  }
  assert.equal(findActionSpec("setup", null), undefined);
  const colorSet = findActionSpec("color", "set");
  assert.ok(colorSet && !colorSet.cliOnly);
});

test("explain is the one new MCP action, on the guide tool", () => {
  const spec = findActionSpec("guide", "explain");
  assert.ok(spec && !spec.cliOnly);
  assert.deepEqual(spec.argv, ["explain"]);
  assert.deepEqual(spec.params.map((p) => p.name), ["query"]);
  const def = buildToolDefinition(TOOL_SPECS.find((t) => t.name === "guide")!);
  assert.ok(JSON.stringify(def.inputSchema).includes("explain"));
});
