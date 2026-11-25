import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  describeUnknownFlag,
  normalizeFxTryAt,
  parseArgv,
  parseArgvWithBooleans,
  specBooleanFlags,
} from "../cli_args.js";
import { cliParamFlagName } from "../cli_args.js";
import { findCliActionSpec } from "../mcp/catalog.js";
import { printHelp } from "../cli_help.js";
import { runCli } from "../cli_main.js";
import { runExplain } from "../explain/explain.js";

const ROOT = process.cwd();

function mergedParams(group: string | undefined, action?: string, rest: string[] = []) {
  const hit = findCliActionSpec(group, action, rest);
  assert.ok(hit, `no catalog action for ${group} ${action ?? ""}`);
  return hit;
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

test("w0a: color set --remove takes a value, live open --no-window stays boolean", () => {
  const spec = mergedParams("color", "set");
  const booleans = specBooleanFlags(spec.params);
  assert.ok(!booleans.has("remove"));
  const parsed = parseArgvWithBooleans(["color", "set", "--remove", "white_balance"], (k) => booleans.has(k));
  assert.equal(parsed.flags["remove"], "white_balance");
  assert.deepEqual(parsed.positionals, ["color", "set"]);

  const legacy = parseArgv(["color", "set", "--remove", "white_balance"]);
  assert.equal(legacy.flags["remove"], true);
  assert.deepEqual(legacy.positionals, ["color", "set", "white_balance"]);

  const live = mergedParams("live", "open");
  const liveBooleans = specBooleanFlags(live.params);
  assert.ok(liveBooleans.has("no-window"));
  const liveParsed = parseArgvWithBooleans(["live", "open", "--no-window", "--dir", "x"], (k) =>
    liveBooleans.has(k),
  );
  assert.equal(liveParsed.flags["no-window"], true);
  assert.equal(liveParsed.flags["dir"], "x");
});

test("w0a: unknown flag names the command, the closest flag and the accepted list", async () => {
  const spec = mergedParams("library", "ingest");
  const msg = describeUnknownFlag("library", "ingest", "files", spec.params);
  assert.match(msg, /`--files` is not a flag of `library ingest`/);
  assert.match(msg, /files (are|is) positional/);
  assert.match(msg, /cuthol library ingest <files\.\.\.>/);
  assert.match(msg, /--handle/);
  assert.match(msg, /--dir/);

  await assert.rejects(() => runCli(["library", "ingest", "--files", "a.mp4"]), (err: unknown) => {
    const text = String((err as Error).message);
    return (
      text.includes("[CUTHOL-G110]") &&
      text.includes("`--files` is not a flag of `library ingest`") &&
      text.includes("files are positional")
    );
  });
});

test("w0a: spine fx try --at accepts bare seconds and time literals", () => {
  assert.equal(normalizeFxTryAt("0.5,1.5"), "0.5,1.5");
  assert.equal(normalizeFxTryAt("0.5s,1500ms"), "0.5,1.5");
});

test("w0a: every HELP_LINES command resolves and its --help lists every catalog flag", () => {
  const helpSrc = fs.readFileSync(path.join(ROOT, "src/cli_help.ts"), "utf8");
  const seen = new Set<string>();
  let checked = 0;
  for (const m of helpSrc.matchAll(/cuthol ([a-z][a-z0-9-]*)((?: [a-z][a-z0-9-]*)+)?/g)) {
    const group = m[1];
    const words = (m[2] ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    const key = `${group} ${words.join(" ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (["help", "mcp"].includes(group)) continue;
    const [action, ...rest] = words;
    const hit = findCliActionSpec(group, action, rest);
    const exact =
      hit &&
      hit.spec.argv.length === [group, action, ...rest].filter((w) => w !== undefined).length &&
      hit.spec.argv.every((w, i) => [group, action, ...rest][i] === w);
    if (exact && hit) {
      const out = captureStdout(() => printHelp(group, action, rest));
      assert.ok(out.length > 0, `${key}: empty --help`);
      for (const prm of hit.params) {
        if (prm.positional) {
          assert.ok(out.includes(`<${prm.name}>`), `${key}: --help misses positional ${prm.name}`);
        } else {
          assert.ok(out.includes(`--${cliParamFlagName(prm)}`), `${key}: --help misses --${cliParamFlagName(prm)}`);
        }
      }
      checked++;
    } else {
      // A group prefix (e.g. `spine fx`): the group listing must be non-empty.
      const out = captureStdout(() => printHelp(group, action, rest));
      assert.ok(out.length > 0, `${key}: no help output`);
    }
  }
  assert.ok(checked > 40, `expected many resolved commands, got ${checked}`);
});

test("w0a: explain returns the G110 record", async () => {
  const rec = runExplain("CUTHOL-G110");
  assert.equal(rec.ok, true);
  assert.match(rec.text, /\[CUTHOL-G110\] Unknown or conflicting CLI flag/);
  assert.match(rec.text, /source:/);
  let printed = "";
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    printed += args.join(" ");
  };
  try {
    await runCli(["explain", "CUTHOL-G110"]);
  } finally {
    console.log = orig;
  }
  assert.ok(printed.includes("[CUTHOL-G110]"), `CLI did not print the G110 record: ${printed.slice(0, 120)}`);
  assert.ok(printed.includes("source:"), `CLI print misses source line: ${printed.slice(0, 120)}`);
});
