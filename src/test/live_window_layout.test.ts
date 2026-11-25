/**
 * Live window layout: measurement tests driven through a
 * real headless browser against a real `live serve` subprocess.
 *
 * Preview bar speed label must not intersect the volume icon (800x600,
 *     1280x800, 1920x1080).
 * Preview caption type scales with the stage: whole-px font size, stroke
 *     width proportional to the stage scale (mirrors the ASS Outline, which
 *     renders at full resolution with ScaledBorderAndShadow), no blur shadow.
 * In a 9:16 project every preview control is inside the viewport and
 *     clickable at the three window sizes.
 * A fresh page shows a neutral "connecting" dot until the first snapshot or
 *     a real failure; a dead token still ends in "error".
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-layout-shots-"));

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

function copyDemo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-win-c-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function makeTall(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-win-c-tall-"));
  initWorkspace({ dir, title: "tall", aspect: "9:16", fps: 30 });
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
});

async function openPage(url: string, w: number, h: number): Promise<{ page: Page; errors: string[] }> {
  const b = await sharedBrowser();
  const page = await b.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  await page.setViewport({ width: w, height: h });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".pv-bar", { timeout: 30000 });
  return { page, errors };
}

async function closePage(page: Page): Promise<void> {
  await page.close().catch(() => {});
}

function rectsIntersect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("speed label never overlaps the volume controls", async () => {
  const dir = copyDemo();
  const fx = await startLive(dir);
  try {
    for (const [w, h] of [[800, 600], [1280, 800], [1920, 1080]] as Array<[number, number]>) {
      const { page } = await openPage(fx.url("/"), w, h);
      try {
        await page.waitForFunction(() => (window as any).__livePreview?.state()?.duration > 0, { timeout: 30000 });
        // Long label like the report ("1x · 1.1x").
        await page.evaluate(() => {
          const el = document.querySelector(".pv-speed");
          if (el) el.textContent = "1× · 1.1×";
        });
        const r = (await page.evaluate(() => {
          const panel = document.querySelector('[data-region="preview"]')!.getBoundingClientRect();
          const q = (s: string) => {
            const e = document.querySelector(s) as HTMLElement | null;
            if (!e) return null;
            const cs = getComputedStyle(e);
            if (cs.display === "none") return "hidden";
            const b = e.getBoundingClientRect();
            return { x: b.x, y: b.y, w: b.width, h: b.height };
          };
          return {
            panel: { x: panel.x, y: panel.y, w: panel.width, h: panel.height },
            ".pv-speed": q(".pv-speed"), ".pv-vol": q(".pv-vol"), '[data-act="mute"]': q('[data-act="mute"]'),
            '[data-act="full"]': q('[data-act="full"]'), '[data-act="play"]': q('[data-act="play"]'), ".pv-time": q(".pv-time"),
          };
        })) as Record<string, any>;
        const ctrls = [".pv-speed", ".pv-vol", '[data-act="mute"]', '[data-act="full"]', '[data-act="play"]'];
        for (const s of ctrls) {
          const c = r[s];
          assert.ok(c && c !== "hidden", `${s} present and visible at ${w}x${h}`);
          assert.ok(c.x >= r.panel.x - 1 && c.x + c.w <= r.panel.x + r.panel.w + 1, `${s} inside panel at ${w}x${h}: ${JSON.stringify(c)} panel ${JSON.stringify(r.panel)}`);
        }
        const vis = ctrls.map((s) => r[s]).filter((c) => c && c !== "hidden");
        for (let i = 0; i < vis.length; i++) {
          for (let j = i + 1; j < vis.length; j++) {
            assert.ok(!rectsIntersect(vis[i], vis[j]), `controls overlap at ${w}x${h}: ${JSON.stringify(vis[i])} vs ${JSON.stringify(vis[j])}`);
          }
        }
        if (w === 800) await page.screenshot({ path: path.join(SHOTS, "speed-label-800.png") });
      } finally {
        await closePage(page);
      }
    }
  } finally {
    await stopLive(fx);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tall project keeps every preview control inside the viewport", async () => {
  const dir = makeTall();
  const fx = await startLive(dir);
  try {
    for (const [w, h] of [[800, 600], [1280, 800], [1920, 1080]] as Array<[number, number]>) {
      const { page } = await openPage(fx.url("/"), w, h);
      try {
        await page.waitForFunction(() => document.body.classList.contains("tall"), { timeout: 30000 });
        const r = (await page.evaluate(() => {
          const out: Record<string, any> = { innerW: window.innerWidth };
          for (const s of [".pv-speed", ".pv-vol", '[data-act="mute"]', '[data-act="full"]', '[data-act="play"]']) {
            const e = document.querySelector(s);
            if (!e) { out[s] = null; continue; }
            const b = e.getBoundingClientRect();
            const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            out[s] = { x: b.x, y: b.y, w: b.width, h: b.height, clickable: !!hit && (hit === e || e.contains(hit)) };
          }
          return out;
        })) as Record<string, any>;
        if (w === 800) await page.screenshot({ path: path.join(SHOTS, "tall-800.png") });
        for (const s of [".pv-speed", ".pv-vol", '[data-act="mute"]', '[data-act="full"]', '[data-act="play"]']) {
          assert.ok(r[s], `${s} present at ${w}x${h} (tall)`);
          assert.ok(r[s].x >= 0 && r[s].x + r[s].w <= r.innerW + 1, `${s} inside viewport at ${w}x${h} (tall): ${JSON.stringify(r[s])}`);
          assert.ok(r[s].clickable, `${s} clickable at ${w}x${h} (tall)`);
        }
        if (w === 800) await page.screenshot({ path: path.join(SHOTS, "tall-800.png") });
      } finally {
        await closePage(page);
      }
    }
  } finally {
    await stopLive(fx);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh page shows connecting, dead token shows error", async () => {
  const dir = copyDemo();
  const fx = await startLive(dir);
  try {
    const b = await sharedBrowser();
    // Fresh page with /events + /api/snapshot held back: still pre-connect.
    const page = await b.newPage();
    try {
      await page.setRequestInterception(true);
      const held: Array<() => void> = [];
      page.on("request", (req) => {
        const u = req.url();
        if (u.includes("/events") || u.includes("/api/snapshot")) {
          held.push(() => req.continue());
          return;
        }
        void req.continue();
      });
      await page.setViewport({ width: 1280, height: 800 });
      const nav = page.goto(fx.url("/"), { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector(".ac-dot", { timeout: 30000 });
      await new Promise((r) => setTimeout(r, 800));
      const pre = await page.evaluate(() => document.querySelector(".ac-dot")?.getAttribute("data-acstate"));
      assert.equal(pre, "connecting", `dot before first snapshot (got ${pre})`);
      for (const resume of held) resume();
      page.off("request", undefined as any);
      await page.setRequestInterception(false).catch(() => {});
      await nav;
      await page.waitForFunction(() => document.querySelector(".ac-dot")?.getAttribute("data-acstate") !== "connecting", { timeout: 30000 });
      const post = await page.evaluate(() => document.querySelector(".ac-dot")?.getAttribute("data-acstate"));
      assert.notEqual(post, "error", `dot after connect (got ${post})`);
    } finally {
      await closePage(page);
    }
    // Dead token: the server rejects it, the window must settle on error.
    const bad = await b.newPage();
    try {
      await bad.setViewport({ width: 1280, height: 800 });
      await bad.goto(`http://127.0.0.1:${fx.port}/?t=dead-token`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await bad.waitForSelector(".ac-dot", { timeout: 30000 });
      await bad.waitForFunction(() => document.querySelector(".ac-dot")?.getAttribute("data-acstate") === "error", { timeout: 30000 });
    } finally {
      await closePage(bad);
    }
  } finally {
    await stopLive(fx);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("caption type scales with the stage in whole px, no blur", async () => {
  const dir = copyDemo();
  const fx = await startLive(dir);
  const seen: Array<{ w: number; fontPx: number; strokePx: number; shadow: string }> = [];
  try {
    for (const [w, h] of [[800, 600], [1920, 1080]] as Array<[number, number]>) {
      const { page } = await openPage(fx.url("/"), w, h);
      try {
        await page.waitForFunction(() => (window as any).__livePreview?.state()?.duration > 0, { timeout: 30000 });
        await page.evaluate(() => (window as any).__livePreview.seek(1000));
        await page.waitForSelector(".pv-caption", { timeout: 30000 });
        const info = (await page.evaluate(() => {
          const el = document.querySelector(".pv-caption") as HTMLElement;
          const cs = getComputedStyle(el);
          const stage = document.querySelector(".pv-stage")!.getBoundingClientRect();
          return { fontPx: parseFloat(cs.fontSize), stroke: cs.webkitTextStrokeWidth, shadow: cs.textShadow, stageH: stage.height };
        })) as { fontPx: number; stroke: string; shadow: string; stageH: number };
        seen.push({ w, fontPx: info.fontPx, strokePx: parseFloat(info.stroke) || 0, shadow: info.shadow });
        if (w === 800) {
          const cap = await page.$(".pv-stage");
          await cap?.screenshot({ path: path.join(SHOTS, "caption-800.png") });
        } else {
          const cap = await page.$(".pv-stage");
          await cap?.screenshot({ path: path.join(SHOTS, "caption-1920.png") });
        }
      } finally {
        await closePage(page);
      }
    }
    const [small, large] = seen;
    assert.ok(Number.isInteger(small.fontPx), `small font whole px (got ${small.fontPx})`);
    assert.ok(Number.isInteger(large.fontPx), `large font whole px (got ${large.fontPx})`);
    assert.ok(small.fontPx < large.fontPx, `font grows with stage: ${small.fontPx} vs ${large.fontPx}`);
    for (const s of seen) {
      const px = [...String(s.shadow ?? "").matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
      // text-shadow is "x y blur": the blur radius (third length, if present) must be 0.
      const blur = px.length >= 3 ? px[2] : 0;
      assert.ok(s.shadow === "none" || px.length === 0 || blur === 0, `no blur shadow (got ${s.shadow})`);
    }
  } finally {
    await stopLive(fx);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
