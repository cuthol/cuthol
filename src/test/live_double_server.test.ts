/**
 * Live double-server guard (`src/test/live_double_server.test.ts`).
 *
 * A stale `server.json` (dead pid, closed port) must be replaced by a single
 * new server, and two concurrent `ensureLiveServer` calls must end with one
 * server answering on one port.
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { initWorkspace } from "../core/workspace.js";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import { resolveLivePaths } from "../live/live_paths.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-double-"));

after(() => rmRetrySync(ROOT));

function httpStatus(port: number, reqPath: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: reqPath, timeout: 3000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test("live double-server: stale server.json with a dead pid is replaced by exactly one server", { timeout: 120000 }, async () => {
  const dir = path.join(ROOT, "ws_stale");
  rmRetrySync(dir);
  initWorkspace({ dir, title: "stale", aspect: "16:9", fps: 30 });
  const lp = resolveLivePaths(dir);
  fs.mkdirSync(lp.dir, { recursive: true });
  // A server that was killed without cleanup: dead pid, closed port.
  fs.writeFileSync(lp.serverFile, JSON.stringify({ schema: "cuthol.live/1", pid: 2147483647, port: 59999, token: "stale", started_at: new Date(0).toISOString(), project_dir: dir, url: "http://127.0.0.1:59999/" }));
  try {
    const info = await ensureLiveServer(dir);
    assert.notEqual(info.pid, 2147483647, "stale pid must not be reused");
    assert.equal(await httpStatus(info.port, `/api/snapshot?t=${info.token}`), 200, "new server answers on its port");
    const onDisk = JSON.parse(fs.readFileSync(lp.serverFile, "utf8")) as { pid: number; port: number };
    assert.equal(onDisk.pid, info.pid, "server.json holds the new server");
    assert.equal(onDisk.port, info.port);
  } finally {
    await stopLiveServer(dir).catch(() => {});
  }
});

test("live double-server: two concurrent ensureLiveServer calls end with one server", { timeout: 120000 }, async () => {
  const dir = path.join(ROOT, "ws_race");
  rmRetrySync(dir);
  initWorkspace({ dir, title: "race", aspect: "16:9", fps: 30 });
  let port = 0;
  try {
    const [a, b] = await Promise.all([ensureLiveServer(dir), ensureLiveServer(dir)]);
    assert.equal(a.port, b.port, `concurrent starts share one port (got ${a.port} and ${b.port})`);
    assert.equal(a.pid, b.pid, `concurrent starts share one pid (got ${a.pid} and ${b.pid})`);
    port = a.port;
    assert.equal(await httpStatus(port, `/api/snapshot?t=${a.token}`), 200, "the single server answers");
    // Both callers can read the same winning file while two servers were
    // spawned underneath: the log shows every startup, so exactly one is allowed.
    const logFile = resolveLivePaths(dir).logFile;
    const startups = async (): Promise<number> => {
      try {
        const log = fs.readFileSync(logFile, "utf8");
        return log.split("\n").filter((line) => line.includes("live server up on")).length;
      } catch {
        return 0;
      }
    };
    let count = await startups();
    const deadline = Date.now() + 12000;
    while (count < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      count = await startups();
    }
    assert.equal(count, 1, `exactly one server started for the project (log shows ${count})`);
  } finally {
    await stopLiveServer(dir).catch(() => {});
  }
  // After stopping the recorded server nothing may still answer for the project.
  // A surviving second server would answer at once, so one check after a grace wait decides it.
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await portAnswers(port), false, `no second server answers on port ${port} after stop`);
});
