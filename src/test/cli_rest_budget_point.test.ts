/**
 * `spine envelope point <add|move|remove>` carries two positionals; the positional budget checks
 * them against the subcommand's own budget while plain `spine envelope` stays strict.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { assertNoExtraPositionals } from "../cli_args.js";

const ok = (rest: string[], flags: Record<string, string | boolean>): void =>
  assert.doesNotThrow(() => assertNoExtraPositionals("spine", "envelope", rest, flags));
const bad = (rest: string[], flags: Record<string, string | boolean>): void =>
  assert.throws(() => assertNoExtraPositionals("spine", "envelope", rest, flags), /CUTHOL-G110/);

test("point subcommand accepts its verb with --clip, or the item as a positional", () => {
  ok(["point", "add"], { clip: "sp_01" });
  ok(["point", "move", "sp_01"], {});
  bad(["point", "add", "sp_01"], { clip: "sp_01" });
  bad(["point", "add", "sp_01", "junk"], {});
});

test("plain spine envelope keeps its single positional", () => {
  ok(["sp_01"], {});
  ok([], { clip: "sp_01" });
  bad(["sp_01", "extra"], {});
  bad(["sp_01"], { clip: "sp_01" });
});
