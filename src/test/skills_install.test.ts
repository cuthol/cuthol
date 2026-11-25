/**
 * Agent skill installer tests (`src/core/skills_install.ts`, `cuthol skills`).
 *
 * Every case runs against a temporary home directory (`HOME`/`USERPROFILE` and the
 * agent config variables point into it); the real home folder is never touched.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_IDS,
  SKILL_MARKER_FILE,
  detectAgentTargets,
  formatSkillsHint,
  installSkills,
  isSkillsHintHidden,
  isValidAgentId,
  listSkillsStatus,
  removeSkills,
  resolvePackageSkillsDir,
  resolveSelectedTargets,
  scanSkills,
  skillsWarningIds,
} from "../core/skills_install.js";
import { computeSkillsHint, CutholMcpServer } from "../mcp/server.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const HOME_VARS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

function makeTempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point the home and agent config variables at `home`; returns a restore function. */
function redirectHome(home: string): () => void {
  const prev = new Map<string, string | undefined>();
  for (const key of HOME_VARS) prev.set(key, process.env[key]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  return () => {
    for (const key of HOME_VARS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function withAuto(value: string, fn: () => void): void {
  const prev = process.env.CUTHOL_SKILLS_AUTO;
  process.env.CUTHOL_SKILLS_AUTO = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_SKILLS_AUTO;
    else process.env.CUTHOL_SKILLS_AUTO = prev;
  }
}

function spawnEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  delete env.XDG_CONFIG_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function runCli(args: string[], home: string, extra: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: spawnEnv(home, extra),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function packageSkillNames(): string[] {
  return scanSkills(resolvePackageSkillsDir()).map((s) => s.name);
}

test("skills install: detection only picks up agent folders that exist", () => {
  const home = makeTempHome("cuthol-skills-detect-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const detected = detectAgentTargets().map((t) => t.id);
    assert.deepEqual(detected, ["claude-code", "codex"]);

    // Env overrides move the base folder.
    const customClaude = path.join(home, "custom-claude");
    fs.mkdirSync(customClaude, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = customClaude;
    const moved = detectAgentTargets().find((t) => t.id === "claude-code");
    assert.equal(moved?.baseDir, customClaude);
    assert.equal(moved?.skillsDir, path.join(customClaude, "skills"));
    delete process.env.CLAUDE_CONFIG_DIR;

    // XDG override moves opencode.
    const xdg = path.join(home, "xdg");
    fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    process.env.XDG_CONFIG_HOME = xdg;
    assert.ok(detectAgentTargets().some((t) => t.id === "opencode"));
    delete process.env.XDG_CONFIG_HOME;
    assert.ok(!detectAgentTargets().some((t) => t.id === "opencode"));

    assert.ok(isValidAgentId("codex"));
    assert.ok(!isValidAgentId("nope"));
    assert.ok(AGENT_IDS.includes("claude-code") && AGENT_IDS.includes("agents"));
  } finally {
    restore();
  }
});

test("skills install: install writes skills + marker, second call is a no-op", () => {
  const home = makeTempHome("cuthol-skills-install-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const names = packageSkillNames();
    assert.ok(names.includes("cuthol"));

    const first = installSkills();
    assert.equal(first.targets.length, 1);
    assert.deepEqual([...first.targets[0].installed].sort(), [...names].sort());
    for (const name of names) {
      const markerFile = path.join(home, ".claude", "skills", name, SKILL_MARKER_FILE);
      assert.ok(fs.existsSync(markerFile), `marker missing for ${name}`);
      const marker = JSON.parse(fs.readFileSync(markerFile, "utf8")) as Record<string, unknown>;
      assert.equal(typeof marker.package_version, "string");
      assert.equal(typeof marker.content_hash, "string");
      assert.equal(typeof marker.installed_at, "string");
    }

    const status = listSkillsStatus();
    for (const entry of status.targets[0].skills) {
      assert.equal(entry.status, "installed");
    }

    const second = installSkills();
    assert.deepEqual(second.targets[0].installed, []);
    assert.deepEqual(second.targets[0].updated, []);
    assert.deepEqual(second.targets[0].removed_stale, []);
    assert.deepEqual([...second.targets[0].unchanged].sort(), [...names].sort());
  } finally {
    restore();
  }
});

test("skills install: version change marks outdated and updates", () => {
  const home = makeTempHome("cuthol-skills-update-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    installSkills({ packageVersion: "0.0.1-test" });
    const stale = listSkillsStatus({ packageVersion: "0.0.2-test" });
    for (const entry of stale.targets[0].skills) {
      assert.equal(entry.status, "outdated");
    }
    const updated = installSkills({ packageVersion: "0.0.2-test" });
    assert.ok(updated.targets[0].updated.length > 0);
    const fresh = listSkillsStatus({ packageVersion: "0.0.2-test" });
    for (const entry of fresh.targets[0].skills) {
      assert.equal(entry.status, "installed");
    }
  } finally {
    restore();
  }
});

test("skills install: user edits are kept (modified) unless --force", () => {
  const home = makeTempHome("cuthol-skills-modified-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    installSkills({ packageVersion: "0.0.1-test" });
    const installedSkill = path.join(home, ".claude", "skills", "cuthol", "SKILL.md");
    fs.appendFileSync(installedSkill, "\n<!-- user note -->\n");

    const status = listSkillsStatus({ packageVersion: "0.0.2-test" });
    const cuthol = status.targets[0].skills.find((s) => s.name === "cuthol");
    assert.equal(cuthol?.status, "modified");

    const kept = installSkills({ packageVersion: "0.0.2-test" });
    assert.ok(kept.targets[0].skipped_modified.some((s) => s.name === "cuthol"));
    assert.ok(fs.readFileSync(installedSkill, "utf8").includes("user note"), "user edit must survive");

    const forced = installSkills({ packageVersion: "0.0.2-test", force: true });
    assert.ok(forced.targets[0].updated.includes("cuthol"));
    assert.ok(!fs.readFileSync(installedSkill, "utf8").includes("user note"), "--force must overwrite");
  } finally {
    restore();
  }
});

test("skills install: stale managed skills are removed, foreign folders are kept", () => {
  const home = makeTempHome("cuthol-skills-stale-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
    installSkills();
    const skillsRoot = path.join(home, ".agents", "skills");
    const staleDir = path.join(skillsRoot, "old-skill");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "SKILL.md"), "# old\n", "utf8");
    fs.writeFileSync(
      path.join(staleDir, SKILL_MARKER_FILE),
      JSON.stringify({ package_version: "0.0.0", content_hash: "x", installed_at: "x", source_path: "x" }),
      "utf8"
    );
    const foreignDir = path.join(skillsRoot, "my-own-skill");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, "SKILL.md"), "# mine\n", "utf8");

    const report = installSkills();
    assert.ok(report.targets[0].removed_stale.includes("old-skill"));
    assert.ok(!fs.existsSync(staleDir), "stale managed skill must be removed");
    assert.ok(fs.existsSync(path.join(foreignDir, "SKILL.md")), "unmarked user folder must be kept");
  } finally {
    restore();
  }
});

test("skills install: remove deletes only Cuthol-managed folders", () => {
  const home = makeTempHome("cuthol-skills-remove-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    installSkills();
    const skillsRoot = path.join(home, ".claude", "skills");
    const foreignDir = path.join(skillsRoot, "my-own-skill");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, "SKILL.md"), "# mine\n", "utf8");

    const removed = removeSkills();
    assert.ok(removed.targets[0].removed.includes("cuthol"));
    assert.ok(!fs.existsSync(path.join(skillsRoot, "cuthol")));
    assert.ok(fs.existsSync(path.join(foreignDir, "SKILL.md")), "remove must keep unmarked folders");

    const status = listSkillsStatus();
    for (const entry of status.targets[0].skills) {
      assert.equal(entry.status, "missing");
    }
  } finally {
    restore();
  }
});

