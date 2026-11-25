/**
 * MCP `workspace open` lists installed extensions
 * (`src/test/mcp_workspace_open_extensions.test.ts`).
 *
 * The MCP server answers `workspace open` in-process: the summary must carry
 * the installed-extension list (enabled/disabled + description, the same data
 * `extension list` reports), exactly like the CLI path does.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { initWorkspace } from "../core/workspace.js";
import { createExtension, enableExtensionInWorkspace } from "../extensions/manager.js";
import { CutholMcpServer } from "../mcp/server.js";

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

test("MCP workspace open shows both extensions with enabled state", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-mcp-wsopen-ext-"));
  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  const prevCacheDir = process.env.CUTHOL_CACHE_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = path.join(tmpRoot, "persistent_extensions");
  process.env.CUTHOL_CACHE_DIR = path.join(tmpRoot, "shared_cache");
  try {
    const projDir = path.join(tmpRoot, "proj");
    initWorkspace({ dir: projDir });
    createExtension({
      name: "alpha",
      workspaceDir: projDir,
      scope: "project",
      template: "helper",
      description: "Alpha helper",
      version: "1.0.0",
    });
    createExtension({
      name: "beta",
      workspaceDir: projDir,
      scope: "project",
      template: "helper",
      description: "Beta helper",
      version: "2.0.0",
    });
    enableExtensionInWorkspace({ workspaceDir: projDir, name: "alpha" });

    const mcp = new CutholMcpServer();
    const res = await mcp.callTool("workspace", { action: "open", dir: projDir });
    assert.equal(res.isError, false, text(res));
    const out = text(res);
    assert.match(out, /- Extensions \(2 installed\):/);
    assert.ok(out.includes("`alpha` (enabled — Alpha helper)"));
    assert.ok(out.includes("`beta` (disabled — Beta helper)"));
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    if (prevCacheDir === undefined) delete process.env.CUTHOL_CACHE_DIR;
    else process.env.CUTHOL_CACHE_DIR = prevCacheDir;
    rmRetrySync(tmpRoot);
  }
});
