// Keeps a long-lived stdio MCP session in step with the Cuthol build on disk.
//
// Every tool call already runs the CLI from disk, but the tool schema and the
// argument translation live in this process. After `git pull && npm run build`
// (or an npm update) the two disagree: new arguments are invisible over MCP and
// old ones may be translated for a CLI that no longer accepts them. When the
// build on disk changes, the relay starts a fresh MCP server from disk, replays
// the client's `initialize`, tells the client the tool list changed, and from
// then on forwards every JSON-RPC line both ways. A later rebuild replaces that
// server (never more than one relay level). If a restart fails the previous
// server keeps serving and the next response carries a warning instead.
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DIAGNOSTICS } from "../core/diagnostics.js";

export interface BuildStamp {
  version: string;
  /** Newest modification time among the files that define the MCP layer and the CLI entry. */
  mtimeMs: number;
}

/** Files whose change means "the MCP layer on disk differs from this process". */
function stampFiles(mcpDir: string, cliPath: string): string[] {
  const files: string[] = [cliPath];
  try {
    for (const name of fs.readdirSync(mcpDir)) {
      if (name.endsWith(".js")) files.push(path.join(mcpDir, name));
    }
  } catch {
    // directory missing: only the CLI entry counts
  }
  return files;
}

export function readBuildStamp(packageRoot: string, mcpDir: string, cliPath: string): BuildStamp | null {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: string };
    version = pkg.version ?? "0.0.0";
  } catch {
    return null;
  }
  let mtimeMs = 0;
  for (const file of stampFiles(mcpDir, cliPath)) {
    try {
      mtimeMs = Math.max(mtimeMs, fs.statSync(file).mtimeMs);
    } catch {
      // a file vanished mid-build; the settle delay covers it
    }
  }
  if (mtimeMs === 0) return null;
  return { version, mtimeMs };
}

export function stampsDiffer(a: BuildStamp, b: BuildStamp): boolean {
  return a.version !== b.version || Math.abs(a.mtimeMs - b.mtimeMs) > 1;
}

