// Full test suite in three stages: files that are safe to overlap run in parallel, then the files that
// measure wall time, share hardware encoder sessions or call paid APIs run one at a time, then the
// load tests (test names starting with "load: ", CPU and playback measurements inside otherwise
// parallel-safe files) run alone, one file at a time, with nothing else on the machine.
// Usage: npm test  (CUTHOL_TEST_CONCURRENCY=N to change the parallel stage, default 4; 1 = old serial run)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERIAL = new Set([
  "stall_watchdog.test.js", // asserts wall-clock stall thresholds of a few seconds
  "color_alpha_encoders.test.js", // hardware encoder probes and session limits
  "render_speed.test.js", // asserts wall-clock worker counts and render timings
  "long_form.test.js", // cold vs cached performance.now comparison
  "speech_cleanup_mix.test.js", // live ElevenLabs + Deepgram
  "ducking_bbox_real_speech.test.js", // reads cached real-speech fixtures, no network
  "tempo_render.test.js", // hardware encoder renders with frame-exact checks
  // Moved to parallel (no wall-clock assert; media-time "ms" only; per-process
  // temp dirs or distinct repo subdirs; env vars saved/restored per file):
  // "composition_audio.test.js", "script_errors.test.js",
  // "composition_coords.test.js", "composition_coords_ink.test.js",
  // "coords_ink_transform.test.js", "coords_query.test.js", "coords_quads.test.js",
  // "runtime_bridge_determinism.test.js", "speech_pauses_fillers.test.js",
  // "shared_cache_layout.test.js", "render_scan_timeouts.test.js",
]);

const testDir = path.join("dist", "test");
let all = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

// --fast: the quick tier from scripts/test-tiers.json (files that took < ~15 s in the
// last measured full run, no paid APIs) plus any test file the tiers do not know yet
// (new files are usually the ones being worked on). Full suite before merge/release.
const fast = process.argv.includes("--fast");
if (fast) {
  const tiersFile = path.join("scripts", "test-tiers.json");
  if (!fs.existsSync(tiersFile)) {
    console.error(`${tiersFile} is missing: run the full suite (npm test) and then npm run test:tiers.`);
    process.exit(2);
  }
  const tiers = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  const quick = new Set(tiers.fast);
  const known = new Set(tiers.known);
  const fresh = all.filter((f) => !known.has(f));
  all = all.filter((f) => quick.has(f) || !known.has(f));
  console.log(`fast tier: ${all.length} files${fresh.length ? ` (new, not yet measured: ${fresh.join(", ")})` : ""}`);
}
const parallel = all.filter((f) => !SERIAL.has(f)).map((f) => path.join(testDir, f));
const serial = all.filter((f) => SERIAL.has(f)).map((f) => path.join(testDir, f));
const concurrency = Math.max(1, Number(process.env.CUTHOL_TEST_CONCURRENCY) || 4);

// Per-file timings of every run land here (git-ignored), one JSON per stage.
const timingDir = path.join("test-workspace", "testperf");
fs.mkdirSync(timingDir, { recursive: true });

// Files holding load tests are found by content, so a new "load: " test needs no list entry.
const LOAD_PREFIX = "load: ";
const LOAD_TEST_RE = /\btest\(\s*["'`]load: /;
const loadFiles = all
  .filter((f) => LOAD_TEST_RE.test(fs.readFileSync(path.join(testDir, f), "utf8")))
  .map((f) => path.join(testDir, f));

const run = (label, files, n, patternArgs = []) => {
  if (files.length === 0) return 0;
  console.log(`\n=== ${label}: ${files.length} files, concurrency ${n} ===`);
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [
      "--import", "./dist/test/test_setup.js",
      "--test", `--test-concurrency=${n}`, ...patternArgs,
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=./scripts/timing-reporter.mjs", `--test-reporter-destination=${path.join(timingDir, `last_${fast ? "fast_" : ""}${label}.json`)}`,
      ...files,
    ],
    { stdio: "inherit" }
  );
  console.log(`=== ${label}: exit ${res.status}, ${Math.round((Date.now() - started) / 1000)}s ===`);
  return res.status ?? 1;
};

const skipLoad = [`--test-skip-pattern=^${LOAD_PREFIX}`];
const a = run("parallel", parallel, concurrency, skipLoad);
const b = run("serial", serial, 1, skipLoad);
const c = run("load", loadFiles, 1, [`--test-name-pattern=^${LOAD_PREFIX}`]);
process.exit(a || b || c ? 1 : 0);
