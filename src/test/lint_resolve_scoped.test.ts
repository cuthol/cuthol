import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLintEntryForCuthol } from "../compositor/hf_lint.js";

function makeComp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-lint-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

const SCOPED_HTML = `<!doctype html><html><body>
<div class="group-a"><span class="x">one</span></div>
<div class="group-b"><span class="x">two</span></div>
</body></html>`;

test("scoped-selector overlap across groups is downgraded with a reason", () => {
  const dir = makeComp({ "index.html": SCOPED_HTML });
  const raw = {
    ok: false,
    content_hash: "t",
    findings: [
      {
        code: "overlapping_gsap_tweens",
        severity: "warning" as const,
        message: "tweens on ':scope > .x' and ':scope > .x' in different groups may overlap",
        selector: ":scope > .x",
      },
    ],
    info_findings: [],
  };
  const out = normalizeLintEntryForCuthol(raw, dir, "index.html");
  assert.equal(out.findings.length, 0);
  assert.equal(out.info_findings.length, 1);
  assert.match(out.info_findings[0].message, /:scope/);
  assert.match(out.info_findings[0].message, /different elements/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a genuine overlap without :scope stays a warning", () => {
  const dir = makeComp({ "index.html": SCOPED_HTML });
  const raw = {
    ok: false,
    content_hash: "t",
    findings: [
      {
        code: "overlapping_gsap_tweens",
        severity: "warning" as const,
        message: "tweens on '.card' overlap",
        selector: ".card",
      },
    ],
    info_findings: [],
  };
  const out = normalizeLintEntryForCuthol(raw, dir, "index.html");
  assert.equal(out.findings.length, 1);
  assert.equal(out.info_findings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("missing three script is downgraded when Three comes from an extension helper", () => {
  const dir = makeComp({
    "index.html": `<!doctype html><html><head><script src="assets/cuthol-ext-three.js"></script></head><body></body></html>`,
    "assets/cuthol-ext-three.js": `/* three helper */\nimport * as THREE from 'three';\n`,
  });
  const raw = {
    ok: false,
    content_hash: "t",
    findings: [
      {
        code: "missing_three_script",
        severity: "warning" as const,
        message: "composition uses Three.js but no three script tag was found",
      },
    ],
    info_findings: [],
  };
  const out = normalizeLintEntryForCuthol(raw, dir, "index.html");
  assert.equal(out.findings.length, 0);
  assert.equal(out.info_findings.length, 1);
  assert.match(out.info_findings[0].message, /extension helper or shared asset/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("missing three script stays a warning without any helper or shared three", () => {
  const dir = makeComp({ "index.html": `<!doctype html><html><body></body></html>` });
  const raw = {
    ok: false,
    content_hash: "t",
    findings: [
      {
        code: "missing_three_script",
        severity: "warning" as const,
        message: "composition uses Three.js but no three script tag was found",
      },
    ],
    info_findings: [],
  };
  const out = normalizeLintEntryForCuthol(raw, dir, "index.html");
  assert.equal(out.findings.length, 1);
  assert.equal(out.info_findings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