/** "0.3.9" when versions differ, "0.4.0 (build 2026-11-16 14:02:11 UTC)" when only the build changed. */
export function describeStamp(stamp: BuildStamp, other: BuildStamp): string {
  if (stamp.version !== other.version) return stamp.version;
  const iso = new Date(stamp.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
  return `${stamp.version} (build ${iso} UTC)`;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: { content?: Array<{ type?: string; text?: unknown }> } & Record<string, unknown>;
  error?: unknown;
};

/** Prepends a note to the first text block of a tools/call response (no-op for other messages). */
export function prependNoteToResponse(msg: JsonRpcMessage, note: string): boolean {
  const first = msg.result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return false;
  first.text = `${note}\n${first.text}`;
  return true;
}

/** Set in a restarted server's environment so it never starts a relay of its own. */
export const RELAY_CHILD_ENV = "CUTHOL_MCP_RELAY_CHILD";

export interface McpReloadRelayOptions {
  packageRoot: string;
  mcpDir: string;
  cliPath: string;
  /** Writes one JSON-RPC message to the client. */
  write: (msg: unknown) => void;
  /** Project folder the session currently uses (passed to the new server as `--dir`). */
  sessionDir: () => string | null;
  /** A build is used only once its newest file is at least this old (an in-progress build is not started). */
  settleMs?: number;
  /** How long the new server may take to answer `initialize`. */
  startTimeoutMs?: number;
  /** Minimum time between disk checks. */
  checkIntervalMs?: number;
  /** A build whose restart failed is tried again after this long (an npm install may have been mid-way). */
  retryAfterMs?: number;
  /** Test hook: replaces the clock. */
  now?: () => number;
}

const REPLAY_INIT_ID = "__cuthol_reload_initialize";

export class McpReloadRelay {
  private readonly opts: Required<Omit<McpReloadRelayOptions, "now">> & { now: () => number };
  /** Build this process started with (what the in-process server runs). */
  private readonly started: BuildStamp | null;
  /** Build requests currently go to: `started` in-process, or the running child's build. */
  private current: BuildStamp | null;
  private initializeParams: unknown = undefined;
  private child: ChildProcess | null = null;
  private active = false;
  private lastCheck = 0;
  private failedFor: BuildStamp | null = null;
  private failedAt = 0;
  /** Note waiting for the next tools/call response (success or failure of a restart). */
  private pendingNote: string | null = null;
  private switching: Promise<boolean> | null = null;
  /** Request ids forwarded to the child and not answered yet. */
  private readonly outstanding = new Set<string | number>();

  constructor(options: McpReloadRelayOptions) {
    this.opts = {
      settleMs: 2000,
      startTimeoutMs: 20000,
      checkIntervalMs: 1000,
      retryAfterMs: 60000,
      now: () => Date.now(),
      ...options,
    };
    this.started = readBuildStamp(this.opts.packageRoot, this.opts.mcpDir, this.opts.cliPath);
    this.current = this.started;
  }

  /** True while requests are forwarded to a restarted server. */
  get isRelaying(): boolean {
    return this.active;
  }

  /** Remember the client's handshake so it can be replayed to a new server. */
  observeInitialize(params: unknown): void {
    this.initializeParams = params ?? {};
  }

  /** Forward one raw client line to the restarted server. Only valid while relaying. */
  forward(line: string, id?: string | number | null): void {
    if (id !== undefined && id !== null) this.outstanding.add(id);
    this.child?.stdin?.write(`${line}\n`);
  }

  /** Note for an in-process response (restart failed); returned once. */
  takePendingNote(): string | null {
    const note = this.pendingNote;
    this.pendingNote = null;
    return note;
  }

  /**
   * Checks the build on disk (throttled) and, when it changed and has settled,
   * starts a server from it, replacing a previous restarted server. Call only
   * while no request is in flight in this process. Resolves true when requests
   * should be forwarded.
   */
  async maybeSwitch(): Promise<boolean> {
    if (this.switching) return this.switching;
    if (!this.current || this.initializeParams === undefined) return this.active;
    // Never swap a server out from under a request it has not answered yet.
    if (this.active && this.outstanding.size > 0) return true;
    const now = this.opts.now();
    if (now - this.lastCheck < this.opts.checkIntervalMs) return this.active;
    this.lastCheck = now;
    const onDisk = readBuildStamp(this.opts.packageRoot, this.opts.mcpDir, this.opts.cliPath);
    if (!onDisk || !stampsDiffer(onDisk, this.current)) return this.active;
    if (this.failedFor && !stampsDiffer(onDisk, this.failedFor) && now - this.failedAt < this.opts.retryAfterMs) return this.active;
    if (now - onDisk.mtimeMs < this.opts.settleMs) return this.active;
    this.switching = this.startChild(onDisk).finally(() => {
      this.switching = null;
    });
    return this.switching;
  }

  private startChild(onDisk: BuildStamp): Promise<boolean> {
    const base = this.current as BuildStamp;
    const from = describeStamp(base, onDisk);
    const to = describeStamp(onDisk, base);
    const wasActive = this.active;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const dir = this.opts.sessionDir();
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [this.opts.cliPath, "mcp", ...(dir ? ["--dir", dir] : [])], {
          stdio: ["pipe", "pipe", "inherit"],
          windowsHide: true,
          // The parent owns restarts; the child never relays itself (one level only).
          env: { ...process.env, [RELAY_CHILD_ENV]: "1" },
        });
      } catch (err) {
        this.fail(onDisk, from, to, err instanceof Error ? err.message : String(err));
        resolve(wasActive);
        return;
      }
      const finish = (ok: boolean, detail?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          try {
            child.kill();
          } catch {
            // already gone
          }
          this.fail(onDisk, from, to, detail ?? "unknown error");
          // A failed replacement keeps the previous restarted server.
          resolve(wasActive);
          return;
        }
        const previous = this.child;
        this.child = child;
        this.active = true;
        this.current = onDisk;
        this.failedFor = null;
        if (previous) {
          try {
            previous.kill();
          } catch {
            // already gone
          }
        }
        this.pendingNote = DIAGNOSTICS.MCP_RELOADED_NEWER_BUILD(from, to).formatted;
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        this.opts.write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        resolve(true);
      };
      const timer = setTimeout(() => finish(false, `no answer to initialize within ${this.opts.startTimeoutMs} ms`), this.opts.startTimeoutMs);
      child.on("error", (err) => finish(false, err.message));
      child.on("exit", (code) => {
        if (!settled) {
          finish(false, `the new server exited with code ${code}`);
          return;
        }
        if (this.child === child) this.onChildLost(onDisk, code);
      });
      const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream, terminal: false });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(trimmed) as JsonRpcMessage;
        } catch {
          return;
        }
        if (msg.id === REPLAY_INIT_ID) {
          if (msg.error) finish(false, `initialize failed: ${JSON.stringify(msg.error).slice(0, 200)}`);
          else finish(true);
          return;
        }
        if (!settled || this.child !== child) return;
        if (msg.id !== undefined && msg.id !== null) this.outstanding.delete(msg.id);
        // The client re-reads the tool list on our list_changed; its own handshake already happened.
        if (this.pendingNote && msg.id !== undefined && msg.id !== null && prependNoteToResponse(msg, this.pendingNote)) {
          this.pendingNote = null;
        }
        this.opts.write(msg);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: REPLAY_INIT_ID, method: "initialize", params: this.initializeParams })}\n`);
    });
  }

  private fail(onDisk: BuildStamp, from: string, to: string, detail: string): void {
    const repeat = this.failedFor !== null && !stampsDiffer(onDisk, this.failedFor);
    this.failedFor = onDisk;
    this.failedAt = this.opts.now();
    if (repeat) return; // already warned once for this build
    this.pendingNote = DIAGNOSTICS.MCP_RELOAD_FAILED(from, to, detail).formatted;
  }

  /** The restarted server died: serve in-process again (the build this process started with) and say so once. */
  private onChildLost(onDisk: BuildStamp, code: number | null): void {
    this.child = null;
    this.active = false;
    this.current = this.started;
    const started = this.started as BuildStamp;
    const from = describeStamp(started, onDisk);
    const to = describeStamp(onDisk, started);
    this.fail(onDisk, from, to, `the restarted server exited with code ${code}`);
    for (const id of this.outstanding) {
      this.opts.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: DIAGNOSTICS.MCP_RELOAD_FAILED(from, to, `the restarted server exited with code ${code} before answering`).formatted },
      });
    }
    this.outstanding.clear();
    this.opts.write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  /** Stops the restarted server (client gone or process exit). */
  dispose(): void {
    const child = this.child;
    this.child = null;
    this.active = false;
    try {
      child?.kill();
    } catch {
      // already gone
    }
  }
}
