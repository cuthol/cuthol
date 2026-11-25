/**
 * Thumbnail requests must not hold the connection while the render pass runs.
 * Cold-open the demo copy with an empty thumbnail cache, fire one thumbnail
 * request per scene plus a composition asset request, and measure time to
 * first byte. Fixed code answers at once (placeholder, Retry-After); the old
 * code holds each request open until its JPEG lands.
 */
import "./test_setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLiveServer, stopLiveServer } from "../live/live_server.js";
import { resolveLivePaths } from "../live/live_paths.js";

process.env.CUTHOL_SKILLS_AUTO = "0";

const DEMO = path.resolve(process.cwd(), "test-workspace/live-design/fixture/live_demo");

function httpGet(port: number, reqPath: string): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers, ms: Date.now() - t0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("live: cold thumbnail answers at once, real JPEG follows on retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-b2-"));
  try {
    fs.cpSync(DEMO, dir, { recursive: true });
    const thumbsDir = resolveLivePaths(dir).thumbsDir;
    fs.rmSync(thumbsDir, { recursive: true, force: true });

    const info = await ensureLiveServer(dir);
    try {
      const snap = await httpGet(info.port, `/api/snapshot?t=${info.token}`);
      assert.equal(snap.status, 200, `snapshot: ${snap.body.toString("utf8").slice(0, 200)}`);
      const scenes = (JSON.parse(snap.body.toString("utf8")) as { scenes: { id: string; thumb?: string }[] }).scenes;
      assert.ok(scenes.length > 0, "demo has scenes");
      // Keep the cache cold: the snapshot-triggered background pass may have started.
      fs.rmSync(thumbsDir, { recursive: true, force: true });

      const thumbPaths = scenes.map((s) => {
        const base = s.thumb ?? `/api/thumb/${s.id}`;
        return `${base}${base.includes("?") ? "&" : "?"}t=${info.token}`;
      });
      // Cold open: every scene asks at once, like the window's scene strip.
      const all = await Promise.all(thumbPaths.map((p) => httpGet(info.port, p)));
      const worst = Math.max(...all.map((r) => r.ms));
      console.log(`thumb cold TTFB per scene: ${all.map((r) => `${r.ms}ms/${r.status}/${r.headers["content-type"]}`).join(" ")}`);
      for (const r of all) {
        const ct = r.headers["content-type"] ?? "";
        assert.ok(ct.includes("image/"), `answer must be a renderable image, got ${ct}`);
        if (ct.includes("image/svg+xml")) {
          assert.equal(r.headers["x-thumbnail-status"], "pending");
          assert.ok(r.headers["retry-after"], "pending placeholder carries Retry-After");
        } else {
          assert.equal(ct.includes("image/jpeg"), true);
        }
      }
      assert.ok(worst < 5000, `cold thumbnails must answer at once, worst took ${worst}ms`);

      // Poll until the real JPEG lands (background pass), then it must be served.
      let jpeg: { status: number; headers: http.IncomingHttpHeaders } | null = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const retry = await httpGet(info.port, thumbPaths[0]);
        if ((retry.headers["content-type"] ?? "").includes("image/jpeg")) {
          jpeg = retry;
          break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      assert.ok(jpeg, "real JPEG thumbnail never landed on disk");
      assert.equal(jpeg!.status, 200);
    } finally {
      await stopLiveServer(dir);
    }
  } finally {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
  }
});

