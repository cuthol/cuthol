// Shader pre-pass worker (`node dist/render/shader_worker.js <specFile>`).
//
// A compiled plan whose spine clip chain was cut at a shader fx entry carries
// a `kind: "shader"` pre-pass job. This child process owns one long-lived
// browser for that job: ffmpeg decodes the prefix to raw frames on stdout,
// the worker streams them through the page (2 pages, `fetch` + `Blob` POST),
// an ffmpeg step runs between two shader steps when the written order says
// so, and a second ffmpeg encodes the results to the intermediate.
//
// Usage must stay synchronous for the caller (`pre_pass.ts` runs it with
// `spawnWatchedSync`): this process runs to completion and exits. Exit 0 on
// success; exit 3 with a `CUTHOL-G708` marker on stderr when a frame times
// out (an endless loop in a shader ends in a diagnostic, never a hang);
// any other failure exits nonzero with the reason on stderr. The browser and
// every page close in `finally`; only the given tmp path is written, so an
// interruption never leaves a partial intermediate. Every child process uses
// `windowsHide: true`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { CutholError, DIAGNOSTICS } from "../core/diagnostics.js";
import { spawnWatchedSync } from "../core/subprocess.js";
import type { PrePassJob } from "../compositor/compiler.js";
import type { FxShaderRunStep } from "../compositor/compile_fx_stage.js";
import { evaluateEnvelopeAt } from "../sequence/spine_envelope.js";
import type { ParameterEnvelope } from "../core/schema.js";
import { SHADER_PAGE_HTML } from "./shader_page.js";

export interface ShaderWorkerSpec {
  job: PrePassJob;
  tmpOut: string;
  cwd: string;
  step?: string;
  frameTimeoutMs?: number;
}

export const SHADER_FRAME_TIMEOUT_MS_DEFAULT = 120_000;
const FRAME_QUEUE_CAP = 8;
const PAGE_COUNT = 2;

type ShaderStep = Extract<FxShaderRunStep, { kind: "shader" }>;

/**
 * Map a step's `.glsl` uniform declarations to host setter types: `f`/`i`
 * for scalars, `v2`/`v3`/`v4` (float vectors) and `i2`/`i3`/`i4` (int
 * vectors, rounded). Vector components arrive as `<name>_x` … params.
 */
export function shaderUniformTypes(source: string): Record<string, "f" | "i" | "v2" | "v3" | "v4" | "i2" | "i3" | "i4"> {
  const out: Record<string, "f" | "i" | "v2" | "v3" | "v4" | "i2" | "i3" | "i4"> = {};
  const re = /uniform\s+(float|int|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const t = m[1];
    out[m[2]] =
      t === "float" ? "f" : t === "vec2" ? "v2" : t === "vec3" ? "v3" : t === "vec4" ? "v4"
      : t === "ivec2" ? "i2" : t === "ivec3" ? "i3" : t === "ivec4" ? "i4" : "i";
  }
  return out;
}

export interface FrameUniforms {
  time: number;
  values: Record<string, { v: number; t: "f" | "i" } | { vec: number[]; t: "v2" | "v3" | "v4" | "i2" | "i3" | "i4" }>;
}

const VEC_COMPS = ["x", "y", "z", "w"] as const;

/**
 * Per-frame uniform values of one shader step: the entry's static uniforms
 * with each envelope evaluated at the frame's item-local time (`frame n` is
 * `n/fps` item-local seconds: the pre-pass prefix always starts at the
 * item-local start). Vector uniforms are composed from their `<name>_x` …
 * components (static or enveloped per component). The same evaluator
 * `spine value` reads, so the two agree by construction; the equality proof
 * compares them frame by frame.
 */
