import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";

import { syncAllCompositionBridges } from "../compositor/bridge_exporter.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { initWorkspace, loadSequence } from "../core/workspace.js";
import { createExtension, enableExtensionInWorkspace } from "../extensions/manager.js";
import { MediaLedger } from "../library/ledger.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { CutholMcpServer } from "../mcp/server.js";
import { captureMonitorFrame, captureMonitorSheet } from "../monitor/preview.js";
import { renderSequenceToMp4 } from "../render/renderer.js";
import { addLaneCue, removeLaneCues, updateLaneCue } from "../sequence/lanes.js";
import { setStageBackdropColor } from "../sequence/stage.js";
import { appendSpineClip } from "../sequence/spine.js";
import { runWorkspaceVerification } from "../verify/gates.js";
import { runCliFast } from "./c_helpers.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-silent-"));

/** Payload-only CLI calls go in-process (same handlers, no ~0.7 s spawn each). */
async function runCliJson(workspaceDir: string, args: string[]): Promise<Record<string, unknown>> {
  const res = await runCliFast([...args, "--dir", workspaceDir]);
  const text = res.stdout.trim().startsWith("{") ? res.stdout : res.stderr;
  assert.equal(res.status === 0 || text.trim().startsWith("{"), true, res.stderr);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Fixture media generated once (stable params, gitignored tmp), copied per test. */
const SHARED_MEDIA = path.join(os.tmpdir(), "cuthol-silent-shared");

/** Mono 48 kHz pcm_s16le wav written directly (no ffmpeg subprocess). */
function sharedWav(name: string, seconds: number, fn: (t: number) => number): string {
  const out = path.join(SHARED_MEDIA, name);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(SHARED_MEDIA, { recursive: true });
    const sampleRate = 48000;
    const totalSamples = Math.round(seconds * sampleRate);
    const pcmBuf = Buffer.alloc(44 + totalSamples * 2);
    pcmBuf.write("RIFF", 0);
    pcmBuf.writeUInt32LE(36 + totalSamples * 2, 4);
    pcmBuf.write("WAVE", 8);
    pcmBuf.write("fmt ", 12);
    pcmBuf.writeUInt32LE(16, 16);
    pcmBuf.writeUInt16LE(1, 20);
    pcmBuf.writeUInt16LE(1, 22);
    pcmBuf.writeUInt32LE(sampleRate, 24);
    pcmBuf.writeUInt32LE(sampleRate * 2, 28);
    pcmBuf.writeUInt16LE(2, 32);
    pcmBuf.writeUInt16LE(16, 34);
    pcmBuf.write("data", 36);
    pcmBuf.writeUInt32LE(totalSamples * 2, 40);
    for (let i = 0; i < totalSamples; i++) {
      const s16 = Math.max(-32767, Math.min(32767, Math.round(28000 * fn(i / sampleRate))));
      pcmBuf.writeInt16LE(s16, 44 + i * 2);
    }
    // Atomic publish: parallel agents on this machine share the tmp dir.
    const tmp = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, pcmBuf);
    fs.renameSync(tmp, out);
  }
  return out;
}

function sharedFfmpeg(out: string, args: string[]): string {
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Keep the extension on the temp name so ffmpeg picks the right muxer.
    const tmp = out.replace(/(\.[A-Za-z0-9]+)$/, `.tmp-${process.pid}$1`);
    const proc = spawnSync("ffmpeg", ["-y", "-v", "error", ...args, tmp], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    fs.renameSync(tmp, out);
  }
  return out;
}

