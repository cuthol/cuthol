import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { hyperframesCacheDir } from "../speech/local_engine.js";

const REAL_CHROME_CACHE = path.join(hyperframesCacheDir(), "chrome");

function countProfiles(): number {
  return fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith("cuthol_browser_profile-") || n.startsWith("puppeteer_dev_chrome_profile-"))
    .length;
}

interface IsoHome {
  dir: string;
  restore: () => void;
}

/** Redirects home and the renderer cache into a fresh temp home (no downloads). */
function isolateHome(opts?: { junctionChrome?: boolean }): IsoHome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol browsertest home-"));
  const cache = path.join(dir, ".cache", "hyperframes");
  fs.mkdirSync(cache, { recursive: true });
  if (opts?.junctionChrome) {
    fs.symlinkSync(REAL_CHROME_CACHE, path.join(cache, "chrome"), "junction");
  }
  const prev = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    HYPERFRAMES_CACHE_DIR: process.env.HYPERFRAMES_CACHE_DIR,
    HYPERFRAMES_BROWSER_PATH: process.env.HYPERFRAMES_BROWSER_PATH,
  };
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  process.env.HYPERFRAMES_CACHE_DIR = cache;
  delete process.env.HYPERFRAMES_BROWSER_PATH;
  return {
    dir,
    restore: () => {
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = prev.HOME;
      if (prev.HYPERFRAMES_CACHE_DIR === undefined) delete process.env.HYPERFRAMES_CACHE_DIR;
      else process.env.HYPERFRAMES_CACHE_DIR = prev.HYPERFRAMES_CACHE_DIR;
      if (prev.HYPERFRAMES_BROWSER_PATH === undefined) delete process.env.HYPERFRAMES_BROWSER_PATH;
      else process.env.HYPERFRAMES_BROWSER_PATH = prev.HYPERFRAMES_BROWSER_PATH;
      rmRetrySync(dir);
    },
  };
}

test("browser: shell path is recognized, system chrome is not", async () => {
  const { isHeadlessShellPath } = await import("../compositor/coords_extract.js");
  assert.equal(
    isHeadlessShellPath(
      "C:\\Users\\k\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-152.0.7977.30\\chrome-headless-shell-win64\\chrome-headless-shell.exe"
    ),
    true
  );
  assert.equal(
    isHeadlessShellPath("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
    false
  );
  assert.equal(isHeadlessShellPath("/usr/bin/google-chrome"), false);
});

test("browser: cached path is keyed by home, not reused across homes", async () => {
  const mod = await import("../compositor/coords_extract.js");
  const a = isolateHome({ junctionChrome: true });
  try {
    const exeA = mod.resolveCoordsChromePath();
    assert.ok(exeA.startsWith(a.dir), `first home resolves inside itself: ${exeA}`);
    const b = isolateHome({ junctionChrome: true });
    try {
      const exeB = mod.resolveCoordsChromePath();
      assert.ok(exeB.startsWith(b.dir), `second home resolves inside itself, not stale: ${exeB}`);
    } finally {
      b.restore();
    }
  } finally {
    a.restore();
  }
});

test("browser: isolated home launches the shell and removes its profile", async () => {
  const iso = isolateHome({ junctionChrome: true });
  try {
    const mod = await import("../compositor/coords_extract.js");
    const exe = mod.resolveCoordsChromePath();
    assert.equal(mod.isHeadlessShellPath(exe), true);
    const before = countProfiles();
    const browser = await mod.launchScriptProbeBrowser();
    try {
      const page = await browser.newPage();
      await page.goto("about:blank");
      await page.close();
    } finally {
      await browser.close();
    }
    assert.equal(countProfiles(), before, "temp profile folders are removed after close");
  } finally {
    iso.restore();
  }
});

test("browser: failed launch names the browser, the profile and the fix", async () => {
  const iso = isolateHome();
  const stub = path.join(iso.dir, "chrome-headless-shell.cmd");
  fs.writeFileSync(stub, "@echo off\r\nexit 1\r\n");
  process.env.HYPERFRAMES_BROWSER_PATH = stub;
  try {
    const mod = await import("../compositor/coords_extract.js");
    const before = countProfiles();
    let err: unknown;
    try {
      await mod.launchScriptProbeBrowser();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "launch with a failing binary must throw");
    assert.equal(mod.isBrowserLaunchError(err), true);
    assert.match(err.message, /Browser launch failed/);
    assert.ok(err.message.includes(stub), "message names the browser path");
    assert.ok(err.message.includes("profile"), "message names the profile folder");
    assert.ok(err.message.includes("hyperframes browser ensure"), "message suggests the fix");
    assert.ok(err.message.includes("G780"), "message points at the launch diagnostic");
    assert.equal(countProfiles(), before, "temp profile folders are removed after failure");
  } finally {
    iso.restore();
  }
});

test("browser: launch diagnostics are errors that name the fix", async () => {
  const { DIAGNOSTICS } = await import("../core/diagnostics.js");
  const one = DIAGNOSTICS.BROWSER_LAUNCH_FAILED("cue_01", "browser launch failed: boom");
  assert.equal(one.code, "CUTHOL-G780");
  assert.equal(one.severity, "ERROR");
  assert.ok(one.what.includes("cue_01") && one.what.includes("boom"));
  assert.ok(one.suggestion.includes("hyperframes browser ensure"));
  const many = DIAGNOSTICS.BROWSER_LAUNCH_FAILED_MANY("browser launch failed: boom", [
    "cue_01",
    "cue_02",
  ]);
  assert.equal(many.code, "CUTHOL-G780");
  assert.equal(many.severity, "ERROR");
  const sys = DIAGNOSTICS.BROWSER_SYSTEM_CHROME_ONLY("C:\\Program Files\\x\\chrome.exe");
  assert.equal(sys.code, "CUTHOL-G781");
  assert.equal(sys.severity, "ERROR");
  assert.ok(sys.suggestion.includes("hyperframes browser ensure"));
});

test("browser: explain covers the launch diagnostics", async () => {
  const { CAPTIONS_DOCS } = await import("../explain/docs_captions.js");
  for (const code of ["G780", "G781"]) {
    const doc = CAPTIONS_DOCS.find((d) => d.code === code);
    assert.ok(doc, `explain has ${code}`);
    assert.ok(doc.fix.some((f) => f.includes("hyperframes browser ensure")));
  }
});
