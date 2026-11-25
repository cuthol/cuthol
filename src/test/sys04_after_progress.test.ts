/**
 * SYS04 after-progress wording: when an ffmpeg step produced frames and then
 * died (killed or crashed), the diagnostic must name the last frame and point
 * at re-running instead of suggesting a corrupt input or a missing binary.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createSubprocessFailureDiagnostic } from "../core/diagnostics.js";

function baseProc(over: Record<string, unknown> = {}) {
  return {
    status: null,
    signal: "SIGKILL",
    error: undefined,
    stderr: "",
    stdout: "",
    stalled: false,
    lastProgress: "frame=551, out_time=18.40s, size=2500000B",
    commandSummary: "ffmpeg -filter_complex ... out.mp4",
    ...over,
  };
}

test("ffmpeg killed after frame 551 reports SYS04 with the frame, not PATH/corrupt input", () => {
  const diag = createSubprocessFailureDiagnostic({
    tool: "ffmpeg render",
    executable: "ffmpeg",
    args: ["-i", "in.mp4", "out.mp4"],
    proc: baseProc() as never,
  });
  assert.equal(diag.code, "CUTHOL-SYS04");
  assert.match(diag.what, /ended after frame 551/);
  assert.match(diag.what, /signal=SIGKILL/);
  assert.match(diag.suggestion ?? "", /Re-run/);
  assert.doesNotMatch(diag.what, /not corrupt/);
  assert.doesNotMatch(diag.suggestion ?? "", /system PATH/);
});

test("crashed ffmpeg (exit code) after progress names the frame too", () => {
  const diag = createSubprocessFailureDiagnostic({
    tool: "ffmpeg render",
    executable: "ffmpeg",
    args: [],
    proc: baseProc({ signal: null, status: 1 }) as never,
  });
  assert.equal(diag.code, "CUTHOL-SYS04");
  assert.match(diag.what, /ended after frame 551/);
  assert.match(diag.what, /exit_code=1/);
});

test("no progress (frame 0) keeps the old corrupt-input/PATH wording", () => {
  const diag = createSubprocessFailureDiagnostic({
    tool: "ffmpeg render",
    executable: "ffmpeg",
    args: [],
    proc: baseProc({ lastProgress: "no progress/output produced", signal: null, status: 1 }) as never,
  });
  assert.equal(diag.code, "CUTHOL-SYS04");
  assert.match(diag.suggestion ?? "", /system PATH/);
});

test("stalled runs still report SUBPROCESS_STALLED, even with frames", () => {
  const diag = createSubprocessFailureDiagnostic({
    tool: "ffmpeg render",
    executable: "ffmpeg",
    args: [],
    proc: baseProc({ stalled: true, stalledMs: 90000, stallThresholdMs: 90000 }) as never,
  });
  assert.equal(diag.code, "CUTHOL-SYS10");
});
