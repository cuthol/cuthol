/**
 * Live window trim extension (`src/test/live_window_trim.test.ts`): on an
 * isolated copy of the live demo project the out edge of a shortened clip is
 * dragged right in a real headless browser, proving the edge extends into
 * unused source media through the same `spine trim` path (before/after
 * screenshots), and the trim handles are visible at three window sizes.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { rmRetrySync, waitFor } from "./b_helpers.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = path.join(REPO, "test-workspace", "live-design", "fixture", "live_demo");
const FIXTURE_SKIP = fs.existsSync(FIXTURE) ? false : `fixture not present: ${FIXTURE}`;
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-trim-shots-"));

function cli(dir: string, args: string[]): void {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    timeout: 180000,
  });
  assert.equal(proc.status, 0, `cli ${args.join(" ")} failed: ${(proc.stderr || proc.stdout).slice(0, 500)}`);
}

function freshCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-trim-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function clipDuration(dir: string, id: string): number {
  const seq = JSON.parse(fs.readFileSync(path.join(dir, "cuthol.sequence.json"), "utf8"));
  const clip = (seq.spine?.clips ?? []).find((c: any) => c?.id === id);
  assert.ok(clip, `clip ${id} present`);
  return clip.duration_ms;
}

interface Served {
  dir: string;
  proc: ChildProcess;
  pid: number;
  base: string;
  token: string;
  url: string;
}

async function startServer(dir: string): Promise<Served> {
  const proc = spawn(process.execPath, [CLI, "live", "serve", "--dir", dir], {
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    stdio: "ignore",
    windowsHide: true,
  });
  const serverFile = path.join(dir, ".cuthol", "live", "server.json");
  await waitFor(() => fs.existsSync(serverFile), 30000, "live server.json");
  const info = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { port: number; token: string; pid: number };
  const base = `http://127.0.0.1:${info.port}`;
  return { dir, proc, pid: info.pid, base, token: info.token, url: `${base}/?t=${info.token}` };
}

async function stopServer(srv: Served): Promise<void> {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 });
    } else {
      srv.proc.kill("SIGKILL");
    }
  } catch {}
  try {
    srv.proc.kill("SIGKILL");
  } catch {}
  await new Promise((r) => setTimeout(r, 800));
  try {
    rmRetrySync(srv.dir);
  } catch {}
}

function postJson(base: string, reqPath: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: Number(new URL(base).port), path: `${reqPath}?t=${token}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

let sharedBrowser: Browser | null = null;
before(async () => {
  sharedBrowser = await puppeteer.launch({
    executablePath: resolveCoordsChromePath(),
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
});

after(async () => {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
});

async function openPage(srv: Served, width: number, height: number): Promise<{ page: Page; errors: string[] }> {
  assert.ok(sharedBrowser, "browser launched");
  const page = await sharedBrowser.newPage();
  await page.setViewport({ width, height });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(srv.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".ac-row", { timeout: 30000 });
  return { page, errors };
}

/** Pause as the human and select the clip by clicking its newest activity row. */
async function pauseAndSelect(page: Page, srv: Served): Promise<void> {
  const lock = await postJson(srv.base, "/api/lock", srv.token, { holder: "human" });
  assert.equal(lock.status, 200, `lock as human: ${lock.body.slice(0, 300)}`);
  await page.waitForFunction(
    () => !!document.querySelector('.ed-handle[data-ed-handle="trim-out"], .ac-row'),
    { timeout: 15000 }
  );
  // Click the newest activity row for sp_01 (the trim revision selects it).
  const clicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ac-row")] as HTMLElement[];
    const row = rows.find((r) => (r.title || "").includes("sp_01")) ?? rows[0];
    if (!row) return null;
    row.click();
    return row.title;
  });
  assert.ok(clicked, "an activity row was clicked");
  await page.waitForSelector('.ed-handle[data-ed-handle="trim-out"]', { timeout: 15000 });
}

test("window drag extends the out edge into unused media", { skip: FIXTURE_SKIP, timeout: 240000 }, async () => {
  const dir = freshCopy();
  // Shorten sp_01 so ~7 s of its source media sits unused after it.
  cli(dir, ["spine", "trim", "--clip", "sp_01", "--out", "7000ms"]);
  assert.equal(clipDuration(dir, "sp_01"), 7000);
  const srv = await startServer(dir);
  const { page, errors } = await openPage(srv, 1280, 800);
  try {
    await pauseAndSelect(page, srv);
    const beforePath = path.join(SHOTS, "trim-before.png");
    await page.screenshot({ path: beforePath });
    assert.ok(fs.existsSync(beforePath));

    const handle = await page.$('.ed-handle[data-ed-handle="trim-out"]');
    assert.ok(handle, "trim-out handle present");
    const box = await handle.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "trim-out handle has a box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cx + i * 10, cy, { steps: 2 });
      await new Promise((r) => setTimeout(r, 120));
    }
    await page.mouse.up();

    const grown = await waitFor(() => {
      const d = clipDuration(dir, "sp_01");
      return d > 7000 ? d : null;
    }, 20000, "clip duration to grow past 7000ms");
    assert.ok(grown > 7000 && grown < 12000, `clip grew by dragging (now ${grown}ms)`);
    const afterPath = path.join(SHOTS, "trim-after.png");
    await page.screenshot({ path: afterPath });
    assert.ok(fs.existsSync(afterPath));
    assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ").slice(0, 500)}`);
  } finally {
    await page.close().catch(() => {});
    await stopServer(srv);
  }
});

for (const [width, height] of [[800, 600], [1920, 1080]] as const) {
  test(`trim handles are visible at ${width}x${height}`, { skip: FIXTURE_SKIP, timeout: 240000 }, async () => {
    const dir = freshCopy();
    cli(dir, ["spine", "trim", "--clip", "sp_01", "--out", "7000ms"]);
    const srv = await startServer(dir);
    const { page, errors } = await openPage(srv, width, height);
    try {
      await pauseAndSelect(page, srv);
      const rects = await page.evaluate(() => {
        const out = document.querySelector('.ed-handle[data-ed-handle="trim-out"]')?.getBoundingClientRect();
        const inn = document.querySelector('.ed-handle[data-ed-handle="trim-in"]')?.getBoundingClientRect();
        return {
          out: out ? { x: out.x, y: out.y, w: out.width, h: out.height } : null,
          inn: inn ? { x: inn.x, y: inn.y, w: inn.width, h: inn.height } : null,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      });
      assert.ok(rects.out && rects.out.w > 0 && rects.out.h > 0, "trim-out handle visible");
      assert.ok(rects.inn && rects.inn.w > 0 && rects.inn.h > 0, "trim-in handle visible");
      for (const r of [rects.out!, rects.inn!]) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= rects.vw && r.y + r.h <= rects.vh, `handle inside viewport: ${JSON.stringify(r)}`);
      }
      const shot = path.join(SHOTS, `trim-handles-${width}x${height}.png`);
      await page.screenshot({ path: shot });
      assert.ok(fs.existsSync(shot));
      assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ").slice(0, 500)}`);
    } finally {
      await page.close().catch(() => {});
      await stopServer(srv);
    }
  });
}
