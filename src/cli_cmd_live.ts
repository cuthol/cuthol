import { CLI_NOT_HANDLED, type CliCommandContext, emitEnvelopeJson } from "./cli_output.js";
import { boolFlag, numFlag, strFlag } from "./cli_args.js";
import { resolveLiveConfig, setLiveConfig } from "./live/live_config.js";
import { othersRunning } from "./live/live_instances.js";
import { ensureLiveServer, getLiveStatus, runLiveServer, stopLiveServer, waitForLiveResume } from "./live/live_server.js";
import { openLiveWindow } from "./live/live_window.js";
import type { LiveMode } from "./live/live_types.js";

/**
 * `cuthol live open|status|wait|config|stop|serve`.
 * open   start (or reuse) the project's live server and open the window
 * status one-line state for the agent: mode, running, lock, pending notes
 * wait   block until the user resumes the agent (after G601)
 * config --mode ask|on|off [--global]
 * stop   stop the server (the window shows "disconnected")
 * serve  internal: run the server in this process (spawned by `open`)
 */
export async function runLiveCommand(ctx: CliCommandContext): Promise<unknown> {
  const { action, flags, workspaceDir } = ctx;
  switch (action) {
    case "open": {
      const others = othersRunning(workspaceDir);
      if (others.length > 0 && !boolFlag(flags, "replace")) {
        const list = others.map((o) => `${o.project_dir} (pid ${o.pid}, port ${o.port}; stop with: cuthol live stop --dir "${o.project_dir}")`).join("; ");
        emitEnvelopeJson(workspaceDir, "live open", {
          live: {
            warning: `another Live server is running for ${list}. Not started and nothing was stopped; pass --replace to stop the other server first and open this one.`,
            other_servers: others,
          },
        });
        return;
      }
      if (others.length > 0 && boolFlag(flags, "replace")) {
        for (const o of others) await stopLiveServer(o.project_dir);
      }
      const server = await ensureLiveServer(workspaceDir);
      const window = boolFlag(flags, "no-window") ? { opened: false, mode: "none" as const } : openLiveWindow(server.url, workspaceDir);
      emitEnvelopeJson(workspaceDir, "live open", { live: { url: server.url, port: server.port, pid: server.pid, window, replaced: boolFlag(flags, "replace") ? others.length : 0 } });
      return;
    }
    case "status": {
      const status = getLiveStatus(workspaceDir);
      emitEnvelopeJson(workspaceDir, "live status", { live: { ...status, config: resolveLiveConfig(workspaceDir) } });
      return;
    }
    case "wait": {
      const r = await waitForLiveResume(workspaceDir, numFlag(flags, "timeout") ?? 1800);
      emitEnvelopeJson(workspaceDir, "live wait", { live: r });
      return;
    }
    case "config": {
      const mode = strFlag(flags, "mode") as LiveMode | undefined;
      const resolved = mode ? setLiveConfig(workspaceDir, mode, boolFlag(flags, "global") ? "user" : "project") : resolveLiveConfig(workspaceDir);
      emitEnvelopeJson(workspaceDir, "live config", { live: { config: resolved } });
      return;
    }
    case "stop": {
      const stopped = await stopLiveServer(workspaceDir);
      emitEnvelopeJson(workspaceDir, "live stop", { live: { stopped } });
      return;
    }
    case "serve": {
      await runLiveServer(workspaceDir, { port: numFlag(flags, "port") });
      return;
    }
  }
  return CLI_NOT_HANDLED;
}
