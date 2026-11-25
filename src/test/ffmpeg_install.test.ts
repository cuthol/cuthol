/**
 * Pinned ffmpeg setup tests (`src/test/ffmpeg_install.test.ts`).
 *
 * No network: a local HTTP server (Node `http`, port 0, closed in `finally`)
 * serves a small fake archive (a stored zip built in-test) holding stub
 * `ffmpeg`/`ffprobe` scripts that print `ffmpeg version 8.1.1 ...`. The
 * pinned table is injected through the test-only `CUTHOL_FFMPEG_PIN_OVERRIDE`.
 */

import "./test_setup.js";
import { rmRetrySync } from "./fs_cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import {
  applyFfmpegSetup,
  describeFfmpegSetup,
  FFMPEG_PINNED_MAJOR,
  makeDownloadProgress,
  planFfmpegSetup,
} from "../core/ffmpeg_install.js";
import {
  clearFfmpegPreferenceForTest,
  preferCutholFfmpeg,
} from "../core/env.js";
import { clearFfmpegVersionCache } from "../core/ffmpeg_version.js";
import { checkFfmpeg } from "../core/doctor.js";

const tmpRoots: string[] = [];
test.after(() => {
  for (const dir of tmpRoots) rmRetrySync(dir);
});

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

/** Minimal stored (uncompressed) zip builder: enough for the OS `tar` to read. */
function buildZip(entries: Array<{ name: string; data: Buffer; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, nameBuf, entry.data);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o644) & 0xffff) << 16, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);
    offset += header.length + nameBuf.length + entry.data.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDir, end]);
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function stubScripts(): Array<{ name: string; data: Buffer; mode?: number }> {
  if (process.platform === "win32") {
    return [
      { name: "ffmpeg.cmd", data: Buffer.from("@echo ffmpeg version 8.1.1-full_build\r\n", "utf8") },
      { name: "ffprobe.cmd", data: Buffer.from("@echo ffprobe version 8.1.1-full_build\r\n", "utf8") },
    ];
  }
  return [
    {
      name: "ffmpeg",
      data: Buffer.from('#!/bin/sh\necho "ffmpeg version 8.1.1-full_build"\n', "utf8"),
      mode: 0o755,
    },
    {
      name: "ffprobe",
      data: Buffer.from('#!/bin/sh\necho "ffprobe version 8.1.1-full_build"\n', "utf8"),
      mode: 0o755,
    },
  ];
}

function pinOverride(url: string, archive: Buffer, sha256?: string): string {
  return JSON.stringify({
    [`${process.platform}-${process.arch}`]: {
      version: "8.1",
      url,
      bytes: archive.length,
      sha256: sha256 ?? crypto.createHash("sha256").update(archive).digest("hex"),
      archiveKind: "zip",
    },
  });
}

