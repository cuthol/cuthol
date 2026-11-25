/**
 * Live watcher storm: delete + re-copy of a composition folder must not
 * broadcast endlessly; identical content hashes suppress repeats, and an
 * event naming the watched root (empty or absolute path) re-checks it.
 * Fails on old builds: old handler treated an absolute filename as a
 * relative path and broadcast on every debounce without any hash check;
 * fingerprintCompDir does not exist there.
 * Merged from live_comp_watch_storm.test.ts: its fingerprint behaviour
 * checks live on here. The old source-text assertions (grep for
 * compContentHash / fingerprintCompDir / startsWith(absPosix in
 * live_server.ts) are replaced by the server-observed broadcast behaviour
 * and the direct fingerprint checks below.
 */
import "./test_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../core/workspace.js";
import { resolveLivePaths } from "../live/live_paths.js";
import { addLaneCue } from "../sequence/lanes.js";
import { fingerprintCompDir } from "../live/live_server.js";

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 2000 });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function countCompsChanged(logFile: string): number {
  try {
    const text = fs.readFileSync(logFile, "utf8");
    return text.split("\n").filter((l) => l.includes("comps changed:")).length;
  } catch {
    return 0;
  }
}

/**
 * Live proof: with the server running, delete + re-copy a composition folder
 * → at most a few `comps changed` lines, then silence; a real edit after
 * that still broadcasts once. Fails on the old build, which logged a line
 * per debounce (~every 310 ms) without end. This server-observed behaviour
 * replaces the old source-text assertions (hash suppression, absolute root
 * filename normalization, no broadcast on unchanged hash).
 */
test("server: delete plus re-copy stays quiet, real edit broadcasts once", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-compstorm-"));
  let child: ChildProcess | null = null;
  try {
    const wsDir = path.join(tmp, "ws");
    initWorkspace({ dir: wsDir, title: "compstorm", aspect: "16:9", fps: 30 });
    const compDir = path.join(wsDir, "compositions", "x");
    fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(compDir, "index.html"),
      `<!doctype html>
<html>
<head><meta charset="UTF-8" /></head>
<body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-fps="30" data-duration="3">
  <div id="box" class="clip" data-start="0" data-duration="3" style="position:absolute;left:10px;top:10px;width:60px;height:60px;background:#ff0000;"></div>
</div>
<script src="assets/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to("#box", { x: 100, duration: 3, ease: "none" }, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>`,
      "utf8",
    );
    fs.writeFileSync(path.join(compDir, "assets/gsap.min.js"), "/* stub */", "utf8");
    addLaneCue({
      workspaceDir: wsDir,
      laneId: "ln_motion",
      kind: "composition",
      atMs: 0,
      durationMs: 3000,
      composition: { composition_dir: "compositions/x", entry_html: "index.html", props: {}, transparent: true },
    });
    const backup = path.join(tmp, "x-backup");
    fs.cpSync(compDir, backup, { recursive: true });

    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const cli = path.resolve(here, "../cli.js");
    child = spawn(process.execPath, [cli, "live", "serve", "--port", "0", "--dir", wsDir], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
    });
    const lp = resolveLivePaths(wsDir);
    let port = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const info = JSON.parse(fs.readFileSync(lp.serverFile, "utf8")) as { port: number };
        if (info?.port && (await portAnswers(info.port))) {
          port = info.port;
          break;
        }
      } catch {
        // not up yet
      }
      if (child.exitCode !== null) throw new Error(`server child exited early (${child.exitCode})`);
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(port > 0, "live server answers on its port");
    await new Promise((r) => setTimeout(r, 2000));
    const base = countCompsChanged(lp.logFile);

    fs.rmSync(compDir, { recursive: true, force: true });
    fs.cpSync(backup, compDir, { recursive: true });
    await new Promise((r) => setTimeout(r, 2000));
    const afterRecopy = countCompsChanged(lp.logFile);
    assert.ok(afterRecopy - base <= 2, `delete + identical re-copy logs at most 2 lines (got ${afterRecopy - base})`);
    await new Promise((r) => setTimeout(r, 10000));
    assert.equal(countCompsChanged(lp.logFile), afterRecopy, "silence for 10 s after the re-copy");

    fs.writeFileSync(path.join(compDir, "index.html"), "<!doctype html><html><body>changed</body></html>", "utf8");
    await new Promise((r) => setTimeout(r, 2500));
    const afterEdit = countCompsChanged(lp.logFile);
    assert.ok(afterEdit - afterRecopy >= 1 && afterEdit - afterRecopy <= 2, `real edit broadcasts once (got ${afterEdit - afterRecopy})`);
  } finally {
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        child?.once("exit", done);
        setTimeout(done, 5000);
      });
    }
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        if (i === 4) throw new Error(`temp cleanup failed: ${tmp}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
});

test("identical folder content hashes stable across re-copy", async () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), "comp-hash-"));
  try {
    const d = path.join(tmp, "x");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "a.txt"), "hello");
    const before: string = fingerprintCompDir(d);
    assert.ok(before.length > 0);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "a.txt"), "hello");
    assert.equal(fingerprintCompDir(d), before, "re-copied identical content hashes equal");
    fs.writeFileSync(path.join(d, "a.txt"), "changed!");
    assert.notEqual(fingerprintCompDir(d), before, "a real edit changes the hash");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function makeCompDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-compfp-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body>hi</body></html>");
  return dir;
}

test("fingerprint is stable across ignored-file writes, moves on real edits", () => {
  const dir = makeCompDir();
  try {
    const before = fingerprintCompDir(dir);
    assert.ok(before.length >= 8, "non-trivial fingerprint");
    // Files Cuthol itself writes must not move the fingerprint (no storm).
    fs.writeFileSync(path.join(dir, ".cuthol-thumb.png"), Buffer.from([1, 2, 3, 4]));
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshots", "s.png"), Buffer.from([5, 6, 7, 8]));
    assert.equal(fingerprintCompDir(dir), before, "ignored entries keep fingerprint stable");
    // A real edit must move it (broadcast + iframe reload still happen).
    fs.writeFileSync(
      path.join(dir, "index.html"),
      "<html><head></head><body>changed</body></html>",
    );
    assert.notEqual(fingerprintCompDir(dir), before, "real edit changes fingerprint");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untouched directory keeps a stable fingerprint (no repeat broadcast)", () => {
  const dir = makeCompDir();
  try {
    assert.equal(fingerprintCompDir(dir), fingerprintCompDir(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
