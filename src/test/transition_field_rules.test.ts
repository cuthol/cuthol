/**
 * Field rules for extension transition templates (`transitions` in `cuthol-extension.json`).
 *
 * Chain (filter) fields are spliced into comma-separated ffmpeg filter options while the
 * eased-progress `{{p}}` expansion contains commas: an unquoted `{{p}}` splits the option
 * at render time (`No such filter: '0)'`), so it is rejected at manifest load with
 * CUTHOL-G330. Quoted use, plain-number vars (`t0`/`dur`) and the scale/overlay fields
 * (whose expansions are quoted or comma-safe by the compiler) pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { resolveExtension } from "../extensions/ext_registry.js";
import { substituteTransitionTemplate } from "../extensions/ext_transitions.js";

function freshWorkspace(): { wsDir: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-trfields-"));
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "trfields-", aspect: "16:9", fps: 30 });
  return { wsDir, tmp };
}

function writeManifest(wsDir: string, name: string, transitions: Record<string, unknown>): void {
  const dir = path.join(wsDir, ".cuthol", "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify({ name, version: "1.0.0", description: "field-rule fixture.", transitions }, null, 2),
    "utf8"
  );
}

test("unquoted {{p}} in a filter field is G330 naming transition, field and placeholder", () => {
  const { wsDir, tmp } = freshWorkspace();
  try {
    writeManifest(wsDir, "badf", { k: { outgoing_filter: "eq=brightness=-0.5*{{p}}" } });
    assert.throws(() => resolveExtension("badf", wsDir), (err: unknown) => {
      const msg = String((err as Error).message);
      return /CUTHOL-G330/.test(msg) && msg.includes("'k'") && msg.includes("outgoing_filter") && msg.includes("{{p}}");
    });
    writeManifest(wsDir, "badf", { k: { incoming_filter: "eq=brightness=-0.5*{{p}}" } });
    assert.throws(() => resolveExtension("badf", wsDir), /CUTHOL-G330/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("quoted {{p}}, plain-number vars and non-filter fields pass the load rule", () => {
  const { wsDir, tmp } = freshWorkspace();
  try {
    writeManifest(wsDir, "goodf", {
      quoted: {
        outgoing_filter: "eq=brightness='min(1,2*({{p}}))':eval=frame",
        incoming_filter: "fade=t=in:st=0:d={{dur}}:alpha=1,eq=brightness='1-({{p}})'",
      },
      numbers: { outgoing_filter: "fade=t=out:st={{t0}}:d={{dur}}:alpha=1" },
      scale: { incoming_scale: "0.8+0.2*{{p}}" },
      pos: {
        incoming_x: "if(lt(t,{{t1}}),{{W}}-{{W}}*{{p}},{{x}})",
        outgoing_y: "if(lt(t,{{t1}}),{{y}}-{{H}}*{{p}},{{y}})",
      },
    });
    assert.ok(resolveExtension("goodf", wsDir).manifest.transitions?.quoted);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("param values holding a comma fail only in filter fields (G123)", () => {
  assert.throws(
    () => substituteTransitionTemplate("eq=brightness={{v}}", { t0: "0", dur: "1", p: "p" }, { v: "a,b" }, "ext:f/k", "sp_01", true),
    /CUTHOL-G123/
  );
  assert.equal(
    substituteTransitionTemplate("eq=brightness={{v}}", { t0: "0", dur: "1", p: "p" }, { v: "a,b" }, "ext:f/k", "sp_01", false),
    "eq=brightness=a,b"
  );
  assert.equal(
    substituteTransitionTemplate("eq=brightness='({{p}})'", { t0: "0", dur: "1", p: "(p)" }, {}, "ext:f/k", "sp_01", true),
    "eq=brightness='((p))'"
  );
});
