/**
 * Encode progress printer: the worker writes `cuthol:progress <name> done/total`
 * only when the frame count changes. A stalled encode must not repeat the same
 * line every tick.
 *
 * The worker samples real `-progress` files, so the child drives it through the
 * public progress API with a planted progress file: same frame for 3 ticks,
 * then one new frame. New build: exactly 2 lines. Old build: a line per tick.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CLI_CHILD = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { progressBegin, progressStop } from DIST_PLACEHOLDER;
const progFile = path.join(os.tmpdir(), "cuthol_ffprog_" + process.pid + "_changeprint.txt");
progressBegin("encode", 930, { mode: "ffmpeg-frames" });
fs.writeFileSync(progFile, "frame=551\\nout_time_us=17000000\\nprogress=continue\\n", "utf8");
setTimeout(() => {
  fs.writeFileSync(progFile, "frame=552\\nout_time_us=17040000\\nprogress=continue\\n", "utf8");
}, 4500);
setTimeout(() => { try { progressStop(); } catch {} try { fs.unlinkSync(progFile); } catch {} setTimeout(() => process.exit(0), 300); }, 7000);
`;

test("progress printer writes a line only when the frame count changes", { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-progress-print-"));
  try {
    const distUrl = new URL("../core/progress.js", import.meta.url).href;
    const childPath = path.join(dir, "child.mjs");
    fs.writeFileSync(childPath, CLI_CHILD.replace("DIST_PLACEHOLDER", JSON.stringify(distUrl)), "utf8");
    const proc = spawnSync(process.execPath, [childPath], { encoding: "utf8", timeout: 30_000 });
    assert.equal(proc.status, 0, `child failed: ${proc.stderr ?? ""}`.slice(0, 1000));
    const lines = String(proc.stderr ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("cuthol:progress encode"));
    assert.deepEqual(
      lines.map((l) => l.replace(/ eta .*$/, "")),
      ["cuthol:progress encode 0/930", "cuthol:progress encode 551/930", "cuthol:progress encode 552/930"],
      `expected exactly 3 progress lines, got ${lines.length}: ${JSON.stringify(lines)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
