/**
 * Keyless local ASR defaults: 4 parallel jobs x 3 CPU threads each, unless
 * the environment overrides them.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { localAsrCpuThreads, localAsrJobs } from "../speech/local_engine.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("keyless local ASR defaults to 4 jobs x 3 threads", () => {
  withEnv({ CUTHOL_LOCAL_ASR_JOBS: undefined, CUTHOL_LOCAL_ASR_THREADS: undefined }, () => {
    assert.equal(localAsrJobs(), 4);
    assert.equal(localAsrCpuThreads(), 3);
  });
});

test("environment overrides still win over the defaults", () => {
  withEnv({ CUTHOL_LOCAL_ASR_JOBS: "2", CUTHOL_LOCAL_ASR_THREADS: "6" }, () => {
    assert.equal(localAsrJobs(), 2);
    assert.equal(localAsrCpuThreads(), 6);
  });
  withEnv({ CUTHOL_LOCAL_ASR_JOBS: "bogus", CUTHOL_LOCAL_ASR_THREADS: "bogus" }, () => {
    assert.equal(localAsrJobs(), 4);
    assert.equal(localAsrCpuThreads(), 3);
  });
});
