/**
 * Composition scaffolds never silently overwrite edited files.
 *
 * `composition scaffold` and `lane add-composition --scaffold` used to rewrite the entry HTML
 * unconditionally, so a hand-edited composition was lost and `journal undo` could not bring it back.
 * Now an edited file stops the scaffold (G215); `--force` overwrites it as one journal revision and
 * `workspace journal undo` restores the edited bytes. Re-scaffolding an untouched scaffold with other
 * arguments needs no flag.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CutholMcpServer } from "../mcp/server.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function cli(args: string[]): { status: number; out: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { status: proc.status ?? 1, out: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
}

function withProject(fn: (ws: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-scaffold-guard-"));
  const ws = path.join(tmp, "proj");
  try {
    assert.equal(cli(["workspace", "init", ws, "--size", "640x360", "--fps", "30"]).status, 0);
    fn(ws);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const scaffold = (ws: string, extra: string[] = []) =>
  cli(["composition", "scaffold", "--dir", ws, "--comp-dir", "comps/t", "--preset", "counter", "--duration", "2000ms", ...extra]);

test("scaffold refuses an edited entry HTML; --force overwrites as one undoable revision", () => {
  withProject((ws) => {
    assert.equal(scaffold(ws).status, 0);
    const entry = path.join(ws, "comps", "t", "index.html");
    fs.appendFileSync(entry, "<!-- hand edit -->\n");
    const edited = fs.readFileSync(entry);

    const refused = scaffold(ws);
    assert.notEqual(refused.status, 0, "scaffold over an edited file must fail");
    assert.match(refused.out, /CUTHOL-G215/);
    assert.deepEqual(fs.readFileSync(entry), edited, "the edited file is untouched");

    const forced = scaffold(ws, ["--force"]);
    assert.equal(forced.status, 0, forced.out);
    assert.ok(!fs.readFileSync(entry, "utf8").includes("hand edit"), "--force overwrote the file");

    assert.equal(cli(["workspace", "journal", "undo", "--dir", ws]).status, 0);
    assert.deepEqual(fs.readFileSync(entry), edited, "undo brings the edited bytes back");
    assert.equal(cli(["workspace", "journal", "redo", "--dir", ws]).status, 0);
    assert.ok(!fs.readFileSync(entry, "utf8").includes("hand edit"), "redo re-applies the scaffold");
  });
});

const cueCount = (ws: string): number =>
  (JSON.parse(fs.readFileSync(path.join(ws, "cuthol.sequence.json"), "utf8")).lanes as Array<{ cues: unknown[] }>).reduce(
    (n, l) => n + l.cues.length,
    0
  );
const cursor = (ws: string): number =>
  JSON.parse(fs.readFileSync(path.join(ws, "cuthol.sequence.json"), "utf8")).meta.revision as number;

test("lane add-composition --scaffold: refuses edited files; --force rides on the cue's revision", () => {
  withProject((ws) => {
    assert.equal(scaffold(ws).status, 0);
    const entry = path.join(ws, "comps", "t", "index.html");
    fs.appendFileSync(entry, "<!-- hand edit -->\n");
    const edited = fs.readFileSync(entry);
    const add = (extra: string[] = []) =>
      cli(["lane", "add-composition", "--dir", ws, "--comp-dir", "comps/t", "--scaffold", "counter", "--duration", "2000ms", "--at", "0s", ...extra]);

    const refused = add();
    assert.match(refused.out, /CUTHOL-G215/);
    assert.deepEqual(fs.readFileSync(entry), edited);
    assert.equal(cueCount(ws), 0, "no cue on refusal");

    const before = cursor(ws);
    const forced = add(["--force"]);
    assert.equal(forced.status, 0, forced.out);
    assert.equal(cursor(ws), before + 1, "cue add and forced scaffold are one revision");
    assert.equal(cueCount(ws), 1);

    assert.equal(cli(["workspace", "journal", "undo", "--dir", ws]).status, 0);
    assert.equal(cueCount(ws), 0, "one undo removes the cue");
    assert.deepEqual(fs.readFileSync(entry), edited, "and brings the edited bytes back");
    assert.equal(cli(["workspace", "journal", "redo", "--dir", ws]).status, 0);
    assert.equal(cueCount(ws), 1);
    assert.ok(!fs.readFileSync(entry, "utf8").includes("hand edit"));
  });
});

test("a pruned forced-scaffold revision cannot fire on the commit that reuses its number", () => {
  withProject((ws) => {
    assert.equal(scaffold(ws).status, 0);
    const entry = path.join(ws, "comps", "t", "index.html");
    fs.appendFileSync(entry, "<!-- hand edit -->\n");
    const edited = fs.readFileSync(entry);
    assert.equal(scaffold(ws, ["--force"]).status, 0);
    const forcedRev = cursor(ws);
    const sidecar = path.join(ws, ".cuthol", "extchange", `scaffold_rev_${String(forcedRev).padStart(4, "0")}.json`);
    assert.ok(fs.existsSync(sidecar), `sidecar at ${sidecar}`);

    assert.equal(cli(["workspace", "journal", "undo", "--dir", ws]).status, 0);
    assert.equal(cli(["workspace", "backdrop", "--color", "#112233", "--dir", ws]).status, 0);
    assert.equal(cursor(ws), forcedRev, "the unrelated commit reuses the pruned number");
    assert.ok(!fs.existsSync(sidecar), "the pruned revision's sidecar is gone");

    assert.equal(cli(["workspace", "journal", "undo", "--dir", ws]).status, 0);
    assert.equal(cli(["workspace", "journal", "redo", "--dir", ws]).status, 0);
    assert.deepEqual(fs.readFileSync(entry), edited, "the hand edit survives undo/redo of the unrelated revision");
  });
});

test("MCP composition.scaffold maps force=false/true to the guard", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-scaffold-guard-mcp-"));
  const ws = path.join(tmp, "proj");
  try {
    assert.equal(cli(["workspace", "init", ws, "--size", "640x360", "--fps", "30"]).status, 0);
    const mcp = new CutholMcpServer({ defaultDir: ws });
    const args = { action: "scaffold", comp_dir: "comps/t", preset: "counter", duration: "2000ms" };
    assert.equal((await mcp.callTool("composition", args)).isError, false);
    const entry = path.join(ws, "comps", "t", "index.html");
    fs.appendFileSync(entry, "<!-- hand edit -->\n");
    const edited = fs.readFileSync(entry);

    const refused = await mcp.callTool("composition", { ...args, force: false });
    assert.equal(refused.isError, true);
    assert.match(String(refused.content[0].text), /G215/);
    assert.deepEqual(fs.readFileSync(entry), edited);

    const forced = await mcp.callTool("composition", { ...args, force: true });
    assert.equal(forced.isError, false, String(forced.content[0].text).slice(0, 400));
    assert.ok(!fs.readFileSync(entry, "utf8").includes("hand edit"));
    const undo = await mcp.callTool("workspace", { action: "undo" });
    assert.equal(undo.isError, false, String(undo.content[0].text).slice(0, 300));
    assert.deepEqual(fs.readFileSync(entry), edited, "workspace.undo over MCP restores the edit");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("re-scaffolding an untouched scaffold with other arguments needs no --force", () => {
  withProject((ws) => {
    assert.equal(scaffold(ws).status, 0);
    const again = cli(["composition", "scaffold", "--dir", ws, "--comp-dir", "comps/t", "--preset", "title_card", "--duration", "3000ms"]);
    assert.equal(again.status, 0, again.out);
    assert.doesNotMatch(again.out, /CUTHOL-G215/);
  });
});
