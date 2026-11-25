/**
 * Shared composition file-hash cache: one read per file per command, a
 * persisted project index across commands, and counter-tests proving no
 * caching hides a real change.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashExtensionDirectory } from "../extensions/ext_registry.js";
import { syncEnabledExtensionAssetsToComposition } from "../compositor/bridge_extension_assets.js";
import { getCompositionDirHashes } from "../compositor/bridge_hash.js";
import { lintHyperFramesComposition } from "../compositor/hf_lint.js";
import { scaffoldHyperFramesComposition } from "../compositor/hyperframes_bridge.js";
import {
  beginHashCommandScope,
  clearInMemoryFileHashes,
  findProjectRoot,
  flushFileHashIndex,
  hashFileContent,
} from "../core/file_hash_index.js";
import { initWorkspace, resolveWorkspacePaths } from "../core/workspace.js";
import { addLaneCue } from "../sequence/lanes.js";
import { runWorkspaceVerification } from "../verify/gates.js";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-hash-cache-"));

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
  // Unique bytes per test project: content-keyed process caches (lint,
  // usage) must not leak results between tests sharing one process.
  // The gsap script tag keeps the scaffold page runnable so verification
  // reports no script error (the bridge sync provides the bundled copy).
  const scaffoldIndex = path.join(compDir, "index.html");
  const scaffoldHtml = fs.readFileSync(scaffoldIndex, "utf8");
  const withGsap = scaffoldHtml.includes("assets/gsap.min.js")
    ? scaffoldHtml
    : scaffoldHtml.replace(/<\/head>/i, '    <script src="assets/gsap.min.js"></script>\n  </head>');
  fs.writeFileSync(scaffoldIndex, `${withGsap}\n<!-- ${name} -->`, "utf8");
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

function countLintFiles(ws: string): number {
  const blobs = path.join(ws, ".cuthol", "blobs");
  if (!fs.existsSync(blobs)) return 0;
  return fs.readdirSync(blobs).filter((n) => n.startsWith("hf_lint_")).length;
}

test("file hash is shared and re-reads on size or mtime change", () => {
  beginHashCommandScope();
  const dir = path.join(TEST_ROOT, "basic");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.txt");
  writeFile(f, "x".repeat(100));
  const h1 = hashFileContent(f);
  assert.ok(h1);
  assert.equal(hashFileContent(f), h1, "same command reuses the hash");

  writeFile(f, "y".repeat(200));
  const h2 = hashFileContent(f);
  assert.notEqual(h2, h1, "size change is re-read");

  writeFile(f, "z".repeat(200));
  const h3 = hashFileContent(f);
  assert.notEqual(h3, h2, "same-size content change is re-read through the mtime");
});

test("a forged size+mtime edit between two calls in one process is seen", () => {
  beginHashCommandScope();
  const dir = path.join(TEST_ROOT, "forged");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.txt");
  writeFile(f, "a".repeat(64));
  // Normalize to whole-millisecond timestamps: utimesSync cannot restore
  // sub-millisecond fractions, so an exact forgery needs a whole-ms base.
  const base = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(f, base, base);
  const before = hashFileContent(f);
  assert.ok(before);
  const st = fs.statSync(f);
  assert.equal(st.mtimeMs % 1, 0, "test setup: whole-ms mtime");

  // New command generation, same process: overwrite with different bytes,
  // then restore the exact size and the exact mtime.
  beginHashCommandScope();
  writeFile(f, "b".repeat(64));
  fs.utimesSync(f, st.atime, st.mtime);
  const after = fs.statSync(f);
  assert.equal(after.size, st.size, "test setup: size forged");
  assert.equal(after.mtimeMs, st.mtimeMs, "test setup: mtime forged");
  assert.notEqual(hashFileContent(f), before, "forged edit must be seen in the next call");
});

test("persisted index reuses hashes and detects second-precision mtime forgery", () => {
  const ws = path.join(TEST_ROOT, "persisted");
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  writeFile(path.join(ws, "cuthol.sequence.json"), '{"meta":{"revision":1}}');
  const f = path.join(ws, "sub", "a.txt");
  writeFile(f, "q".repeat(128));

  beginHashCommandScope();
  const h1 = hashFileContent(f);
  assert.ok(h1);
  assert.equal(findProjectRoot(f), path.resolve(ws));
  flushFileHashIndex();
  assert.ok(fs.existsSync(path.join(ws, ".cuthol", "file-hash-index.json")), "index persisted in the project");

  // Simulate a fresh process: drop all memory, open a new command scope.
  clearInMemoryFileHashes();
  beginHashCommandScope();
  assert.equal(hashFileContent(f), h1, "persisted hash reused across processes");

  // Same size, mtime restored to the same second (truncated ms): detected.
  const st = fs.statSync(f);
  writeFile(f, "r".repeat(128));
  const truncated = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
  fs.utimesSync(f, truncated, truncated);
  clearInMemoryFileHashes();
  beginHashCommandScope();
  assert.notEqual(hashFileContent(f), h1, "second-precision mtime forgery is detected");
});

test("composition dir hash changes on index.html edit and is stable otherwise", () => {
  const { compDir } = setupProject("dirhash");
  beginHashCommandScope();
  const a = getCompositionDirHashes(compDir);
  beginHashCommandScope();
  const b = getCompositionDirHashes(compDir);
  assert.equal(b.filesHash, a.filesHash, "untouched composition hash is stable");

  const indexPath = path.join(compDir, "index.html");
  writeFile(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- edit -->`);
  beginHashCommandScope();
  const c = getCompositionDirHashes(compDir);
  assert.notEqual(c.filesHash, a.filesHash, "index.html edit changes the composition hash");
});

test("lint key is stable for untouched compositions and changes on edit", () => {
  const { ws, compDir } = setupProject("lintkey");
  const cacheDir = path.join(ws, ".cuthol", "blobs");
  beginHashCommandScope();
  const first = lintHyperFramesComposition(compDir, "index.html", cacheDir);
  beginHashCommandScope();
  const second = lintHyperFramesComposition(compDir, "index.html", cacheDir);
  assert.equal(second.content_hash, first.content_hash, "untouched composition keeps its lint key");
  assert.equal(second.cached, true, "untouched composition reuses the lint result");
  assert.deepEqual(second.findings, first.findings, "lint output identical");

  const indexPath = path.join(compDir, "index.html");
  writeFile(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- edit -->`);
  beginHashCommandScope();
  const third = lintHyperFramesComposition(compDir, "index.html", cacheDir);
  assert.notEqual(third.content_hash, first.content_hash, "edited composition is re-linted");
  assert.deepEqual(third.findings, first.findings, "lint findings unchanged by the comment edit");
});

test("enabled extension asset edit is copied again", () => {
  const { ws, compDir } = setupProject("extcopy");
  const extDir = path.join(ws, ".cuthol", "extensions", "tcopy");
  fs.mkdirSync(path.join(extDir, "assets"), { recursive: true });
  writeFile(
    path.join(extDir, "cuthol-extension.json"),
    JSON.stringify({ name: "tcopy", version: "1.0.0", description: "t", helper: "helper.js", assets: "assets" })
  );
  writeFile(path.join(extDir, "helper.js"), "window.__t = 1;\n");
  writeFile(path.join(extDir, "assets", "data.txt"), "v1");

  const paths = resolveWorkspacePaths(ws);
  const extRef = {
    name: "tcopy",
    version: "1.0.0",
    content_hash: hashExtensionDirectory(extDir),
    scope: "project" as const,
    enabled_at: new Date().toISOString(),
  };
  const seq = {
    extensions: [extRef],
    lanes: [],
    spine: { clips: [] },
  } as unknown as Parameters<typeof syncEnabledExtensionAssetsToComposition>[0];

  beginHashCommandScope();
  const first = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(first.updated, "first sync copies the assets");
  assert.ok(
    fs.readFileSync(path.join(compDir, "assets", "ext", "tcopy", "data.txt"), "utf8") === "v1",
    "asset copied"
  );
  beginHashCommandScope();
  const second = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.equal(second.updated, false, "in-sync copies write nothing");

  const before = hashExtensionDirectory(extDir);
  writeFile(path.join(extDir, "assets", "data.txt"), "v2");
  assert.notEqual(hashExtensionDirectory(extDir), before, "extension content hash sees the edit");
  extRef.content_hash = hashExtensionDirectory(extDir);
  beginHashCommandScope();
  const third = syncEnabledExtensionAssetsToComposition(seq, compDir, "index.html", paths);
  assert.ok(third.updated, "edited extension asset is copied again");
  assert.equal(
    fs.readFileSync(path.join(compDir, "assets", "ext", "tcopy", "data.txt"), "utf8"),
    "v2",
    "copy carries the new bytes"
  );
});

test("same-size library replace is detected; deleted asset changes the fingerprint", () => {
  const { compDir } = setupProject("libreplace");
  beginHashCommandScope();
  const media = path.join(compDir, "assets", "clip.bin");
  writeFile(media, "0".repeat(4096));
  // Distinct explicit mtimes: back-to-back writes can share a millisecond,
  // and identical stats are indistinguishable for any stat-based cache.
  // A real replace always advances the mtime.
  const t1 = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(media, t1, t1);
  const h1 = hashFileContent(media);
  writeFile(media, "1".repeat(4096));
  const t2 = new Date(t1.getTime() + 1000);
  fs.utimesSync(media, t2, t2);
  const h2 = hashFileContent(media);
  assert.notEqual(h2, h1, "same-size replace with new mtime is detected");
  const fpBefore = getCompositionDirHashes(compDir).fp;
  fs.rmSync(media);
  assert.equal(hashFileContent(media), null, "deleted file has no hash");
  beginHashCommandScope();
  assert.notEqual(getCompositionDirHashes(compDir).fp, fpBefore, "deleted asset changes the fingerprint");
});

test("one MCP server process sees composition edits across two calls", async () => {
  const { ws } = setupProject("mcpcalls");
  const { CutholMcpServer } = await import("../mcp/server.js");
  const mcp = new CutholMcpServer();
  const verify = async (): Promise<void> => {
    const res = await mcp.callTool("verify", { dir: ws });
    assert.equal(res.isError, false, JSON.stringify(res).slice(0, 400));
  };
  const indexPath = path.join(ws, "compositions", "cmp_a", "index.html");

  await verify();
  const n1 = countLintFiles(ws);
  assert.ok(n1 > 0, "first MCP verify lints the composition");

  // Sub-case 1: different-size edit between the calls.
  writeFile(indexPath, `${fs.readFileSync(indexPath, "utf8")}\n<!-- mcp-a -->`);
  await verify();
  const n2 = countLintFiles(ws);
  assert.ok(n2 > n1, "second MCP verify re-lints the changed composition");

  // Sub-case 2: same size, mtime restored to the same second. The unique
  // setup comment is replaced in place, keeping valid HTML so verification
  // stays green.
  const base = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(indexPath, base, base);
  const original = fs.readFileSync(indexPath, "utf8");
  assert.ok(original.includes("<!-- mcpcalls -->"), "test setup: unique marker present");
  const forged = original.replace("<!-- mcpcalls -->", `<!-- ${"f".repeat(8)} -->`);
  assert.equal(Buffer.byteLength(forged), Buffer.byteLength(original), "test setup: same size");
  fs.writeFileSync(indexPath, forged, "utf8");
  const st = fs.statSync(indexPath);
  const truncated = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
  fs.utimesSync(indexPath, truncated, truncated);
  await verify();
  assert.ok(
    countLintFiles(ws) > n2,
    "third MCP verify re-lints the same-size same-mtime composition instead of reusing the stale key"
  );
});

test("two verifications in one process see a forged composition edit", () => {
  const { ws } = setupProject("twocalls");
  beginHashCommandScope();
  runWorkspaceVerification(ws);
  const lintBefore = countLintFiles(ws);
  assert.ok(lintBefore > 0, "first verify lints the composition");

  // Forged external edit: different bytes, same size, exact same mtime
  // (whole-ms base, since utimesSync cannot restore sub-ms fractions).
  // The unique setup comment is replaced in place, keeping valid HTML so
  // verification stays green.
  const indexPath = path.join(ws, "compositions", "cmp_a", "index.html");
  const base = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(indexPath, base, base);
  const original = fs.readFileSync(indexPath, "utf8");
  assert.ok(original.includes("<!-- twocalls -->"), "test setup: unique marker present");
  const forged = original.replace("<!-- twocalls -->", `<!-- ${"f".repeat(8)} -->`);
  assert.equal(Buffer.byteLength(forged), Buffer.byteLength(original), "test setup: same size");
  fs.writeFileSync(indexPath, forged, "utf8");
  const st = fs.statSync(indexPath);
  fs.utimesSync(indexPath, base, base);
  const check = fs.statSync(indexPath);
  assert.equal(check.size, st.size);
  assert.equal(check.mtimeMs, base.getTime());

  beginHashCommandScope();
  runWorkspaceVerification(ws);
  assert.ok(
    countLintFiles(ws) > lintBefore,
    "second verify re-lints the forged composition instead of reusing the stale key"
  );
});
