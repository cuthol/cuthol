import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { singleFrameFilterArgs } from "../render/render_frames.js";

test("short graph stays inline", () => {
  const r = singleFrameFilterArgs("null[v_single_out]", ["-i", "a.mp4"]);
  assert.deepEqual(r.args, ["-filter_complex", "null[v_single_out]"]);
  assert.equal(r.filterScript, null);
});

test("long graph goes through a file", () => {
  const graph = `null,${"trim=start=0,".repeat(600)}null[v_single_out]`;
  assert.ok(graph.length > 4000);
  const r = singleFrameFilterArgs(graph, ["-i", "a.mp4"]);
  assert.equal(r.args[0], "-/filter_complex");
  assert.equal(r.filterScript, graph);
});

test("many inputs force the file even for a short graph", () => {
  const inputs: string[] = [];
  for (let i = 0; i < 400; i++) inputs.push("-i", `C:\\media\\clip_${i}_with_a_long_name.mp4`);
  const r = singleFrameFilterArgs("null[v_single_out]", inputs);
  assert.equal(r.args[0], "-/filter_complex");
  assert.equal(r.filterScript, "null[v_single_out]");
});

test("single frame renders on a small project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-frame-file-"));
  const dir = path.join(root, "proj");
  const run = (args: string[]) => {
    const proc = spawnSync("node", [path.resolve(process.cwd(), "dist/cli.js"), ...args, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    });
    assert.equal(proc.status, 0, args.join(" ") + "\n" + proc.stderr);
    return proc.stdout;
  };
  run(["workspace", "init", dir, "--aspect", "16:9", "--fps", "30", "--title", "t"]);
  // Build one tiny source with ffmpeg itself so the test needs no fixtures.
  const src = path.join(root, "src.mp4");
  const gen = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=2", "-pix_fmt", "yuv420p", src],
    { encoding: "utf8" }
  );
  assert.equal(gen.status, 0, gen.stderr);
  run(["library", "ingest", src]);
  run(["spine", "append", "--asset", "vid_01", "--in", "0ms", "--out", "2000ms"]);
  const out = path.join(root, "f.png");
  const json = run(["monitor", "frame", "--at", "500ms", "--out", out]);
  assert.match(json, /"ok":\s*true/);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.statSync(out).size > 1000);
  // No filter script files are left behind after the run.
  const blobs = path.join(dir, ".cuthol", "blobs");
  const leftover = fs.existsSync(blobs)
    ? fs.readdirSync(blobs).filter((f) => f.startsWith("single_frame_"))
    : [];
  assert.deepEqual(leftover, []);
  fs.rmSync(root, { recursive: true, force: true });
});
