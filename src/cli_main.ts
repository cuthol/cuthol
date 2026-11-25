/**
 * Cuthol CLI command dispatcher (`src/cli_main.ts`); the executable entry is `src/cli.ts`.
 * `runCli` runs one command for an argv, so tests can drive the real dispatcher in-process.
 *
 * Agent-native command surface for workspace management, media library ingestion,
 * signal/scene analysis, spine & lane editing, declarative cue sheets,
 * 5-gate verification, and multi-lens sequence inspection.
 *
 * Startup-cost design: only `cli_args`, `diagnostics`, `time`, the declarative
 * `mcp/catalog`, `explain` and `cli_help` load statically. Everything else
 * (env, `cli_output` state, the MCP server helpers, every `cli_cmd_*` group)
 * loads via dynamic `import()` on the path that needs it, so `--version`,
 * `help` and `explain` never touch render/compositor/MCP code and every other
 * command pays only its own group's imports.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  assertNoExtraPositionals,
  describeUnknownFlag,
  normalizeFxTryAt,
  parseArgv,
  parseArgvWithBooleans,
  boolFlag,
  KNOWN_CLI_FLAGS,
  specBooleanFlags,
  suggestFlagFix,
  strFlag,
  numFlag,
} from "./cli_args.js";
import { findCliActionSpec } from "./mcp/catalog.js";
import { printHelp, runGuideCommand } from "./cli_help.js";
import type { CliCommandContext } from "./cli_output.js";

/**
 * Runs one CLI command. Throws on failure (`runCliMain` turns that into the error envelope).
 * `argv` = the arguments after the script path; `invokedPath` = the script path (selects `cuthol-mcp`).
 */