export function shaderFrameUniforms(
  step: ShaderStep,
  types: Record<string, "f" | "i" | "v2" | "v3" | "v4" | "i2" | "i3" | "i4">,
  frameIndex: number,
  fps: number
): FrameUniforms {
  const localMs = (frameIndex / Math.max(1e-9, fps)) * 1000;
  const comp = (name: string): number => {
    const env = (step.envelopes as Record<string, ParameterEnvelope | undefined>)[name];
    if (env) return evaluateEnvelopeAt(env, localMs);
    const s = (step.uniforms as Record<string, number | boolean | undefined>)[name];
    if (typeof s === "boolean") return s ? 1 : 0;
    if (typeof s === "number") return s;
    return 0;
  };
  const values: FrameUniforms["values"] = {};
  for (const [k, v] of Object.entries(step.uniforms)) {
    values[k] = { v: typeof v === "boolean" ? (v ? 1 : 0) : v, t: types[k] === undefined || types[k] === "f" || types[k] === "i" ? (types[k] ?? "f") : "f" };
  }
  for (const [k, env] of Object.entries(step.envelopes)) {
    values[k] = { v: evaluateEnvelopeAt(env as ParameterEnvelope, localMs), t: types[k] === undefined || types[k] === "f" || types[k] === "i" ? (types[k] ?? "f") : "f" };
  }
  for (const [name, t] of Object.entries(types)) {
    if (t !== "v2" && t !== "v3" && t !== "v4" && t !== "i2" && t !== "i3" && t !== "i4") continue;
    const n = Number(t.slice(1));
    const vec = VEC_COMPS.slice(0, n).map((c) => {
      const v = comp(`${name}_${c}`);
      return t.startsWith("i") ? Math.round(v) : v;
    });
    values[name] = { vec, t };
  }
  return { time: frameIndex / Math.max(1e-9, fps), values };
}

interface DecodedFrame {
  index: number;
  buf: Buffer;
}

/** Bounded FIFO with backpressure callbacks (pause the producer when full). */
class FrameQueue {
  private items: DecodedFrame[] = [];
  private takers: Array<(f: DecodedFrame | null) => void> = [];
  private closed = false;
  onFull: (() => void) | null = null;
  onSpace: (() => void) | null = null;

  push(f: DecodedFrame): void {
    if (this.closed) return;
    if (this.takers.length > 0) {
      const take = this.takers.shift()!;
      take(f);
      return;
    }
    this.items.push(f);
    if (this.items.length >= FRAME_QUEUE_CAP && this.onFull) this.onFull();
  }

  take(): Promise<DecodedFrame | null> {
    if (this.items.length > 0) {
      const f = this.items.shift()!;
      if (this.onSpace) this.onSpace();
      return Promise.resolve(f);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.takers.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const take of this.takers.splice(0)) take(null);
  }

  get done(): boolean {
    return this.closed && this.items.length === 0 && this.takers.length === 0;
  }
}

function killProc(proc: { kill(sig?: NodeJS.Signals): boolean } | null): void {
  try {
    proc?.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Waits for a process exit; resolves false on nonzero exit or signal. */
function waitExit(proc: { on(ev: string, fn: (...a: never[]) => void): void }, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.on("close", (code: never) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Raw pixel format of the prefix/intermediate frames. */
function rawPixFmt(pixFmt: string): "rgba" | "rgba64le" {
  return pixFmt === "rgba64le" ? "rgba64le" : "rgba";
}

interface ActivePhase {
  /** Server routing id (`/frame?id=` / `/result?id=`); one per shader phase. */
  id: string;
  pending: DecodedFrame[];
  inFlight: Map<number, number>;
  results: Map<number, Buffer>;
  decodeDone: boolean;
  failed: Error | null;
  nextServe: number;
  nextEmit: number;
  emitWaiters: Array<() => void>;
  /** Pump backpressure waiters: the pump parks here while `pending` is full. */
  pumpWaiters: Array<() => void>;
  step: ShaderStep;
  types: ReturnType<typeof shaderUniformTypes>;
  fps: number;
  /** Item-local index of the first decoded frame (`frameOffset` of the step, 0 for full clips). */
  frameBase: number;
  /** Hash of the programmed source: pages re-program when it changes. */
  progHash: string;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const joined = Buffer.concat(chunks);
      resolve(Buffer.from(joined.buffer, joined.byteOffset, joined.byteLength));
    });
    req.on("error", reject);
  });
}

function servePageHtml(): string {
  return SHADER_PAGE_HTML;
}

/**
 * Runs one shader step as a streaming phase: the two pages pull frames from
 * `input` over HTTP and post results back; this yields result frames in
 * index order. Programs both pages first (compile errors throw with
 * file:line); a frame with no result within `frameTimeoutMs` fails the run.
 */
