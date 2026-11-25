/**
 * int2fix2: join-edge rule shared by `verify` and `speech verify-cleanup`,
 * and the G402 suggestion that no longer tells agents to split captions.
 *
 * 1. A summary above the WARN threshold (11/24 loud, 46%) takes the G741
 *    WARN on the `verify` path; a summary below it takes the G740 INFO.
 *    G740 wording states the measured share and the threshold and never
 *    calls the joins quiet. The `cuthol explain G740/G741` records match.
 * 2. G402 suggests shorter text or more on-screen time (never splitting,
 *    which halves characters and duration alike so cps is unchanged), keeps
 *    the measured worst cue and the ceiling, and names the record.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CutholDiagnostic, DIAGNOSTICS } from "../core/diagnostics.js";
import { ALL_DIAGNOSTIC_DOCS } from "../explain/explain.js";
import { pushJoinEdgeSummaryDiagnostic } from "../verify/gates.js";
import { pickJoinEdgeDiagnostic } from "../speech/verify_cleanup.js";

const ABOVE_LINE =
  "join edges: 11/24 loud (46%) across 12 joins; worst: ex_vid_01_1000_1500@left 1000ms";
const BELOW_LINE =
  "join edges: 2/24 loud (8%) across 12 joins; worst: ex_vid_01_1000_1500@left 1000ms";

function pushOnVerifyPath(summaryLine: string, loudShare: number, totalJoins: number): CutholDiagnostic {
  const diagnostics: CutholDiagnostic[] = [];
  pushJoinEdgeSummaryDiagnostic({ summary_line: summaryLine, loud_share: loudShare, total_joins: totalJoins }, diagnostics);
  assert.equal(diagnostics.length, 1);
  return diagnostics[0];
}

function docFor(code: string) {
  const doc = ALL_DIAGNOSTIC_DOCS.find((d) => d.code === code);
  assert.ok(doc, `Explain record for ${code} must exist`);
  return doc;
}

test("1a. verify path: loud share above threshold (11/24, 46%) is G741 WARN", () => {
  const diag = pushOnVerifyPath(ABOVE_LINE, 11 / 24, 12);
  assert.equal(diag.code, "CUTHOL-G741");
  assert.equal(diag.severity, "WARN");
  assert.match(diag.formatted, /11\/24 loud \(46%\)/);
  assert.match(diag.formatted, /40%/);
  // Same shared rule on the cleanup path: the two paths can never disagree.
  const twin = pickJoinEdgeDiagnostic(ABOVE_LINE, 11 / 24, 12);
  assert.equal(twin.code, diag.code);
  assert.equal(twin.severity, diag.severity);
});

test("1b. verify path: loud share at exactly the threshold is G741 (>= rule)", () => {
  const diag = pushOnVerifyPath("join edges: 4/10 loud (40%) across 5 joins; worst: none loud", 0.4, 5);
  assert.equal(diag.code, "CUTHOL-G741");
  assert.equal(diag.severity, "WARN");
});

test("1c. verify path: loud share below threshold (2/24, 8%) is G740 INFO, not quiet", () => {
  const diag = pushOnVerifyPath(BELOW_LINE, 2 / 24, 12);
  assert.equal(diag.code, "CUTHOL-G740");
  assert.equal(diag.severity, "INFO");
  assert.match(diag.formatted, /2\/24 loud \(8%\)/);
  assert.match(diag.formatted, /40%/);
  assert.doesNotMatch(diag.formatted, /quiet/i);
  const twin = pickJoinEdgeDiagnostic(BELOW_LINE, 2 / 24, 12);
  assert.equal(twin.code, diag.code);
});

test("1d. explain records match the G740/G741 diagnostics", () => {
  const g740 = DIAGNOSTICS.JOIN_EDGE_SUMMARY(BELOW_LINE);
  const doc740 = docFor("G740");
  assert.equal(doc740.messageShape, g740.what.replace(BELOW_LINE, "${summaryLine}"));
  assert.equal(doc740.severity, "INFO");
  const g741 = DIAGNOSTICS.JOIN_EDGE_LOUD_SHARE_HIGH(ABOVE_LINE);
  const doc741 = docFor("G741");
  assert.equal(doc741.messageShape, g741.what.replace(ABOVE_LINE, "${summary_line}"));
  assert.equal(doc741.severity, "WARN");
});

test("2. G402 suggests shorter text or more on-screen time, never splitting", () => {
  const single = DIAGNOSTICS.CAPTION_READING_SPEED_HIGH("cue_07", 45, 17);
  assert.match(single.what, /cue_07/);
  assert.match(single.what, /45\.0 cps/);
  assert.match(single.what, /17 cps ceiling/);
  assert.doesNotMatch(single.suggestion, /[Ss]plit/);
  assert.match(single.suggestion, /cuthol lane update-cue --cue cue_07 --duration <ms>/);
  assert.match(single.suggestion, /cuthol explain G402/);

  const many = DIAGNOSTICS.CAPTION_READING_SPEED_HIGH_MANY("ln_captions", [
    { cueId: "cue_07", cps: 45, maxCps: 17 },
    { cueId: "cue_08", cps: 30, maxCps: 17 },
  ]);
  assert.match(many.what, /cue_07/);
  assert.match(many.what, /45\.0 cps/);
  assert.match(many.what, /17 cps ceiling/);
  assert.doesNotMatch(many.suggestion, /[Ss]plit/);
  assert.match(many.suggestion, /cuthol lane update-cue --cue <cue_XX> --duration <ms>/);
  assert.match(many.suggestion, /cuthol speech captions --replace --max-words <n>/);
  assert.match(many.suggestion, /cuthol explain G402/);

  const doc402 = docFor("G402");
  assert.ok(doc402.fix.some((f) => f.includes("cuthol speech captions --replace --max-words")));
});
