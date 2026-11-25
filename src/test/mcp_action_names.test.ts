/**
 * MCP action names use underscores; hyphenated aliases keep working.
 *
 * `workspace.audio_fade` and `spine.motion_blur` are the served names (every
 * other MCP-served action already used `_`); `audio-fade` / `motion-blur`
 * stay accepted over MCP. The CLI spellings (`cuthol workspace audio-fade`,
 * `cuthol spine motion-blur`) are unchanged.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { CutholMcpServer } from "../mcp/server.js";
import { translateCliHint } from "../mcp/mcp_format.js";

function scratch(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-mcp-rename-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

test("tool schemas show the underscore names", () => {
  const mcp = new CutholMcpServer();
  const defs = mcp.getToolDefinitions();
  const workspace = defs.find((d) => d.name === "workspace")!;
  const spine = defs.find((d) => d.name === "spine")!;
  const wActions = (workspace.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum;
  const sActions = (spine.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum;
  assert.ok(wActions.includes("audio_fade"), "workspace enum has audio_fade");
  assert.ok(!wActions.includes("audio-fade"), "workspace enum has no audio-fade");
  assert.ok(sActions.includes("motion_blur"), "spine enum has motion_blur");
  assert.ok(!sActions.includes("motion-blur"), "spine enum has no motion-blur");
});

test("hyphenated names still work over MCP; CLI hints use the new names", async (t) => {
  const dir = scratch(t);
  const ws = path.join(dir, "ws");
  initWorkspace({ dir: ws, title: "rename", aspect: "16:9", fps: 30 });
  const mcp = new CutholMcpServer();

  const faded = await mcp.callTool("workspace", { action: "audio_fade", dir: ws, ms: 20 });
  assert.equal(faded.isError, false, text(faded));
  const legacy = await mcp.callTool("workspace", { action: "audio-fade", dir: ws, ms: 10 });
  assert.equal(legacy.isError, false, text(legacy));

  const blurred = await mcp.callTool("spine", { action: "motion-blur", dir: ws, clip: "sp_99" });
  assert.equal(blurred.isError, true);
  assert.ok(!text(blurred).includes("unknown action"), "old motion-blur name is accepted (fails on the clip, not the action)");

  assert.equal(
    translateCliHint("'cuthol workspace audio-fade --ms 20'"),
    "workspace(action=audio_fade, ms=20)"
  );
  assert.match(
    translateCliHint("'cuthol spine motion-blur --clip sp_02 --shutter 180 --subframes 4'"),
    /spine\(action=motion_blur/
  );
});
