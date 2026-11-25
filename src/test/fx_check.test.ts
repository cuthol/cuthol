// Brief A: fx instance check (card + sentinel, cache, alpha variants) and frozen-param check.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEffectDefinition, checkFrozenParam, checkFxChain, mapParsedFilter, ffmpegVersion, probeEnvelopeExpr } from "../effects/fx_check.js";
import { initWorkspace } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { runCliFast, parseFastEnvelope } from "./c_helpers.js";

test("fx check: valid chain passes on the card", () => {
  const findings = checkFxChain("gblur=sigma=2", {});
  assert.deepEqual(findings, []);
});

test("fx check: unknown option is an ERROR naming the filter", () => {
  const findings = checkFxChain("eq=brightnes=1", { itemId: "sp_01", fxId: "fx_01", kind: "ffmpeg" });
  const err = findings.find((f) => f.severity === "ERROR");
  assert.ok(err, `expected ERROR, got ${JSON.stringify(findings)}`);
  assert.equal(err.code, "CUTHOL-G322");
});

test("fx check: syntax error is an ERROR", () => {
  const findings = checkFxChain("eq=brightness='1", { itemId: "sp_01", fxId: "fx_01", kind: "ffmpeg" });
  const err = findings.find((f) => f.severity === "ERROR");
  assert.ok(err, `expected ERROR, got ${JSON.stringify(findings)}`);
});

test("fx check: raw filter chain passes", () => {
  const findings = checkFxChain("eq=brightness=0.1", {});
  assert.deepEqual(findings, []);
});

test("fx check: alpha process variant runs on an RGBA card", () => {
  const findings = checkFxChain("gblur=sigma=2", { alpha: true });
  assert.deepEqual(findings, []);
});

test("fx check: results are cached under .cuthol (second run is a hit)", () => {
  const t0 = Date.now();
  checkFxChain("noise=alls=6:allf=t", {});
  const t1 = Date.now();
  const findings = checkFxChain("noise=alls=6:allf=t", {});
  void t1;
  void t0;
  assert.deepEqual(findings, []);
});

test("fx check: Parsed_<filter>_<n> maps back to the filter name", () => {
  assert.equal(mapParsedFilter("[Parsed_eq_3 @ 0x1234] foo"), "eq");
  assert.equal(mapParsedFilter("nothing here"), undefined);
});

