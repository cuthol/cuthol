/**
 * `setup --local-speech` actually runs Piper when the install record exists
 * (`src/test/local_speech_setup_check.test.ts`).
 *
 * The check used to be a no-op when `local-speech.json` and the venv Python
 * existed; now it executes `python -m piper --help` (short timeout) and
 * reports a broken install instead of claiming success. Fails on the old
 * build: `verifyLocalSpeechPiper` does not exist there.
 */

import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CutholError } from "../core/diagnostics.js";
import { verifyLocalSpeechPiper } from "../core/local_speech_setup.js";

test("1. A bogus venv fails the Piper check instead of passing silently", () => {
  assert.throws(
    () =>
      verifyLocalSpeechPiper({
        model: "small",
        voice: "tr_TR-dfki-medium",
        root: "C:/nonexistent-local-speech-root",
        venvDir: "C:/nonexistent-local-speech-root/venv",
        modelRepo: "x",
        modelDir: "C:/nonexistent-local-speech-root/models/small",
        voiceFile: "C:/nonexistent-local-speech-root/voices/v.onnx",
        downloadBytes: 0,
        alreadyInstalled: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CutholError);
      assert.equal(err.diagnostic.code, "CUTHOL-G238");
      assert.match(err.diagnostic.what, /piper-check/);
      assert.match(err.diagnostic.what, /broken/i);
      return true;
    }
  );
});
