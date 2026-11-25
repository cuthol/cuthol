// Tests for the fx sandbox: `spine fx try` picture grid, `spine fx check --full`,
// optional fx manifest fields (`neutral` per param, `temporal`, `cost_class`),
// and the G340
// scanner rule (backslash before the closing quote does not close it, matching ffmpeg).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmRetrySync } from "./fs_cleanup.js";
import { fxTemplateQuoteState } from "../compositor/compile_fx_stage.js";
import { initWorkspace } from "../core/workspace.js";
import { enableExtensionInWorkspace } from "../extensions/ext_lifecycle.js";
import { parseManifestFxSection } from "../extensions/ext_fx.js";
import { checkEffectDefinition } from "../effects/fx_check.js";
import { runFxCheckFull } from "../effects/fx_check_full.js";
import { openFxSandbox, renderSandboxFramesAtTimes, renderSandboxPngs } from "../effects/fx_sandbox.js";
import { parseSweep, runFxTry } from "../effects/fx_try.js";
import { runSpineFxTry } from "../cli_cmd_spine.js";

function withTmp(fn: (tmp: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxd-"));
  try {
    fn(tmp);
  } finally {
    rmRetrySync(tmp);
  }
}

test("sandbox builds a throw-away one-clip project and deletes it", () => {
  withTmp(() => {
    const sb = openFxSandbox({ filter: "gblur=sigma=2" });
    assert.ok(fs.statSync(sb.wsDir).isDirectory());
    assert.ok(fs.statSync(path.join(sb.wsDir, "cuthol.sequence.json")).isFile());
    assert.match(sb.clipId, /^sp_/);
    const dir = sb.dir;
    sb.dispose();
    assert.ok(!fs.existsSync(dir), "sandbox dir is gone after dispose");
  });
});

test("sandbox dispose is idempotent and cleans stale siblings", () => {
  withTmp(() => {
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxsb-"));
    assert.ok(fs.existsSync(stale));
    // Backdate: only dirs older than 10 minutes count as hard-kill leftovers.
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    const sb = openFxSandbox({ filter: "gblur=sigma=2" });
    assert.ok(!fs.existsSync(stale), "stale sandbox from a hard kill is cleaned on open");
    sb.dispose();
    sb.dispose();
  });
});

test("sandbox renders frames through the compiled product plan", () => {
  withTmp((tmp) => {
    const sb = openFxSandbox({ filter: "eq=brightness=0.05:saturation=1.2:eval=frame" });
    try {
      const pngs = renderSandboxPngs(sb, path.join(tmp, "frames"), { frames: 6, fps: 4 });
      assert.ok(pngs.length >= 4, `expected frames, got ${pngs.length}`);
      for (const p of pngs) assert.ok(fs.statSync(p).size > 1000, p);
    } finally {
      sb.dispose();
    }
  });
});

test("try renders a grid with the layout JSON on a tiny sweep", () => {
  withTmp((tmp) => {
    const out = path.join(tmp, "grid.png");
    const res = runFxTry({
      kind: "ext:film-look/soft_focus",
      extDir: { name: "film-look", dir: path.resolve("examples/extensions/film-look") },
      sweep: parseSweep("sigma=0..4:2"),
      at: [0.5, 1.5],
      out,
    });
    assert.ok(fs.statSync(out).size > 1000);
    assert.deepEqual(res.cols, [0.5, 1.5]);
    assert.deepEqual(res.rows, [0, 4]);
    assert.equal(res.sweepParam, "sigma");
    assert.equal(res.cells.length, 4);
    assert.ok(res.costMsPerFrame1080p >= 0);
  });
});

test("fx try --out resolves a relative path against the project folder, not the cwd", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxtry-proj-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-fxtry-cwd-"));
  const prevCwd = process.cwd();
  try {
    initWorkspace({ dir: proj, title: "fxtry-out", aspect: "16:9", fps: 30 });
    process.chdir(elsewhere);
    await runSpineFxTry(proj, { filter: "gblur=sigma=2", at: "0.5,1.5", out: "try-grid.png" });
    assert.ok(fs.statSync(path.join(proj, "try-grid.png")).isFile(), "relative --out lands in the project folder");
    assert.ok(!fs.existsSync(path.join(elsewhere, "try-grid.png")), "relative --out must not land in the cwd");
    assert.ok(!fs.existsSync(path.join(elsewhere, "fxtry-proj-grid.png")));
  } finally {
    process.chdir(prevCwd);
    rmRetrySync(proj);
    rmRetrySync(elsewhere);
  }
});

