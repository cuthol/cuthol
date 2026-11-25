/**
 * `spine fx add --help` shows the repeatable `--param k=v` flag.
 *
 * `collectSpineFxParams` accepts `--param k=v` (repeatable, comma-separated
 * pairs) and `--params` JSON, but the per-command help (from the MCP catalog
 * spec) only listed `--params`, so agents never found `--param`.
 * Fails on the old build, where the fx_add spec has no `param` entry.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { printHelp } from "../cli_help.js";
import { ACTION_SPECS } from "../mcp/catalog.js";

function captureHelp(group: string, action: string, rest: string[]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printHelp(group, action, rest);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("spine fx add help lists --param k=v with an example", () => {
  const spec = ACTION_SPECS.find((a) => a.tool === "spine" && a.action === "fx_add");
  assert.ok(spec, "expected a spine fx_add catalog spec");
  assert.ok(
    spec.params.some((p) => p.name === "param"),
    "fx_add spec should declare the repeatable `param` flag"
  );

  const help = captureHelp("spine", "fx", ["add"]);
  assert.ok(help.includes("--param"), "help should show --param");
  assert.ok(help.includes("k=v"), "help should show the k=v form");
  assert.ok(help.includes("--param sigma=4"), "help should show a --param example");
});