test("1. Composition C.audio auto-analyzes sfx/spine/vo waveforms in window, warns on failure, and skips extra analysis when C.audio is unused", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_audio_auto");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Audio Auto Analyze", aspect: "16:9", fps: 30 });

  const sfxWav = path.join(wsDir, "sfx_mod.wav");
  const bgmWav = path.join(wsDir, "bgm_bed.wav");
  fs.copyFileSync(
    sharedWav("sfx_mod.wav", 3.0, (t) => (0.1 + 0.9 * Math.abs(Math.sin(2 * Math.PI * 0.6 * t))) * Math.sin(2 * Math.PI * 950 * t)),
    sfxWav
  );
  fs.copyFileSync(
    sharedWav("bgm_bed.wav", 3.0, (t) => 0.4 * Math.sin(2 * Math.PI * 220 * t)),
    bgmWav
  );

  const ingested = ingestAssetsIntoWorkspace({
    workspaceDir: wsDir,
    filePaths: [sfxWav, bgmWav],
  });
  const sfxAsset = ingested[0];
  const bgmAsset = ingested[1];

  // Add only SFX cue at 0..3000ms (no manual waveform analysis run)
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_sfx",
    kind: "sfx",
    assetHandle: sfxAsset.handle,
    atMs: 0,
    durationMs: 3000,
  });

  // Counter-metric: a composition that does NOT use C.audio must NOT trigger waveform analysis on SFX or emit G507
  const plainCompDir = path.join(wsDir, "compositions/plain_card");
  scaffoldHyperFramesComposition({
    targetDir: plainCompDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "title_card",
    props: { headline: "NO AUDIO USED" },
    transparent: true,
  });
  const plainCueRes = await runCliJson(wsDir, [
    "lane",
    "add-composition",
    "--lane",
    "ln_motion",
    "--comp-dir",
    "compositions/plain_card",
    "--at",
    "0ms",
    "--duration",
    "3000ms",
  ]);
  const plainVer = plainCueRes.verification as { diagnostics: Array<{ code: string }> };
  assert.equal(
    plainVer.diagnostics.some((d) => d.code === "CUTHOL-G507"),
    false,
    "Composition not using C.audio must not emit G507"
  );

  const ledger1 = new MediaLedger(path.join(wsDir, ".cuthol/ledger.sqlite"));
  try {
    assert.equal(
      ledger1.getLatestWaveform(sfxAsset.digest_sha256),
      null,
      "Composition not using C.audio must not auto-analyze non-music SFX waveform"
    );
  } finally {
    ledger1.close();
  }

  // Now mount a composition that DOES use C.audio
  const audioCompDir = path.join(wsDir, "compositions/sfx_audio_comp");
  scaffoldHyperFramesComposition({
    targetDir: audioCompDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "audio_glow",
    props: { headline: "SFX ENERGY", subline: "REACTIVE" },
    transparent: true,
  });
  await runCliJson(wsDir, [
    "lane",
    "add-composition",
    "--lane",
    "ln_motion",
    "--comp-dir",
    "compositions/sfx_audio_comp",
    "--at",
    "0ms",
    "--duration",
    "3000ms",
  ]);

  const dataJsonPath = path.join(audioCompDir, "assets/cuthol-data.json");
  const bridgeData = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as {
    audio: { fps: number; mid: number[]; low: number[]; high: number[] };
    warnings?: string[];
  };
  assert.ok(bridgeData.audio.mid.length >= 70, "Expected populated audio.mid array");
  assert.ok(
    Math.max(...bridgeData.audio.mid) >= 0.95 && Math.min(...bridgeData.audio.mid) <= 0.1,
    "Expected dynamic 0.05..1.0 range in audio.mid"
  );
  assert.equal(bridgeData.warnings, undefined);

  // Force waveform analysis failure by clearing waveform_cache and corrupting the SFX file on disk
  const db = new DatabaseSync(path.join(wsDir, ".cuthol/ledger.sqlite"));
  db.exec("DELETE FROM waveform_cache");
  db.close();
  fs.writeFileSync(sfxWav, "corrupted-audio-payload", "utf8");

  await runCliJson(wsDir, ["composition", "sync"]);
  const failedData = JSON.parse(fs.readFileSync(dataJsonPath, "utf8")) as {
    audio: { mid: number[] };
    warnings?: string[];
  };
  assert.equal(failedData.audio.mid.length, 0);
  assert.ok(
    failedData.warnings && failedData.warnings.some((w) => w.includes("C.audio")),
    "Expected explicit C.audio failure warning in cuthol-data.json"
  );

  // Verify window.__cuthol.warnings also carries the warning
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(audioCompDir, "assets/cuthol-data.js"), "utf8"), sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(audioCompDir, "assets/cuthol-runtime.js"), "utf8"),
    sandbox
  );
  const runtimeC = sandbox.window.__cuthol as { warnings: string[] };
  assert.ok(
    runtimeC.warnings.some((w) => w.includes("C.audio")),
    `Expected C.warnings to include audio warning, got: ${JSON.stringify(runtimeC.warnings)}`
  );

  // Verify `cuthol verify` emits CUTHOL-G507 only for the composition using C.audio
  const verReport = runWorkspaceVerification(wsDir);
  const g507 = verReport.diagnostics.filter((d) => d.code === "CUTHOL-G507");
  assert.equal(g507.length, 1, "Expected exactly 1 G507 diagnostic (only for the C.audio composition)");

  // Counter-metric: music lane (`ln_bgm`) still auto-analyzes even for compositions not using C.audio
  removeLaneCues({ workspaceDir: wsDir, cueIds: ["cue_03"] });
  addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_bgm",
    kind: "music",
    assetHandle: bgmAsset.handle,
    atMs: 0,
    durationMs: 3000,
  });
  const plainDataAfterBgm = JSON.parse(
    fs.readFileSync(path.join(plainCompDir, "assets/cuthol-data.json"), "utf8")
  ) as { audio: { low: number[] } };
  assert.ok(
    plainDataAfterBgm.audio.low.length > 0,
    "Music lane auto-analysis behavior must remain intact"
  );
});

