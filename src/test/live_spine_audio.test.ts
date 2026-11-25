/**
 * Audio-only spine clips: no thumbnail URL, waveform path instead.
 * Fails on old builds (isAudioOnlySpineClip / sceneIsAudioOnly did not exist).
 * Merged from live_audio_spine.test.ts: its buildScenes behaviour checks live
 * on here, and its source-text UI assertions (timeline.js / scenes.js grep)
 * are replaced by a server-observed check (snapshot carries audio_only with
 * no thumb URL; the thumb endpoint answers with a placeholder, never a file).
 */
import "./test_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { buildScenes, isAudioOnlySpineClip, sceneIsAudioOnly } from "../live/live_state.js";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import type { LiveServerInfo } from "../live/live_types.js";
import { ensureSceneThumb, refreshSceneThumbs } from "../live/live_thumbs.js";
import { appendSpineClip } from "../sequence/spine.js";
import { rmRetrySync } from "./b_helpers.js";

function seqWith(clips: any[], library: any[] = []): any {
  return { stage: {}, spine: { clips }, lanes: [], library };
}

test("audio library asset is detected as audio-only", () => {
  const seq = seqWith(
    [{ id: "sp_1", asset_handle: "take1.mp3", timeline_in_ms: 0, duration_ms: 1000 }],
    [{ handle: "take1.mp3", kind: "audio" }],
  );
  assert.equal(isAudioOnlySpineClip(seq, seq.spine.clips[0]), true);
  assert.equal(sceneIsAudioOnly(seq, ["sp_1"]), true);
});

test("footage clip is not audio-only", () => {
  const seq = seqWith(
    [{ id: "sp_1", asset_handle: "a.mp4", timeline_in_ms: 0, duration_ms: 1000 }],
    [{ handle: "a.mp4", kind: "footage" }],
  );
  assert.equal(isAudioOnlySpineClip(seq, seq.spine.clips[0]), false);
});

test("audio-only scene carries no thumbnail URL", () => {
  const seq = seqWith(
    [
      { id: "sp_1", asset_handle: "take1.mp3", timeline_in_ms: 0, duration_ms: 1000 },
      { id: "sp_2", asset_handle: "b.mp4", timeline_in_ms: 1000, duration_ms: 1000 },
    ],
    [
      { handle: "take1.mp3", kind: "audio" },
      { handle: "b.mp4", kind: "footage" },
    ],
  );
  const scenes = buildScenes(seq);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].audio_only, true);
  assert.equal(scenes[0].thumb, undefined);
  assert.ok(typeof scenes[1].thumb === "string" && scenes[1].thumb.length > 0);
});

test("audio-only spine scene from song assets carries no thumbnail", () => {
  const seq = {
    spine: {
      clips: [
        { id: "c1", asset_handle: "song.mp3", timeline_in_ms: 0, duration_ms: 1000 },
        { id: "c2", asset_handle: "song.mp3", timeline_in_ms: 1000, duration_ms: 1000 },
      ],
    },
    library: [{ handle: "song.mp3", kind: "audio" }],
  } as any;
  const scenes = buildScenes(seq);
  const first = scenes.find((s) => (s.members ?? []).includes("c1"));
  assert.ok(first, "scene covering the audio clip exists");
  assert.equal((first as any).audio_only, true, "scene marked audio-only for behaviour, not export presence");
  assert.ok(!(first as any).thumb, "no thumb URL so the window never requests one");
});

test("mixed scene is not audio-only", () => {
  const seq: any = {
    spine: {
      clips: [
        { id: "c1", asset_handle: "song.mp3", timeline_in_ms: 0, duration_ms: 1000 },
        { id: "c2", asset_handle: "shot.mp4", timeline_in_ms: 1000, duration_ms: 1000 },
      ],
    },
    library: [{ handle: "song.mp3", kind: "audio" }, { handle: "shot.mp4", kind: "video" }],
  };
  const scenes = buildScenes(seq);
  const videoScene = scenes.find((s) => (s.members ?? []).includes("c2"));
  assert.ok(videoScene, "scene covering the video clip exists");
  assert.equal((videoScene as any).audio_only, undefined);
});

test("audio-only scene renders no thumbnail file", async () => {
  const seq = seqWith(
    [{ id: "sp_1", asset_handle: "take1.mp3", timeline_in_ms: 0, duration_ms: 1000 }],
    [{ handle: "take1.mp3", kind: "audio" }],
  );
  const scenes = buildScenes(seq);
  assert.equal(scenes[0].audio_only, true);
  assert.equal(ensureSceneThumb("nonexistent-proj", seq, scenes[0] as any), null);
  assert.deepEqual(await refreshSceneThumbs("nonexistent-proj", seq, scenes as any), []);
});

function httpGet(port: number, reqPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => {
        body += c.toString("utf8");
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Server-observed audio-only behaviour (replaces the old timeline.js /
 * scenes.js source-text assertions): with an audio-only spine clip the live
 * snapshot marks the scene audio_only with no thumb URL, and the thumb
 * endpoint answers with a placeholder instead of a rendered picture.
 */
test("server: audio-only scene has no thumb URL and serves a placeholder", { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-spine-audio-srv-"));
  const wsDir = path.join(tmp, "ws");
  let info: LiveServerInfo | null = null;
  try {
    initWorkspace({ dir: wsDir, title: "spine audio", aspect: "16:9", fps: 30 });
    const media = path.join(tmp, "voice.mp3");
    const proc = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=2", "-t", "2", "-c:a", "libmp3lame", media],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? ""}`);
    const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [media] });
    appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 2000 });

    info = await ensureLiveServer(wsDir);
    const snap = await httpGet(info.port, `/api/snapshot?t=${info.token}`);
    assert.equal(snap.status, 200, `snapshot failed: ${snap.body.slice(0, 300)}`);
    const scenes = (JSON.parse(snap.body) as any).scenes as any[];
    assert.ok(Array.isArray(scenes) && scenes.length > 0, "snapshot carries scenes");
    const audioScene = scenes.find((s) => (s.audio_only ?? false) === true);
    assert.ok(audioScene, `expected an audio-only scene, got: ${snap.body.slice(0, 500)}`);
    assert.ok(!audioScene.thumb, "audio-only scene carries no thumb URL so the window never requests one");

    const thumb = await httpGet(info.port, `/api/thumb/${audioScene.id}?t=${info.token}`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers["content-type"] ?? "", /svg/, "thumb endpoint answers with a placeholder image");
    assert.ok(!/jpeg/.test(thumb.headers["content-type"] ?? ""), "no rendered picture is served for the audio-only scene");
  } finally {
    if (info) {
      try {
        await stopLiveServer(wsDir);
      } catch {
        // already gone
      }
    }
    rmRetrySync(tmp);
  }
});
