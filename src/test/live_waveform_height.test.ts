/**
 * Live waveform lane height (`src/test/live_waveform_height.test.ts`): the audio
 * waveform uses the lane's full drawable height with the label overlaid, instead
 * of the old double margin that shrank median peaks to a ~2 px line.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { waitFor } from "./b_helpers.js";
import { rmRetrySync } from "./fs_cleanup.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");
import { LIVE_DEMO_DIR, missingLiveDemo } from "./fixtures.js";

const FIXTURE = LIVE_DEMO_DIR;
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-waveheight-shots-"));

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

function copyDemo(aspect?: "9:16"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-waveheight-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (aspect) {
    const proc = spawnSync(process.execPath, [CLI, "workspace", "stage", "--aspect", aspect, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, CUTHOL_SKILLS_AUTO: "0", CI: "1" },
    });
    assert.equal(proc.status, 0, `stage ${aspect} failed: ${proc.stderr.slice(0, 500)}`);
  }
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
    rmRetrySync(SHOTS);
  } catch {
    // best effort
  }
});

/** Median vertical run (CSS px) of waveform-colored pixels on the track canvases. */
async function measureWaveRuns(page: import("puppeteer-core").Page): Promise<{ median: number; p90: number; runs: number; wave: string }> {
  return (await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement).getPropertyValue("--wave").trim();
    const m = css.match(/#([0-9a-f]{6})/i);
    const target = m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [0, 0, 0];
    const dpr = window.devicePixelRatio || 1;
    const runs: number[] = [];
    for (const cv of Array.from(document.querySelectorAll(".tl-tracks canvas")) as HTMLCanvasElement[]) {
      const g = cv.getContext("2d");
      if (!g) continue;
      const w = cv.width;
      const h = cv.height;
      if (w === 0 || h === 0) continue;
      let data: Uint8ClampedArray;
      try {
        data = g.getImageData(0, 0, w, h).data;
      } catch {
        continue;
      }
      for (let x = 0; x < w; x += 2) {
        let run = 0;
        let best = 0;
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          const diff = Math.abs(data[i] - target[0]) + Math.abs(data[i + 1] - target[1]) + Math.abs(data[i + 2] - target[2]);
          if (data[i + 3] > 200 && diff < 48) run++;
          else {
            if (run > best) best = run;
            run = 0;
          }
        }
        if (run > best) best = run;
        if (best >= 2 * dpr) runs.push(best / dpr);
      }
    }
    runs.sort((a, b) => a - b);
    const median = runs.length > 0 ? runs[Math.floor(runs.length / 2)] : 0;
    const p90 = runs.length > 0 ? runs[Math.floor(runs.length * 0.9)] : 0;
    return { median, p90, runs: runs.length, wave: css };
  })) as { median: number; p90: number; runs: number; wave: string };
}

for (const [name, aspect] of [["16x9", undefined], ["9x16", "9:16"]] as Array<[string, "9:16" | undefined]>) {
  test(`waveform fills the lane height (${name} at 1280 px)`, { skip: missingLiveDemo() }, async () => {
    const dir = copyDemo(aspect);
    const fx = await startLive(dir);
    try {
      const b = await sharedBrowser();
      const page = await b.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(fx.url("/"), { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForFunction(() => (window as any).__tlWaveStats?.ready > 0, { timeout: 90000 });
        // Let the redraw with peak data land.
        await page.waitForFunction(() => (window as any).__tlStats?.draws > 3, { timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1500));
        await page.screenshot({ path: path.join(SHOTS, `wave-${name}.png`) });
        const m = await measureWaveRuns(page);
        console.log(`wave runs ${name}: wave=${m.wave} columns=${m.runs} median=${m.median.toFixed(1)}px p90=${m.p90.toFixed(1)}px`);
        assert.ok(m.runs > 50, `too few waveform columns measured: ${m.runs}`);
        // The cue lane is 34 px high. The old double-margin drawing gave the
        // median peak (~0.30) ~2 px; the full-height drawing gives ~6+ px.
        assert.ok(m.median >= 5, `waveform too flat: median run ${m.median.toFixed(1)}px`);
        assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await stopLive(fx);
      rmRetrySync(dir);
    }
  });
}