test("2. lane add-composition syncs extension assets before lint (no false G407) while catching genuinely missing files", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_ext_lint");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Ext Lint Order", aspect: "16:9", fps: 30 });

  createExtension({
    name: "uikit",
    scope: "project",
    workspaceDir: wsDir,
    template: "full",
    overwrite: true,
  });
  const extBadgePath = path.join(wsDir, ".cuthol/extensions/uikit/assets/logo.svg");
  fs.mkdirSync(path.dirname(extBadgePath), { recursive: true });
  fs.writeFileSync(
    extBadgePath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#22C55E"/></svg>`,
    "utf8"
  );
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "uikit" });

  // Composition 1: uses `assets/ext/uikit/logo.svg` before it exists in the composition folder
  const validCompDir = path.join(wsDir, "compositions/with_ext_asset");
  scaffoldHyperFramesComposition({
    targetDir: validCompDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "blank",
    transparent: true,
  });
  const validHtmlPath = path.join(validCompDir, "index.html");
  fs.writeFileSync(
    validHtmlPath,
    fs
      .readFileSync(validHtmlPath, "utf8")
      .replace(
        `<div id="main-content"></div>`,
        `<div id="main-content"><img src="assets/ext/uikit/logo.svg" width="80" height="80" /></div>`
      ),
    "utf8"
  );
  assert.equal(
    fs.existsSync(path.join(validCompDir, "assets/ext/uikit/logo.svg")),
    false,
    "Precondition: extension asset is not yet in composition folder before add-composition"
  );

  const addValidRes = await runCliJson(wsDir, [
    "lane",
    "add-composition",
    "--lane",
    "ln_motion",
    "--comp-dir",
    "compositions/with_ext_asset",
    "--at",
    "0ms",
    "--duration",
    "2000ms",
  ]);
  const validDiags = (addValidRes.verification as { diagnostics: Array<{ code: string }> })
    .diagnostics;
  assert.equal(
    validDiags.filter((d) => d.code === "CUTHOL-G407").length,
    0,
    `Expected 0 G407 warnings for enabled extension asset, got: ${JSON.stringify(validDiags)}`
  );
  assert.equal(fs.existsSync(path.join(validCompDir, "assets/ext/uikit/logo.svg")), true);

  // Composition 2: references a genuinely non-existent file `assets/does_not_exist.png`
  const missingCompDir = path.join(wsDir, "compositions/with_missing_asset");
  scaffoldHyperFramesComposition({
    targetDir: missingCompDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "blank",
    transparent: true,
  });
  const missingHtmlPath = path.join(missingCompDir, "index.html");
  fs.writeFileSync(
    missingHtmlPath,
    fs
      .readFileSync(missingHtmlPath, "utf8")
      .replace(
        `<div id="main-content"></div>`,
        `<div id="main-content"><img src="assets/does_not_exist.png" width="80" height="80" /></div>`
      ),
    "utf8"
  );
  const addMissingRes = await runCliJson(wsDir, [
    "lane",
    "add-composition",
    "--lane",
    "ln_motion",
    "--comp-dir",
    "compositions/with_missing_asset",
    "--at",
    "2500ms",
    "--duration",
    "2000ms",
  ]);
  const missingG407 = (
    addMissingRes.verification as { diagnostics: Array<{ code: string; what: string }> }
  ).diagnostics.filter((d) => d.code === "CUTHOL-G407");
  assert.equal(missingG407.length, 1, "Expected G407 warning for genuinely missing local asset");
  assert.match(missingG407[0].what, /missing_local_asset/);
});

