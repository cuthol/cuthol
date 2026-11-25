/**
 * Render report composition audio state: the render's own verification runs
 * before the composition audio stems are extracted, so a fresh project with
 * a composition that plays audio must not carry a stale G416 WARN ("no stem
 * extracted") in its render report. The report reflects the post-extraction
 * state, and a later `verify` agrees with it.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const GSAP_MIN_JS = path.resolve("node_modules/gsap/dist/gsap.min.js");

function runCli(
  wsDir: string,
  args: string[]
): { status: number | null; envelope: any } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", wsDir], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CUTHOL_SKILLS_AUTO: "0",
      CUTHOL_ENCODER: "x264",
    },
  });
  const text = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `no JSON envelope for ${args.join(" ")}:\n${text.slice(0, 2000)}`);
  return { status: proc.status, envelope: JSON.parse(text.slice(start, end + 1)) };
}

function writeToneWav(outPath: string, seconds: number): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const proc = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=880:duration=${seconds}:sample_rate=48000`,
      "-c:a",
      "pcm_s16le",
      outPath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
}

function makeAudioComp(wsDir: string, compName: string, audioTag: string | null): string {
  const compDir = path.join(wsDir, "compositions", compName);
  fs.rmSync(compDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  const audioEl = audioTag ? `\n  ${audioTag}` : "";
  fs.writeFileSync(
    path.join(compDir, "index.html"),
    `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="3">
  <div id="box" class="clip" data-start="0" data-duration="3" style="position:absolute;left:10px;top:10px;width:60px;height:60px;background:#ff0000;"></div>${audioEl}
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
`,
    "utf8"
  );
  fs.copyFileSync(GSAP_MIN_JS, path.join(compDir, "assets/gsap.min.js"));
  const res = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 3000,
    composition: {
      composition_dir: `compositions/${compName}`,
      entry_html: "index.html",
      props: {},
      transparent: true,
    },
  });
  return res.cue.id;
}

function allDiags(envelope: any): any[] {
  return (
    envelope?.result?.verification?.diagnostics ??
    envelope?.result?.diagnostics ??
    envelope?.verification?.diagnostics ??
    envelope?.diagnostics ??
    []
  );
}

function g416(diags: any[]): any[] {
  return (diags ?? []).filter((d) => d.code === "CUTHOL-G416");
}

function setupSmall(wsDir: string, title: string): void {
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title, aspect: "16:9", fps: 30 });
  const seqPath = path.join(wsDir, "cuthol.sequence.json");
  const seqInit = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  seqInit.stage.width = 320;
  seqInit.stage.height = 180;
  fs.writeFileSync(seqPath, JSON.stringify(seqInit, null, 2), "utf8");
}

test("render report drops the stale G416 WARN once the stem is extracted", () => {
  const wsDir = path.join(path.resolve(process.cwd(), "test-workspace"), "render_stem_report_ok");
  setupSmall(wsDir, "stem report");
  const cueId = makeAudioComp(
    wsDir,
    "aud",
    '<audio id="tone" src="assets/tone.wav" data-start="0" data-duration="1"></audio>'
  );
  writeToneWav(path.join(wsDir, "compositions/aud/assets/tone.wav"), 1);

  // Before any render the stem is genuinely missing: verify alone still warns.
  const preVerify = runCli(wsDir, ["verify"]);
  assert.equal(preVerify.status, 0, JSON.stringify(preVerify.envelope).slice(0, 1000));
  const preG416 = g416(allDiags(preVerify.envelope));
  assert.equal(preG416.length, 1, JSON.stringify(preG416));
  assert.equal(preG416[0].severity, "WARN");

  const render = runCli(wsDir, ["render", "--preset", "draft_480p"]);
  assert.equal(render.status, 0, JSON.stringify(render.envelope).slice(0, 2000));
  const renderDiags = allDiags(render.envelope);
  const renderG416 = g416(renderDiags);
  assert.ok(
    renderG416.every((d) => d.severity !== "WARN"),
    `stale G416 WARN in render report: ${JSON.stringify(renderG416)}`
  );
  assert.ok(
    renderG416.some((d) => d.severity === "INFO" && String(d.what).includes(cueId)),
    `expected G416 in-mix INFO for ${cueId}: ${JSON.stringify(renderG416)}`
  );

  const postVerify = runCli(wsDir, ["verify"]);
  assert.equal(postVerify.status, 0);
  const postG416 = g416(allDiags(postVerify.envelope));
  assert.deepEqual(
    postG416.map((d) => ({ code: d.code, severity: d.severity, what: d.what })),
    renderG416.map((d: any) => ({ code: d.code, severity: d.severity, what: d.what }))
  );
});

test("a stem that render cannot extract still warns", () => {
  const wsDir = path.join(path.resolve(process.cwd(), "test-workspace"), "render_stem_report_missing");
  setupSmall(wsDir, "stem missing");
  // Audio tag points at a file that does not exist: extraction fails.
  makeAudioComp(
    wsDir,
    "broken",
    '<audio id="tone" src="assets/gone.wav" data-start="0" data-duration="1"></audio>'
  );

  const preVerify = runCli(wsDir, ["verify"]);
  assert.equal(preVerify.status, 0);
  const preWarns = g416(allDiags(preVerify.envelope));
  assert.ok(preWarns.some((d) => d.severity === "WARN"), "verify alone must warn while the stem is missing");

  const render = runCli(wsDir, ["render", "--preset", "draft_480p"]);
  if (render.status !== 0 || render.envelope.ok === false) {
    // The broken composition stops the render: the failure must name the
    // missing audio, never silently claim a healthy mix.
    const blob = JSON.stringify(render.envelope).slice(0, 3000);
    assert.match(blob, /audio|stem|tone/i, `render failure must name the missing audio: ${blob}`);
    return;
  }
  const renderDiags: any[] = allDiags(render.envelope);
  const cueWarns = renderDiags.filter(
    (d) => d.severity === "WARN" && (d.code === "CUTHOL-G416" || d.code === "CUTHOL-G435")
  );
  assert.ok(cueWarns.length > 0, `expected a stem-missing WARN, got: ${JSON.stringify(renderDiags.map((d) => [d.code, d.severity]))}`);
  assert.ok(
    !renderDiags.some((d) => d.code === "CUTHOL-G416" && d.severity === "INFO" && /brings .* into the Cuthol mix/.test(String(d.what))),
    "render must not claim the missing stem is in the mix"
  );
});