test("live: the window learns when pending thumbnails are ready (thumbs event, s=1 URLs serve JPEG)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-thumbs-event-"));
  let sse: http.ClientRequest | null = null;
  try {
    fs.cpSync(DEMO, dir, { recursive: true });
    fs.rmSync(resolveLivePaths(dir).thumbsDir, { recursive: true, force: true });
    const info = await ensureLiveServer(dir);
    try {
      // Listen like the window does, then read the snapshot's scene URLs.
      const events: Array<{ event: string; data: string }> = [];
      sse = http.request({ host: "127.0.0.1", port: info.port, path: `/events?t=${info.token}`, method: "GET" }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
            const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            events.push({ event: ev, data });
          }
        });
      });
      sse.on("error", () => {});
      sse.end();

      const snap = await httpGet(info.port, `/api/snapshot?t=${info.token}`);
      const scenes = (JSON.parse(snap.body.toString("utf8")) as { scenes: { id: string; thumb: string }[] }).scenes;
      assert.ok(scenes.length > 0);
      assert.ok(scenes.every((s) => s.thumb.includes("&s=0")), `cold scenes carry s=0: ${scenes.map((s) => s.thumb).join(" ")}`);

      type SceneUrl = { id: string; thumb: string };
      const findReady = (): SceneUrl[] | null => {
        for (const e of events.filter((x) => x.event === "thumbs")) {
          const list = (JSON.parse(e.data) as { scenes: SceneUrl[] }).scenes;
          if (list.length === scenes.length && list.every((s) => s.thumb.includes("&s=1"))) return list;
        }
        return null;
      };
      const deadline = Date.now() + 180_000;
      let ready = findReady();
      while (Date.now() < deadline && !ready) {
        await new Promise((r) => setTimeout(r, 500));
        ready = findReady();
      }
      assert.ok(ready, `no thumbs event with every scene ready; events: ${events.map((e) => e.event).join(",")}`);
      for (const s of ready) {
        assert.notEqual(s.thumb, scenes.find((x) => x.id === s.id)?.thumb, `${s.id}: the URL changes so the window reloads it`);
        const r = await httpGet(info.port, s.thumb);
        assert.equal(r.status, 200);
        assert.ok((r.headers["content-type"] ?? "").includes("image/jpeg"), `${s.id}: ${r.headers["content-type"]}`);
      }
    } finally {
      sse?.destroy();
      await stopLiveServer(dir);
    }
  } finally {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
  }
});

test("live: missing media still gets the placeholder once the pass finished", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-live-b2missing-"));
  try {
    fs.cpSync(DEMO, dir, { recursive: true });
    // Break every library asset so no scene can render (missing-media path).
    const seqFile = path.join(dir, "cuthol.sequence.json");
    const seq = JSON.parse(fs.readFileSync(seqFile, "utf8")) as { library: { uri: string }[] };
    for (const item of seq.library) item.uri = "media/gone-missing.mp4";
    fs.writeFileSync(seqFile, JSON.stringify(seq, null, 2));
    fs.rmSync(resolveLivePaths(dir).thumbsDir, { recursive: true, force: true });

    const info = await ensureLiveServer(dir);
    try {
      const snap = await httpGet(info.port, `/api/snapshot?t=${info.token}`);
      assert.equal(snap.status, 200);
      const scenes = (JSON.parse(snap.body.toString("utf8")) as { scenes: { id: string; thumb?: string }[] }).scenes;
      assert.ok(scenes.length > 0, "demo has scenes");
      const base = scenes[0].thumb ?? `/api/thumb/${scenes[0].id}`;
      const thumbPath = `${base}${base.includes("?") ? "&" : "?"}t=${info.token}`;

      // Poll with the current key: pending while the pass runs, then the
      // final placeholder once the pass finished without a file.
      let final: { status: number; headers: http.IncomingHttpHeaders; body: Buffer } | null = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const r = await httpGet(info.port, thumbPath);
        if ((r.headers["content-type"] ?? "").includes("image/svg+xml") && r.headers["x-thumbnail-status"] === "unavailable") {
          final = r;
          break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      assert.ok(final, "missing-media scene never got its final placeholder");
      assert.equal(final!.status, 200);
      assert.ok(final!.body.toString("utf8").includes("Thumbnail unavailable"));
    } finally {
      await stopLiveServer(dir);
    }
  } finally {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
  }
});
