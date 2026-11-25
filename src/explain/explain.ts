import { OPEN_STANDARDS } from "../core/standards.js";
import { DiagnosticDoc, TopicDoc } from "./docs_types.js";
import { SCHEMA_DOCS } from "./docs_schema.js";
import { ASSETS_DOCS } from "./docs_assets.js";
import { TIMELINE_DOCS } from "./docs_timeline.js";
import { CAPTIONS_DOCS } from "./docs_captions.js";
import { RENDER_DOCS } from "./docs_render.js";
import { COLOR_DOCS } from "./docs_color.js";
import { COMPOSITION_DOCS } from "./docs_composition.js";
import { WORKSPACE_DOCS } from "./docs_workspace.js";
import { SPEECH_DOCS } from "./docs_speech.js";
import { MONITOR_DOCS } from "./docs_monitor.js";
import { EDITING_DOCS } from "./docs_editing.js";
import { EXTENSIONS_DOCS } from "./docs_extensions.js";
import { LIVE_DOCS } from "./docs_live.js";
import { PRESETS_DOCS } from "./docs_presets.js";
import { SEQUENCE_DOCS } from "./docs_sequence.js";
import { BACKSTOP_DOCS } from "./docs_backstop.js";
import { EFFECTS_DOCS } from "./docs_effects.js";
import { JSON_FLAG_DOCS } from "./docs_json_flags.js";
import { TOPIC_DOCS } from "./docs_topics.js";

export const ALL_DIAGNOSTIC_DOCS: DiagnosticDoc[] = [
  ...SCHEMA_DOCS,
  ...ASSETS_DOCS,
  ...TIMELINE_DOCS,
  ...CAPTIONS_DOCS,
  ...RENDER_DOCS,
  ...COLOR_DOCS,
  ...COMPOSITION_DOCS,
  ...WORKSPACE_DOCS,
  ...SPEECH_DOCS,
  ...EDITING_DOCS,
  ...EXTENSIONS_DOCS,
  ...LIVE_DOCS,
  ...PRESETS_DOCS,
  ...SEQUENCE_DOCS,
  ...BACKSTOP_DOCS,
  ...EFFECTS_DOCS,
  ...MONITOR_DOCS,
  ...JSON_FLAG_DOCS,
];

export interface ExplainResult {
  ok: boolean;
  text: string;
}

function norm(code: string): string {
  return code.trim().toUpperCase().replace(/^CUTHOL-/, "");
}

function resolveThreshold(key: string): string {
  const parts = key.split(".");
  let cur: unknown = OPEN_STANDARDS as unknown;
  for (const p of parts) {
    if (cur !== null && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return `${key} = <unresolved>`;
    }
  }
  if (Array.isArray(cur)) return `${key} = [${cur.join(", ")}]`;
  if (typeof cur === "object") return `${key} = <object>`;
  return `${key} = ${String(cur)}`;
}

function renderDiagnostic(doc: DiagnosticDoc): string {
  const lines: string[] = [];
  lines.push(`[CUTHOL-${doc.code}] ${doc.title}`);
  lines.push(`severity: ${doc.severity} | gate: ${doc.gate}`);
  lines.push(`checks: ${doc.checks}`);
  lines.push(`fires when: ${doc.fires_when}`);
  lines.push(`source: ${doc.source}`);
  lines.push(`message shape: ${doc.messageShape}`);
  lines.push(`thresholds:`);
  for (const t of doc.thresholds) {
    if ("none" in t && t.none) {
      lines.push(`  - (no OPEN_STANDARDS threshold) ${t.why}`);
    } else {
      lines.push(`  - ${resolveThreshold((t as { key: string }).key)}`);
    }
  }
  lines.push(`fix:`);
  for (const f of doc.fix) lines.push(`  - ${f}`);
  if (doc.see) lines.push(`see: ${doc.see}`);
  return lines.join("\n");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

function closeCodes(q: string): string[] {
  const cands = ALL_DIAGNOSTIC_DOCS.map((d) => `CUTHOL-${d.code}`);
  const topics = TOPIC_DOCS.map((t) => t.topic);
  const all = [...cands, ...topics];
  return all
    .map((c) => ({ c, d: levenshtein(q.toUpperCase(), c.toUpperCase()) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 5)
    .map((x) => x.c);
}

export function runExplain(query: string): ExplainResult {
  const q = (query ?? "").trim();
  if (!q) return { ok: false, text: `Empty query. Known codes: ${ALL_DIAGNOSTIC_DOCS.map((d) => d.code).join(", ")}. Topics: ${TOPIC_DOCS.map((t) => t.topic).join(", ")}.` };
  const n = norm(q);
  const doc = ALL_DIAGNOSTIC_DOCS.find((d) => d.code.toUpperCase() === n);
  if (doc) return { ok: true, text: renderDiagnostic(doc) };
  const topic = TOPIC_DOCS.find((t) => t.topic.toLowerCase() === q.toLowerCase());
  if (topic) {
    const t: TopicDoc = topic;
    return { ok: true, text: `${t.topic}: ${t.title}\n${t.body}\nsee: ${t.see}` };
  }
  return {
    ok: false,
    text: `Unknown query '${q}'. Close codes/topics: ${closeCodes(q).join(", ")}.`,
  };
}
