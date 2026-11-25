// Cuthol Live shader sources: ordered shader fx entries of a spine item with
// their .glsl source, uniform list, params and content hash, so the window can
// build WebGL2 programs and evaluate uniforms itself. Read-only.
import type http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSequence } from "../core/workspace.js";
import { DIAGNOSTICS } from "../core/diagnostics.js";
import { getSequenceEffectRegistry } from "../extensions/ext_effects.js";
import { parseShaderFileRef, parseShaderUniforms } from "../effects/shader_def.js";
import type { EffectParamValue } from "../core/schema.js";

function sendJson(res: http.ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
}

export interface LiveShaderEntry {
  id: string;
  kind: string;
  file: string;
  source: string;
  hash: string;
  uniforms: string[];
  params: Record<string, EffectParamValue>;
}

export function liveShaderSources(projectDir: string, itemId: string): { status: number; json: unknown } {
  let loaded: ReturnType<typeof loadSequence>;
  try {
    loaded = loadSequence(projectDir);
  } catch (e) {
    const d = DIAGNOSTICS.LIVE_SHADER_ENTRY_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
  const seq = loaded.sequence;
  const rootDir = loaded.paths.rootDir;
  const clip = seq.spine.clips.find((c) => c.id === itemId);
  if (!clip) {
    const d = DIAGNOSTICS.LIVE_SHADER_UNKNOWN_ITEM(itemId);
    return { status: 404, json: { ok: false, code: d.code, message: d.formatted } };
  }
  try {
    const reg = getSequenceEffectRegistry(seq, rootDir);
    const out: LiveShaderEntry[] = [];
    for (const fx of clip.fx ?? []) {
      if (!fx || fx.enabled === false) continue;
      if (!fx.kind.startsWith("ext:")) continue;
      const def = reg.fx.get(fx.kind as `ext:${string}/${string}`);
      if (!def || def.spec.backend !== "shader") continue;
      const extName = fx.kind.startsWith("ext:")
        ? fx.kind.slice(4).split("/")[0]
        : fx.kind;
      const rel = def.spec.shader ?? "";
      const parsed = parseShaderFileRef(rel, extName, fx.id, def.dir);
      const abs = path.resolve(def.dir, parsed.file);
      let source = "";
      try {
        source = fs.readFileSync(abs, "utf8");
      } catch (e) {
        const d = DIAGNOSTICS.LIVE_SHADER_SOURCE_FAILED(itemId, e instanceof Error ? e.message : String(e));
        return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
      }
      const uniforms = parseShaderUniforms(source, extName, fx.id);
      out.push({
        id: fx.id,
        kind: fx.kind,
        file: parsed.file,
        source,
        hash: createHash("sha256").update(source).digest("hex").slice(0, 16),
        uniforms: [...uniforms.animatable],
        params: { ...(fx.params as Record<string, EffectParamValue>) },
      });
    }
    return { status: 200, json: { ok: true, item: itemId, shaders: out } };
  } catch (e) {
    const d = DIAGNOSTICS.LIVE_SHADER_SOURCE_FAILED(itemId, e instanceof Error ? e.message : String(e));
    return { status: 500, json: { ok: false, code: d.code, message: d.formatted } };
  }
}

export function routeLiveShaderRequest(projectDir: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname === "/api/live/shader" && req.method === "GET") {
    const out = liveShaderSources(projectDir, url.searchParams.get("item") ?? "");
    sendJson(res, out.status, out.json);
    return true;
  }
  return false;
}
