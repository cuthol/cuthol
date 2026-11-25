// Shared quote-aware substitution and G322 rule hints (no ffmpeg needed).
import test from "node:test";
import assert from "node:assert/strict";
import { substituteFxTemplateValues } from "../compositor/compile_fx_stage.js";
import { fxEntryFilterName, fxTemplateRuleHint } from "../effects/fx_check.js";

const fail = (detail: string): never => {
  throw new Error(detail);
};

test("shared substitution: animated outside quotes is quoted", () => {
  const out = substituteFxTemplateValues("eq=brightness={{s}}:eval=frame", { s: 0.5 }, new Map([["s", "if(lt(t,1),0,1)"]]), fail);
  assert.equal(out, "eq=brightness='if(lt(t,1),0,1)':eval=frame");
});

test("shared substitution: animated inside quotes is bare", () => {
  const out = substituteFxTemplateValues("eq=saturation='1+0.8*({{strength}})':eval=frame", { strength: 0 }, new Map([["strength", "if(lt(t,1),0,1)"]]), fail);
  assert.equal(out, "eq=saturation='1+0.8*(if(lt(t,1),0,1))':eval=frame");
});

test("shared substitution: static inside quotes is escaped, quote rejected", () => {
  const out = substituteFxTemplateValues("eq=saturation='{{s}}':eval=frame", { s: "a:b" }, new Map(), fail);
  assert.equal(out, "eq=saturation='a\\:b':eval=frame");
  assert.throws(
    () => substituteFxTemplateValues("eq=saturation='{{s}}':eval=frame", { s: "a'b" }, new Map(), fail),
    /'s' parameter value contains a single quote/
  );
});

test("shared substitution: unterminated quote throws", () => {
  assert.throws(
    () => substituteFxTemplateValues("eq=saturation='{{s}}", { s: 1 }, new Map(), fail),
    /unterminated single-quoted region/
  );
});

test("rule hints: stray comma names the colon rule only", () => {
  const comma = fxTemplateRuleHint(
    "No option name near '1+0.3*(0)'",
    "eq=saturation=1+0.3*(0),contrast=1",
    "eq=saturation=1+0.3*(0),contrast=1"
  );
  assert.ok(comma?.includes("':'"), `expected colon hint, got ${comma}`);
  assert.ok(!comma?.includes("nested quotes"), `comma case must not add the nested hint, got ${comma}`);
});

test("rule hints: plain errors with no quoted placeholder get no hint", () => {
  assert.equal(fxTemplateRuleHint("Option not found", "eq=brightness=1", "eq=brightness=1"), undefined);
  assert.equal(fxTemplateRuleHint("Invalid chars 'x' at the end of expression", "eq=brightness=1", "eq=brightness=1"), undefined);
  assert.equal(fxTemplateRuleHint("No option name near 'x'", undefined, "eq=brightness=1"), undefined);
});

test("rule hints: nested quotes need a quoted placeholder and adjacent quotes", () => {
  const template = "eq=saturation='1+0.8*({{s}})':eval=frame";
  const chain = "eq=saturation='1+0.8*('if(lt(t,1),0,1)')':eval=frame";
  const nested = fxTemplateRuleHint("No option name near 'frame'", template, chain);
  assert.ok(nested?.includes("nested quotes"), `expected nested-quote hint, got ${nested}`);
});

test("frozen filter name comes from the entry template, not the stage chain", () => {
  assert.equal(fxEntryFilterName("eq=saturation='1+0.8*({{s}})'", "scale=iw:ih,eq=saturation='1+0.8*(0.5)'"), "eq");
  assert.equal(fxEntryFilterName(undefined, "scale=iw:ih,eq=saturation=1"), "scale");
  assert.equal(fxEntryFilterName("eq=saturation=1", ""), "eq");
});
