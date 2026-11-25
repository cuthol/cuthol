/**
 * [w1b repeats] loops that collect the same code for many items in one pass emit one
 * diagnostic with the count, the id range, the shared value and every id in
 * `subject_ids`. Fails on the old build: `pushRepeatDiagnostic` and the `*_MANY`
 * factories do not exist there (import fails).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DIAGNOSTICS,
  pushRepeatDiagnostic,
  repeatIdRange,
  type CutholDiagnostic,
} from "../core/diagnostics.js";

describe("w1b repeat aggregation", () => {
  it("repeatIdRange renders a single id and a first…last range", () => {
    assert.equal(repeatIdRange(["cue_03"]), "cue_03");
    assert.equal(repeatIdRange(["cue_386", "cue_004", "cue_100"]), "cue_004 … cue_386");
  });

  it("one G267 stays single, two cues with the same filter merge", () => {
    const list: CutholDiagnostic[] = [];
    const push = (cue: string, filter: string) =>
      pushRepeatDiagnostic(
        list,
        `CUTHOL-G267:${filter}`,
        { subjectId: cue },
        (e) => DIAGNOSTICS.COMPOSITION_TEMPORAL_FX_SINGLEFRAME(e.subjectId, filter),
        (es) => DIAGNOSTICS.COMPOSITION_TEMPORAL_FX_SINGLEFRAME_MANY(filter, es.map((e) => e.subjectId))
      );
    push("cue_01", "tmix=frames=4");
    assert.equal(list.length, 1);
    assert.ok(list[0].formatted.includes("'cue_01'"));
    push("cue_02", "tmix=frames=4");
    assert.equal(list.length, 1);
    assert.equal(list[0].code, "CUTHOL-G267");
    assert.deepEqual(list[0].subject_ids, ["cue_01", "cue_02"]);
    assert.ok(list[0].what.includes("2 composition cues"), list[0].what);
    assert.ok(list[0].what.includes("cue_01 … cue_02"), list[0].what);
  });

  it("G417 merges per shared reason and stays split per cause", () => {
    const list: CutholDiagnostic[] = [];
    const push = (cue: string, reason: string) =>
      pushRepeatDiagnostic(
        list,
        `CUTHOL-G417:${reason}`,
        { subjectId: cue },
        (e) => DIAGNOSTICS.COORDS_MEASUREMENT_FAILED(e.subjectId, reason),
        (es) => DIAGNOSTICS.COORDS_MEASUREMENT_FAILED_MANY(reason, es.map((e) => e.subjectId))
      );
    push("cue_01", "browser launch failed: no browser");
    push("cue_02", "browser launch failed: no browser");
    push("cue_03", "composition entry 'c/index.html' not found");
    assert.equal(list.length, 2);
    const merged = list.find((d) => d.subject_ids?.length === 2)!;
    assert.ok(merged);
    assert.equal(merged.code, "CUTHOL-G417");
    assert.deepEqual(merged.subject_ids, ["cue_01", "cue_02"]);
  });

  it("G418/G419 merge the same detail across cues", () => {
    const list: CutholDiagnostic[] = [];
    pushRepeatDiagnostic(
      list,
      "CUTHOL-G418:no fonts",
      { subjectId: "cue_01" },
      (e) => DIAGNOSTICS.COORDS_FONTS_NOT_BUNDLED(e.subjectId, "no fonts"),
      (es) => DIAGNOSTICS.COORDS_FONTS_NOT_BUNDLED_MANY("no fonts", es.map((e) => e.subjectId))
    );
    pushRepeatDiagnostic(
      list,
      "CUTHOL-G418:no fonts",
      { subjectId: "cue_02" },
      (e) => DIAGNOSTICS.COORDS_FONTS_NOT_BUNDLED(e.subjectId, "no fonts"),
      (es) => DIAGNOSTICS.COORDS_FONTS_NOT_BUNDLED_MANY("no fonts", es.map((e) => e.subjectId))
    );
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].subject_ids, ["cue_01", "cue_02"]);
    pushRepeatDiagnostic(
      list,
      "CUTHOL-G419:static",
      { subjectId: "cue_01" },
      (e) => DIAGNOSTICS.COORDS_PAGE_ISSUES(e.subjectId, "static"),
      (es) => DIAGNOSTICS.COORDS_PAGE_ISSUES_MANY("static", es.map((e) => e.subjectId))
    );
    pushRepeatDiagnostic(
      list,
      "CUTHOL-G419:static",
      { subjectId: "cue_02" },
      (e) => DIAGNOSTICS.COORDS_PAGE_ISSUES(e.subjectId, "static"),
      (es) => DIAGNOSTICS.COORDS_PAGE_ISSUES_MANY("static", es.map((e) => e.subjectId))
    );
    assert.equal(list.length, 2);
    assert.equal(list[1].code, "CUTHOL-G419");
    assert.deepEqual(list[1].subject_ids, ["cue_01", "cue_02"]);
  });

  it("G440 merges per-item p99 values with the worst named", () => {
    const list: CutholDiagnostic[] = [];
    const push = (id: string, p99: number) =>
      pushRepeatDiagnostic(
        list,
        "CUTHOL-G440:1",
        { subjectId: id, detail: String(p99) },
        (e) => DIAGNOSTICS.COLOR_LUT_SELFTEST_ABOVE_LIMIT(e.subjectId, Number(e.detail)),
        (es) =>
          DIAGNOSTICS.COLOR_LUT_SELFTEST_ABOVE_LIMIT_MANY(
            1.0,
            es.map((e) => ({ id: e.subjectId, p99: Number(e.detail) }))
          )
      );
    push("sp_01", 1.42);
    push("sp_02", 2.1);
    assert.equal(list.length, 1);
    assert.equal(list[0].code, "CUTHOL-G440");
    assert.deepEqual(list[0].subject_ids, ["sp_01", "sp_02"]);
    assert.ok(list[0].what.includes("worst 'sp_02'"), list[0].what);
  });

  it("G415 merges elements of one composition", () => {
    const list: CutholDiagnostic[] = [];
    const push = (element: string, error: string) =>
      pushRepeatDiagnostic(
        list,
        "CUTHOL-G415:comp_a",
        { subjectId: element, detail: error },
        (e) => DIAGNOSTICS.SCRIPT_ERROR_ISOLATED("comp_a", e.subjectId, null, e.detail ?? ""),
        (es) => DIAGNOSTICS.SCRIPT_ERROR_ISOLATED_MANY("comp_a", es.map((e) => e.subjectId), es[0]?.detail ?? "")
      );
    push("el1", "boom");
    assert.ok(list[0].formatted.includes("'el1'"));
    push("el2", "bam");
    assert.equal(list.length, 1);
    assert.equal(list[0].code, "CUTHOL-G415");
    assert.ok(list[0].what.includes("2 elements"), list[0].what);
    assert.deepEqual(list[0].subject_ids, ["comp_a/el1", "comp_a/el2"]);
  });

  it("G512 MANY names the count, range, worst item and every dE", () => {
    const d = DIAGNOSTICS.COLOR_RENDER_GRADE_MISMATCH_MANY([
      { id: "sp_02", atMs: 600, meanDe: 18.81 },
      { id: "sp_04", atMs: 1200, meanDe: 5.2 },
    ]);
    assert.equal(d.code, "CUTHOL-G512");
    assert.deepEqual(d.subject_ids, ["sp_02", "sp_04"]);
    assert.ok(d.what.includes("2 graded items"), d.what);
    assert.ok(d.what.includes("sp_02 … sp_04"), d.what);
    assert.ok(d.what.includes("worst 'sp_02'"), d.what);
  });

  it("dedupes the same subject pushed twice", () => {
    const list: CutholDiagnostic[] = [];
    for (let k = 0; k < 3; k++) {
      pushRepeatDiagnostic(
        list,
        "CUTHOL-G267:tmix",
        { subjectId: "cue_01" },
        (e) => DIAGNOSTICS.COMPOSITION_TEMPORAL_FX_SINGLEFRAME(e.subjectId, "tmix"),
        (es) => DIAGNOSTICS.COMPOSITION_TEMPORAL_FX_SINGLEFRAME_MANY("tmix", es.map((e) => e.subjectId))
      );
    }
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].subject_ids, ["cue_01"]);
  });
});
