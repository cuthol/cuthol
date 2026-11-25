import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compositionReferencesSharedAssets,
  syncSharedProjectAssetsToComposition,
} from "../compositor/bridge_extension_assets.js";
import { hashCompositionFilesExcludingBridgeData } from "../compositor/bridge_hash.js";
import type { WorkspacePaths } from "../core/workspace.js";

function makeProject(): { root: string; paths: WorkspacePaths } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-shared-"));
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared", "style.css"), ".card{color:red}\n");
  return { root, paths: { rootDir: root } as WorkspacePaths };
}

function makeComp(root: string, name: string, referencesShared: boolean): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  const link = referencesShared
    ? `<link rel="stylesheet" href="assets/shared/style.css">`
    : `<style>.card{color:blue}</style>`;
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head>${link}</head><body></body></html>`);
  return dir;
}

test("shared files sync into compositions that reference them, and nothing else", () => {
  const { root, paths } = makeProject();
  const userA = makeComp(root, "comp_a", true);
  const userB = makeComp(root, "comp_b", true);
  const other = makeComp(root, "comp_c", false);

  assert.equal(compositionReferencesSharedAssets(userA), true);
  assert.equal(compositionReferencesSharedAssets(other), false);

  const rA = syncSharedProjectAssetsToComposition(userA, "index.html", paths);
  const rB = syncSharedProjectAssetsToComposition(userB, "index.html", paths);
  const rC = syncSharedProjectAssetsToComposition(other, "index.html", paths);
  assert.deepEqual(rA.updatedFiles, ["assets/shared/style.css"]);
  assert.deepEqual(rB.updatedFiles, ["assets/shared/style.css"]);
  assert.equal(rC.updated, false);
  assert.equal(fs.readFileSync(path.join(userA, "assets", "shared", "style.css"), "utf8"), ".card{color:red}\n");
  assert.ok(!fs.existsSync(path.join(other, "assets", "shared")));

  // Editing the shared file refreshes exactly the two users.
  fs.writeFileSync(path.join(root, "shared", "style.css"), ".card{color:green}\n");
  const hashA1 = hashCompositionFilesExcludingBridgeData(userA);
  const hashC1 = hashCompositionFilesExcludingBridgeData(other);
  const rA2 = syncSharedProjectAssetsToComposition(userA, "index.html", paths);
  const rB2 = syncSharedProjectAssetsToComposition(userB, "index.html", paths);
  const rC2 = syncSharedProjectAssetsToComposition(other, "index.html", paths);
  assert.equal(rA2.updated, true);
  assert.equal(rB2.updated, true);
  assert.equal(rC2.updated, false);
  assert.equal(fs.readFileSync(path.join(userA, "assets", "shared", "style.css"), "utf8"), ".card{color:green}\n");
  assert.notEqual(hashCompositionFilesExcludingBridgeData(userA), hashA1);
  assert.equal(hashCompositionFilesExcludingBridgeData(other), hashC1);

  // A user edit inside the composition is left alone.
  fs.writeFileSync(path.join(userA, "assets", "shared", "style.css"), ".card{color:black}\n");
  const rA3 = syncSharedProjectAssetsToComposition(userA, "index.html", paths);
  assert.equal(rA3.updated, false);
  assert.equal(fs.readFileSync(path.join(userA, "assets", "shared", "style.css"), "utf8"), ".card{color:black}\n");

  fs.rmSync(root, { recursive: true, force: true });
});
