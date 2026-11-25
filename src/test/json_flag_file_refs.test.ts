/**
 * JSON flag file references and quote-stripped diagnostics.
 *
 * Every JSON-valued CLI flag (`--props`, `--params`, `--patch`, `--blocks`,
 * `--variants`) accepts inline JSON plus `file:<path>` (shell-safe everywhere)
 * and `@<path>` (quote it in PowerShell). Failures name the actual flag and
 * command, and say when the shell stripped the double quotes.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { jsonFixCommand, parseJsonFlag } from "../cli_args.js";
import { parseColorFlags } from "../color/cli_parse.js";

function scratch(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-json-flag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PARAMS = {
  command: "spine fx add",
  flag: "params",
  kind: "object" as const,
  fixCommand: "cuthol spine fx add --item sp_01 --params file:params.json",
};

test("inline JSON still parses", () => {
  assert.deepEqual(parseJsonFlag('{"a":1}', PARAMS), { a: 1 });
});

test("file: and @ references load JSON on two different commands", (t) => {
  const dir = scratch(t);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    fs.writeFileSync("params.json", '{"a":1}', "utf8");
    fs.writeFileSync("props.json", '{"headline":"Hi"}', "utf8");
    assert.deepEqual(parseJsonFlag("file:params.json", PARAMS), { a: 1 });
    assert.deepEqual(parseJsonFlag("@params.json", PARAMS), { a: 1 });
    assert.deepEqual(parseJsonFlag("'@params.json'", PARAMS), { a: 1 });
    assert.deepEqual(
      parseJsonFlag("file:props.json", {
        command: "composition scaffold",
        flag: "props",
        kind: "object",
        fixCommand: "cuthol composition scaffold --comp-dir compositions/intro --props file:props.json",
      }),
      { headline: "Hi" }
    );
  } finally {
    process.chdir(prev);
  }
});

test("quote-stripped JSON on --params names the flag and the cause (G778)", () => {
  assert.throws(() => parseJsonFlag("{a:1}", PARAMS), (err: unknown) => {
    const msg = (err as Error).message;
    return (
      /CUTHOL-G778/.test(msg) &&
      /'--params' of 'spine fx add'/.test(msg) &&
      /stripped the double quotes/.test(msg) &&
      /file:params\.json/.test(msg)
    );
  });
});

test("quote-stripped JSON on --variants names the flag and the cause (G778)", () => {
  assert.throws(
    () =>
      parseJsonFlag("[{label:warm}]", {
        command: "color compare",
        flag: "variants",
        kind: "array",
        fixCommand: "cuthol color compare --item sp_01 --variants file:variants.json",
      }),
    (err: unknown) => {
      const msg = (err as Error).message;
      return (
        /CUTHOL-G778/.test(msg) &&
        /'--variants' of 'color compare'/.test(msg) &&
        /stripped the double quotes/.test(msg) &&
        /expected a JSON array/.test(msg)
      );
    }
  );
});

test("missing file reference reports the flag, command and resolved path (G779)", () => {
  assert.throws(() => parseJsonFlag("file:nope.json", PARAMS), (err: unknown) => {
    const msg = (err as Error).message;
    return (
      /CUTHOL-G779/.test(msg) &&
      /'--params' of 'spine fx add'/.test(msg) &&
      /nope\.json/.test(msg)
    );
  });
});

test("color --patch accepts file: and reports the actual flag", (t) => {
  const dir = scratch(t);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    fs.writeFileSync("patch.json", '{"exposure":{"stops":-0.4}}', "utf8");
    const { patch } = parseColorFlags({ patch: "file:patch.json" });
    assert.deepEqual(patch.exposure, { stops: -0.4 });
    assert.throws(() => parseColorFlags({ patch: "{exposure:1}" }), (err: unknown) =>
      /--patch of 'color set'/.test((err as Error).message) &&
      /stripped the double quotes/.test((err as Error).message)
    );
    assert.throws(
      () => parseColorFlags({ patch: "{exposure:1}" }, undefined, "--blocks", "color look create"),
      (err: unknown) => /--blocks of 'color look create'/.test((err as Error).message)
    );
  } finally {
    process.chdir(prev);
  }
});

test("spine fx set retry names the real subcommand and item (G778)", () => {
  const fix = jsonFixCommand("spine fx set", "params", "--item sp_03");
  assert.equal(fix, "cuthol spine fx set --item sp_03 --params file:params.json");
  assert.throws(
    () => parseJsonFlag("{a:1}", { command: "spine fx set", flag: "params", kind: "object", fixCommand: fix }),
    (err: unknown) => /spine fx set --item sp_03 --params file:params\.json/.test((err as Error).message)
  );
});

test("color compare retry names the real item (G778)", () => {
  const fix = jsonFixCommand("color compare", "variants", "--item sp_07");
  assert.throws(
    () => parseJsonFlag("[{label:warm}]", { command: "color compare", flag: "variants", kind: "array", fixCommand: fix }),
    (err: unknown) => /color compare --item sp_07 --variants file:variants\.json/.test((err as Error).message)
  );
});

test("color set retry names the passed target (G778)", () => {
  assert.throws(
    () => parseColorFlags({ patch: "{exposure:1}" }, undefined, "--patch", "color set", jsonFixCommand("color set", "patch", "--item sp_07")),
    (err: unknown) => /color set --item sp_07 --patch file:patch\.json/.test((err as Error).message)
  );
});
