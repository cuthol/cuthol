/**
 * Live waveform fetch retries (`src/test/live_waveform_retries.test.ts`): a 404
 * (unknown handle, asset without audio) is never retried in the window session;
 * other failures back off (5 s, 30 s) and then stop.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { waitFor } from "./b_helpers.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = path.join(REPO, "test-workspace", "live-design", "fixture", "live_demo");

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

test("a 404 waveform is fetched once and never retried; backoff policy is 5 s, 30 s, stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-waveretry-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  try {
    // Point the music cue at an unknown asset: the endpoint answers 404.
    const seqPath = path.join(dir, "cuthol.sequence.json");
    const seq = JSON.parse(fs.readFileSync(seqPath, "utf8")) as {
      lanes: Array<{ cues?: Array<{ id?: string; asset_handle?: string }> }>;
    };
    let touched = 0;
    for (const lane of seq.lanes ?? []) {
      for (const cue of lane.cues ?? []) {
        if (cue.asset_handle === "aud_01") {
          cue.asset_handle = "aud_missing";
          touched++;
        }
      }
    }
    assert.ok(touched > 0, "music cue not found");
    fs.writeFileSync(seqPath, JSON.stringify(seq, null, 2));
    const fx = await startLive(dir);
    try {
      const b = await sharedBrowser();
      const page = await b.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      let waveRequests = 0;
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (req.url().includes("/api/waveform/")) waveRequests++;
        void req.continue();
      });
      try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(fx.url("/"), { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForSelector(".tl-toolbar", { timeout: 30000 });
        await page.waitForFunction(() => (window as any).__tlStats?.draws > 0, { timeout: 30000 });
        // Keep redrawing past the old 5 s retry horizon: scroll the timeline.
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          await page.evaluate(() => {
            document.querySelector(".tl-scroll")?.scrollBy(30, 0);
          });
          await new Promise((r) => setTimeout(r, 1000));
        }
        console.log(`404 wave requests in 8 s: ${waveRequests}`);
        assert.equal(waveRequests, 1, `404 retried: ${waveRequests} requests`);
        // Delays cross the page boundary as strings (Infinity is not JSON-safe).
        const policy = (await page.evaluate(() => ({
          d1: String((window as any).__tlWavePolicy?.retryDelayMs(1)),
          d2: String((window as any).__tlWavePolicy?.retryDelayMs(2)),
          d3: String((window as any).__tlWavePolicy?.retryDelayMs(3)),
        }))) as { d1: string; d2: string; d3: string };
        assert.equal(policy.d1, "5000");
        assert.equal(policy.d2, "30000");
        assert.equal(policy.d3, "Infinity");
        assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
      } finally {
        await page.setRequestInterception(false).catch(() => {});
        await page.close().catch(() => {});
      }
    } finally {
      await stopLive(fx);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