export async function runCli(argv: string[] = process.argv.slice(2), invokedPath: string = process.argv[1] ?? ""): Promise<void> {
  const firstPass = parseArgv(argv);
  const [preGroup, preAction, ...preRest] = firstPass.positionals;
  const cliSpec = findCliActionSpec(preGroup, preAction, preRest);
  const specBooleans = cliSpec ? specBooleanFlags(cliSpec.params) : null;
  const { positionals, flags } = specBooleans
    ? parseArgvWithBooleans(argv, (key) => specBooleans.has(key))
    : firstPass;
  const [group, action, ...rest] = positionals;
  if (group === "spine" && action === "fx" && rest[0] === "try" && typeof flags["at"] === "string") {
    try {
      flags["at"] = normalizeFxTryAt(flags["at"] as string);
    } catch {
      // Leave the raw value: the fx try handler reports the time error.
    }
  }

  // `cuthol --version` / `cuthol -v`: print `cuthol <version>` from
  // package.json and exit 0, before any group dispatch (used to fall through
  // to the usage text). Only when no command group is given, so a `--version`
  // value flag on a real command keeps its old behaviour.
  const versionOnly =
    positionals.every((p) => p === "-v") &&
    (flags["version"] === true || argv.includes("-v") || argv.includes("--version")) &&
    Object.keys(flags).every((k) => k === "version");
  if (versionOnly) {
    console.log(`cuthol ${readPackageVersion()}`);
    return;
  }

  const fmtLight = typeof flags["format"] === "string" ? flags["format"].trim().toLowerCase() : "";
  const isLibraryQueryLight = group === "library" && action === "query";
  const wantsCompact = computeCompactMode(group, action, flags);

  // Light path: help / explain / guide succeed without the cli_output state,
  // env loading, or any command-group module. Errors below print the same
  // JSON envelope bytes as the heavy path (compact errors delegate to it).
  if (!group || group === "help" || flags["help"]) {
    try {
      validateFlags(group, action, flags, cliSpec, fmtLight, isLibraryQueryLight);
      if (flags["json"]) {
        const { CUTHOL_MCP_TOOLS } = await import("./mcp/server.js");
        const targetGroup = group === "help" ? action : group;
        const tools = targetGroup
          ? CUTHOL_MCP_TOOLS.filter((t) => t.name === targetGroup)
          : CUTHOL_MCP_TOOLS;
        console.log(
          JSON.stringify(
            {
              ok: true,
              command: "help",
              schema_version: "cuthol.envelope/1",
              tools,
              flag_lexicon: {
                workspace_dir: ["--dir", "--project"],
                composition_dir: ["--comp-dir", "--composition-dir"],
                revision_guard: ["--expect-rev"],
                targeted_undo: ["--to"],
              },
            },
            null,
            2
          )
        );
        return;
      }
      if (group === "help") {
        printHelp(action);
      } else {
        printHelp(group, action, rest);
      }
      return;
    } catch (err: unknown) {
      await reportLightError(err, group, action, rest, flags, wantsCompact);
      return;
    }
  }

  if (group === "explain") {
    try {
      validateFlags(group, action, flags, cliSpec, fmtLight, isLibraryQueryLight);
      const { runExplain } = await import("./explain/explain.js");
      const bits = [...(action ? [action] : []), ...rest];
      const joined = bits.join(" ").trim();
      const query =
        joined || (typeof flags["query"] === "string" ? (flags["query"] as string) : undefined);
      if (!query) throw new CutholError(DIAGNOSTICS.EXPLAIN_MISSING_QUERY());
      console.log(runExplain(query).text);
      return;
    } catch (err: unknown) {
      await reportLightError(err, group, action, rest, flags, wantsCompact);
      return;
    }
  }

  if (group === "guide") {
    try {
      validateFlags(group, action, flags, cliSpec, fmtLight, isLibraryQueryLight);
      const workspaceDir = strFlag(flags, "dir") ?? strFlag(flags, "project") ?? process.cwd();
      await runGuideCommand(workspaceDir, flags);
      return;
    } catch (err: unknown) {
      await reportLightError(err, group, action, rest, flags, wantsCompact);
      return;
    }
  }

  // Heavy path: every other command. State, env and group modules load here.
  const {
    setActiveCliCommand,
    setActiveCliCompactMode,
    setActiveCliRevisionBefore,
    setActiveCliValues,
    setActiveCliWorkspaceDir,
    CLI_NOT_HANDLED,
  } = await import("./cli_output.js");
  const { loadDotEnvIfNeeded, preferCutholFfmpeg } = await import("./core/env.js");
  const { readWorkspaceRevision } = await import("./mcp/mcp_format.js");
  setActiveCliCommand(group ?? "", action, rest[0]);

  const fmt = typeof flags["format"] === "string" ? flags["format"].trim().toLowerCase() : "";
  const isLibraryQuery = group === "library" && action === "query";
  const wantsJsonOutput = Boolean(flags["json"]) || fmt === "json";
  setActiveCliCompactMode(
    !wantsJsonOutput &&
      (boolFlag(flags, "compact", false) === true ||
        fmt === "text" ||
        (fmt === "compact" && !isLibraryQuery))
  );

  const invokedBin = path.basename(invokedPath).toLowerCase();
  if (group === "mcp" || invokedBin.startsWith("cuthol-mcp")) {
    const { startMcpStdioServer } = await import("./mcp/server.js");
    const mcpDir = typeof flags["dir"] === "string" ? flags["dir"] : undefined;
    startMcpStdioServer({ defaultDir: mcpDir });
    return;
  }

  // Skills are never installed automatically: only an explicit
  // `cuthol skills install --agent <id>` (or `cuthol setup --apply` with
  // `--agent`) writes into agent tool folders.
  validateFlags(group, action, flags, cliSpec, fmt, isLibraryQuery);

  const workspaceDir = strFlag(flags, "dir") ?? strFlag(flags, "project") ?? process.cwd();
  setActiveCliWorkspaceDir(workspaceDir);
  setActiveCliRevisionBefore(readWorkspaceRevision(workspaceDir));
  setActiveCliValues({
    dry_run: boolFlag(flags, "dry-run", false),
    verbose: boolFlag(flags, "verbose", false),
    clip: strFlag(flags, "clip"),
    cursor: strFlag(flags, "cursor"),
    limit: numFlag(flags, "limit"),
  });
  loadDotEnvIfNeeded(workspaceDir);
  preferCutholFfmpeg();
  if (!process.env.CUTHOL_PROJECT_DIR) process.env.CUTHOL_PROJECT_DIR = workspaceDir;

  assertNoExtraPositionals(group, action, rest, flags);

  const ctx: CliCommandContext = {
    group,
    action,
    rest,
    flags,
    workspaceDir,
    formatFlag: fmt,
  };

  switch (group) {
    case "workspace": {
      const { runWorkspaceCommand } = await import("./cli_cmd_workspace.js");
      if ((await runWorkspaceCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "library": {
      const { runLibraryCommand } = await import("./cli_cmd_library.js");
      if ((await runLibraryCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "spine": {
      const { runSpineCommand } = await import("./cli_cmd_spine.js");
      if ((await runSpineCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "lane": {
      const { runLaneCommand } = await import("./cli_cmd_lane.js");
      if ((await runLaneCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "composition": {
      const { runCompositionCommand } = await import("./cli_cmd_composition.js");
      if ((await runCompositionCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "cue": {
      const { runCueCommand } = await import("./cli_cmd_composition.js");
      if ((await runCueCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "verify": {
      const { runVerifyCommand } = await import("./cli_cmd_output.js");
      if ((await runVerifyCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "speech": {
      const { runSpeechCommand } = await import("./cli_cmd_speech.js");
      if ((await runSpeechCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "mix": {
      const { runMixCommand } = await import("./cli_cmd_mix.js");
      if ((await runMixCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "monitor": {
      const { runMonitorCommand } = await import("./cli_cmd_output.js");
      if ((await runMonitorCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "render": {
      const { runRenderCommand } = await import("./cli_cmd_output.js");
      if ((await runRenderCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "brief": {
      const { runBriefCommand } = await import("./cli_cmd_output.js");
      if ((await runBriefCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "extension": {
      const { runExtensionCommand } = await import("./cli_cmd_extension.js");
      if ((await runExtensionCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "skills": {
      const { runSkillsCommand } = await import("./cli_cmd_skills.js");
      if (runSkillsCommand(ctx) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "live": {
      const { runLiveCommand } = await import("./cli_cmd_live.js");
      if ((await runLiveCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "settings": {
      const { runSettingsCommand } = await import("./cli_cmd_settings.js");
      if ((await runSettingsCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "doctor": {
      const { runDoctorCommand } = await import("./cli_cmd_doctor.js");
      if ((await runDoctorCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "setup": {
      const { runSetupCommand } = await import("./cli_cmd_setup.js");
      if ((await runSetupCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "color": {
      const { runColorCommand } = await import("./cli_cmd_color.js");
      if ((await runColorCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
    case "export": {
      const { runExportCommand } = await import("./cli_cmd_export.js");
      if ((await runExportCommand(ctx)) !== CLI_NOT_HANDLED) return;
      break;
    }
  }

  printHelp();
  process.exitCode = 1;
}

/**
 * Unknown-flag and `--format` validation shared by the light and heavy paths
 * (same order and messages as the old inline checks).
 */
function validateFlags(
  group: string | undefined,
  action: string | undefined,
  flags: Record<string, string | boolean>,
  cliSpec: { params: Array<{ flag?: string; name: string; type: string; positional?: boolean }> } | undefined,
  fmt: string,
  isLibraryQuery: boolean
): void {
  for (const key of Object.keys(flags)) {
    if (!KNOWN_CLI_FLAGS.has(key)) {
      const suggestion = cliSpec
        ? describeUnknownFlag(group ?? "", action, key, cliSpec.params)
        : suggestFlagFix(key, group ?? "", action);
      throw new CutholError(
        DIAGNOSTICS.UNKNOWN_FLAG(`--${key}`, `${group ?? "cuthol"}${action ? `.${action}` : ""}`, suggestion)
      );
    }
  }
  if (
    fmt &&
    fmt !== "json" &&
    fmt !== "text" &&
    fmt !== "compact" &&
    !(isLibraryQuery && fmt === "default")
  ) {
    // `--format` is the reserved global output flag (text|json|compact): its value is never a
    // command-specific format, so the suggestion must not propose `--format text` for one.
    const formatHint =
      group === "export" && action === "timeline"
        ? "cuthol export timeline fcpxml|xmeml|edl|otio (the interchange format is a positional or --as, not --format)"
        : `cuthol ${group ?? ""}${action ? ` ${action}` : ""} --format text|json`;
    throw new CutholError(
      DIAGNOSTICS.UNKNOWN_FLAG(
        `--format ${String(flags["format"])}`,
        `${group ?? "cuthol"}${action ? `.${action}` : ""}`,
        formatHint
      )
    );
  }
}

/** `cuthol <version>`: read once from the package.json next to `dist/`. */
function readPackageVersion(): string {
  try {
    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // Fall through to the default below.
  }
  return "0.0.0";
}

/**
 * The same compact-mode decision the heavy path applies, computed without the
 * `cli_output` state (light commands never emit envelopes on success, so this
 * only selects the error shape).
 */
function computeCompactMode(
  group: string | undefined,
  action: string | undefined,
  flags: Record<string, string | boolean>
): boolean {
  const fmt = typeof flags["format"] === "string" ? flags["format"].trim().toLowerCase() : "";
  const isLibraryQuery = group === "library" && action === "query";
  const wantsJsonOutput = Boolean(flags["json"]) || fmt === "json";
  return (
    !wantsJsonOutput &&
    (boolFlag(flags, "compact", false) === true || fmt === "text" || (fmt === "compact" && !isLibraryQuery))
  );
}

/**
 * Error envelope for the light path (`help` / `explain` / `guide` / `--version`).
 * Plain JSON bytes match the heavy path exactly; compact mode delegates to the
 * heavy formatter so its bytes match too.
 */
async function reportLightError(
  err: unknown,
  group: string | undefined,
  action: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  compact: boolean
): Promise<void> {
  if (!compact) {
    const { drainLiveInbox } = await import("./live/live_inbox.js");
    const errEnvelope: Record<string, unknown> =
      err instanceof CutholError
        ? {
            ok: false,
            schema_version: "cuthol.envelope/1",
            diagnostic: err.diagnostic,
          }
        : {
            ok: false,
            schema_version: "cuthol.envelope/1",
            error: err instanceof Error ? err.message : String(err),
          };
    try {
      const liveNotes = drainLiveInbox(process.cwd());
      if (liveNotes) errEnvelope.live_notes = liveNotes;
    } catch {
      // never break error reporting
    }
    console.error(JSON.stringify(errEnvelope, null, 2));
    process.exitCode = 1;
    return;
  }
  await reportCompactLightError(err, group, action, rest, flags);
}

async function reportCompactLightError(
  err: unknown,
  group: string | undefined,
  action: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const {
    setActiveCliCommand,
    setActiveCliCompactMode,
    setActiveCliWorkspaceDir,
  } = await import("./cli_output.js");
  const { resolveActionSpecForCommand, formatEnvelopeCompact } = await import("./mcp/mcp_format.js");
  const { drainLiveInbox } = await import("./live/live_inbox.js");
  setActiveCliCommand(group ?? "", action, rest[0]);
  setActiveCliCompactMode(true);
  const workspaceDir = strFlag(flags, "dir") ?? strFlag(flags, "project") ?? process.cwd();
  setActiveCliWorkspaceDir(workspaceDir);
  const { activeCliGroup, activeCliAction, activeCliSub, activeCliValues } =
    await import("./cli_output.js");
  const errEnvelope: Record<string, unknown> =
    err instanceof CutholError
      ? {
          ok: false,
          schema_version: "cuthol.envelope/1",
          diagnostic: err.diagnostic,
        }
      : {
          ok: false,
          schema_version: "cuthol.envelope/1",
          error: err instanceof Error ? err.message : String(err),
        };
  try {
    const liveNotes = drainLiveInbox(workspaceDir);
    if (liveNotes) errEnvelope.live_notes = liveNotes;
  } catch {
    // never break error reporting
  }
  const spec = resolveActionSpecForCommand(activeCliGroup, activeCliAction, activeCliSub);
  const { text } = formatEnvelopeCompact({
    envelope: errEnvelope,
    spec,
    dir: workspaceDir,
    values: activeCliValues,
    revisionBefore: null,
    exitCode: 1,
    hintForm: "cli",
  });
  console.error(text);
  process.exitCode = 1;
}

/** Runs one CLI command and reports a failure as the error envelope with exit code 1 (never throws). */
export async function runCliMain(argv: string[] = process.argv.slice(2), invokedPath: string = process.argv[1] ?? ""): Promise<void> {
  try {
    await runCli(argv, invokedPath);
  } catch (err: unknown) {
    await reportCliError(err);
  }
}

async function reportCliError(err: unknown): Promise<void> {
  const { drainLiveInbox } = await import("./live/live_inbox.js");
  const {
    activeCliCompactMode,
    activeCliGroup,
    activeCliAction,
    activeCliSub,
    activeCliValues,
    activeCliWorkspaceDir,
    activeCliRevisionBefore,
  } = await import("./cli_output.js");
  const { resolveActionSpecForCommand, formatEnvelopeCompact } = await import("./mcp/mcp_format.js");
  const errEnvelope: Record<string, unknown> =
    err instanceof CutholError
      ? {
          ok: false,
          schema_version: "cuthol.envelope/1",
          diagnostic: err.diagnostic,
        }
      : {
          ok: false,
          schema_version: "cuthol.envelope/1",
          error: err instanceof Error ? err.message : String(err),
        };

  // Cuthol Live: queued user notes ride the error response too (failed commands
  // still deliver; untouched when the inbox is empty).
  try {
    const liveNotes = drainLiveInbox(activeCliWorkspaceDir);
    if (liveNotes) errEnvelope.live_notes = liveNotes;
  } catch {
    // never break error reporting
  }

  if (activeCliCompactMode) {
    const spec = resolveActionSpecForCommand(activeCliGroup, activeCliAction, activeCliSub);
    const { text } = formatEnvelopeCompact({
      envelope: errEnvelope,
      spec,
      dir: activeCliWorkspaceDir,
      values: activeCliValues,
      revisionBefore: activeCliRevisionBefore,
      exitCode: 1,
      hintForm: "cli",
    });
    console.error(text);
  } else {
    console.error(JSON.stringify(errEnvelope, null, 2));
  }
  process.exitCode = 1;
}