test("try sweep parsing rejects garbage", () => {
  assert.throws(() => parseSweep("nope"), /--sweep must look like/);
  assert.throws(() => parseSweep("s=a..b"), /--sweep must look like/);
});

function writeNeutExt(tmp: string, neutral: number): { name: string; dir: string } {
  const dir = path.join(tmp, "neut");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cuthol-extension.json"),
    JSON.stringify({
      schema_version: "1.0.0",
      name: "neut",
      version: "1.0.0",
      description: "neutral probe",
      fx: {
        eqb: {
          video_filter: "eq=brightness={{b}}:eval=frame",
          params: { b: { type: "number", default: 0, min: -1, max: 1, neutral } },
        },
      },
    }),
    "utf8"
  );
  return { name: "neut", dir };
}

test("full neutral passes for a truly neutral value, fails for a lying one", () => {
  withTmp((tmp) => {
    const runNeutral = (neutral: number): ReturnType<typeof runFxCheckFull> => {
      // The staged dir is the source of truth; runFxCheckFull takes the validated spec directly.
      const extDir = writeNeutExt(path.join(tmp, `n_${neutral}`), neutral);
      const direct = parseManifestFxSection(
        (JSON.parse(fs.readFileSync(path.join(extDir.dir, "cuthol-extension.json"), "utf8")) as { fx: Record<string, unknown> }).fx,
        "neut"
      )?.eqb;
      assert.ok(direct);
      return runFxCheckFull({ kind: "ext:neut/eqb", spec: direct, extDir });
    };
    const okRes = runNeutral(0);
    const neutralRow = okRes.rows.find((r) => r.check === "neutral");
    assert.ok(neutralRow?.ok, JSON.stringify(neutralRow));
    const lieRes = runNeutral(0.2);
    const lieRow = lieRes.rows.find((r) => r.check === "neutral");
    assert.ok(lieRow && !lieRow.ok, JSON.stringify(lieRow));
    assert.ok(lieRes.findings.some((f) => f.code === "CUTHOL-G347"));
  });
});

test("optional fx fields validate: neutral/temporal/cost_class", () => {
  const parsed = parseManifestFxSection(
    {
      soft: {
        video_filter: "gblur=sigma={{sigma}}",
        params: { sigma: { type: "number", default: 2, min: 0, max: 20, neutral: 0 } },
        temporal: false,
        cost_class: "medium",
      },
    },
    "demo"
  );
  assert.deepEqual(parsed?.soft.neutral, { sigma: 0 });
  assert.equal(parsed?.soft.temporal, false);
  assert.equal(parsed?.soft.cost_class, "medium");
  assert.throws(
    () => parseManifestFxSection({ bad: { video_filter: "gblur=sigma={{s}}", params: { s: { type: "number", neutral: "x" } } } }, "demo"),
    /neutral/
  );
  assert.throws(
    () => parseManifestFxSection({ bad: { video_filter: "gblur=sigma=1", cost_class: "ultra" } }, "demo"),
    /cost_class/
  );
  assert.throws(
    () => parseManifestFxSection({ bad: { video_filter: "gblur=sigma=1", temporal: "yes" } }, "demo"),
    /temporal/
  );
  // Example extensions load unchanged (no new fields required).
  const filmLook = JSON.parse(fs.readFileSync("examples/extensions/film-look/cuthol-extension.json", "utf8")) as {
    fx: Record<string, unknown>;
  };
  const film = parseManifestFxSection(filmLook.fx, "film-look");
  assert.equal(Object.keys(film ?? {}).length, 5);
});

test("G340: backslash is literal inside quotes, escape outside (matches ffmpeg 8.1.1)", () => {
  // Measured: `eq=brightness='0.1\':eval=frame` parses as value `0.1\` + `:eval=frame`
  // ("Invalid chars ':eval=frame' ... expression '0.1:eval=frame'"), and
  // `eq=brightness='0.1\'` alone gives "Invalid chars '\'" — i.e. inside a
  // single-quoted region a backslash does NOT escape, the next `'` still closes it.
  const closed = "eq=brightness='0.1\\':eval=frame";
  assert.equal(fxTemplateQuoteState(closed, closed.length), false);
  const lone = "eq=brightness='0.1\\'";
  assert.equal(fxTemplateQuoteState(lone, lone.length), false);
  // The manifest gate agrees with ffmpeg: no longer rejected as unterminated.
  assert.doesNotThrow(() =>
    parseManifestFxSection({ ok: { video_filter: "eq=brightness='0.1\\':eval=frame" } }, "demo")
  );
  // A truly unterminated region is still rejected.
  assert.equal(fxTemplateQuoteState("eq=brightness='0.1", "eq=brightness='0.1".length), true);
  assert.throws(
    () => parseManifestFxSection({ bad: { video_filter: "eq=brightness='0.1" } }, "demo"),
    /unterminated/
  );
  // Outside quotes a backslash still escapes the next character.
  const escaped = "eq=x\\'y";
  assert.equal(fxTemplateQuoteState(escaped, escaped.length), false);
});

