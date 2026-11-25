/**
 * MCP self-restart on a newer build (`src/mcp/mcp_reload.ts`).
 *
 * Uses a fake package folder (package.json + an `mcp` folder + a tiny JSON-RPC
 * "cli") so the real build is never touched: the relay must keep serving
 * in-process while the build is unchanged or still settling, switch to the new
 * server once it changed, replay `initialize`, announce `tools/list_changed`,
 * prefix the first answer with G635 only once, and report G636 when the new
 * server cannot start.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { McpReloadRelay, readBuildStamp, describeStamp } from "../mcp/mcp_reload.js";

const ROOT = path.resolve(process.cwd(), "test-workspace", "mcp_reload_tests");

const FAKE_SERVER = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake", version: "2" }, echo: m.params } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "from new build " + m.method }] } }) + "\\n");
  }
});
`;

function makePackage(name: string, cliSource: string): { root: string; mcpDir: string; cli: string } {
  const root = path.join(ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  const mcpDir = path.join(root, "dist", "mcp");
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(path.join(mcpDir, "server.js"), "// fake\n");
  const cli = path.join(root, "dist", "cli.cjs");
  fs.writeFileSync(cli, cliSource);
  // Age every file so the starting build counts as settled.
  const old = new Date(Date.now() - 60_000);
  for (const f of [path.join(mcpDir, "server.js"), cli]) fs.utimesSync(f, old, old);
  return { root, mcpDir, cli };
}

function rebuild(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

type Msg = { jsonrpc: string; id?: unknown; method?: string; result?: any; error?: any };

function waitFor(out: Msg[], pred: (m: Msg) => boolean, ms = 10_000): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const hit = out.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return reject(new Error("timed out waiting for message"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("build stamp: version change and build-only change are both described", () => {
  const a = { version: "0.3.9", mtimeMs: Date.UTC(2026, 10, 16, 7, 0, 0) };
  const b = { version: "0.4.0", mtimeMs: a.mtimeMs + 5000 };
  assert.equal(describeStamp(a, b), "0.3.9");
  const c = { version: "0.3.9", mtimeMs: a.mtimeMs + 5000 };
  assert.match(describeStamp(c, a), /^0\.3\.9 \(build 2026-11-16 07:00:05 UTC\)$/);
});

test("relay: unchanged and still-settling builds keep the in-process server", async () => {
  const pkg = makePackage("unchanged", FAKE_SERVER);
  const out: Msg[] = [];
  const relay = new McpReloadRelay({ packageRoot: pkg.root, mcpDir: pkg.mcpDir, cliPath: pkg.cli, write: (m) => out.push(m as Msg), sessionDir: () => null, checkIntervalMs: 0 });
  try {
    relay.observeInitialize({ protocolVersion: "2025-06-18" });
    assert.equal(await relay.maybeSwitch(), false);
    // A build that is still being written (newest file younger than the settle delay) is not started.
    rebuild(pkg.cli, 0);
    assert.equal(await relay.maybeSwitch(), false);
    assert.equal(relay.isRelaying, false);
    assert.equal(out.length, 0);
    assert.equal(relay.takePendingNote(), null);
  } finally {
    relay.dispose();
  }
});

test("relay: a changed build restarts from disk, replays initialize, announces the new tool list once", { timeout: 30_000 }, async () => {
  const pkg = makePackage("changed", FAKE_SERVER);
  const out: Msg[] = [];
  const relay = new McpReloadRelay({ packageRoot: pkg.root, mcpDir: pkg.mcpDir, cliPath: pkg.cli, write: (m) => out.push(m as Msg), sessionDir: () => null, checkIntervalMs: 0 });
  try {
    relay.observeInitialize({ protocolVersion: "2025-06-18", clientInfo: { name: "t" } });
    fs.writeFileSync(path.join(pkg.root, "package.json"), JSON.stringify({ version: "1.1.0" }));
    rebuild(pkg.cli, 5000);
    assert.ok(readBuildStamp(pkg.root, pkg.mcpDir, pkg.cli));
    assert.equal(await relay.maybeSwitch(), true);
    assert.equal(relay.isRelaying, true);
    assert.deepEqual(out.map((m) => m.method), ["notifications/tools/list_changed"]);

    relay.forward(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }), 7);
    const first = await waitFor(out, (m) => m.id === 7);
    const text: string = first.result.content[0].text;
    assert.match(text, /^\[CUTHOL-G635\] Cuthol was rebuilt on disk while this MCP session ran \(server build 1\.0\.0 -> 1\.1\.0\)/);
    assert.match(text, /from new build tools\/call$/);

    relay.forward(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }), 8);
    const second = await waitFor(out, (m) => m.id === 8);
    assert.equal(second.result.content[0].text, "from new build tools/call");
    // The replayed initialize answer never reaches the client.
    assert.equal(out.filter((m) => m.result?.serverInfo).length, 0);
  } finally {
    relay.dispose();
  }
});

test("relay: a new server that cannot start leaves the old one serving and warns once (G636)", { timeout: 30_000 }, async () => {
  const pkg = makePackage("broken", "process.exit(3);\n");
  const out: Msg[] = [];
  const relay = new McpReloadRelay({ packageRoot: pkg.root, mcpDir: pkg.mcpDir, cliPath: pkg.cli, write: (m) => out.push(m as Msg), sessionDir: () => null, checkIntervalMs: 0 });
  try {
    relay.observeInitialize({});
    rebuild(pkg.cli, 5000);
    assert.equal(await relay.maybeSwitch(), false);
    assert.equal(relay.isRelaying, false);
    const note = relay.takePendingNote();
    assert.ok(note);
    assert.match(note, /^\[CUTHOL-G636\] .*the new server exited with code 3/);
    assert.equal(relay.takePendingNote(), null);
    // The same failed build is not retried on every call.
    assert.equal(await relay.maybeSwitch(), false);
    assert.equal(relay.takePendingNote(), null);
    assert.equal(out.length, 0);
  } finally {
    relay.dispose();
  }
});

test("relay: a second rebuild replaces the restarted server instead of nesting", { timeout: 30_000 }, async () => {
  const pkg = makePackage("replace", FAKE_SERVER);
  const out: Msg[] = [];
  const relay = new McpReloadRelay({ packageRoot: pkg.root, mcpDir: pkg.mcpDir, cliPath: pkg.cli, write: (m) => out.push(m as Msg), sessionDir: () => null, checkIntervalMs: 0 });
  try {
    relay.observeInitialize({});
    rebuild(pkg.cli, 20_000);
    assert.equal(await relay.maybeSwitch(), true);
    relay.forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }), 1);
    await waitFor(out, (m) => m.id === 1);
    // Same build again: no new server.
    assert.equal(await relay.maybeSwitch(), true);
    assert.equal(out.filter((m) => m.method === "notifications/tools/list_changed").length, 1);
    // A newer build: the parent replaces its child (one relay level) and says so once more.
    rebuild(pkg.cli, 5000);
    assert.equal(await relay.maybeSwitch(), true);
    assert.equal(out.filter((m) => m.method === "notifications/tools/list_changed").length, 2);
    relay.forward(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }), 2);
    const answer = await waitFor(out, (m) => m.id === 2);
    assert.match(answer.result.content[0].text, /^\[CUTHOL-G635\] .*\(server build 1\.0\.0 \(build .*\) -> 1\.0\.0 \(build .*\)\)/);
    // Exactly one answer per request (the replaced server's late output never reaches the client).
    assert.equal(out.filter((m) => m.id === 2).length, 1);
  } finally {
    relay.dispose();
  }
});

test("relay: a failed build is retried after the retry delay, warned only once", { timeout: 30_000 }, async () => {
  const pkg = makePackage("retry", "process.exit(4);\n");
  const out: Msg[] = [];
  let clock = Date.now();
  const relay = new McpReloadRelay({ packageRoot: pkg.root, mcpDir: pkg.mcpDir, cliPath: pkg.cli, write: (m) => out.push(m as Msg), sessionDir: () => null, checkIntervalMs: 0, retryAfterMs: 60_000, now: () => clock });
  try {
    relay.observeInitialize({});
    const failedMtime = new Date(Date.now() - 5000);
    fs.utimesSync(pkg.cli, failedMtime, failedMtime);
    assert.equal(await relay.maybeSwitch(), false);
    assert.match(relay.takePendingNote() ?? "", /CUTHOL-G636/);
    // The install finished with the same file times (npm keeps tarball mtimes), now a working server.
    // Not retried before the delay...
    fs.writeFileSync(pkg.cli, FAKE_SERVER);
    fs.utimesSync(pkg.cli, failedMtime, failedMtime);
    clock += 30_000;
    assert.equal(await relay.maybeSwitch(), false);
    // ...and retried after it.
    clock += 31_000;
    assert.equal(await relay.maybeSwitch(), true);
    assert.equal(relay.isRelaying, true);
  } finally {
    relay.dispose();
  }
});