test("3. VFR detection in library probe and INFO [CUTHOL-G207] in verify (none on CFR)", () => {
  const wsDir = path.join(TEST_ROOT, "ws_vfr");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "VFR Check", aspect: "16:9", fps: 30 });

  const cfrMp4 = path.join(wsDir, "cfr_clip.mp4");
  fs.copyFileSync(
    sharedFfmpeg(path.join(SHARED_MEDIA, "cfr_clip.mp4"), [
      "-f", "lavfi", "-i", "color=c=#334155:s=640x360:r=30:d=1.5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]),
    cfrMp4
  );

  // Create a synthetic VFR MP4 by concatenating a 15fps segment and a 60fps segment with vfr vsync
  const seg15 = sharedFfmpeg(path.join(SHARED_MEDIA, "seg15.mp4"), [
    "-f", "lavfi", "-i", "testsrc=s=640x360:r=15:d=1.0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]);
  const seg60 = sharedFfmpeg(path.join(SHARED_MEDIA, "seg60.mp4"), [
    "-f", "lavfi", "-i", "testsrc=s=640x360:r=60:d=1.0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]);
  const vfrMp4 = path.join(wsDir, "vfr_clip.mp4");
  fs.copyFileSync(
    sharedFfmpeg(path.join(SHARED_MEDIA, "vfr_clip.mp4"), [
      "-i", seg15, "-i", seg60,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-fps_mode", "vfr",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]),
    vfrMp4
  );

  const cfrIngested = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [cfrMp4] })[0];
  assert.equal(cfrIngested.probe.is_vfr, false, "CFR source must have is_vfr: false");
  appendSpineClip({ workspaceDir: wsDir, assetHandle: cfrIngested.handle });

  const verCfr = runWorkspaceVerification(wsDir);
  assert.equal(
    verCfr.diagnostics.some((d) => d.code === "CUTHOL-G207"),
    false,
    "CFR source must not emit CUTHOL-G207"
  );

  const vfrIngested = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [vfrMp4] })[0];
  assert.equal(vfrIngested.probe.is_vfr, true, "VFR source must have is_vfr: true");

  // An ingested VFR asset that no clip or cue plays is not reported.
  const verUnused = runWorkspaceVerification(wsDir);
  assert.equal(
    verUnused.diagnostics.some((d) => d.code === "CUTHOL-G207"),
    false,
    "Unused VFR asset must not emit CUTHOL-G207"
  );

  appendSpineClip({ workspaceDir: wsDir, assetHandle: vfrIngested.handle });
  const verVfr = runWorkspaceVerification(wsDir);
  const g207 = verVfr.diagnostics.filter((d) => d.code === "CUTHOL-G207");
  assert.equal(g207.length, 1, "Expected 1 CUTHOL-G207 diagnostic for VFR asset");
  assert.equal(g207[0].severity, "INFO");
  assert.equal(verVfr.warning_count, 0, "INFO diagnostic must not inflate warning_count");
  assert.equal(verVfr.info_count, 1);
  assert.match(g207[0].what, /VFR/);
});

test("4. monitor sheet --at / at=[...], 5. lane cue rotation (graphic + title), and 6. composition.sync updated flag", async () => {
  const wsDir = path.join(TEST_ROOT, "ws_sheet_rot_sync");
  fs.rmSync(wsDir, { recursive: true, force: true });
  initWorkspace({ dir: wsDir, title: "Sheet Rotation Sync", aspect: "16:9", fps: 30 });
  setStageBackdropColor({ workspaceDir: wsDir, color: "#0F172A" });

  const cardPng = path.join(wsDir, "card.png");
  fs.copyFileSync(
    sharedFfmpeg(path.join(SHARED_MEDIA, "card.png"), [
      "-f", "lavfi", "-i",
      "color=c=#F59E0B:s=640x360:d=1,drawbox=x=16:y=16:w=608:h=328:color=#FFFFFF:t=8",
      "-frames:v", "1",
    ]),
    cardPng
  );
  const [imgAsset] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [cardPng] });

  const gCue = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_broll",
    kind: "broll",
    assetHandle: imgAsset.handle,
    atMs: 0,
    durationMs: 5000,
    scale: 0.45,
    yPct: -14,
    rotationDeg: 5,
  });
  assert.equal(gCue.cue.placement.rotation_deg, 5);

  const gCueUpdated = updateLaneCue({
    workspaceDir: wsDir,
    cueId: gCue.cue.id,
    rotationDeg: "+=10",
  });
  assert.equal(gCueUpdated.cue.placement.rotation_deg, 15);

  const tCue = addLaneCue({
    workspaceDir: wsDir,
    laneId: "ln_titles",
    kind: "title",
    text: "ROTATED 15 DEG",
    atMs: 0,
    durationMs: 5000,
    fontSizePx: 64,
    yPct: 22,
  });
  const tCueUpdated = updateLaneCue({
    workspaceDir: wsDir,
    cueId: tCue.cue.id,
    rotationDeg: 15,
  });
  assert.equal(tCueUpdated.cue.placement.rotation_deg, 15);

  // 4. monitor sheet with 4 explicit timestamps via CLI and MCP
  const sheetRes = captureMonitorSheet({
    workspaceDir: wsDir,
    atMs: [400, 1250, 2700, 4100],
  });
  // Each cell is labelled with the frame-grid instant actually drawn (30 fps): 1250 ms lands
  // inside frame 37, whose instant is 1233.33 ms; on-grid requests keep their value.
  assert.deepEqual(
    sheetRes.frames.map((f) => f.timestamp_ms),
    [400, (37 * 1000) / 30, 2700, 4100]
  );

  const mcp = new CutholMcpServer({ defaultDir: wsDir });
  const mcpSheet = await mcp.callTool("monitor", {
    action: "sheet",
    at: ["0.4s", "1.25s", "2.7s", "4.1s"],
  });
  assert.equal(mcpSheet.isError, false);

  // 5. Verify monitor frame at 1000ms and draft render at 1000ms both show the rotated graphic and title (non-blank)
  const monFrame = captureMonitorFrame({
    workspaceDir: wsDir,
    atMs: 1000,
    showBoxes: false,
  });
  assert.equal(monFrame.metrics.is_blank_frame, false);
  assert.ok(monFrame.metrics.luma_mean > 35, `Expected visible rotated graphic/title, got luma=${monFrame.metrics.luma_mean}`);

  const renderRes = renderSequenceToMp4({
    workspaceDir: wsDir,
    preset: "draft_480p",
  });
  assert.equal(renderRes.ok, true);

  // 6. composition.sync `updated` flag when unchanged vs changed
  const compDir = path.join(wsDir, "compositions/sync_test");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 2000,
    preset: "title_card",
    props: { headline: "INITIAL" },
    transparent: true,
  });
  await runCliJson(wsDir, [
    "lane",
    "add-composition",
    "--lane",
    "ln_motion",
    "--comp-dir",
    "compositions/sync_test",
    "--at",
    "0ms",
    "--duration",
    "2000ms",
  ]);

  // No change -> updated: false
  const sync1 = await runCliJson(wsDir, ["composition", "sync"]);
  assert.equal(sync1.updated, false);
  assert.equal(sync1.updated_count, 0);

  // Modify props in sequence file -> composition.sync must report updated: true with updated_files & reason
  const { paths, sequence } = loadSequence(wsDir);
  const compCue = sequence.lanes.find((l) => l.id === "ln_motion")!.cues[0];
  compCue.composition!.props = { headline: "CHANGED" };
  fs.writeFileSync(paths.sequenceFile, JSON.stringify(sequence, null, 2), "utf8");

  const sync2 = await runCliJson(wsDir, ["composition", "sync"]);
  assert.equal(sync2.updated, true);
  assert.equal(sync2.updated_count, 1);
  const syncedItem = (sync2.synced as Array<{ updated: boolean; updated_files: string[]; reason: string }>)[0];
  assert.equal(syncedItem.updated, true);
  assert.ok(syncedItem.updated_files.includes("assets/cuthol-data.json"));
  assert.ok(syncedItem.updated_files.includes("assets/cuthol-vars.json"));
  assert.match(syncedItem.reason, /slice_hash_changed/);

  // Immediate repeat without changes -> updated: false
  const sync3 = await runCliJson(wsDir, ["composition", "sync"]);
  assert.equal(sync3.updated, false);
  assert.equal(sync3.updated_count, 0);
  const syncedAfter = syncAllCompositionBridges(loadSequence(wsDir).sequence, paths);
  assert.equal(syncedAfter[0].updated, false);
});
