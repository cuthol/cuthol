// Multi-scene notes (parts 1+4): cue lookup, sheet cell planning, agent lines.
// @ts-ignore - plain JS UI module without types; resolved at runtime
import { cueAtTimeSeq, cueBoundaries, cueOptions, orderedDrafts, renumberAll } from "../../src/live/ui/notes.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { CutholSequence } from "../core/schema.js";
import { cueAtTime, planSheetCells, SHEET_MAX_CELLS } from "../live/live_notes_api.js";
import { formatLiveNoteLines } from "../live/live_inbox.js";
import type { LiveNote, LiveNotePacket } from "../live/live_types.js";

function seq(): CutholSequence {
  return {
    stage: { width: 1920, height: 1080, fps: 30, aspect: "16:9", backdrop: "#000" },
    spine: { clips: [{ id: "clip_3", at_ms: 0, duration_ms: 10000 }] },
    lanes: [
      {
        id: "ln_1",
        z_index: 1,
        cues: [
          { id: "s04", kind: "composition", anchor: null, at_ms: 0, duration_ms: 5000, placement: {}, envelopes: [] },
          { id: "s05", kind: "composition", anchor: null, at_ms: 5000, duration_ms: 5000, placement: {}, envelopes: [] },
        ],
      },
    ],
  } as unknown as CutholSequence;
}

function note(n: number, over: Partial<LiveNote> = {}): LiveNote {
  return {
    n,
    text: `note ${n}`,
    at_ms: 1000,
    frame: 30,
    point: { x: 960, y: 540, nx: 0.5, ny: 0.5 },
    elements: [],
    ...over,
  };
}

function packet(notes: LiveNote[]): LiveNotePacket {
  return { schema: "cuthol.live/1", id: "n_x", created_at: new Date().toISOString(), revision: 1, notes };
}

test("cueAtTime picks the cue under the time, else the spine clip", () => {
  const s = seq();
  assert.equal(cueAtTime(s, 1000), "s04");
  assert.equal(cueAtTime(s, 7000), "s05");
  const empty = seq();
  empty.lanes = [];
  assert.equal(cueAtTime(empty, 1000), "clip_3");
  assert.equal(cueAtTime(empty, 50000), undefined);
});

test("planSheetCells renders each pinned frame once and caps the sheet", () => {
  const notes = [note(1, { at_ms: 1000 }), note(2, { at_ms: 2000 }), note(3, { at_ms: 1000 })];
  const plan = planSheetCells(notes, 30);
  assert.equal(plan.cells.length, 3);
  assert.equal(plan.dropped, 0);
  assert.deepEqual(plan.cells.map((c) => c.at_ms), [1000, 2000, 1000]);
});

test("planSheetCells skips all-scope notes and caps with a drop count", () => {
  const notes = [note(1, { scope: { kind: "all" }, point: undefined }), note(2, { at_ms: 3000 })];
  const plan = planSheetCells(notes, 30);
  assert.equal(plan.cells.length, 1);
  const many = Array.from({ length: 10 }, (_, i) => note(i + 1, { at_ms: i * 1000 }));
  const capped = planSheetCells(many, 30);
  assert.equal(capped.cells.length, SHEET_MAX_CELLS);
  assert.equal(capped.dropped, 10 - SHEET_MAX_CELLS);
});

test("planSheetCells gives a boundary note two cells around the cut", () => {
  const notes = [note(1, { at_ms: 5000, scope: { kind: "boundary", from: "s04", to: "s05" } })];
  const plan = planSheetCells(notes, 30);
  assert.equal(plan.cells.length, 2);
  assert.ok(plan.cells[0].at_ms < 5000);
  assert.equal(plan.cells[1].at_ms, 5000);
});

test("inbox lines name scene, time and scope", () => {
  const lines = formatLiveNoteLines([
    packet([
      note(1, { cue: "s04", at_ms: 72400 }),
      note(2, { cue: "s04", at_ms: 58200, scope: { kind: "boundary", from: "s03", to: "s04" } }),
      note(3, { cue: "s04", at_ms: 1000, scope: { kind: "range", from: "s04", to: "s13" } }),
      note(4, { cue: "s04", at_ms: 1000, scope: { kind: "all" }, point: undefined }),
    ]),
  ]);
  assert.ok(lines.some((l) => l.includes("note 1 @ s04 1:12.400")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("note 2 boundary s03→s04 @ 0:58.200")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("note 3 range s04–s13")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("note 4 all scenes")), lines.join("\n"));
});

test("inbox lines keep the old shape for old packets", () => {
  const lines = formatLiveNoteLines([packet([{ n: 1, text: "trim here", at_ms: 300, frame: 9, point: { x: 1, y: 1, nx: 0, ny: 0 }, elements: [] }])]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '#1 00:00.30 "trim here"');
});

test("window cue lookup matches the server scene", () => {
  const s = seq() as unknown as Parameters<typeof cueAtTimeSeq>[0];
  assert.equal(cueAtTimeSeq(s, 1000), "s04");
  assert.equal(cueAtTimeSeq(s, 7000), "s05");
  assert.deepEqual(cueOptions(s), ["s04", "s05"]);
});

test("window lists the cuts between consecutive cues", () => {
  const s = seq() as unknown as Parameters<typeof cueBoundaries>[0];
  const bounds = cueBoundaries(s, 30);
  assert.equal(bounds.length, 1);
  assert.equal(bounds[0].from, "s04");
  assert.equal(bounds[0].to, "s05");
  assert.ok(Math.abs(bounds[0].at_ms - 5000) <= 40);
});

test("packet numbering is stable across frames", () => {
  const drafts = new Map([
    [60, [{ uid: 2, n: 0, at_ms: 2000 }]],
    [30, [{ uid: 1, n: 0, at_ms: 1000 }, { uid: 3, n: 0, at_ms: 1000 }]],
  ]);
  renumberAll(drafts as never);
  assert.deepEqual(orderedDrafts(drafts as never).map((d: { n: number }) => d.n), [1, 2, 3]);
  assert.deepEqual(orderedDrafts(drafts as never).map((d: { uid: number }) => d.uid), [1, 3, 2]);
});

test("inbox lines report dropped sheet cells", () => {
  const lines = formatLiveNoteLines([{ ...packet([note(1)]), sheet_note: "2 of 8 sheet cells dropped (cap 6)" }]);
  assert.ok(lines.includes("2 of 8 sheet cells dropped (cap 6)"));
});
