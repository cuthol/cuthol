#!/usr/bin/env node
/**
 * Dedicated `cuthol-mcp` entry point (`src/mcp_bin.ts` -> `dist/mcp_bin.js`).
 * Starts the MCP stdio server directly, so the mode never depends on the
 * invoked file name (npm's Windows `.cmd` shims run `node .../cli.js`,
 * which hides the `cuthol-mcp` name from `cli.js`). Honours `--dir <dir>`
 * (`--dir=<dir>` too); `cuthol mcp` keeps working via `cli_main.ts`.
 */
import { startMcpStdioServer } from "./mcp/server.js";

function dirOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith("--dir=")) return a.slice("--dir=".length);
  }
  return undefined;
}

startMcpStdioServer({ defaultDir: dirOf(process.argv.slice(2)) });
