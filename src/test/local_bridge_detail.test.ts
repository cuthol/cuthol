/**
 * Bridge-failure messages keep the cause and fit the suggestion
 * (`src/test/local_bridge_detail.test.ts`).
 *
 * CUTHOL-G239 used to keep only the last 300 characters of stderr, so the
 * real cause (an early line) was cut and the suggestion always pointed at
 * `setup --apply`, even when the install was fine. Fails on the old build:
 * the old message is exactly the 300-character tail.
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { selectBridgeFailureDetail } from "../speech/local_engine.js";

const FAKE_STDERR = [
  "ffmpeg version 8.1 Copyright (c) 2000-2025",
  "ERROR: error: invalid data found when processing input",
  "Traceback (most recent call last):",
  '  File "local_speech.py", line 812, in <module>',
  "    raise RuntimeError('decode failed')",
  "RuntimeError: decode failed",
  "[ffmpeg argv dump]",
  ...Array.from({ length: 40 }, (_, i) => `  --opt-${i} ${"x".repeat(60)}`),
  "last tail line",
].join("\n");

test("1. The message shows the early cause line, not just the tail", () => {
  const { detail, suggestion } = selectBridgeFailureDetail(FAKE_STDERR);
  assert.ok(
    detail.includes("ERROR: error: invalid data found when processing input"),
    `cause line must survive: ${detail.slice(0, 200)}`
  );
  assert.ok(detail.length < FAKE_STDERR.length, "the argv dump must not be pasted whole");
  // The old code produced exactly the last 300 chars; the new one must not.
  assert.notEqual(detail, FAKE_STDERR.slice(-300));
  assert.ok(
    /readable media|input audio/i.test(suggestion),
    `an input-file failure must not suggest reinstalling: ${suggestion}`
  );
  assert.ok(!/setup --local-speech --apply/.test(suggestion) || /install itself looks fine/.test(suggestion));
  const diag = DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("local ASR", detail, suggestion);
  assert.equal(diag.code, "CUTHOL-G239");
  assert.ok(diag.what.includes("invalid data found"));
});

test("2. A voice/piper failure suggests checking the voice and venv", () => {
  const { detail, suggestion } = selectBridgeFailureDetail(
    "Traceback...\nerror: Piper voice missing at 'C:/voices/tr.onnx'\n" + "y".repeat(50)
  );
  assert.ok(detail.includes("Piper voice missing"));
  assert.ok(/voice/i.test(suggestion));
});

test("3. Default suggestion still repairs the install", () => {
  const { suggestion } = selectBridgeFailureDetail("something odd happened");
  assert.ok(suggestion.includes("setup --local-speech --apply"));
  const diag = DIAGNOSTICS.LOCAL_SPEECH_BRIDGE_FAILED("local ASR", "something odd happened");
  assert.ok(diag.suggestion.includes("setup --local-speech --apply"));
});
