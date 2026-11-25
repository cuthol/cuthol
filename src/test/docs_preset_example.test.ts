// The `punch_out` manifest example in `skills/cuthol-extensions/references/effects.md`
// ("Presets") enables and applies exactly as written: the JSON is extracted
// from the Markdown, installed as an extension, enabled, applied with
// `spine fx preset` and reapplied.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSpineFxPreset } from "../cli_cmd_spine.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine.js";

const EFFECTS_MD = path.resolve("skills", "cuthol-extensions", "references", "effects.md");

function extractPresetExample(): Record<string, unknown> {
  const md = fs.readFileSync(EFFECTS_MD, "utf8");
  const m = /```json preset-example\r?\n([\s\S]*?)```/.exec(md);
  assert.ok(m, "effects.md must contain a ```json preset-example block");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

test("docs preset example enables and applies as written", () => {
  const manifest = extractPresetExample();
  assert.equal(typeof manifest.name, "string");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxfix-preset-"));
  try {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "preset-docs", aspect: "16:9", fps: 30 });
    const dir = path.join(wsDir, ".cuthol", "extensions", String(manifest.name));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(manifest, null, 2), "utf8");
    // `cuthol extension enable punch` (same function the CLI calls).
    enableExtensionInWorkspace({ workspaceDir: wsDir, name: String(manifest.name) });
    const media = path.join(wsDir, "media", "clip.mp4");
    fs.mkdirSync(path.dirname(media), { recursive: true });
    const proc = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", media],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(proc.status, 0, proc.stderr || "ffmpeg failed");
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    const { clip } = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle });
    // `cuthol spine fx preset --item <sp_XX> --preset ext:punch/punch_out --param amount=1`.
    runSpineFxPreset(wsDir, {
      item: clip.id,
      preset: `ext:${manifest.name}/punch_out`,
      params: '{"amount":1}',
    });
    const seq = loadSequence(wsDir).sequence;
    const entry = (seq.spine.clips.find((c) => c.id === clip.id)?.fx ?? []).find(
      (f) => (f as { preset?: unknown }).preset
    ) as unknown as { id: string } | undefined;
    assert.ok(entry, "preset apply writes one fx entry with a record");
    // `cuthol spine fx preset --item <sp_XX> --fx <fx_XX> --reapply`.
    runSpineFxPreset(wsDir, { item: clip.id, fx: entry.id, reapply: true });
    // `cuthol spine fx preset --item <sp_XX> --reapply --all`.
    runSpineFxPreset(wsDir, { item: clip.id, reapply: true, all: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
