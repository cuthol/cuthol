/**
 * Lanes-only scenes for the Live strip (`src/test/live_scenes_lanes.test.ts`):
 * a project with an empty spine but composition cues still gets one scene per
 * top-level composition cue, in time order, with stable ids and thumbnails;
 * spine projects keep exactly the old scenes.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { buildScenes } from "../live/live_state.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

function lanesOnly(): any {
  return {
    spine: { clips: [] },
    lanes: [{ id: "ln_a", kind: "composition", cues: [
      { id: "cue_02", kind: "composition", at_ms: 4000, duration_ms: 2000, composition: { composition_dir: "comps/lower" } },
      { id: "cue_01", kind: "composition", at_ms: 0, duration_ms: 4000, composition: { composition_dir: "comps/title" } },
    ] }],
    stage: { width: 1920, height: 1080 },
  };
}

test("lanes-only project yields one scene per composition cue in time order", () => {
  const scenes = buildScenes(lanesOnly());
  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes.map((s) => s.id), ["sc_1", "sc_2"]);
  assert.deepEqual(scenes[0].members, ["cue_01"]);
  assert.deepEqual(scenes[1].members, ["cue_02"]);
  assert.equal(scenes[0].start_ms, 0);
  assert.equal(scenes[0].end_ms, 4000);
  assert.equal(scenes[1].start_ms, 4000);
  assert.equal(scenes[1].end_ms, 6000);
  for (const s of scenes) assert.match(s.thumb!, new RegExp(`^/api/thumb/${s.id}\\?k=[0-9a-f]{16}$`));
  assert.notEqual(scenes[0].thumb, scenes[1].thumb);
});

test("lanes-only scene ids are stable across rebuilds", () => {
  const a = buildScenes(lanesOnly());
  const b = buildScenes(lanesOnly());
  assert.deepEqual(a, b);
});

test("spine project scenes are unchanged", () => {
  const seq: any = {
    spine: { clips: [
      { id: "sp_01", timeline_in_ms: 0, duration_ms: 3000, asset_handle: "a.mp4" },
      { id: "sp_02", timeline_in_ms: 3000, duration_ms: 2000, asset_handle: "b.mp4" },
    ] },
    lanes: [{ id: "ln_a", kind: "composition", cues: [
      { id: "cue_01", kind: "composition", at_ms: 0, duration_ms: 4000, composition: { composition_dir: "comps/title" } },
    ] }],
    stage: { width: 1920, height: 1080 },
  };
  const scenes = buildScenes(seq);
  assert.deepEqual(scenes.map((s) => s.id), ["sc_1", "sc_2"]);
  assert.deepEqual(scenes.map((s) => [s.start_ms, s.end_ms]), [[0, 3000], [3000, 5000]]);
  assert.deepEqual(scenes[0].members, ["sp_01"]);
  assert.deepEqual(scenes.map((s) => s.label), ["a.mp4", "b.mp4"]);
});