test("definition probe substitution failure is a G322 ERROR, never a raw error", () => {
  const findings = checkEffectDefinition({
    kind: "drawtext-demo",
    params: { label: { type: "string", default: "it's" } },
    animatable: [],
    ffmpeg: { video_filter: "drawtext=text='{{label}}'" },
  });
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.code === "CUTHOL-G322"), JSON.stringify(findings));
  assert.ok(findings[0].message.includes("'label'"));
});

test("frames-at-times spans the whole card (0.5/1.5/2.5 all differ)", () => {
  withTmp((tmp) => {
    const sb = openFxSandbox({ filter: "hue=s=0" });
    try {
      const pngs = renderSandboxFramesAtTimes(sb, path.join(tmp, "times"), [0.5, 1.5, 2.5]);
      assert.equal(pngs.length, 3);
      const bufs = pngs.map((p) => fs.readFileSync(p));
      // The card counter moves, so a whole-card render never repeats a frame.
      assert.ok(!bufs[0].equals(bufs[1]) && !bufs[1].equals(bufs[2]), "times must sample different card moments");
    } finally {
      sb.dispose();
    }
  });
});

test("full envelope check reaches the end value (brightness margin)", () => {
  withTmp((tmp) => {
    const dir = path.join(tmp, "br");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cuthol-extension.json"),
      JSON.stringify({
        schema_version: "1.0.0",
        name: "brenv",
        version: "1.0.0",
        description: "envelope probe",
        fx: {
          lift: {
            video_filter: "eq=brightness={{b}}:eval=frame",
            params: { b: { type: "number", default: 0, min: 0, max: 0.5 } },
            animatable: ["b"],
          },
        },
      }),
      "utf8"
    );
    const direct = parseManifestFxSection(
      (JSON.parse(fs.readFileSync(path.join(dir, "cuthol-extension.json"), "utf8")) as { fx: Record<string, unknown> }).fx,
      "brenv"
    )?.lift;
    assert.ok(direct);
    const res = runFxCheckFull({ kind: "ext:brenv/lift", spec: direct, extDir: { name: "brenv", dir } });
    const row = res.rows.find((r) => r.check === "envelope:b");
    assert.ok(row?.ok, JSON.stringify(row));
    assert.match(row.detail, /start\/mid\/end sampled/);
    const m = /luma \+([0-9.]+) end-vs-start/.exec(row.detail);
    assert.ok(m && Number(m[1]) > 5, `expected a measured brightness margin, got: ${row.detail}`);
  });
});

test("sandbox render failure names exit code, signal, elapsed, timeout and stderr tail", () => {
  withTmp((tmp) => {
    // A bad filter is rejected at add time (G322 probe), so force the render
    // child to fail by removing the card media after the sandbox is built.
    const sb = openFxSandbox({ filter: "gblur=sigma=2" });
    try {
      fs.rmSync(path.join(sb.dir, `${sb.card}.mp4`));
      assert.throws(
        () => renderSandboxPngs(sb, path.join(tmp, "frames"), { frames: 2 }),
        /sandbox render failed: exit=.*signal=.*elapsed=.*timeout=120000ms stderr=.+/s
      );
    } finally {
      sb.dispose();
    }
  });
});

test("sandbox stages a project extension for ext kinds", () => {
  withTmp((tmp) => {
    const wsDir = path.join(tmp, "proj");
    initWorkspace({ dir: wsDir, title: "fxd", aspect: "16:9", fps: 30 });
    const sb = openFxSandbox({
      kind: "ext:film-look/soft_focus",
      params: { sigma: 2 },
      extDirs: [{ name: "film-look", dir: path.resolve("examples/extensions/film-look") }],
    });
    try {
      const pngs = renderSandboxPngs(sb, path.join(tmp, "frames"), { frames: 4, fps: 4 });
      assert.ok(pngs.length >= 2);
    } finally {
      sb.dispose();
    }
    void enableExtensionInWorkspace;
  });
});
