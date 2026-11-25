/**
 * Shader intermediate disk cap (`render.shader_cache_cap_gb`):
 * setting validation plus cap enforcement (under / over / locked file kept /
 * young unused file kept / dead-process sweep). New exports fail on the old
 * build (unknown setting key G620, missing enforcement function).
 */
import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultSettingValue,
  isAgentSettable,
  isSettingKey,
  resolveSetting,
  setSetting,
  settingEnvVar,
  validateSettingValue,
} from "../core/settings.js";
import {
  enforceShaderIntermediateCap,
  listShaderIntermediateFiles,
  SHADER_CACHE_UNUSED_GRACE_MS,
  sweepDeadShaderProcessFiles,
} from "../render/pre_pass.js";

process.env.CUTHOL_SKILLS_AUTO = "0";
process.env.CI = "1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shcap-"));
test.after(() => rmRetrySync(TMP));

function makeBlobs(name: string): string {
  const blobs = path.join(TMP, name, ".cuthol", "blobs");
  fs.rmSync(path.join(TMP, name), { recursive: true, force: true });
  fs.mkdirSync(blobs, { recursive: true });
  return blobs;
}

function writeSized(full: string, bytes: number, ageMs = 0): void {
  fs.writeFileSync(full, Buffer.alloc(bytes, 7));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(full, t, t);
  }
}

test("shader cache cap setting follows live.prewarm_cap_gb", () => {
  assert.ok(isSettingKey("render.shader_cache_cap_gb"));
  assert.equal(defaultSettingValue("render.shader_cache_cap_gb"), 2);
  assert.equal(settingEnvVar("render.shader_cache_cap_gb"), "CUTHOL_SHADER_CACHE_CAP_GB");
  assert.ok(isAgentSettable("render.shader_cache_cap_gb"));
  assert.equal(validateSettingValue("render.shader_cache_cap_gb", 0.05), 0.05);
  assert.equal(validateSettingValue("render.shader_cache_cap_gb", "0.05"), 0.05);
  assert.throws(() => validateSettingValue("render.shader_cache_cap_gb", 0), /G621/);
  assert.throws(() => validateSettingValue("render.shader_cache_cap_gb", -1), /G621/);
  assert.throws(() => validateSettingValue("render.shader_cache_cap_gb", 101), /G621/);
  assert.throws(() => validateSettingValue("render.shader_cache_cap_gb", "huge"), /G621/);
});

test("shader cache cap resolves env > default", () => {
  const prev = process.env.CUTHOL_SHADER_CACHE_CAP_GB;
  process.env.CUTHOL_SHADER_CACHE_CAP_GB = "0.05";
  try {
    assert.equal(resolveSetting(TMP, "render.shader_cache_cap_gb").value, 0.05);
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_SHADER_CACHE_CAP_GB;
    else process.env.CUTHOL_SHADER_CACHE_CAP_GB = prev;
  }
});

test("shader cache cap: project file value is stored and resolved", () => {
  const dir = path.join(TMP, "projsettings");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const prev = process.env.CUTHOL_SETTINGS_FILE;
  const userFile = path.join(TMP, "user-settings.json");
  process.env.CUTHOL_SETTINGS_FILE = userFile;
  try {
    setSetting(dir, "render.shader_cache_cap_gb", 0.05, "agent");
    assert.equal(resolveSetting(dir, "render.shader_cache_cap_gb").value, 0.05);
  } finally {
    if (prev === undefined) delete process.env.CUTHOL_SETTINGS_FILE;
    else process.env.CUTHOL_SETTINGS_FILE = prev;
  }
});

