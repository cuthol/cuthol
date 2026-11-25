// CLI 'setup' command: registers the Cuthol MCP server with the agent tools found on this machine.
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  detectAgentTargets,
  installSkills,
  isValidAgentId,
  listSkillsStatus,
  resolveSelectedTargets,
} from "./core/skills_install.js";
import { applySetup } from "./core/mcp_register.js";
import {
  applyLocalSpeechSetup,
  describeLocalSpeechSetup,
  planLocalSpeechSetup,
} from "./core/local_speech_setup.js";
import { boolFlag, strFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export async function runSetupCommand(ctx: CliCommandContext): Promise<CliCommandResult> {
  const { flags, workspaceDir } = ctx;
  if (ctx.group !== "setup" || ctx.action !== undefined) return CLI_NOT_HANDLED;

  if (boolFlag(flags, "local-speech", false)) {
    const plan = planLocalSpeechSetup({
      model: strFlag(flags, "model"),
      voice: strFlag(flags, "voice"),
    });
    const wantsLocalJson = Boolean(flags["json"]);
    if (!boolFlag(flags, "apply", false)) {
      const lines = describeLocalSpeechSetup(plan);
      if (wantsLocalJson) {
        emitEnvelopeJson(workspaceDir, "setup.local-speech", {
          action: "setup.local-speech",
          dry_run: true,
          ...plan,
        });
        return;
      }
      for (const line of lines) console.log(line);
      return;
    }
    const startedAt = Date.now();
    const { noop, seconds } = await applyLocalSpeechSetup(
      { model: plan.model, voice: plan.voice, apply: true },
      startedAt
    );
    if (wantsLocalJson) {
      emitEnvelopeJson(workspaceDir, "setup.local-speech", {
        action: "setup.local-speech",
        dry_run: false,
        noop,
        seconds,
        ...plan,
      });
      return;
    }
    if (noop) {
      console.log(
        `local speech already installed in '${plan.root}' (model ${plan.model}, voice ${plan.voice}); nothing to do.`
      );
      return;
    }
    console.log(
      `local speech installed in '${plan.root}' (model ${plan.model}, voice ${plan.voice}) in ${seconds}s.`
    );
    return;
  }

  const agentRaw = strFlag(flags, "agent");
  const ids = agentRaw
    ? agentRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  if (ids) {
    for (const id of ids) {
      if (!isValidAgentId(id)) {
        throw new CutholError(DIAGNOSTICS.SETUP_UNKNOWN_AGENT(id));
      }
    }
  }

  const report = applySetup({
    ids,
    apply: boolFlag(flags, "apply", false),
    force: boolFlag(flags, "force", false),
  });
  // Skills follow the --agent selection only: setup --apply performs the
  // skills step together with the registration because the user asked setup
  // to apply. Edited skills are never overwritten (setup --force is not
  // passed to the skills step). Without --agent no skills are written.
  const skillsTargets = resolveSelectedTargets({ ids });
  const skillsStatus = listSkillsStatus({ targets: skillsTargets });
  const skillsLines = skillsStatus.targets.map((t) => {
    if (!t.detected) return `skills ${t.id}: not detected; skipped`;
    const missing = t.skills.filter((s) => s.status === "missing").length;
    const outdated = t.skills.filter((s) => s.status === "outdated").length;
    const state = missing > 0 || outdated > 0 ? "would install/update" : "up to date";
    return `skills ${t.id}: ${state}`;
  });
  const wantsJson = Boolean(flags["json"]);
  if (wantsJson) {
    emitEnvelopeJson(workspaceDir, "setup", { ...report, skills: skillsStatus });
    return;
  }
  if (!report.dry_run) {
    for (const tool of report.tools) {
      console.log(`${tool.id}: ${tool.action}${tool.backup ? ` (backup: ${tool.backup})` : ""}`);
    }
    for (const diag of report.diagnostics) console.log(diag.formatted);
    if (ids && ids.length > 0) {
      const installed = installSkills({ targets: skillsTargets });
      for (const target of installed.targets) {
        if (target.error) {
          console.log(`skills ${target.id}: not written (${target.error})`);
          continue;
        }
        const changed = target.installed.length + target.updated.length + target.removed_stale.length;
        const kept = target.skipped_modified.length > 0 ? `; kept ${target.skipped_modified.length} edited` : "";
        console.log(
          changed > 0
            ? `skills ${target.id}: installed ${target.installed.length}, updated ${target.updated.length}${kept}`
            : `skills ${target.id}: up to date${kept}`
        );
      }
    } else {
      const detected = detectAgentTargets();
      console.log("skills: not written (no --agent); run one command per tool you use:");
      for (const t of detected) console.log(`  cuthol skills install --agent ${t.id}`);
    }
    console.log("Start a new agent session to load the MCP server.");
    return;
  }
  const claudeRun = `claude mcp add --scope user cuthol -- ${report.command.command} ${report.command.args.join(" ")}`;
  for (const tool of report.tools) {
    if (tool.state === "manual") {
      console.log(`${tool.id}: manual: ${tool.action}`);
    } else if (tool.id === "claude-code" && tool.state !== "registered-same") {
      console.log(`${tool.id}: not registered; would run: ${claudeRun}`);
    } else if (tool.state === "registered-same") {
      console.log(`${tool.id}: registered, same command`);
    } else if (tool.state === "registered-different") {
      console.log(`${tool.id}: registered, different command; would replace with --force`);
    } else if (tool.state === "broken") {
      console.log(`${tool.id}: ${tool.file} unparseable; not written [CUTHOL-G630]`);
    } else {
      console.log(`${tool.id}: not registered; would write ${tool.file}`);
    }
  }
  for (const diag of report.diagnostics) console.log(diag.formatted);
  for (const line of skillsLines) console.log(line);
  if (!ids || ids.length === 0) {
    for (const t of detectAgentTargets()) console.log(`  cuthol skills install --agent ${t.id}`);
  }
  console.log("Start a new agent session to load the MCP server.");
}
