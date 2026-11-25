/** Single-frame early window trim helper.
 *
 * Runs on a finished clip/cue filter chain and inserts a frame-number trim
 * (`trim=start_frame=K:end_frame=E`) as early as possible to avoid running
 * the whole clip through scale/colour/placement for one frame. Pure: input
 * lists are not mutated.
 */

export interface EarlyTrimInput {
  entries: string[];
  /** Index where the timing block ends: the trim may only go at or after this index. */
  timingEndIdx: number;
  /** Window in chain frame numbers, [K, E). */
  startFrame: number;
  endFrame: number;
  fps: number;
}

export interface EarlyTrimResult {
  entries: string[];
  applied: boolean;
  reason: string;
  /** Entry index of the inserted trim in `entries`, or -1 when not applied. */
  trimIndex: number;
  /** Filter name the trim sits behind, or null. */
  behindFilter: string | null;
}

const STATELESS_NO_ARG = new Set(["hflip", "vflip", "settb"]);
const STATELESS_WITH_ARG = new Set([
  "scale",
  "format",
  "crop",
  "pad",
  "setparams",
  "colorchannelmixer",
]);

function filterNameOf(filter: string): string {
  const t = filter.trim();
  const m = /^([a-zA-Z0-9_]+)/.exec(t);
  return m ? m[1] : "";
}

function splitTopLevel(entry: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let cur = "";
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i];
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      cur += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
      continue;
    }
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (inSingle || inDouble || depth !== 0) return null;
  parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

function frameCounterUses(filter: string, fps: number): { ok: boolean; hasAllowed: boolean } {
  const fpsStr = String(fps);
  const allowedRe = new RegExp(
    `\\(\\(\\s*in\\s*-\\s*1\\s*\\)\\s*/\\s*${fpsStr}\\s*\\)`,
    "g"
  );
  const stripped = filter.replace(allowedRe, "");
  const counterRe = /(^|[^a-zA-Z_])(n|N|in|on|out)($|[^a-zA-Z_0-9])/;
  if (counterRe.test(stripped)) return { ok: false, hasAllowed: filter !== stripped };
  return { ok: true, hasAllowed: filter !== stripped };
}

function rewriteAllowedCounters(filter: string, fps: number, k: number): string {
  const fpsStr = String(fps);
  const re = new RegExp(`\\(\\(\\s*in\\s*-\\s*1\\s*\\)\\s*/\\s*${fpsStr}\\s*\\)`, "g");
  return filter.replace(re, `((in-1+${k})/${fpsStr})`);
}

function isAllowedSetpts(filter: string): boolean {
  return /^setpts=PTS\+\d+(\.\d+)?\/TB$/.test(filter.trim());
}

function isStateless(filter: string, fps: number): boolean {
  const name = filterNameOf(filter);
  if (STATELESS_NO_ARG.has(name)) {
    if (name === "settb") return /^settb=/.test(filter.trim());
    return true;
  }
  if (name === "scale" || name === "format" || name === "crop" || name === "pad" || name === "setparams") {
    const c = frameCounterUses(filter, fps);
    return c.ok;
  }
  if (name === "colorchannelmixer") {
    if (/[nN]|in|on|out|\(t\b|\bT\b/.test(filter)) {
      const c = frameCounterUses(filter, fps);
      if (!c.ok) return false;
    }
    return frameCounterUses(filter, fps).ok;
  }
  if (name === "setpts") return isAllowedSetpts(filter);
  if (name === "geq" || name === "perspective") {
    return frameCounterUses(filter, fps).ok;
  }
  return false;
}

function isPassThrough(filter: string, fps: number): boolean {
  const name = filterNameOf(filter);
  if (name === "rotate") return frameCounterUses(filter, fps).ok;
  return isStateless(filter, fps);
}

export function applySingleFrameEarlyTrim(input: EarlyTrimInput): EarlyTrimResult {
  const { entries, timingEndIdx, startFrame, endFrame, fps } = input;
  const fail = (reason: string): EarlyTrimResult => ({
    entries: [...entries],
    applied: false,
    reason,
    trimIndex: -1,
    behindFilter: null,
  });
  const k = Math.max(0, Math.floor(startFrame));
  const e = Math.max(k + 1, Math.floor(endFrame));
  if (!Number.isFinite(k) || !Number.isFinite(e) || e <= k) return fail("empty window");
  if (timingEndIdx < 0 || timingEndIdx > entries.length) return fail("timing block out of range");
  const tail = entries.slice(timingEndIdx);
  if (tail.length === 0) return fail("empty chain tail");

  const flat: string[] = [];
  for (const entry of tail) {
    if (entry.includes("[") || entry.includes(";")) return fail("labelled entry");
    const parts = splitTopLevel(entry);
    if (!parts) return fail("unparseable entry");
    flat.push(...parts);
  }

  // The trim goes right after the last filter that is not stateless. Everything
  // left of it must pass one frame in, one frame out with PTS unchanged
  // (`rotate` plus the stateless list); everything right of it must be stateless.
  let insertAt = 0;
  for (let i = 0; i < flat.length; i++) {
    if (!isStateless(flat[i], fps)) insertAt = i + 1;
  }
  for (let i = 0; i < insertAt; i++) {
    if (!isPassThrough(flat[i], fps)) return fail(`${filterNameOf(flat[i]) || "unknown"} not pass-through`);
  }
  for (let i = insertAt; i < flat.length; i++) {
    if (!isStateless(flat[i], fps)) {
      return fail(`${filterNameOf(flat[i]) || "unknown"} not stateless`);
    }
  }

  const behind = insertAt > 0 ? flat[insertAt - 1] : null;
  const behindFilter = behind ? filterNameOf(behind) || null : null;
  const trimFilter = `trim=start_frame=${k}:end_frame=${e}`;
  const right = flat.slice(insertAt).map((f) => rewriteAllowedCounters(f, fps, k));
  const head = entries.slice(0, timingEndIdx);
  const next = [...head, ...flat.slice(0, insertAt), trimFilter, ...right];
  return { entries: next, applied: true, reason: "ok", trimIndex: head.length + insertAt, behindFilter };
}

export function rewriteEarlyTrimCounters(filter: string, fps: number, k: number): string {
  return rewriteAllowedCounters(filter, fps, k);
}
