/**
 * `brief` flow lens shows `comp-audio: mix` only for compositions that
 * actually hold audible elements; silent compositions omit the tag, an
 * explicit `--composition-audio off` still shows `off`.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSequenceBrief } from "../brief/inspector.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";

function makeWs(title: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-brief-compaudio-"));
  const wsDir = path.join(tmp, "ws");
  initWorkspace({ dir: wsDir, title, aspect: "16:9", fps: 30 });
  return wsDir;
}

function compHtml(bodyInner: string): string {
  return `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="3">
  <div id="box" class="clip" data-start="0" data-duration="3" style="position:absolute;left:10px;top:10px;width:60px;height:60px;background:#ff0000;"></div>
${bodyInner}
</div>
<script src="assets/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to("#box", { x: 100, duration: 3, ease: "none" }, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
}

function mountComp(wsDir: string, name: string, bodyInner: string): string {
  const compDir = path.join(wsDir, "compositions", name);
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(compDir, "index.html"), compHtml(bodyInner), "utf8");
  fs.writeFileSync(path.join(compDir, "assets/gsap.min.js"), "/* stub */", "utf8");
  const res = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 3000,
    composition: {
      composition_dir: `compositions/${name}`,
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });
  return res.cue.id;
}

function setCueFieldDirect(wsDir: string, cueId: string, patch: Record<string, unknown>): void {
  const { sequence, paths } = loadSequence(wsDir);
  const cue = sequence.lanes.flatMap((l) => l.cues).find((c) => c.id === cueId);
  assert.ok(cue, `cue ${cueId} missing`);
  Object.assign(cue, patch);
  sequence.meta.revision += 1;
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");
}

test("silent composition omits comp-audio, audible one shows mix", () => {
  const wsDir = makeWs("brief-compaudio-mix");
  try {
    const silentId = mountComp(wsDir, "silent", "");
    const audId = mountComp(
      wsDir,
      "aud",
      '  <audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
    );
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "flow", compositionRootDir: wsDir });
    assert.match(md, new RegExp(`\`${audId}\`.*comp-audio: mix`));
    const silentLine = md.split("\n").find((l) => l.includes(`\`${silentId}\``));
    assert.ok(silentLine, "silent cue line missing");
    assert.ok(!silentLine.includes("comp-audio"), `silent cue must omit comp-audio: ${silentLine}`);
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("explicit off still shows off on a silent composition", () => {
  const wsDir = makeWs("brief-compaudio-off");
  try {
    const silentId = mountComp(wsDir, "silent", "");
    setCueFieldDirect(wsDir, silentId, { composition_audio: "off" });
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "flow", compositionRootDir: wsDir });
    assert.match(md, new RegExp(`\`${silentId}\`.*comp-audio: off`));
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("explicit mix shows mix even on a silent composition", () => {
  const wsDir = makeWs("brief-compaudio-explicit-mix");
  try {
    const silentId = mountComp(wsDir, "silent", "");
    setCueFieldDirect(wsDir, silentId, { composition_audio: "mix" });
    const { sequence } = loadSequence(wsDir);
    const md = renderSequenceBrief(sequence, { lens: "flow", compositionRootDir: wsDir });
    assert.match(md, new RegExp(`\`${silentId}\`.*comp-audio: mix`));
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});

test("project without compositions is byte-identical with or without compositionRootDir", () => {
  const wsDir = makeWs("brief-compaudio-nocomp");
  try {
    const { sequence } = loadSequence(wsDir);
    const plain = renderSequenceBrief(sequence, { lens: "flow" });
    const withRoot = renderSequenceBrief(sequence, { lens: "flow", compositionRootDir: wsDir });
    assert.equal(withRoot, plain);
    assert.ok(!plain.includes("comp-audio"), "no compositions means no comp-audio text");
  } finally {
    fs.rmSync(path.dirname(wsDir), { recursive: true, force: true });
  }
});
