/**
 * Fast in-process replacement for `spawnSync(process.execPath, [CLI_PATH, ...])`.
 *
 * Runs the real CLI dispatcher (`runCliMain` from `src/cli_main.ts`: the same argv
 * parsing, flag checks, command handlers and error envelope as `cuthol`) without
 * starting a new Node process (~0.7 s saved per call). Stdout/stderr are captured by
 * intercepting `console.log`/`console.error`; the exit code is `process.exitCode`.
 *
 * Use only for calls that assert on the JSON payload. Calls that assert on exit codes,
 * argv parsing, output text, or failure envelopes keep a real subprocess (at least one
 * per file where the test is about the CLI).
 */
import { runCliMain } from "../cli_main.js";

export interface FastCliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** One CLI command in-process; same behaviour as the `cuthol` binary for the payload. */
export async function runCliFast(rawArgs: string[]): Promise<FastCliResult> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  console.log = (...a: unknown[]) => {
    outLines.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errLines.push(a.map(String).join(" "));
  };
  process.exitCode = 0;
  try {
    await runCliMain(rawArgs, "cli.js");
    const status = typeof process.exitCode === "number" ? process.exitCode : Number(process.exitCode ?? 0) || 0;
    return { status, stdout: outLines.join("\n"), stderr: errLines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
  }
}

export function parseFastEnvelope(
  res: FastCliResult,
  argsForMessage: string[],
): Record<string, unknown> {
  const text = `${res.stdout}\n${res.stderr}`.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON envelope for ${argsForMessage.join(" ")}`);
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}