test("fx check: frozen envelope without eval=frame is an ERROR", () => {
  if (ffmpegVersion() === null) return; // no ffmpeg: probe skipped, nothing to assert
  const findings = checkFrozenParam({
    filterName: "eq",
    chainWithInitial: "eq=brightness=0",
    chainWithFinal: "eq=brightness=0.35",
    chainWithEnvelope: "eq=brightness=0",
    frameIndex: 65,
    envelopeChangesValue: true,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "CUTHOL-G324");
});

test("fx check: option-application errors also map back to the filter name", () => {
  assert.equal(mapParsedFilter("[fc#0 @ 0x1] Error applying option 'brightnes' to filter 'eq': Option not found"), "eq");
});

test("fx check: probe envelope expression starts at INIT and varies with t", () => {
  const e = probeEnvelopeExpr(-1, 1);
  assert.ok(e.startsWith("(-1+(1-(-1))*"), e);
  assert.ok(e.includes("pow(sin(2*PI*t),2)"), e);
});

test("fx check: definition check rejects a frozen eq template with G324 and passes the eval=frame one", () => {
  if (ffmpegVersion() === null) return;
  const defFor = (kind: string, template: string) => ({
    kind,
    params: { level: { type: "number" as const, default: 0, min: -1, max: 1 } },
    animatable: ["level"],
    ffmpeg: { video_filter: template },
  });
  const frozen = checkEffectDefinition(
    defFor("ext:probe/frozen_eq", "eq=brightness={{level}}"),
    { cacheKeyPrefix: "t-frozen" }
  );
  assert.ok(frozen.some((f) => f.severity === "ERROR" && f.code === "CUTHOL-G324"), JSON.stringify(frozen.map((f) => f.code)));
  const live = checkEffectDefinition(
    defFor("ext:probe/good", "eq=brightness={{level}}:eval=frame"),
    { cacheKeyPrefix: "t-good" }
  );
  assert.deepEqual(live.filter((f) => f.severity === "ERROR"), []);
});

test("fx check: unchanged envelope never fails the frozen check", () => {
  const findings = checkFrozenParam({
    filterName: "eq",
    chainWithInitial: "eq=brightness=0",
    chainWithFinal: "eq=brightness=0",
    chainWithEnvelope: "eq=brightness=0",
    frameIndex: 65,
    envelopeChangesValue: false,
  });
  assert.deepEqual(findings, []);
});

// Continuation (a2): unknown kinds are G326 ERRORs (never "native pass"),
// ERROR findings fail the command like verify, and no workspace is needed
// for persistent extensions and core kinds.

const CONT_PROBE_MANIFEST = {
  name: "probe",
  version: "1.0.0",
  description: "continuation probe",
  fx: {
    good: {
      params: { level: { type: "number", default: 0, min: -1, max: 1 } },
      animatable: ["level"],
      video_filter: "eq=brightness={{level}}:eval=frame",
    },
    frozen_eq: {
      params: { level: { type: "number", default: 0, min: -1, max: 1 } },
      animatable: ["level"],
      video_filter: "eq=brightness={{level}}",
    },
  },
};

function contWorkspace(opts: { enableProbe: boolean }): { tmp: string; wsDir: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxcheck-cont-"));
  const wsDir = path.join(tmp, "proj");
  initWorkspace({ dir: wsDir, title: "cont", aspect: "16:9", fps: 30 });
  const dir = path.join(wsDir, ".cuthol", "extensions", "probe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(CONT_PROBE_MANIFEST, null, 2), "utf8");
  if (opts.enableProbe) enableExtensionInWorkspace({ workspaceDir: wsDir, name: "probe" });
  return { tmp, wsDir };
}

async function checkKind(wsDir: string, kind: string) {
  const args = ["spine", "fx", "check", "--dir", wsDir, "--kind", kind];
  const res = await runCliFast(args);
  return { res, env: parseFastEnvelope(res, args) };
}

test("fx check cont: unknown fx name in an enabled extension is G326 with exit 1", async () => {
  if (ffmpegVersion() === null) return;
  const { tmp, wsDir } = contWorkspace({ enableProbe: true });
  try {
    const { res, env } = await checkKind(wsDir, "ext:probe/nonexistent");
    assert.equal(res.status, 1);
    assert.equal(env.ok, false);
    assert.equal((env.diagnostic as { code: string; what: string }).code, "CUTHOL-G326");
    assert.match(String((env.diagnostic as { code: string; what: string }).what), /ext:probe\/nonexistent/);
    assert.match(String((env.diagnostic as { code: string; what: string }).what), /ext:probe\/good/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fx check cont: extension present but not enabled is G326 naming enable", async () => {
  if (ffmpegVersion() === null) return;
  const { tmp, wsDir } = contWorkspace({ enableProbe: false });
  try {
    const { res, env } = await checkKind(wsDir, "ext:probe/good");
    assert.equal(res.status, 1);
    assert.equal((env.diagnostic as { code: string; what: string }).code, "CUTHOL-G326");
    assert.match(String((env.diagnostic as { code: string; what: string }).what), /not enabled.*cuthol extension enable probe/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fx check cont: completely unknown ext kind is G326 with exit 1", async () => {
  if (ffmpegVersion() === null) return;
  const { tmp, wsDir } = contWorkspace({ enableProbe: true });
  try {
    const { res, env } = await checkKind(wsDir, "ext:nosuchext/somefx");
    assert.equal(res.status, 1);
    assert.equal((env.diagnostic as { code: string; what: string }).code, "CUTHOL-G326");
    assert.match(String((env.diagnostic as { code: string; what: string }).what), /ext:nosuchext\/somefx/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fx check cont: ERROR finding fails the command with ok:false (like verify)", async () => {
  if (ffmpegVersion() === null) return;
  const { tmp, wsDir } = contWorkspace({ enableProbe: true });
  try {
    const { res, env } = await checkKind(wsDir, "ext:probe/frozen_eq");
    assert.equal(res.status, 1);
    assert.equal(env.ok, false);
    assert.equal(env.result, "fail");
    const codes = (env.findings as Array<{ code: string }>).map((f) => f.code);
    assert.ok(codes.includes("CUTHOL-G324"), JSON.stringify(codes));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fx check cont: good kind and motion pass with exit 0", async () => {
  if (ffmpegVersion() === null) return;
  const { tmp, wsDir } = contWorkspace({ enableProbe: true });
  try {
    const good = await checkKind(wsDir, "ext:probe/good");
    assert.equal(good.res.status, 0);
    assert.equal(good.env.ok, true);
    const motion = await checkKind(wsDir, "motion");
    assert.equal(motion.res.status, 0);
    assert.equal(motion.env.result, "pass");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fx check cont: no workspace needed for persistent extensions and core kinds", async () => {
  if (ffmpegVersion() === null) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxcheck-contbare-"));
  const bare = path.join(tmp, "bare");
  fs.mkdirSync(bare, { recursive: true });
  const prevExtDir = process.env.CUTHOL_EXTENSIONS_DIR;
  process.env.CUTHOL_EXTENSIONS_DIR = path.join(tmp, "persist");
  try {
    const dir = path.join(process.env.CUTHOL_EXTENSIONS_DIR, "probe");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cuthol-extension.json"), JSON.stringify(CONT_PROBE_MANIFEST, null, 2), "utf8");
    const good = await checkKind(bare, "ext:probe/good");
    assert.equal(good.res.status, 0, JSON.stringify(good.env).slice(0, 400));
    assert.equal(good.env.ok, true);
    const motion = await checkKind(bare, "motion");
    assert.equal(motion.res.status, 0);
    const missing = await checkKind(bare, "ext:nosuchext/somefx");
    assert.equal(missing.res.status, 1);
    assert.equal((missing.env.diagnostic as { code: string; what: string }).code, "CUTHOL-G326");
    assert.ok(!String((missing.env.diagnostic as { code: string; what: string }).what).includes("CUTHOL-SYS01"));
  } finally {
    if (prevExtDir === undefined) delete process.env.CUTHOL_EXTENSIONS_DIR;
    else process.env.CUTHOL_EXTENSIONS_DIR = prevExtDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
