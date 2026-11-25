/**
 * Live shader window (`src/test/live_shader_window.test.ts`): a shader clip
 * paints the window's `pv-shader` canvas (pixels change with the shader, the
 * badge stays hidden, disable/enable updates without a reload), and a
 * `.glsl` file that is broken after enable-time (a `vec4(vec2, float)`
 * constructor has only 3 components, so no compiler accepts it) falls back
 * to the unshaded video with a visible notice naming the fx and the log
 * line (`[CUTHOL-G732]`).
 */
import "../test/test_setup.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveCoordsChromePath } from "../compositor/coords_extract.js";
import { initWorkspace } from "../core/workspace.js";
import { ingestAssetsIntoWorkspace } from "../library/probe.js";
import { appendSpineClip } from "../sequence/spine_edit.js";
import { addSpineFx } from "../sequence/spine_fx.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { rmRetrySync, waitFor } from "./b_helpers.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const CLI = path.join(REPO, "dist", "cli.js");

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-shader-win-"));
after(() => rmRetrySync(ROOT));

const GRAD = `vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return vec4(uv.x, uv.y, 0.0, 1.0); }
`;
// Passes the API probe (balanced, declared) but has no ANGLE constructor.
const BAD = `vec4 getInput(vec2 uv);
uniform float time;
vec4 effect(vec2 uv) { return vec4(uv, 0.0); }
`;

function media(outPath: string): void {
  if (fs.existsSync(outPath)) return;
  const proc = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
    "-i", "testsrc2=size=320x180:rate=30:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outPath],
    { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  assert.equal(proc.status, 0, `ffmpeg failed: ${proc.stderr ?? proc.error}`);
}

function cli(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    timeout: 120000,
  });
  return { status: proc.status ?? 1, stdout: String(proc.stdout ?? ""), stderr: String(proc.stderr ?? "") };
}

function makeWs(name: string): { wsDir: string; clipA: string; clipB: string; extDir: string } {
  const wsDir = path.join(ROOT, name);
  rmRetrySync(wsDir);
  const src = path.join(ROOT, "src.mp4");
  media(src);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [src] });
  const a = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 4000 });
  const b = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 4000 });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shwin");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "shaders", "grad.glsl"), GRAD);
  fs.writeFileSync(path.join(extDir, "cuthol-extension.json"), JSON.stringify({
    name: "shwin", version: "1.0.0", description: "window proof",
    fx: {
      grad: { description: "gradient", backend: "shader", shader: "shaders/grad.glsl" },
    },
  }));
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shwin" });
  return { wsDir, clipA: a.clip.id, clipB: b.clip.id, extDir };
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
  if (sharedBrowser) await sharedBrowser.close().catch(() => {});
});

async function startServer(dir: string): Promise<{ proc: ChildProcess; pid: number; url: string; q: (p: string) => string }> {
  const proc = spawn(process.execPath, [CLI, "live", "serve", "--dir", dir], {
    env: { ...process.env, CUTHOL_SKILLS_AUTO: "0" },
    stdio: "ignore",
    windowsHide: true,
  });
  const serverFile = path.join(dir, ".cuthol", "live", "server.json");
  await waitFor(() => fs.existsSync(serverFile), 30000, "live server.json");
  const info = JSON.parse(fs.readFileSync(serverFile, "utf8")) as { port: number; token: string; pid: number };
  const base = `http://127.0.0.1:${info.port}`;
  return {
    proc, pid: info.pid, url: `${base}/?t=${info.token}`,
    q: (p: string) => `${base}${p}${p.includes("?") ? "&" : "?"}t=${info.token}`,
  };
}

async function stopServer(srv: { proc: ChildProcess; pid: number }, dir: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 });
    } else srv.proc.kill("SIGKILL");
  } catch {}
  try { srv.proc.kill("SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 800));
}

async function openPage(url: string): Promise<{ page: Page; errors: string[] }> {
  const page = await sharedBrowser!.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => (window as any).__livePreview, { timeout: 30000 });
  await page.waitForFunction(() => ((window as any).__livePreview.state().duration ?? 0) > 0, { timeout: 30000 });
  return { page, errors };
}

/** Mean red of the left vs right third of the pv-shader canvas (uv.x gradient). */
async function gradientHalves(page: Page): Promise<{ left: number; right: number } | null> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.pv-shader") as HTMLCanvasElement | null;
    if (!c || !c.width) return null;
    if ((c as any).style?.visibility === "hidden") return null;
    const d = document.createElement("canvas");
    d.width = 60; d.height = 20;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0, 60, 20);
    const px = g.getImageData(0, 0, 60, 20).data;
    let l = 0, r = 0;
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 60; x++) {
        const v = px[(y * 60 + x) * 4];
        if (x < 20) l += v; else if (x >= 40) r += v;
      }
    }
    return { left: l / 400, right: r / 400 };
  });
}

