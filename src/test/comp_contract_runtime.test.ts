/**
 * comp-contract: the composition contract accepts timelines built in a
 * separate JS file, rejects unpaused timelines, and lets a run-time probe
 * result override the two static timeline findings.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureCompositionRuntimeFiles,
  readCompositionScriptSources,
  scaffoldHyperFramesComposition,
  validateHyperFramesCompositionContract,
} from "../compositor/hyperframes_bridge.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-comp-contract-"));

function writeComp(name: string, indexHtml: string, scripts: Record<string, string> = {}): string {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), indexHtml, "utf8");
  for (const [rel, content] of Object.entries(scripts)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

const head = (body: string): string =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

test("contract: timeline built in a separate JS file passes", () => {
  const dir = writeComp(
    "separate-file",
    head(
      `<div id="root" data-composition-id="main"></div>` +
        `<script src="assets/app.js"></script>`
    ),
    {
      "assets/app.js": `const tl = gsap.timeline({ paused: true });
window.__timelines["main"] = tl;`,
    }
  );
  const res = validateHyperFramesCompositionContract(dir, "index.html");
  assert.equal(res.ok, true, JSON.stringify(res.findings));
  assert.equal(res.composition_id, "main");
});

test("contract: inline timeline still passes; missing registration fails", () => {
  const okDir = writeComp(
    "inline-ok",
    head(
      `<div id="root" data-composition-id="main"></div>` +
        `<script>const tl = gsap.timeline({ paused: true }); window.__timelines['main'] = tl;</script>`
    )
  );
  assert.equal(validateHyperFramesCompositionContract(okDir, "index.html").ok, true);

  const badDir = writeComp(
    "inline-bad",
    head(
      `<div id="root" data-composition-id="main"></div>` +
        `<script>const tl = gsap.timeline({ paused: true });</script>`
    )
  );
  const bad = validateHyperFramesCompositionContract(badDir, "index.html");
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f) => f.includes("timeline registration")));
});

test("contract: unpaused timeline fails with a clear message", () => {
  const dir = writeComp(
    "unpaused",
    head(
      `<div id="root" data-composition-id="main"></div>` +
        `<script>const tl = gsap.timeline({ paused: false }); window.__timelines["main"] = tl;</script>`
    )
  );
  const res = validateHyperFramesCompositionContract(dir, "index.html");
  assert.equal(res.ok, false);
  assert.ok(res.findings.some((f) => f.includes("paused")));
});

test("contract: run-time probe result overrides static timeline findings", () => {
  const dir = writeComp(
    "runtime-override",
    head(`<div id="root" data-composition-id="main"></div>`)
  );
  const staticOnly = validateHyperFramesCompositionContract(dir, "index.html");
  assert.equal(staticOnly.ok, false);

  const runtimePass = validateHyperFramesCompositionContract(dir, "index.html", false, false, {
    timelineRegistered: true,
    timelinePaused: true,
  });
  assert.equal(runtimePass.ok, true, JSON.stringify(runtimePass.findings));

  // A running (unpaused) timeline at run time still fails.
  const runtimeRunning = validateHyperFramesCompositionContract(dir, "index.html", false, false, {
    timelineRegistered: true,
    timelinePaused: false,
  });
  assert.equal(runtimeRunning.ok, false);

  // An unknown pause state falls back to the static text.
  const runtimeUnknown = validateHyperFramesCompositionContract(dir, "index.html", false, false, {
    timelineRegistered: true,
    timelinePaused: null,
  });
  assert.equal(runtimeUnknown.ok, false);
});

test("contract: local script sources stay inside the folder", () => {
  const dir = writeComp(
    "path-escape",
    head(
      `<div id="root" data-composition-id="main"></div>` +
        `<script src="../outside.js"></script>` +
        `<script src="https://cdn.example.com/gsap.min.js"></script>`
    )
  );
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.deepEqual(readCompositionScriptSources(dir, html), []);
});

test("runtime files: placed without touching index.html", () => {
  const dir = path.join(TEST_ROOT, "runtime-topup");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const before = `<div id="root" data-composition-id="main"></div>`;
  fs.writeFileSync(path.join(dir, "index.html"), before, "utf8");

  const placed = ensureCompositionRuntimeFiles(
    dir,
    { width: 1920, height: 1080, fps: 30, durationMs: 3000, props: {} },
    false
  );
  assert.ok(placed.placed.length > 0);
  assert.ok(fs.existsSync(path.join(dir, "assets", "cuthol-runtime.js")));
  assert.ok(fs.existsSync(path.join(dir, "assets", "gsap.min.js")));
  assert.ok(fs.existsSync(path.join(dir, "hyperframes.json")));
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), before);

  // Second run places nothing: agent files are never clobbered.
  const again = ensureCompositionRuntimeFiles(
    dir,
    { width: 1920, height: 1080, fps: 30, durationMs: 3000, props: {} },
    false
  );
  assert.deepEqual(again.placed, []);
});

test("scaffold output unchanged: entry html plus runtime files", () => {
  const dir = path.join(TEST_ROOT, "scaffolded");
  fs.rmSync(dir, { recursive: true, force: true });
  const res = scaffoldHyperFramesComposition({
    targetDir: dir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "counter",
    props: {},
    transparent: true,
  });
  assert.equal(res.compositionId, "main");
  const contract = validateHyperFramesCompositionContract(dir, "index.html");
  assert.equal(contract.ok, true, JSON.stringify(contract.findings));
});
