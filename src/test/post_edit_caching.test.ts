/**
 * Post-edit path reuse: the lint key ignores Cuthol-injected bridge tags,
 * older lint cache entries are adopted without re-linting, the
 * command-scoped ledger memo never hides a write, the extension sync memo is
 * keyed by the inputs it reads (bytes changed in place resync), and one MCP
 * server process observes composition edits across calls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectCompositionExtensionCopyDrift,
  syncEnabledExtensionAssetsToComposition,
} from "../compositor/bridge_extension_assets.js";
import { getCompositionDirHashes } from "../compositor/bridge_hash.js";
import {
  computeCompositionLintHashLegacy,
  lintHyperFramesComposition,
  stripInjectedBridgeScriptTags,
} from "../compositor/hf_lint.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import { MediaLedger } from "../library/ledger.js";
import { beginHashCommandScope } from "../core/file_hash_index.js";
import { initWorkspace, resolveWorkspacePaths } from "../core/workspace.js";
import { resolveExtension } from "../extensions/ext_registry.js";
import { CutholMcpServer } from "../mcp/server.js";
import { CutholSequence } from "../core/schema.js";
import { addLaneCue } from "../sequence/lanes.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-post-edit-"));

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function setupProject(name: string): { ws: string; compDir: string } {
  const ws = path.join(TEST_ROOT, name);
  fs.rmSync(ws, { recursive: true, force: true });
  initWorkspace({ dir: ws, title: name, aspect: "16:9", fps: 30 });
  const compDir = path.join(ws, "compositions", "cmp_a");
  scaffoldHyperFramesComposition({
    targetDir: compDir,
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 3000,
    preset: "counter",
    props: {},
    transparent: true,
  });
  const scaffoldIndex = path.join(compDir, "index.html");
  const scaffoldHtml = fs.readFileSync(scaffoldIndex, "utf8");
  fs.writeFileSync(scaffoldIndex, `${scaffoldHtml}\n<!-- ${name} -->`, "utf8");
  addLaneCue({
    workspaceDir: ws,
    laneId: "ln_motion",
    kind: "composition",
    atMs: 0,
    durationMs: 3000,
    composition: {
      composition_dir: "compositions/cmp_a",
      entry_html: "index.html",
      props: {},
      transparent: true,
      mode: "overlay_alpha",
    },
  });
  return { ws, compDir };
}

function injectBridgeTags(html: string): string {
  const dataTag = `<script src="assets/cuthol-data.js"></script>`;
  const runtimeTag = `<script src="assets/cuthol-runtime.js"></script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `    ${dataTag}\n    ${runtimeTag}\n  </head>`);
  }
  return `${dataTag}\n${runtimeTag}\n${html}`;
}

test("injected bridge tags are not authored content for lint", () => {
  const html = [
    "<!DOCTYPE html>",
    "<html><head>",
    '<script src="app.js"></script>',
    "</head><body></body></html>",
    "",
  ].join("\n");
  const stripped = stripInjectedBridgeScriptTags(
    html.replace("</head>", '  <script src="assets/cuthol-data.js"></script>\n    <script src="assets/cuthol-runtime.js"></script>\n    <script src="assets/cuthol-ext-demo.js"></script>\n  </head>')
  );
  assert.ok(!stripped.includes("cuthol-data.js"), "data tag removed");
  assert.ok(!stripped.includes("cuthol-runtime.js"), "runtime tag removed");
  assert.ok(!stripped.includes("cuthol-ext-demo.js"), "helper tag removed");
  assert.ok(stripped.includes('<script src="app.js"></script>'), "authored tag kept");
});

test("lint key survives bridge tag injection but sees a real edit", () => {
  const { ws, compDir } = setupProject("linttags");
  const cacheDir = path.join(ws, ".cuthol", "blobs");
  const indexPath = path.join(compDir, "index.html");
  beginHashCommandScope();
  const before = lintHyperFramesComposition(compDir, "index.html", cacheDir);

  // What the bridge sync writes into every entry HTML on the first edit.
  writeFile(indexPath, injectBridgeTags(fs.readFileSync(indexPath, "utf8")));
  beginHashCommandScope();
  const afterTags = lintHyperFramesComposition(compDir, "index.html", cacheDir);
  assert.equal(
    afterTags.content_hash,
    before.content_hash,
    "bridge tag placement alone must not re-lint the composition"
  );
  assert.equal(afterTags.cached, true, "tag-only change reuses the lint result");

  // A real authored edit still changes the key.
  writeFile(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- authored -->`);
  beginHashCommandScope();
  const afterEdit = lintHyperFramesComposition(compDir, "index.html", cacheDir);
  assert.notEqual(afterEdit.content_hash, before.content_hash, "authored edit is re-linted");
});

test("lint cache written before tag normalization is adopted", () => {
  const { ws, compDir } = setupProject("lintadopt");
  const cacheDir = path.join(ws, ".cuthol", "blobs");
  fs.mkdirSync(cacheDir, { recursive: true });
  // Simulate an older build: lint with tags injected under the legacy key,
  // then present that entry to a fresh entry name the memory cache never saw.
  const indexPath = path.join(compDir, "index.html");
  writeFile(indexPath, injectBridgeTags(fs.readFileSync(indexPath, "utf8")));
  beginHashCommandScope();
  const seeded = lintHyperFramesComposition(compDir, "index.html", cacheDir);
  const page2Path = path.join(compDir, "second.html");
  writeFile(page2Path, fs.readFileSync(indexPath, "utf8"));
  const legacyKey = computeCompositionLintHashLegacy(compDir, "second.html");
  const seededFile = path.join(cacheDir, `hf_lint_${legacyKey.slice(0, 24)}.json`);
  void seededFile;
  const newFiles = fs.readdirSync(cacheDir).filter((n) => n.startsWith("hf_lint_"));
  assert.ok(newFiles.length > 0, "test setup: seed lint wrote a cache file");
  const seedRaw = JSON.parse(
    fs.readFileSync(path.join(cacheDir, newFiles[0]), "utf8")
  ) as Record<string, unknown>;
  seedRaw.content_hash = legacyKey;
  const legacyFile = path.join(cacheDir, `hf_lint_${legacyKey.slice(0, 24)}.json`);
  fs.writeFileSync(legacyFile, JSON.stringify(seedRaw, null, 2), "utf8");
  // Remove any new-keyed file so only the legacy entry can satisfy the lookup.
  for (const n of newFiles) {
    if (path.join(cacheDir, n) !== legacyFile) fs.rmSync(path.join(cacheDir, n));
  }

  beginHashCommandScope();
  const adopted = lintHyperFramesComposition(compDir, "second.html", cacheDir);
  assert.equal(adopted.cached, true, "legacy cache entry is reused without re-linting");
  assert.deepEqual(adopted.findings, seeded.findings, "adopted findings identical");
});

test("ledger latest-transcript memo observes a write in the same command", () => {
  const dir = path.join(TEST_ROOT, "ledgermemo");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ledger = new MediaLedger(path.join(dir, "ledger.sqlite"));
  const digest = "0".repeat(64);
  beginHashCommandScope();
  assert.equal(ledger.getLatestTranscript(digest), null, "empty cache reads null");
  ledger.setTranscript(digest, "en", { words: [{ word: "one" }] });
  const first = ledger.getLatestTranscript<{ words: Array<{ word: string }> }>(digest);
  assert.equal(first?.words?.[0]?.word, "one", "write is visible in the same command");
  // A second read in the same command reuses the memo, and a second write
  // invalidates it: a stale memo would keep returning "one".
  assert.equal(
    ledger.getLatestTranscript<{ words: Array<{ word: string }> }>(digest)?.words?.[0]?.word,
    "one"
  );
  ledger.setTranscript(digest, "en", { words: [{ word: "two" }] });
  assert.equal(
    ledger.getLatestTranscript<{ words: Array<{ word: string }> }>(digest)?.words?.[0]?.word,
    "two",
    "transcript overwritten mid-command must be seen"
  );
  ledger.close();
});

test("extension asset sync repeats share one command and resync on new refs", () => {
  const { ws, compDir } = setupProject("extmemo");
  const paths = resolveWorkspacePaths(ws);
  const seq = { extensions: [], lanes: [], spine: { clips: [] } } as unknown as Parameters<
    typeof syncEnabledExtensionAssetsToComposition
  >[0];

  beginHashCommandScope();
  const first = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  const second = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.deepEqual(second, first, "repeat sync in one command answers identically");

  const fpBefore = getCompositionDirHashes(compDir).fp;
  beginHashCommandScope();
  const third = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.deepEqual(third, first, "next command re-syncs and stays in sync");
  assert.equal(getCompositionDirHashes(compDir).fp, fpBefore, "repeat syncs write nothing");
});

function makeExtensionProject(name: string): { ws: string; compDir: string; extDir: string } {
  const ws = path.join(TEST_ROOT, name);
  fs.rmSync(ws, { recursive: true, force: true });
  writeFile(path.join(ws, "cuthol.sequence.json"), JSON.stringify({ title: name }));
  const extDir = path.join(ws, ".cuthol", "extensions", "kit");
  fs.mkdirSync(path.join(extDir, "assets"), { recursive: true });
  writeFile(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({ name: "kit", version: "1.0.0", description: "kit", helper: "helper.js", assets: "assets" })
  );
  writeFile(path.join(extDir, "helper.js"), "window.__kit = 1;\n");
  writeFile(path.join(extDir, "assets", "logo.txt"), "v1\n");
  const compDir = path.join(ws, "compositions", "cmp");
  fs.mkdirSync(path.join(compDir, "assets"), { recursive: true });
  writeFile(path.join(compDir, "index.html"), "<html></html>\n");
  return { ws, compDir, extDir };
}

function seqWithKit(ws: string): CutholSequence {
  const ext = resolveExtension("kit", ws);
  return {
    extensions: [
      {
        name: ext.name,
        version: ext.version,
        content_hash: ext.contentHash,
        scope: ext.scope,
        enabled_at: new Date().toISOString(),
      },
    ],
    lanes: [],
    spine: { clips: [] },
  } as unknown as CutholSequence;
}

test("extension asset bytes edited in place resync without new refs", () => {
  const { ws, compDir, extDir } = makeExtensionProject("extbytes");
  const paths = resolveWorkspacePaths(ws);
  // The sequence pins the extension exactly once, as a long-lived process
  // would: no re-resolve, no new command generation between the calls below.
  const seq = seqWithKit(ws);
  const helperCopy = path.join(compDir, "assets", "cuthol-ext-kit.js");
  const assetCopy = path.join(compDir, "assets", "ext", "kit", "logo.txt");

  const seed = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(seed.updatedFiles.includes("assets/cuthol-ext-kit.js"), "seed copies the helper");
  assert.equal(fs.readFileSync(assetCopy, "utf8"), "v1\n");

  // Same pinned refs, changed bytes on disk: a generation-keyed memo would
  // return the seed answer and never copy the new bytes.
  writeFile(path.join(extDir, "helper.js"), "window.__kit = 2;\n// bump\n");
  writeFile(path.join(extDir, "assets", "logo.txt"), "v2222\n");
  const refreshed = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(
    refreshed.updatedFiles.includes("assets/cuthol-ext-kit.js"),
    "changed helper is recopied without new refs"
  );
  assert.ok(refreshed.updatedFiles.includes("assets/ext/kit/logo.txt"), "changed asset is recopied");
  assert.ok(fs.readFileSync(helperCopy, "utf8").includes("window.__kit = 2;"));
  assert.equal(fs.readFileSync(assetCopy, "utf8"), "v2222\n");
  assert.equal(
    detectCompositionExtensionCopyDrift(seq, "kit", paths).drifted,
    false,
    "copies match the edited extension again"
  );
});

function mcpText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

test("one MCP server process sees composition edits across calls", async () => {
  const { ws, compDir } = setupProject("mcpchanges");
  const indexPath = path.join(compDir, "index.html");
  const server = new CutholMcpServer();

  const opened = await server.callTool("workspace", { action: "open", dir: ws });
  assert.equal(opened.isError, false, `workspace.open failed: ${mcpText(opened).slice(0, 300)}`);

  const baseline = await server.callTool("workspace", { action: "changes_show", dir: ws });
  assert.equal(baseline.isError, false, `changes_show failed: ${mcpText(baseline).slice(0, 300)}`);
  assert.match(mcpText(baseline), /no .*change|up to date|nothing/i, "clean tree shows no changes");

  // Case 1: different size.
  writeFile(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- mcp edit one -->\n`);
  const afterBigger = await server.callTool("workspace", { action: "changes_show", dir: ws });
  assert.equal(afterBigger.isError, false);
  const textBigger = mcpText(afterBigger);
  assert.ok(!/no .*change|up to date|nothing/i.test(textBigger), "grown file is reported changed");
  assert.ok(textBigger.includes("cmp_a"), "changed composition is named");

  // Case 2: same size, mtime within the same second: replace bytes in place.
  const current = fs.readFileSync(indexPath, "utf8");
  const marker = "<!-- mcp edit one -->";
  assert.ok(current.includes(marker), "test setup: first edit present");
  const sameSize = current.replace(marker, "<!-- mcp EDIT two -->");
  assert.equal(sameSize.length, current.length, "test setup: replacement keeps the size");
  writeFile(indexPath, sameSize);
  const afterSameSize = await server.callTool("workspace", { action: "changes_show", dir: ws });
  assert.equal(afterSameSize.isError, false);
  const textSameSize = mcpText(afterSameSize);
  assert.ok(!/no .*change|up to date|nothing/i.test(textSameSize), "same-size edit is reported changed");
  assert.notEqual(textSameSize, textBigger, "second edit yields a new change set, not a stale repeat");
});
