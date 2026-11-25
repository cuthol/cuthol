import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_SPECS } from "../mcp/catalog.js";

test("setup declares the local speech engine choice", () => {
  const setup = ACTION_SPECS.find((a) => a.argv.join(" ") === "setup");
  assert.ok(setup, "expected a setup action spec");
  const engine = setup.params.find((p) => p.name === "engine");
  assert.ok(engine, "expected setup to declare --engine");
  assert.deepEqual([...(engine.enum ?? [])].sort(), ["parakeet", "whisper"]);
  assert.match(engine.description, /25 European languages/);
  assert.match(engine.description, /whisper.*every language including Turkish/i);
});