const MIXR = `vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return mix(getInput(uv), vec4(1.0, 0.0, 0.0, 1.0), 0.5); }
`;
const MIXB = `vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) { return mix(getInput(uv), vec4(0.0, 0.0, 1.0, 1.0), 0.5); }
`;

function makeOrderWs(name: string): { wsDir: string; clip: string } {
  const wsDir = path.join(ROOT, name);
  rmRetrySync(wsDir);
  const src = path.join(ROOT, "src.mp4");
  media(src);
  initWorkspace({ dir: wsDir, title: name, aspect: "16:9", fps: 30 });
  const [item] = ingestAssetsIntoWorkspace({ workspaceDir: wsDir, filePaths: [src] });
  const a = appendSpineClip({ workspaceDir: wsDir, assetHandle: item.handle, sourceInMs: 0, sourceOutMs: 4000 });
  const extDir = path.join(wsDir, ".cuthol", "extensions", "shord");
  fs.mkdirSync(path.join(extDir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "shaders", "mixr.glsl"), MIXR);
  fs.writeFileSync(path.join(extDir, "shaders", "mixb.glsl"), MIXB);
  fs.writeFileSync(path.join(extDir, "cuthol-extension.json"), JSON.stringify({
    name: "shord", version: "1.0.0", description: "order proof",
    fx: {
      mixr: { description: "red mix", backend: "shader", shader: "shaders/mixr.glsl" },
      mixb: { description: "blue mix", backend: "shader", shader: "shaders/mixb.glsl" },
    },
  }));
  enableExtensionInWorkspace({ workspaceDir: wsDir, name: "shord" });
  return { wsDir, clip: a.clip.id };
}

/** Downscaled mean red/blue of the pv-shader canvas, plus pixels for order comparison. */
async function shaderMeans(page: Page): Promise<{ r: number; b: number; px: number[] } | null> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.pv-shader") as HTMLCanvasElement | null;
    if (!c || !c.width) return null;
    if ((c as any).style?.visibility === "hidden") return null;
    const d = document.createElement("canvas");
    d.width = 96; d.height = 54;
    const g = d.getContext("2d")!;
    g.drawImage(c, 0, 0, 96, 54);
    const px = g.getImageData(0, 0, 96, 54).data;
    let r = 0, b = 0;
    const n = 96 * 54;
    for (let i = 0; i < n; i++) { r += px[i * 4]; b += px[i * 4 + 2]; }
    return { r: r / n, b: b / n, px: Array.from(px) };
  });
}

function meanAbs(a: number[], b: number[]): number {
  const n = a.length / 4;
  let s = 0;
  for (let i = 0; i < n; i++) s += (Math.abs(a[i * 4] - b[i * 4]) + Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + Math.abs(a[i * 4 + 2] - b[i * 4 + 2])) / 3;
  return s / n;
}

async function shaderCanvasVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.pv-shader") as HTMLCanvasElement | null;
    return !!c && (c as any).style.visibility !== "hidden" && c.width > 0;
  });
}

