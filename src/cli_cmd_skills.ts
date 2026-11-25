// CLI 'skills' command group handler: install Cuthol skills into detected agent tools.
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import {
  AGENT_IDS,
  detectAgentTargets,
  installSkills,
  isValidAgentId,
  listSkillsStatus,
  removeSkills,
  resolveSelectedTargets,
} from "./core/skills_install.js";
import { strFlag, boolFlag } from "./cli_args.js";
import {
  CLI_NOT_HANDLED,
  CliCommandContext,
  CliCommandResult,
  emitEnvelopeJson,
} from "./cli_output.js";

export function runSkillsCommand(ctx: CliCommandContext): CliCommandResult {
  const { action, flags, workspaceDir } = ctx;
  const skillsAction = action ?? "list";
  if (skillsAction !== "list" && skillsAction !== "install" && skillsAction !== "check" && skillsAction !== "remove") {
    return CLI_NOT_HANDLED;
  }

  const agentRaw = strFlag(flags, "agent");
  const ids = agentRaw
    ? agentRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  if (ids) {
    for (const id of ids) {
      if (!isValidAgentId(id)) {
        throw new CutholError(
          DIAGNOSTICS.UNKNOWN_FLAG(
            `--agent ${id}`,
            `skills.${skillsAction}`,
            `cuthol skills ${skillsAction} --agent ${AGENT_IDS.join(",")}`
          )
        );
      }
    }
  }
  // For this group `--dir` names a custom skills folder to install into, not a workspace.
  const customDir = strFlag(flags, "dir");
  const targets = resolveSelectedTargets({ ids, customDir });

  if (skillsAction === "list") {
    emitEnvelopeJson(workspaceDir, "skills.list", { ...listSkillsStatus({ targets }) });
    return;
  }

  if (skillsAction === "check") {
    const status = listSkillsStatus({ targets });
    const up_to_date = status.targets
      .filter((t) => t.detected)
      .every((t) => t.skills.every((s) => s.status === "installed"));
    emitEnvelopeJson(workspaceDir, "skills.check", { up_to_date, ...status });
    return;
  }

  if (skillsAction === "install") {
    // Without --agent nothing is written: list the detected tools and the
    // exact command per tool. Skills are only installed for named tools.
    if (!ids && !customDir) {
      const detected = detectAgentTargets();
      const empty = listSkillsStatus({ targets: [] });
      emitEnvelopeJson(workspaceDir, "skills.install", {
        package_version: empty.package_version,
        skills: empty.skills,
        targets: [],
        detected: detected.map((t) => t.id),
        hint: "No agent selected; nothing written. Run one command per tool you use:",
        commands: detected.map((t) => `cuthol skills install --agent ${t.id}`),
      });
      return;
    }
    const report = installSkills({ targets, force: boolFlag(flags, "force", false) });
    emitEnvelopeJson(workspaceDir, "skills.install", { ...report });
    return;
  }

  const report = removeSkills({ targets });
  emitEnvelopeJson(workspaceDir, "skills.remove", { ...report });
}