test("skills install: --agent filter and unknown agent id", () => {
  const home = makeTempHome("cuthol-skills-agent-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const selected = resolveSelectedTargets({ ids: ["codex"] });
    assert.deepEqual(selected.map((t) => t.id), ["codex"]);
    installSkills({ targets: selected });
    assert.ok(!fs.existsSync(path.join(home, ".claude", "skills")));
    assert.ok(fs.existsSync(path.join(home, ".codex", "skills", "cuthol", "SKILL.md")));

    const missing = resolveSelectedTargets({ ids: ["cursor"] });
    assert.equal(missing[0].detected, false);
    const skipped = installSkills({ targets: missing });
    assert.equal(skipped.targets[0].detected, false);
  } finally {
    restore();
  }

  const home2 = makeTempHome("cuthol-skills-agent-cli-");
  const bad = runCli(["skills", "list", "--agent", "nope"], home2, { CUTHOL_SKILLS_AUTO: "0" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /CUTHOL-G110/);
});

test("skills install: --dir installs into a custom skills folder", () => {
  const home = makeTempHome("cuthol-skills-dir-");
  const custom = path.join(home, "custom-skills");
  const installed = runCli(["skills", "install", "--dir", custom], home, { CUTHOL_SKILLS_AUTO: "0" });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.ok(fs.existsSync(path.join(custom, "cuthol", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(custom, "cuthol", SKILL_MARKER_FILE)));

  const listed = runCli(["skills", "list", "--dir", custom], home, { CUTHOL_SKILLS_AUTO: "0" });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const env = JSON.parse(listed.stdout) as {
    ok: boolean;
    targets: Array<{ id: string; skills: Array<{ name: string; status: string }> }>;
  };
  assert.equal(env.ok, true);
  const customTarget = env.targets.find((t) => t.id === "custom");
  assert.ok(customTarget, "list must include the --dir target");
  assert.ok(customTarget.skills.every((s) => s.status === "installed"));

  const checked = runCli(["skills", "check", "--dir", custom], home, { CUTHOL_SKILLS_AUTO: "0" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal((JSON.parse(checked.stdout) as { up_to_date: boolean }).up_to_date, true);
});

function listFilesRecursiveForProof(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

test("skills install: no CLI command and no MCP start writes into agent tool folders", async () => {
  const home = makeTempHome("cuthol-skills-noauto-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  for (const value of ["1", "unset"]) {
    const before = listFilesRecursiveForProof(home);
    const savedAuto = process.env.CUTHOL_SKILLS_AUTO;
    if (value === "unset") delete process.env.CUTHOL_SKILLS_AUTO;
    else process.env.CUTHOL_SKILLS_AUTO = value;
    try {
      // No `setup` here: its dry run asks the real `claude` CLI on PATH for a
      // version, and that external tool writes its own files under the home
      // folder. `setup` is covered by the dedicated tests below.
      for (const args of [["skills", "list"], ["skills", "check"], ["doctor"], ["help"]]) {
        const res = runCli(args, home, { CI: "1" });
        assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr || res.stdout}`);
      }
    } finally {
      if (savedAuto === undefined) delete process.env.CUTHOL_SKILLS_AUTO;
      else process.env.CUTHOL_SKILLS_AUTO = savedAuto;
    }
    const restore = redirectHome(home);
    try {
      if (value === "unset") delete process.env.CUTHOL_SKILLS_AUTO;
      else process.env.CUTHOL_SKILLS_AUTO = value;
      const server = new CutholMcpServer({ skillsNote: computeSkillsHint() });
      await server.callTool("no-such-tool", {});
    } finally {
      restore();
    }
    const after = listFilesRecursiveForProof(home);
    assert.deepEqual(after, before, `CUTHOL_SKILLS_AUTO=${value}: files appeared under the temp home`);
  }
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills")));
  assert.ok(!fs.existsSync(path.join(home, ".codex", "skills")));
  assert.ok(!fs.existsSync(path.join(home, ".cuthol", "skills-installed.json")));
});

test("skills install: CUTHOL_SKILLS_AUTO=0 hides the hint, other values change nothing", () => {
  const home = makeTempHome("cuthol-skills-autoval-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    withAuto("0", () => {
      assert.equal(isSkillsHintHidden(), true);
      assert.equal(computeSkillsHint(), null);
    });
    for (const value of ["1", "true", "yes"]) {
      withAuto(value, () => {
        assert.equal(isSkillsHintHidden(), false);
      });
    }
    delete process.env.CUTHOL_SKILLS_AUTO;
    assert.equal(isSkillsHintHidden(), false);
  } finally {
    restore();
  }
});

test("skills install: outdated skills warn; modified skills never warn", () => {
  const home = makeTempHome("cuthol-skills-warnrule-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    installSkills({ packageVersion: "0.0.1-test" });
    // A user edit in one tool: with the same package version that tool has
    // only installed/modified skills, so nothing fires for it.
    fs.appendFileSync(path.join(home, ".codex", "skills", "cuthol", "SKILL.md"), "\n<!-- user note -->\n");
    const edited = listSkillsStatus({ packageVersion: "0.0.1-test" });
    assert.deepEqual(skillsWarningIds(edited), []);
    // A version change marks the untouched skills outdated, which does fire.
    const stale = listSkillsStatus({ packageVersion: "0.0.2-test" });
    assert.deepEqual(skillsWarningIds(stale), ["claude-code", "codex"]);
    const hint = formatSkillsHint(["claude-code"]);
    assert.ok(hint.includes("claude-code"));
    assert.ok(hint.includes("cuthol skills install --agent <id>"));
    assert.ok(hint.includes("CUTHOL_SKILLS_AUTO=0"));
  } finally {
    restore();
  }
});

test("skills install: MCP hint fires once when skills are missing, never when current", async () => {
  const home = makeTempHome("cuthol-skills-mcphint-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    delete process.env.CUTHOL_SKILLS_AUTO;
    const missing = computeSkillsHint();
    assert.ok(missing?.includes("claude-code"), `hint must name the tool: ${missing}`);
    const server = new CutholMcpServer({ skillsNote: missing });
    const first = await server.callTool("no-such-tool", {});
    assert.ok(
      typeof first.content[0]?.text === "string" && first.content[0].text.startsWith(missing as string),
      "first tool response carries the hint"
    );
    const second = await server.callTool("no-such-tool", {});
    assert.ok(
      typeof second.content[0]?.text === "string" && !second.content[0].text.includes("Cuthol skills are outdated"),
      "second tool response carries no hint"
    );
    withAuto("0", () => {
      assert.equal(computeSkillsHint(), null);
    });
    installSkills();
    assert.equal(computeSkillsHint(), null, "no hint when skills are current");
  } finally {
    restore();
  }
});

test("skills install: hint computation never throws", () => {
  const home = makeTempHome("cuthol-skills-hintthrow-");
  const restore = redirectHome(home);
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "skills"), "blocking file", "utf8");
    delete process.env.CUTHOL_SKILLS_AUTO;
    assert.doesNotThrow(() => computeSkillsHint());
  } finally {
    restore();
  }
});

test("skills install: install and setup --apply without --agent write nothing and print the per-tool command", () => {
  const home = makeTempHome("cuthol-skills-noagent-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const installed = runCli(["skills", "install"], home, { CUTHOL_SKILLS_AUTO: "0", CI: "1" });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const env = JSON.parse(installed.stdout) as { targets: unknown[]; commands: string[] };
  assert.deepEqual(env.targets, []);
  assert.ok(env.commands.some((c) => c === "cuthol skills install --agent claude-code"));
  assert.ok(env.commands.some((c) => c === "cuthol skills install --agent codex"));
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills")));
  assert.ok(!fs.existsSync(path.join(home, ".codex", "skills")));

  const dry = runCli(["setup"], home, { CUTHOL_SKILLS_AUTO: "0", CI: "1" });
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.match(dry.stdout, /skills claude-code: /);
  assert.match(dry.stdout, /cuthol skills install --agent claude-code/);
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills")));
});

test("skills install: setup --agent applies the skills step for that tool only", () => {
  const home = makeTempHome("cuthol-skills-setupagent-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const applied = runCli(["setup", "--agent", "claude-code", "--apply"], home, {
    CUTHOL_SKILLS_AUTO: "0",
    CI: "1",
  });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.match(applied.stdout, /skills claude-code: /);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "cuthol", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(home, ".codex", "skills")));
});