test("live shader: gradient clip paints the canvas, disable/enable updates without reload", { timeout: 300000 }, async (t) => {
  const { wsDir, clipA } = makeWs("paint");
  const fx = addSpineFx({ workspaceDir: wsDir, item: clipA, kind: "ext:shwin/grad" }).fx;
  const srv = await startServer(wsDir);
  try {
    t.after(() => stopServer(srv, wsDir));
    const { page } = await openPage(srv.url);
    try {
      t.after(() => page.close().catch(() => {}));
      await page.evaluate((ms: number) => (window as any).__livePreview.seek(ms), 2000);
      const halves = await waitFor(async () => {
        const h = await gradientHalves(page);
        return h && h.right - h.left > 40 ? h : null;
      }, 60000, "gradient canvas halves");
      assert.ok(halves.right > halves.left + 40, `red rises left to right (got ${halves.left}/${halves.right})`);
      const badgeHidden = await page.evaluate(() => (document.querySelector(".pv-badge") as HTMLElement).hidden);
      assert.equal(badgeHidden, true, "shader-only clip shows no Approximate badge");
      // Disable through the real CLI: the server pushes the delta, no reload.
      const off = cli(wsDir, ["spine", "fx", "set", "--item", clipA, "--fx", fx.id, "--enabled", "false"]);
      assert.equal(off.status, 0, `disable failed: ${off.stderr.slice(0, 300)}`);
      await waitFor(async () => !(await shaderCanvasVisible(page)), 60000, "canvas removed after disable");
      const re = cli(wsDir, ["spine", "fx", "set", "--item", clipA, "--fx", fx.id, "--enabled", "true"]);
      assert.equal(re.status, 0, `re-enable failed: ${re.stderr.slice(0, 300)}`);
      await page.evaluate((ms: number) => (window as any).__livePreview.seek(ms), 2000);
      const back = await waitFor(async () => {
        const h = await gradientHalves(page);
        return h && h.right - h.left > 40 ? h : null;
      }, 60000, "gradient canvas after re-enable");
      assert.ok(back, "canvas repaints after re-enable without reload");
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await stopServer(srv, wsDir);
  }
});

test("live shader: broken compile shows the notice and the unshaded video", { timeout: 300000 }, async (t) => {
  const { wsDir, clipA, extDir } = makeWs("broken");
  const fx = addSpineFx({ workspaceDir: wsDir, item: clipA, kind: "ext:shwin/grad" }).fx;
  // Break the .glsl after enable-time (which already passed): the Live
  // window compiles it at runtime and must fall back with a notice.
  fs.writeFileSync(path.join(extDir, "shaders", "grad.glsl"), BAD);
  const srv = await startServer(wsDir);
  try {
    t.after(() => stopServer(srv, wsDir));
    const { page } = await openPage(srv.url);
    try {
      t.after(() => page.close().catch(() => {}));
      await page.evaluate((ms: number) => (window as any).__livePreview.seek(ms), 2000);
      const notice = await waitFor(async () => {
        const txt = await page.evaluate(() => {
          const el = document.querySelector(".pv-badge") as HTMLElement | null;
          return el && !el.hidden ? el.textContent : null;
        });
        return txt && /CUTHOL-G732/.test(txt) ? txt : null;
      }, 60000, "shader failure notice");
      const text = await page.evaluate(() => (document.querySelector(".pv-badge") as HTMLElement).textContent ?? "");
      assert.match(text, new RegExp(fx.id), "notice names the fx");
      assert.match(text, /CUTHOL-G732/, "notice carries the diagnostic code");
      await waitFor(async () => !(await shaderCanvasVisible(page)), 60000, "no shaded canvas on compile failure");
      assert.equal(await shaderCanvasVisible(page), false, "no shaded canvas on compile failure");
      const videoVisible = await waitFor(async () => {
        const vis = await page.evaluate(() => {
          const vs = [...document.querySelectorAll("video.pv-video")] as HTMLVideoElement[];
          return vs.some((v) => (v as any).style.visibility !== "hidden" && v.videoWidth > 0);
        });
        return vis ? true : null;
      }, 60000, "unshaded video stays visible");
      assert.equal(videoVisible, true, "unshaded video stays visible");
      void notice;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await stopServer(srv, wsDir);
  }
});

test("live shader: two-shader chain applies both passes in order", { timeout: 300000 }, async (t) => {
  // mixr then mixb vs mixb then mixr: the orders must differ, and each order
  // must carry both tints (a dropped first pass would leave only the second).
  const { wsDir, clip } = makeOrderWs("order");
  let f1 = addSpineFx({ workspaceDir: wsDir, item: clip, kind: "ext:shord/mixr" }).fx;
  let f2 = addSpineFx({ workspaceDir: wsDir, item: clip, kind: "ext:shord/mixb" }).fx;
  const srv = await startServer(wsDir);
  try {
    t.after(() => stopServer(srv, wsDir));
    const { page } = await openPage(srv.url);
    try {
      t.after(() => page.close().catch(() => {}));
      await page.evaluate((ms: number) => (window as any).__livePreview.seek(ms), 2000);
      const rb = await waitFor(async () => {
        const m = await shaderMeans(page);
        return m && m.b - m.r > 40 && m.r > 75 ? m : null;
      }, 60000, "chained canvas paints");
      assert.ok(rb.b - rb.r > 40, `red-then-blue is blue-dominant (R=${rb.r} B=${rb.b})`);
      assert.ok(rb.r > 75, `red-then-blue still carries red from the first pass (R=${rb.r})`);
      let rm = cli(wsDir, ["spine", "fx", "remove", "--item", clip, "--fx", f1.id]);
      assert.equal(rm.status, 0, `remove failed: ${rm.stderr.slice(0, 300)}`);
      rm = cli(wsDir, ["spine", "fx", "remove", "--item", clip, "--fx", f2.id]);
      assert.equal(rm.status, 0, `remove failed: ${rm.stderr.slice(0, 300)}`);
      await page.evaluate((ms: number) => (window as any).__livePreview.seek(ms), 2000);
      await waitFor(async () => !(await shaderCanvasVisible(page)), 60000, "canvas removed");
      f1 = addSpineFx({ workspaceDir: wsDir, item: clip, kind: "ext:shord/mixb" }).fx;
      f2 = addSpineFx({ workspaceDir: wsDir, item: clip, kind: "ext:shord/mixr" }).fx;
      await page.evaluate((ms: number) => (window as any).__livePreview.seek(ms), 2000);
      const br = await waitFor(async () => {
        const m = await shaderMeans(page);
        return m && m.r - m.b > 40 && m.b > 75 ? m : null;
      }, 60000, "reversed chain paints");
      assert.ok(br.r - br.b > 40, `blue-then-red is red-dominant (R=${br.r} B=${br.b})`);
      assert.ok(br.b > 75, `blue-then-red still carries blue from the first pass (B=${br.b})`);
      assert.ok(meanAbs(rb.px, br.px) > 25, `the two orders differ (mean abs ${meanAbs(rb.px, br.px)})`);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await stopServer(srv, wsDir);
  }
});
