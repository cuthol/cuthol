// Sync browser-compile child for `extension enable` (`node dist/effects/shader_compile_child.js`).
//
// `enableExtensionInWorkspace` is synchronous, so the browser compile runs in
// one child node process. Args: `<workspaceDir> <extName> <extDir> <dryRun>`.
// One short-lived browser compiles every `.glsl` of the extension and stores
// each result by content hash (skipped with `dryRun=1`, which only reports).
// Always exits 0: the parent reads the single JSON line on stdout.
// `{ status: "ok" }` (or `"none"` when the extension declares no shader fx),
// `{ status: "failed", file, line, detail }` on the first compile failure, or
// `{ status: "unavailable", detail }` when no browser could start (launch
// error, hang, timeout): the parent turns that into a WARN, never a failure.
//
// NOTE: this must stay a real file, never `--eval`: the stall-watchdog worker
// thread never signals back under an `--eval` entry, so a `spawnWatchedSync`
// in an eval child hangs until the watchdog kills it.
import fs from "node:fs";
import path from "node:path";
import { ensureShaderCompileCache, listShaderFxFiles } from "./shader_def.js";

interface ChildResult {
  status: "ok" | "none" | "failed" | "unavailable";
  file?: string;
  line?: number;
  detail?: string;
  files?: string[];
}

async function main(): Promise<ChildResult> {
  const workspaceDir = process.argv[2] ?? "";
  const extName = process.argv[3] ?? "";
  const extDir = process.argv[4] ?? "";
  const dryRun = (process.argv[5] ?? "0") === "1";
  if (!workspaceDir || !extDir) return { status: "unavailable", detail: "missing arguments" };
  const files = listShaderFxFiles(extDir);
  if (files.length === 0) return { status: "none" };
  const shaders = files.map((file) => ({ file, source: fs.readFileSync(path.resolve(extDir, file), "utf8"), ext: extName }));
  let results;
  try {
    results = await ensureShaderCompileCache({ rootDir: workspaceDir, shaders, dryRun });
  } catch (err) {
    return { status: "unavailable", detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
  const bad = results.find((r) => !r.ok);
  if (bad) {
    return { status: "failed", file: bad.file, line: bad.line ?? 0, detail: (bad.detail ?? "unknown error").slice(0, 300) };
  }
  return { status: "ok", files: results.map((r) => r.file) };
}

try {
  const res = await main();
  process.stdout.write(`${JSON.stringify(res)}\n`);
} catch (err) {
  const detail = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  process.stdout.write(`${JSON.stringify({ status: "unavailable", detail } satisfies ChildResult)}\n`);
}
process.exit(0);