test("enforcement under the cap deletes nothing", () => {
  const blobs = makeBlobs("under");
  const a = path.join(blobs, "sh_fxshad_aaaaaaaaaaaaaaaa.nut");
  const b = path.join(blobs, "sh_fxshad1_c1_bbbbbbbbbbbbbbbb.nut");
  writeSized(a, 1024, 3_600_000);
  writeSized(b, 1024, 3_600_000);
  const r = enforceShaderIntermediateCap(blobs, [a], 2);
  assert.equal(r.deletedCount, 0);
  assert.equal(r.totalBeforeBytes, 2048);
  assert.equal(r.totalAfterBytes, 2048);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test("enforcement over the cap deletes oldest-unused first, then own, until under", () => {
  const blobs = makeBlobs("over");
  const oldUnused = path.join(blobs, "sh_fxshad_aaaaaaaaaaaaaaaa.nut");
  const midUnused = path.join(blobs, "sh_fxshad_bbbbbbbbbbbbbbbb.nut");
  const own = path.join(blobs, "sh_fxshad_cccccccccccccccc.nut");
  writeSized(oldUnused, 1000, 3_600_000);
  writeSized(midUnused, 1000, 1_800_000);
  writeSized(own, 1000);
  // Cap fits two files: the oldest unused file goes, B and C are kept.
  const capGb = 2000 / 1024 ** 3;
  const r = enforceShaderIntermediateCap(blobs, [own], capGb);
  assert.equal(r.deletedCount, 1);
  assert.ok(!fs.existsSync(oldUnused), "oldest unused file deleted");
  assert.ok(fs.existsSync(midUnused), "newer unused file kept");
  assert.ok(fs.existsSync(own), "this render's own file kept");
  assert.ok(r.totalAfterBytes <= 2000);
  // Cap fits nothing: unused go first, then this render's own.
  const r2 = enforceShaderIntermediateCap(blobs, [own], 1 / 1024 ** 3);
  assert.ok(!fs.existsSync(midUnused), "remaining unused file deleted before own");
  assert.ok(!fs.existsSync(own), "own file deleted last when still over");
  assert.equal(r2.totalAfterBytes, 0);
});

test("enforcement keeps producer-locked, read-locked and young unused files", () => {
  const blobs = makeBlobs("locked");
  const locked = path.join(blobs, "sh_fxshad_aaaaaaaaaaaaaaaa.nut");
  const young = path.join(blobs, "sh_fxshad_bbbbbbbbbbbbbbbb.nut");
  const emptylock = path.join(blobs, "sh_fxshad_cccccccccccccccc.nut");
  writeSized(locked, 1000, 3_600_000);
  writeSized(young, 1000);
  writeSized(emptylock, 1000, 3_600_000);
  fs.writeFileSync(`${locked}.lock`, String(process.pid), "utf8");
  fs.writeFileSync(`${young}.read.${process.pid}.lock`, String(process.pid), "utf8");
  fs.writeFileSync(`${emptylock}.lock`, "", "utf8");
  try {
    const r = enforceShaderIntermediateCap(blobs, [], 1 / 1024 ** 3);
    assert.ok(fs.existsSync(locked), "live producer lock protects the file");
    assert.ok(fs.existsSync(young), "young unused file is within grace");
    assert.ok(fs.existsSync(emptylock), "empty lock keeps the file (pre-pass wait rule)");
    assert.equal(r.deletedCount, 0);
    // Age the young file past the grace and drop its read lock: deletable.
    const old = new Date(Date.now() - SHADER_CACHE_UNUSED_GRACE_MS - 1000);
    fs.utimesSync(young, old, old);
    fs.unlinkSync(`${young}.read.${process.pid}.lock`);
    const r2 = enforceShaderIntermediateCap(blobs, [], 2500 / 1024 ** 3);
    assert.ok(!fs.existsSync(young), "aged unlocked file is deleted");
    assert.ok(fs.existsSync(locked), "producer-locked file still kept");
    assert.ok(fs.existsSync(emptylock), "empty-locked file still kept");
    assert.equal(r2.deletedCount, 1);
  } finally {
    for (const f of [`${locked}.lock`, `${young}.read.${process.pid}.lock`, `${emptylock}.lock`]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // already gone
      }
    }
  }
});

test("dead-process tmp/spec/lock leftovers are swept", () => {
  const blobs = makeBlobs("sweep");
  const deadPid = 2 ** 31 - 1;
  const tmp = path.join(blobs, `sh_fxshad_aaaaaaaaaaaaaaaa.nut.${deadPid}.tmp`);
  const spec = `${tmp}.spec.json`;
  const keep = path.join(blobs, "sh_fxshad_bbbbbbbbbbbbbbbb.nut");
  writeSized(tmp, 512);
  fs.writeFileSync(spec, "{}");
  fs.writeFileSync(`${keep}.lock`, String(deadPid), "utf8");
  writeSized(keep, 100, 3_600_000);
  sweepDeadShaderProcessFiles(blobs);
  assert.ok(!fs.existsSync(tmp), "dead tmp swept");
  assert.ok(!fs.existsSync(spec), "dead spec swept");
  assert.ok(!fs.existsSync(`${keep}.lock`), "dead-pid lock swept");
  assert.ok(fs.existsSync(keep), "intermediate itself kept");
  assert.deepEqual(
    listShaderIntermediateFiles(blobs),
    [keep],
    "only .nut intermediates are listed"
  );
});

test("enforcement on a missing blobs dir returns zeros and never throws", () => {
  const missing = path.join(TMP, "no-such-project", ".cuthol", "blobs");
  const r = enforceShaderIntermediateCap(missing, [], 1 / 1024 ** 3);
  assert.equal(r.deletedCount, 0);
  assert.equal(r.totalBeforeBytes, 0);
  assert.equal(r.totalAfterBytes, 0);
});
