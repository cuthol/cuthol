/**
 * Rotation metadata: a phone video stored landscape (1920x1080) with a 90°
 * rotation tag presents as portrait. Probing must report the presented
 * dimensions so the canvas is adopted portrait, and the render stays upright.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSequence } from "../core/workspace.js";
import { MediaLedger } from "../library/ledger.js";
import { probeLocalMediaFile } from "../library/probe.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-rotation-"));

function ffmpeg(args: string[]): void {
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
}

function makeRotatedClip(): string {
  const plain = path.join(TMP, "plain.mp4");
  const rotated = path.join(TMP, "rot90.mp4");
  if (!fs.existsSync(rotated)) {
    // Asymmetric source: red top half, blue bottom half, frame number burned
    // in, so an upright frame is distinguishable from a sideways one.
    ffmpeg([
      "-f", "lavfi", "-i", "color=c=#FF0000:s=1920x540:r=30:d=2",
      "-f", "lavfi", "-i", "color=c=#0000FF:s=1920x540:r=30:d=2",
      "-filter_complex",
      "[0:v][1:v]vstack,drawtext=fontfile=C\\\\:/Windows/Fonts/arial.ttf:text='TOP':x=100:y=60:fontsize=72:fontcolor=white[v]",
      "-map", "[v]",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      plain,
    ]);
    ffmpeg(["-display_rotation", "90", "-i", plain, "-c", "copy", rotated]);
  }
  return rotated;
}

function probeDims(filePath: string): { width: number; height: number } {
  const ledger = new MediaLedger(path.join(TMP, "ledger.sqlite"));
  try {
    return probeLocalMediaFile(filePath, ledger).probe;
  } finally {
    ledger.close();
  }
}

test("probe reports the presented dimensions of a rotated clip", () => {
  const rotated = makeRotatedClip();
  const probe = probeDims(rotated);
  assert.equal(probe.width, 1080, `stored 1920x1080 with 90° rotation must present as 1080 wide`);
  assert.equal(probe.height, 1920);
});

test("portrait clip adopts a portrait canvas and renders upright", () => {
  const rotated = makeRotatedClip();
  const wsDir = path.join(TMP, "ws");
  fs.rmSync(wsDir, { recursive: true, force: true });
  // No --aspect/--size: the first visual source adopts the canvas.
  let proc = spawnSync(process.execPath, [CLI, "workspace", "init", wsDir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
  });
  assert.equal(proc.status, 0, proc.stderr);

  ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [rotated] });
  appendSpineClip({ workspaceDir: wsDir, assetHandle: "vid_01", sourceInMs: 0, sourceOutMs: 2000 });

  const { sequence } = loadSequence(wsDir);
  assert.equal(sequence.stage.width, 1080);
  assert.equal(sequence.stage.height, 1920);

  const res = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
    outputPath: "output/rot.mp4",
    workers: 2,
    encoder: "libx264",
  });
  assert.equal(res.ok, true);
  // Draft of a 1080x1920 stage keeps portrait proportions.
  assert.ok(res.height > res.width, `render must be portrait, got ${res.width}x${res.height}`);

  const framePng = path.join(TMP, "rot_frame.png");
  ffmpeg(["-ss", "1", "-i", res.output_path, "-frames:v", "1", framePng]);
  const probePng = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", framePng],
    { encoding: "utf8" }
  );
  const [fw, fh] = String(probePng.stdout).trim().split(",").map(Number);
  assert.ok(fh > fw, `frame must be portrait, got ${fw}x${fh}`);
});