async function withServer(
  body: Buffer,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await fn(`http://127.0.0.1:${port}/ffmpeg.zip`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function installedBinFiles(dataDir: string): string[] {
  const bin = path.join(dataDir, "tools", "ffmpeg-8.1", "bin");
  if (!fs.existsSync(bin)) return [];
  return fs.readdirSync(bin);
}

test("dry run describes the download, size and target folder", () => {
  const dataDir = makeTmp("cuthol-ffmpeg-dry-");
  const archive = buildZip(stubScripts());
  withEnv({ CUTHOL_DATA_DIR: dataDir, CUTHOL_FFMPEG_PIN_OVERRIDE: pinOverride("http://127.0.0.1:9/x.zip", archive) }, () => {
    const plan = planFfmpegSetup();
    assert.equal(plan.supported, true);
    assert.equal(plan.alreadyInstalled, false);
    const lines = describeFfmpegSetup(plan).join("\n");
    assert.ok(lines.includes(plan.url ?? "missing-url"));
    assert.ok(lines.includes(plan.targetDir));
    assert.ok(lines.includes("--apply"));
  });
});

test("install succeeds from a local archive; re-run is a no-op", async () => {
  const dataDir = makeTmp("cuthol-ffmpeg-ok-");
  const archive = buildZip(stubScripts());
  await withServer(archive, async (url) => {
    const savedOverride = process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
    const savedDataDir = process.env.CUTHOL_DATA_DIR;
    process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = pinOverride(url, archive);
    process.env.CUTHOL_DATA_DIR = dataDir;
    try {
      const first = await applyFfmpegSetup(Date.now());
      assert.equal(first.noop, false);
      const files = installedBinFiles(dataDir);
      assert.ok(files.some((f) => f.startsWith("ffmpeg")), `bin holds ffmpeg: ${files.join(",")}`);
      assert.ok(files.some((f) => f.startsWith("ffprobe")), `bin holds ffprobe: ${files.join(",")}`);
      // No temp leftovers next to the install.
      const toolsDir = path.join(dataDir, "tools", "ffmpeg-8.1");
      for (const f of fs.readdirSync(toolsDir)) {
        assert.doesNotMatch(f, /^\.(download|extract)-/, `no temp leftover: ${f}`);
      }
      const second = await applyFfmpegSetup(Date.now());
      assert.equal(second.noop, true);
    } finally {
      if (savedOverride === undefined) delete process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
      else process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = savedOverride;
      if (savedDataDir === undefined) delete process.env.CUTHOL_DATA_DIR;
      else process.env.CUTHOL_DATA_DIR = savedDataDir;
    }
  });
});

test("wrong hash fails with the diagnostic and leaves no files", async () => {
  const dataDir = makeTmp("cuthol-ffmpeg-hash-");
  const archive = buildZip(stubScripts());
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 0xff;
  await withServer(tampered, async (url) => {
    const savedOverride = process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
    const savedDataDir = process.env.CUTHOL_DATA_DIR;
    // Declared sha is the original; the served bytes differ (same length).
    process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = pinOverride(url, archive);
    const parsed = JSON.parse(process.env.CUTHOL_FFMPEG_PIN_OVERRIDE) as Record<string, { bytes: number }>;
    parsed[`${process.platform}-${process.arch}`].bytes = tampered.length;
    process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = JSON.stringify(parsed);
    process.env.CUTHOL_DATA_DIR = dataDir;
    try {
      await assert.rejects(applyFfmpegSetup(Date.now()), /CUTHOL-G252/);
      assert.deepEqual(installedBinFiles(dataDir), []);
      const toolsDir = path.join(dataDir, "tools", "ffmpeg-8.1");
      if (fs.existsSync(toolsDir)) {
        for (const f of fs.readdirSync(toolsDir)) {
          assert.doesNotMatch(f, /^\.(download|extract)-/, `no temp leftover: ${f}`);
        }
      }
    } finally {
      if (savedOverride === undefined) delete process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
      else process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = savedOverride;
      if (savedDataDir === undefined) delete process.env.CUTHOL_DATA_DIR;
      else process.env.CUTHOL_DATA_DIR = savedDataDir;
    }
  });
});

test("truncated download fails and leaves no files", async () => {
  const dataDir = makeTmp("cuthol-ffmpeg-trunc-");
  const archive = buildZip(stubScripts());
  const half = archive.subarray(0, Math.floor(archive.length / 2));
  await withServer(half, async (url) => {
    const savedOverride = process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
    const savedDataDir = process.env.CUTHOL_DATA_DIR;
    // Declared bytes are the full length; the server sends half.
    process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = pinOverride(url, archive);
    process.env.CUTHOL_DATA_DIR = dataDir;
    try {
      await assert.rejects(applyFfmpegSetup(Date.now()), /CUTHOL-G25[30]/);
      assert.deepEqual(installedBinFiles(dataDir), []);
    } finally {
      if (savedOverride === undefined) delete process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
      else process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = savedOverride;
      if (savedDataDir === undefined) delete process.env.CUTHOL_DATA_DIR;
      else process.env.CUTHOL_DATA_DIR = savedDataDir;
    }
  });
});

test("startup preference prepends the install only when PATH ffmpeg is missing or below 8", () => {
  const dataDir = makeTmp("cuthol-ffmpeg-pref-");
  withEnv({ CUTHOL_DATA_DIR: dataDir }, () => {
    const binDir = path.join(dataDir, "tools", "ffmpeg-8.1", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const ffmpegName = process.platform === "win32" ? "ffmpeg.cmd" : "ffmpeg";
    fs.writeFileSync(
      path.join(binDir, ffmpegName),
      process.platform === "win32" ? "@echo ffmpeg version 8.1.1\r\n" : '#!/bin/sh\necho "ffmpeg version 8.1.1"\n'
    );

    const savedPath = process.env.PATH ?? "";

    // Case 1: PATH ffmpeg 6.1 -> installed folder is prepended.
    clearFfmpegVersionCache();
    clearFfmpegPreferenceForTest();
    process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE = "ffmpeg version 6.1";
    delete process.env.CUTHOL_FFMPEG_DIR;
    process.env.PATH = savedPath;
    preferCutholFfmpeg();
    assert.ok(
      (process.env.PATH ?? "").split(path.delimiter)[0] === binDir,
      "install prepended when PATH ffmpeg is 6.1"
    );

    // Case 2: PATH ffmpeg 8.x -> untouched.
    clearFfmpegVersionCache();
    clearFfmpegPreferenceForTest();
    process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE = "ffmpeg version 8.1.1-full_build";
    process.env.PATH = savedPath;
    preferCutholFfmpeg();
    assert.equal(process.env.PATH, savedPath, "PATH untouched when PATH ffmpeg is 8.x");

    // Case 3: CUTHOL_FFMPEG_DIR=off disables the preference.
    clearFfmpegVersionCache();
    clearFfmpegPreferenceForTest();
    process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE = "ffmpeg version 6.1";
    process.env.CUTHOL_FFMPEG_DIR = "off";
    process.env.PATH = savedPath;
    preferCutholFfmpeg();
    assert.equal(process.env.PATH, savedPath, "PATH untouched when disabled");

    delete process.env.CUTHOL_FAKE_FFMPEG_VERSION_LINE;
    delete process.env.CUTHOL_FFMPEG_DIR;
    process.env.PATH = savedPath;
    clearFfmpegVersionCache();
    clearFfmpegPreferenceForTest();
  });
});

test("download progress uses cuthol:progress and stays throttled on many small chunks", () => {
  const lines: string[] = [];
  const onProgress = makeDownloadProgress("download", (line) => lines.push(line));
  const total = 3_000_000;
  // ~184 chunks of 16 KB, like a chunked multi-MB download.
  for (let done = 16384; done < total; done += 16384) onProgress(done, total);
  onProgress(total, total);
  assert.ok(lines.length <= 25, `at most ~25 progress lines, got ${lines.length}`);
  assert.ok(lines.length >= 2, `progress is still reported, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^cuthol:progress download \d+\/\d+ eta \S+\n$/);
  }
  assert.match(lines[lines.length - 1], new RegExp(`^cuthol:progress download ${total}/${total} eta 0s\\n$`));
});

test("a multi-MB install emits few progress lines and no DEP0190 warning", async () => {
  const dataDir = makeTmp("cuthol-ffmpeg-quiet-");
  const big = crypto.randomBytes(3_000_000);
  const archive = buildZip([...stubScripts(), { name: "payload.bin", data: big }]);
  await withServer(archive, async (url) => {
    const savedOverride = process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
    const savedDataDir = process.env.CUTHOL_DATA_DIR;
    process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = pinOverride(url, archive);
    process.env.CUTHOL_DATA_DIR = dataDir;
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = (chunk: any, ...rest: any[]): boolean => {
      captured.push(String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origWrite as any)(chunk, ...rest);
    };
    try {
      await applyFfmpegSetup(Date.now());
    } finally {
      process.stderr.write = origWrite;
      if (savedOverride === undefined) delete process.env.CUTHOL_FFMPEG_PIN_OVERRIDE;
      else process.env.CUTHOL_FFMPEG_PIN_OVERRIDE = savedOverride;
      if (savedDataDir === undefined) delete process.env.CUTHOL_DATA_DIR;
      else process.env.CUTHOL_DATA_DIR = savedDataDir;
    }
    const all = captured.join("");
    assert.doesNotMatch(all, /DEP0190/, "no DEP0190 shell warning on stderr");
    const progressLines = all.split("\n").filter((line) => line.startsWith("cuthol:progress "));
    assert.ok(progressLines.length <= 25, `at most ~25 progress lines, got ${progressLines.length}`);
    assert.ok(progressLines.length >= 1, "a final progress line is emitted");
    const finals = progressLines.filter((line) =>
      new RegExp(`^cuthol:progress download ${archive.length}/${archive.length} eta 0s\\n?$`).test(line)
    );
    assert.equal(finals.length, 1, `exactly one final download line, got ${finals.length}: ${progressLines.slice(-3).join(" | ")}`);
    assert.doesNotMatch(all, /\rdownloading/, "old carriage-return spam is gone");
  });
});

test("doctor ffmpeg check names path, source and the setup fix", () => {
  const missing = checkFfmpeg({ ffmpegMajor: null, ffprobeMajor: null });
  assert.equal(missing.status, "fail");
  assert.match(missing.fix, /cuthol setup --ffmpeg --apply/);

  const old = checkFfmpeg({
    ffmpegMajor: 7,
    ffmpegToken: "7.1",
    ffprobeMajor: 7,
    ffprobeToken: "7.1",
    ffmpegPath: "/usr/bin/ffmpeg",
    ffprobePath: "/usr/bin/ffprobe",
    ffmpegFromSetup: false,
  });
  assert.equal(old.status, "warn");
  assert.match(old.found, /from PATH/);
  assert.match(old.found, /\/usr\/bin\/ffmpeg/);
  assert.match(old.fix, /cuthol setup --ffmpeg --apply/);

  const installed = checkFfmpeg({
    ffmpegMajor: FFMPEG_PINNED_MAJOR,
    ffmpegToken: "8.1.1",
    ffprobeMajor: FFMPEG_PINNED_MAJOR,
    ffprobeToken: "8.1.1",
    ffmpegPath: "/home/u/.cuthol/tools/ffmpeg-8.1/bin/ffmpeg",
    ffprobePath: "/home/u/.cuthol/tools/ffmpeg-8.1/bin/ffprobe",
    ffmpegFromSetup: true,
  });
  assert.equal(installed.status, "ok");
  assert.match(installed.found, /installed by cuthol setup/);
});
