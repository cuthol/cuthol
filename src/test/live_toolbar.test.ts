/**
 * Live timeline toolbar (`src/test/live_toolbar.test.ts`): in a 9:16 project the
 * zoom slider shrinks so every toolbar control stays visible and usable from
 * 1280 px down to 640 px window width.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { initWorkspace } from "../core/workspace.js";
import { waitFor } from "./b_helpers.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = path.join(REPO, "test-workspace", "live-design", "fixture", "live_demo");
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-toolbar-shots-"));

interface Live {
  dir: string;
  token: string;
  port: number;
  proc: ChildProcess;
  url: (p: string) => string;
}

async function startLive(dir: string): Promise<Live> {
  const proc = spawn(process.execPath, [CLI, "live", "serve", "--dir", dir], {
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    stdio: "ignore",
    windowsHide: true,
  });
  const serverFile = path.join(dir, ".cuthol", "live", "server.json");
  await waitFor(() => fs.existsSync(serverFile), 20000, "live server.json");
  const info = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { port: number; token: string };
  return { dir, token: info.token, port: info.port, proc, url: (p: string) => `http://127.0.0.1:${info.port}${p}${p.includes("?") ? "&" : "?"}t=${info.token}` };
}

async function stopLive(fx: Live): Promise<void> {
  fx.proc.kill();
  await new Promise((r) => setTimeout(r, 500));
}

function makeTallDemo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tb-tall-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const proc = spawnSync(process.execPath, [CLI, "workspace", "stage", "--aspect", "9:16", "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
  });
  assert.equal(proc.status, 0, `stage 9:16 failed: ${proc.stderr.slice(0, 500)}`);
  return dir;
}

let browser: Browser | null = null;
async function sharedBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      executablePath: resolveCoordsChromePath(),
      headless: true,
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    });
  }
  return browser;
}

after(async () => {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  try {
    fs.rmSync(SHOTS, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best effort
  }
});

test("narrow window toolbar: every control inside toolbar and viewport down to 640 px", async () => {
  const dir = makeTallDemo();
  const fx = await startLive(dir);
  try {
    const boxes: Record<string, unknown> = {};
    for (const [w, h] of [[1280, 800], [800, 600], [640, 480]] as Array<[number, number]>) {
      const b = await sharedBrowser();
      const page = await b.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      try {
        await page.setViewport({ width: w, height: h });
        await page.goto(fx.url("/"), { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForSelector(".tl-toolbar", { timeout: 30000 });
        await page.waitForFunction(() => (window as any).__tlStats?.draws > 0, { timeout: 30000 });
        const r = (await page.evaluate(() => {
          const bar = document.querySelector(".tl-toolbar")!.getBoundingClientRect();
          const out: Record<string, any> = {
            toolbar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height },
            innerW: window.innerWidth,
          };
          for (const el of document.querySelectorAll(".tl-toolbar button, .tl-toolbar input")) {
            const cs = getComputedStyle(el);
            if (cs.display === "none") continue;
            const b = el.getBoundingClientRect();
            const cls = (el.getAttribute("class") ?? "").split(" ").filter(Boolean).join(".");
            const key = `${el.tagName.toLowerCase()}.${cls}[${el.getAttribute("data-edit-action") ?? el.getAttribute("aria-label") ?? ""}]`;
            const cx = b.x + b.width / 2;
            const cy = b.y + b.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            out[key] = {
              x: Math.round(b.x * 10) / 10,
              y: Math.round(b.y * 10) / 10,
              w: Math.round(b.width * 10) / 10,
              h: Math.round(b.height * 10) / 10,
              clickable: !!hit && (hit === el || el.contains(hit)),
              disabled: (el as HTMLButtonElement).disabled === true,
            };
          }
          return out;
        })) as Record<string, any>;
        boxes[`${w}x${h}`] = r;
        await page.screenshot({ path: path.join(SHOTS, `toolbar-${w}.png`) });
        const bar = r["toolbar"] as { x: number; y: number; w: number; h: number };
        for (const [key, c] of Object.entries(r)) {
          if (key === "toolbar" || key === "innerW") continue;
          const cbox = c as { x: number; y: number; w: number; h: number; clickable: boolean; disabled: boolean };
          assert.ok(
            cbox.x >= bar.x - 1 && cbox.x + cbox.w <= bar.x + bar.w + 1,
            `${key} inside toolbar at ${w}px: ${JSON.stringify(cbox)} bar ${JSON.stringify(bar)}`
          );
          assert.ok(
            cbox.x >= -1 && cbox.x + cbox.w <= (r["innerW"] as number) + 1,
            `${key} inside viewport at ${w}px: ${JSON.stringify(cbox)}`
          );
          // Edit buttons are disabled while the agent edits (by design): they are
          // still laid out, so their boxes are checked above, but hit-testing
          // skips them. Only enabled controls must be clickable.
          if (!cbox.disabled) assert.ok(cbox.clickable, `${key} clickable at ${w}px`);
        }
        assert.deepEqual(errors, [], `console errors at ${w}px`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    console.log("toolbar boxes: " + JSON.stringify(boxes));
  } finally {
    await stopLive(fx);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
