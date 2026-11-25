/**
 * Local ASR thousands-merge and Piper launcher order
 * (`src/test/local_speech_numbers.test.ts`).
 *
 * faster-whisper word timestamps can emit `"30"`, `",000"` (and `"24"`,
 * `",000"`) as separate words. `merge_split_numbers` merges a token that
 * starts with `,`/`.` + digits into the previous digit-ending token when
 * the gap is small (`30` + `,000` -> `30,000`, times = first start/last
 * end). The Piper launcher must prefer `[sys.executable, "-m", "piper"]`
 * when the module is importable, keeping explicit/`PIPER_EXE` first.
 * Pure-function probes through the system Python (no model, no install).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const BRIDGE = path.resolve(process.cwd(), "scripts", "local_speech.py");

function pythonCheck(): string | false {
  const ver = spawnSync("python", ["--version"], { encoding: "utf8" });
  if (ver.status !== 0 || ver.error) return "system python is absent";
  return false;
}

const NEED_PYTHON = pythonCheck();

function runProbe(script: string): unknown {
  const proc = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  return JSON.parse(proc.stdout);
}

const PRELUDE = [
  "import importlib.util, json, sys",
  `spec = importlib.util.spec_from_file_location("local_speech", ${JSON.stringify(BRIDGE)})`,
  "mod = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
].join("\n");

const W = (word: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  word,
  punctuated_word: word,
  source_start_ms: start,
  source_end_ms: end,
  confidence: 0.9,
  ...extra,
});

test("30 + ,000 merges with first start and last end", { skip: NEED_PYTHON }, () => {
  const res = runProbe(
    `${PRELUDE}\nwords = [${JSON.stringify(W("30", 1000, 1230))}, ${JSON.stringify(W(",000", 1240, 1500))}]\n` +
      "sys.stdout.write(json.dumps(mod.merge_split_numbers(words)))"
  ) as Array<{ word: string; source_start_ms: number; source_end_ms: number }>;
  assert.equal(res.length, 1);
  assert.equal(res[0].word, "30,000");
  assert.equal(res[0].source_start_ms, 1000);
  assert.equal(res[0].source_end_ms, 1500);
});

test("24 + ,000 merges; dot decimals merge; large gaps and non-digits do not", { skip: NEED_PYTHON }, () => {
  const res = runProbe(
    `${PRELUDE}\nwords = [` +
      [
        JSON.stringify(W("24", 0, 200)),
        JSON.stringify(W(",000", 210, 400)),
        JSON.stringify(W("about", 500, 700)),
        JSON.stringify(W("3", 800, 900)),
        JSON.stringify(W(".5", 910, 1000)),
        JSON.stringify(W("far", 1100, 1200)),
        JSON.stringify(W(",000", 2000, 2100)),
        JSON.stringify(W(",", 2200, 2250)),
      ].join(",") +
      "]\nsys.stdout.write(json.dumps(mod.merge_split_numbers(words)))"
  ) as Array<{ word: string }>;
  assert.deepEqual(
    res.map((w) => w.word),
    ["24,000", "about", "3.5", "far", ",000", ","]
  );
});

test("piper launcher keeps overrides first and prefers python -m piper", { skip: NEED_PYTHON }, () => {
  const res = runProbe(
    `${PRELUDE}\nimport os\n` +
      "os.environ['PIPER_EXE'] = 'C:/custom/piper.exe'\n" +
      "explicit = mod.resolve_piper_cmd('/x/piper.exe')\n" +
      "env_hit = mod.resolve_piper_cmd(None)\n" +
      "del os.environ['PIPER_EXE']\n" +
      "has_module = mod.piper_module_available()\n" +
      "sys.stdout.write(json.dumps({'explicit': explicit, 'env_hit': env_hit, 'has_module': has_module}))"
  ) as { explicit: string[]; env_hit: string[]; has_module: boolean };
  assert.deepEqual(res.explicit, ["/x/piper.exe"]);
  assert.deepEqual(res.env_hit, ["C:/custom/piper.exe"]);
  assert.equal(typeof res.has_module, "boolean");
});

test("python -m piper wins when the module is importable", { skip: NEED_PYTHON }, () => {
  const proc = spawnSync(
    "python",
    [
      "-c",
      [
        "import importlib.util, json, os, sys, tempfile",
        `spec = importlib.util.spec_from_file_location("local_speech", ${JSON.stringify(BRIDGE)})`,
        "mod = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mod)",
        "d = tempfile.mkdtemp(prefix='fake-piper-')",
        "open(os.path.join(d, 'piper.py'), 'w').write('X = 1\\n')",
        "sys.path.insert(0, d)",
        "import piper",
        "sys.stdout.write(json.dumps(mod.resolve_piper_cmd(None)))",
      ].join("\n"),
    ],
    { encoding: "utf8" }
  );
  assert.equal(proc.status, 0, proc.stderr);
  const cmd = JSON.parse(proc.stdout) as string[];
  assert.equal(cmd.length, 3);
  assert.equal(cmd[1], "-m");
  assert.equal(cmd[2], "piper");
  assert.ok(cmd[0].toLowerCase().includes("python"));
});