async function runShaderPhase(
  opts: {
    route: RouteState;
    pages: { evaluate(fn: (...a: never[]) => unknown, ...a: unknown[]): Promise<unknown> }[];
    step: ShaderStep;
    source: string;
    rawFmt: "rgba" | "rgba64le";
    width: number;
    height: number;
    frameTimeoutMs: number;
    fail: (err: Error) => void;
  },
  input: AsyncGenerator<DecodedFrame>
): Promise<AsyncGenerator<DecodedFrame>> {
  // One id per phase: stacked shader steps run concurrently and share the
  // server and the pages, so frames and results are routed by phase id and
  // each page re-programs whenever the frame's program differs from its own.
  // (A single shared route starved every phase but the last: the stacked
  // card hung until the protocol timed out.)
  const id = `ph${opts.route.nextPhase++}`;
  const phase: ActivePhase = {
    id,
    pending: [],
    inFlight: new Map(),
    results: new Map(),
    decodeDone: false,
    failed: null,
    nextServe: 0,
    nextEmit: 0,
    emitWaiters: [],
    pumpWaiters: [],
    step: opts.step,
    types: shaderUniformTypes(opts.source),
    fps: opts.route.fps,
    frameBase: opts.step.frameOffset ?? 0,
    progHash: createHash("sha256").update(opts.source).digest("hex").slice(0, 16),
  };
  // A phase failure must also wake `out()` (and the pump): they park on
  // waiter lists and only check `phase.failed`, so a failure recorded
  // anywhere else would park them forever (a silent hang instead of the
  // timeout diagnostic).
  const failPhase = (err: Error): void => {
    if (!phase.failed) phase.failed = err;
    for (const w of phase.emitWaiters.splice(0)) w();
    for (const w of phase.pumpWaiters.splice(0)) w();
    opts.fail(err);
  };
  opts.route.phases.set(id, phase);

  for (const page of opts.pages) {
    try {
      await page.evaluate(
        ((src: string, w: number, h: number, is16: boolean, hash: string) =>
          (window as unknown as { __programShader: (s: string, w: number, h: number, b: boolean, hash: string) => unknown }).__programShader(src, w, h, is16, hash)) as (...a: never[]) => unknown,
        opts.source as never,
        opts.width as never,
        opts.height as never,
        (opts.rawFmt === "rgba64le") as never,
        phase.progHash as never
      );
    } catch (err) {
      opts.route.phases.delete(id);
      const raw = err instanceof Error ? err.message : String(err);
      const line = /line=(\d+)/.exec(raw)?.[1] ?? "?";
      throw new CutholError(
        DIAGNOSTICS.SHADER_WORKER_FAILED(opts.step.entryId, `${opts.step.file}:${line}: ${raw.slice(0, 300)}`)
      );
    }
    void page
      .evaluate(
        (((pid: string, progHash: string, src: string, w: number, h: number, is16: boolean) =>
          (window as unknown as { __pullLoop: (p: string, h: string, s: string, w: number, hh: number, b: boolean) => Promise<string> }).__pullLoop(pid, progHash, src, w, h, is16)) as unknown) as (...a: never[]) => unknown,
        id as never,
        phase.progHash as never,
        opts.source as never,
        opts.width as never,
        opts.height as never,
        (opts.rawFmt === "rgba64le") as never
      )
      .catch((err: unknown) => {
        failPhase(err instanceof Error ? err : new Error(String(err)));
      });
  }

  void (async () => {
    try {
      for await (const f of input) {
        if (phase.failed) return;
        // Bound the queue: stacked phases decode ahead while the pages serve
        // a sibling phase; without a cap a 1080p clip parks ~1 GB here.
        while (phase.pending.length >= 32 && !phase.failed) {
          await new Promise<void>((resolve) => phase.pumpWaiters.push(resolve));
        }
        if (phase.failed) return;
        phase.pending.push(f);
      }
      phase.decodeDone = true;
      for (const w of phase.emitWaiters.splice(0)) w();
      for (const w of phase.pumpWaiters.splice(0)) w();
    } catch (err) {
      failPhase(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  const watchdog = setInterval(() => {
    if (phase.failed) return;
    const now = Date.now();
    for (const [index, servedAt] of phase.inFlight) {
      if (now - servedAt > opts.frameTimeoutMs) {
        failPhase(
          new CutholError(DIAGNOSTICS.SHADER_FRAME_TIMEOUT(opts.step.entryId, index, opts.frameTimeoutMs))
        );
        return;
      }
    }
  }, 1000);
  watchdog.unref?.();

  async function* out(): AsyncGenerator<DecodedFrame> {
    try {
      for (;;) {
        if (phase.failed) throw phase.failed;
        const hit = phase.results.get(phase.nextEmit);
        if (hit !== undefined) {
          phase.results.delete(phase.nextEmit);
          yield { index: phase.nextEmit, buf: hit };
          phase.nextEmit++;
          continue;
        }
        if (phase.decodeDone && phase.pending.length === 0 && phase.inFlight.size === 0 && phase.results.size === 0) {
          return;
        }
        await new Promise<void>((resolve) => phase.emitWaiters.push(resolve));
      }
    } finally {
      clearInterval(watchdog);
      // The pages learn the phase is over through `decodeDone` + 410 (or an
      // unknown id → 410); dropping the registration only stops routing.
      opts.route.phases.delete(id);
    }
  }
  return out();
}

interface RouteState {
  phases: Map<string, ActivePhase>;
  nextPhase: number;
  fps: number;
}

function wakePhase(phase: ActivePhase): void {
  for (const w of phase.emitWaiters.splice(0)) w();
}

function startServer(route: RouteState, pageHtml: string): Promise<{ server: http.Server; port: number }> {
  // Every response carries `no-store`: the pages poll `/frame` per frame and
  // a heuristically cached 410 ("no more frames") from one job would end the
  // next job's pull loop before it shades a single frame (all batch jobs
  // share one browser, so the URL repeats). This was the batched stall: the
  // second job's loops exited instantly, the pump filled a queue nobody
  // drained, `out()` parked forever, and the watchdog killed the worker.
  const NO_STORE = { "cache-control": "no-store" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void (async () => {
      try {
        if (url.pathname === "/page.html" || url.pathname === "/") {
          const body = Buffer.from(pageHtml, "utf8");
          res.writeHead(200, { "content-type": "text/html", "content-length": body.length, ...NO_STORE });
          res.end(body);
          return;
        }
        // Phases share this server (stacked steps run concurrently), so every
        // frame and result is routed by phase id. An unknown id means the
        // phase is over: answer 410 so the loop exits instead of spinning.
        const phase = route.phases.get(url.searchParams.get("id") ?? "");
        if (!phase) {
          res.writeHead(410, NO_STORE);
          res.end();
          return;
        }
        if (phase.failed) {
          res.writeHead(500, NO_STORE);
          res.end("phase failed");
          return;
        }
        if (req.method === "GET" && url.pathname === "/frame") {
          const f = phase.pending.shift();
          if (!f) {
            if (phase.decodeDone) {
              res.writeHead(410, NO_STORE);
              res.end();
            } else {
              res.writeHead(204, NO_STORE);
              res.end();
            }
            return;
          }
          // A served frame frees pump space (the pump parks past 32 queued).
          for (const w of phase.pumpWaiters.splice(0)) w();
          const uni = shaderFrameUniforms(phase.step, phase.types, f.index + phase.frameBase, phase.fps);
          phase.inFlight.set(f.index, Date.now());
          phase.nextServe = Math.max(phase.nextServe, f.index + 1);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": f.buf.length,
            "X-Index": String(f.index),
            "X-Prog": phase.progHash,
            "X-Time": String(uni.time),
            "X-Uniforms": JSON.stringify(uni.values),
            ...NO_STORE,
          });
          res.end(f.buf);
          return;
        }
        if (req.method === "POST" && url.pathname === "/result") {
          const index = Number(req.headers["x-index"]);
          if (!Number.isInteger(index) || index < 0) {
            res.writeHead(400, NO_STORE);
            res.end("bad index");
            return;
          }
          const body = await readBody(req, 512 * 1024 * 1024);
          phase.inFlight.delete(index);
          phase.results.set(index, body);
          wakePhase(phase);
          res.writeHead(200, NO_STORE);
          res.end("ok");
          return;
        }
        res.writeHead(404, NO_STORE);
        res.end("unknown");
      } catch (err) {
        try {
          res.writeHead(500);
          res.end(String((err as Error)?.message ?? err));
        } catch {
          // already answered
        }
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/** Splits a rawvideo byte stream into fixed-size frames. */
async function* splitFrames(
  stream: NodeJS.ReadableStream,
  frameBytes: number,
  onPause: () => void,
  onResume: () => void
): AsyncGenerator<Buffer> {
  let carry: Buffer = Buffer.alloc(0);
  let paused = false;
  try {
    for await (const piece of stream as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      while (carry.length >= frameBytes) {
        yield Buffer.from(carry.buffer, carry.byteOffset, frameBytes);
        carry = Buffer.from(carry.buffer, carry.byteOffset + frameBytes, carry.length - frameBytes);
      }
      if (carry.length > 256 * 1024 * 1024) {
        throw new Error("unframed stream: no frame boundary found (size change mid-pass?).");
      }
      if (!paused && carry.length > frameBytes * FRAME_QUEUE_CAP) {
        paused = true;
        onPause();
      }
    }
  } finally {
    if (paused) onResume();
  }
  if (carry.length !== 0) {
    throw new Error(`trailing ${carry.length} bytes after the last full frame (size change mid-pass?).`);
  }
}

/** Reads the output size (`WxH`) of the prefix decode from ffmpeg's stderr. */
function parseDecodeSize(stderrText: string): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  for (const line of stderrText.split("\n")) {
    if (!/rawvideo/.test(line)) continue;
    const m = /(\d{2,5})x(\d{2,5})/.exec(line);
    if (m) found = { width: Number(m[1]), height: Number(m[2]) };
  }
  return found;
}

async function waitDecodeSize(proc: { stderr: NodeJS.ReadableStream | null }, timeoutMs: number): Promise<{ width: number; height: number }> {
  let text = "";
  const deadline = Date.now() + timeoutMs;
  const stderr = proc.stderr;
  if (!stderr) throw new Error("decode process has no stderr.");
  for await (const chunk of stderr as AsyncIterable<Buffer>) {
    text += chunk.toString("utf8");
    const size = parseDecodeSize(text);
    if (size) return size;
    if (Date.now() > deadline) break;
  }
  const size = parseDecodeSize(text);
  if (size) return size;
  throw new Error(`could not read the prefix frame size from ffmpeg (${text.slice(-400)}).`);
}

/**
 * Runs one ffmpeg step of the shader run (entries written between two shader
 * entries): rawvideo in, the entries' filters, rawvideo out, streamed.
 */
async function runFfmpegPhase(
  cwd: string,
  filters: string[],
  rawFmt: "rgba" | "rgba64le",
  width: number,
  height: number,
  fps: number,
  fail: (err: Error) => void,
  input: AsyncGenerator<DecodedFrame>
): Promise<AsyncGenerator<DecodedFrame>> {
  const proc = spawn(
    "ffmpeg",
    [
      "-v", "error",
      "-f", "rawvideo", "-pix_fmt", rawFmt, "-s", `${width}x${height}`, "-framerate", String(fps),
      "-i", "-",
      "-vf", filters.join(","),
      "-f", "rawvideo", "-pix_fmt", rawFmt, "-",
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  const frameBytes = width * height * (rawFmt === "rgba64le" ? 8 : 4);
  let index = 0;
  let done = false;
  const feed = (async () => {
    try {
      for await (const f of input) {
        if (done) return;
        await new Promise<void>((resolve, reject) => {
          const stdin = proc.stdin;
          if (!stdin) {
            reject(new Error("ffmpeg step has no stdin."));
            return;
          }
          if (!stdin.write(f.buf)) stdin.once("drain", resolve);
          else resolve();
        });
      }
      proc.stdin?.end();
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      killProc(proc);
    }
  })();
  void feed;
  async function* out(): AsyncGenerator<DecodedFrame> {
    try {
      const stdout = proc.stdout;
      if (!stdout) throw new Error("ffmpeg step has no stdout.");
      for await (const buf of splitFrames(stdout, frameBytes, () => void stdout.pause(), () => void stdout.resume())) {
        yield { index: index++, buf: Buffer.from(buf) };
      }
      const ok = await waitExit(proc, 120_000);
      if (!ok) throw new Error("ffmpeg mid-pass step failed (see ffmpeg output above).");
    } finally {
      done = true;
    }
  }
  return out();
}

/** Batch spec: several shader jobs sharing one browser (one render's pre-passes). */
export interface ShaderWorkerBatchSpec {
  jobs: Array<{ job: PrePassJob; tmpOut: string }>;
  cwd: string;
  step?: string;
  frameTimeoutMs?: number;
}

type ShaderPages = { evaluate(fn: (...a: never[]) => unknown, ...a: unknown[]): Promise<unknown> }[];

/**
 * One job's pipeline (prefix decode, ordered steps, encode) on an already
 * open browser. Throws on failure; writes only `tmpOut`.
 */
async function runOneJobPipeline(
  job: PrePassJob,
  tmpOut: string,
  cwd: string,
  route: RouteState,
  pages: ShaderPages,
  frameTimeoutMs: number
): Promise<void> {
  if (job.kind !== "shader" || !job.shader) throw new Error("not a shader pre-pass job.");
  const fps = job.shader.fps;
  const rawFmt = rawPixFmt(job.pixFmt);
  route.fps = fps;
  const procs: { kill(sig?: NodeJS.Signals): boolean }[] = [];
  let failed: Error | null = null;
  const fail = (err: Error): void => {
    if (!failed) failed = err;
  };
  const checkFail = (): void => {
    if (failed) throw failed;
  };
  try {
    const decode = spawn(
      "ffmpeg",
      [...job.inputArgs, "-filter_complex", job.filterComplex, "-map", "[preout]", "-f", "rawvideo", "-pix_fmt", rawFmt, "-"],
      { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    procs.push(decode);
    decode.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    const { width, height } = await waitDecodeSize(decode, 120_000);
    const frameBytes = width * height * (rawFmt === "rgba64le" ? 8 : 4);
    const stdout = decode.stdout;
    if (!stdout) throw new Error("prefix decode has no stdout.");
    const queue = new FrameQueue();
    queue.onFull = () => void stdout.pause();
    queue.onSpace = () => void stdout.resume();
    // Feed the queue through the splitter (backpressure via pause/resume).
    void (async () => {
      let index = 0;
      try {
        for await (const buf of splitFrames(stdout, frameBytes, () => void stdout.pause(), () => void stdout.resume())) {
          queue.push({ index: index++, buf: Buffer.from(buf) });
          if (failed) return;
        }
        const ok = await waitExit(decode, 120_000);
        if (!ok) fail(new Error("prefix decode failed (see ffmpeg output above)."));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      } finally {
        queue.close();
      }
    })();
    async function* decodeGen(): AsyncGenerator<DecodedFrame> {
      for (;;) {
        checkFail();
        const f = await queue.take();
        if (!f) return;
        yield f;
      }
    }

    let stream: AsyncGenerator<DecodedFrame> = decodeGen();
    for (const step of job.shader.steps) {
      checkFail();
      if (step.kind === "shader") {
        const source = fs.readFileSync(step.file, "utf8");
        stream = await runShaderPhase(
          { route, pages, step, source, rawFmt, width, height, frameTimeoutMs, fail },
          stream
        );
      } else {
        stream = await runFfmpegPhase(cwd, step.filters, rawFmt, width, height, fps, fail, stream);
      }
    }

    const encode = spawn(
      "ffmpeg",
      [
        "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", rawFmt, "-s", `${width}x${height}`, "-framerate", String(fps),
        "-i", "-",
        "-c:v", "ffv1", "-f", "nut", tmpOut,
      ],
      { cwd, stdio: ["pipe", "ignore", "pipe"], windowsHide: true }
    );
    procs.push(encode);
    encode.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    // Heartbeat on stderr: the watchdog counts worker stderr as progress for
    // node children, so a long shade with no intermediate file growth yet
    // (batch jobs 2+ write nothing until their turn) never looks stalled.
    process.stderr.write(`shader pass job started: ${job.id}\n`);
    let written = 0;
    for await (const f of stream) {
      checkFail();
      if (f.index !== written) throw new Error(`frame order gap: got ${f.index}, expected ${written}.`);
      await new Promise<void>((resolve, reject) => {
        const stdin = encode.stdin;
        if (!stdin) {
          reject(new Error("encoder has no stdin."));
          return;
        }
        if (!stdin.write(f.buf)) stdin.once("drain", resolve);
        else resolve();
      });
      written++;
      if (written % 50 === 0) process.stderr.write(`shader pass ${job.id}: ${written} frames\n`);
    }
    process.stderr.write(`shader pass job done: ${job.id} (${written} frames)\n`);
    encode.stdin?.end();
    const ok = await waitExit(encode, 300_000);
    checkFail();
    if (!ok) throw new Error("result encode failed (see ffmpeg output above).");
    if (written === 0) throw new Error("prefix decoded zero frames; refusing an empty intermediate.");
  } finally {
    for (const p of procs) killProc(p);
  }
}

/**
 * Runs one batch of shader jobs on a single browser: the server and pages
 * open once, each job pipelines decode → steps → its own `tmpOut` encode.
 * Jobs are independent files, so they run sequentially, in order.
 */
export async function runShaderPassBatch(spec: ShaderWorkerBatchSpec): Promise<void> {
  if (spec.jobs.length === 0) return;
  const frameTimeoutMs = spec.frameTimeoutMs ?? SHADER_FRAME_TIMEOUT_MS_DEFAULT;
  const cwd = spec.cwd || process.cwd();
  const fps = spec.jobs[0].job.shader?.fps ?? 30;
  const pageHtml = servePageHtml();
  const route: RouteState = {
    phases: new Map(),
    nextPhase: 0,
    fps,
  };
  const { server, port } = await startServer(route, pageHtml);
  let browser: { close(): Promise<void>; newPage(): Promise<unknown> } | null = null;
  try {
    const { launchScriptProbeBrowser } = await import("../compositor/coords_extract.js");
    const launched = (await launchScriptProbeBrowser()) as unknown as {
      close(): Promise<void>;
      newPage(): Promise<unknown>;
    };
    browser = launched;
    const pages: ShaderPages = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
      const p = (await (browser as unknown as { newPage(): Promise<ShaderPages[number]> }).newPage());
      await (p as unknown as { goto(u: string): Promise<void> }).goto(`http://127.0.0.1:${port}/page.html`);
      pages.push(p as unknown as ShaderPages[number]);
    }
    for (const { job, tmpOut } of spec.jobs) {
      await runOneJobPipeline(job, tmpOut, cwd, route, pages, frameTimeoutMs);
    }
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Full run: decode prefix, stream through the ordered steps, encode. */
export async function runShaderPass(spec: ShaderWorkerSpec): Promise<void> {
  await runShaderPassBatch({
    jobs: [{ job: spec.job, tmpOut: spec.tmpOut }],
    cwd: spec.cwd,
    step: spec.step,
    frameTimeoutMs: spec.frameTimeoutMs,
  });
}

async function childMain(): Promise<number> {
  const specPath = process.argv[2] ?? "";
  if (!specPath || !fs.existsSync(specPath)) {
    process.stderr.write("shader worker: missing spec file argument.\n");
    return 2;
  }
  let raw: ShaderWorkerSpec | ShaderWorkerBatchSpec;
  try {
    raw = JSON.parse(fs.readFileSync(specPath, "utf8")) as ShaderWorkerSpec | ShaderWorkerBatchSpec;
  } catch (err) {
    process.stderr.write(`shader worker: bad spec file (${err instanceof Error ? err.message : String(err)}).\n`);
    return 2;
  }
  try {
    if ("jobs" in raw && Array.isArray((raw as ShaderWorkerBatchSpec).jobs)) {
      await runShaderPassBatch(raw as ShaderWorkerBatchSpec);
    } else {
      await runShaderPass(raw as ShaderWorkerSpec);
    }
    return 0;
  } catch (err) {
    if (err instanceof CutholError) {
      const code = (err.diagnostic as { code?: string } | undefined)?.code;
      if (code === "CUTHOL-G708") {
        const detail = (err.diagnostic as { what?: string } | undefined)?.what ?? String(err);
        process.stderr.write(`${code} ${detail}\n`);
        return 3;
      }
      process.stderr.write(`${code ?? "CUTHOL-G707"} ${String(err.message).slice(0, 500)}\n`);
      return 1;
    }
    process.stderr.write(`shader worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const isChildEntry = process.argv[1] !== undefined && /shader_worker\.(js|ts)$/.test(process.argv[1]);
if (isChildEntry) {
  try {
    process.exit(await childMain());
  } catch (err) {
    try {
      process.stderr.write(`shader worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      // ignore
    }
    process.exit(1);
  }
}


