import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN_STANDARDS } from "../core/standards.js";
import { ALL_DIAGNOSTIC_DOCS, runExplain } from "../explain/explain.js";
import { TOPIC_DOCS } from "../explain/docs_topics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const diagnosticsSrc = fs.readFileSync(path.join(repoRoot, "src", "core", "diagnostics.ts"), "utf8");

interface ParsedEntry {
  code: string;
  gate: string | null;
  severity: string | null;
  literalSeverity: boolean;
  messageShape: string | null;
  messageShapes: string[];
}

function parseDiagnostics(src: string): Map<string, ParsedEntry> {
  const out = new Map<string, ParsedEntry>();
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/"CUTHOL-G(\d+)"/);
    if (!m) continue;
    const code = `G${m[1]}`;
    const window = lines.slice(i, i + 8).join("\n");
    const gate = window.match(/"(G\d_[A-Z]+|SYS)"/)?.[1] ?? null;
    const sevMatch = window.match(/"(ERROR|WARN|INFO)"/);
    const entry: ParsedEntry = {
      code,
      gate,
      severity: sevMatch ? sevMatch[1] : null,
      literalSeverity: Boolean(sevMatch),
      messageShape: null,
      messageShapes: [],
    };
    if (!sevMatch) {
      const sevParam = window.match(/(severity|severity\s*:\s*DiagnosticSeverity)/);
      if (sevParam) entry.severity = null;
    }
    // message templates: all top-level backtick strings after the severity line
    // (some entries use a ternary with singular/plural branches).
    const sevIdx = window.search(/"(ERROR|WARN|INFO)"|severity/);
    const rest = sevIdx >= 0 ? window.slice(sevIdx) : window;
    const shapes: string[] = [];
    let k = 0;
    while (k < rest.length) {
      const tplStart = rest.indexOf("`", k);
      if (tplStart < 0) break;
      let j = tplStart + 1;
      let depth = 0;
      let tpl = "";
      let closed = false;
      while (j < rest.length) {
        const ch = rest[j];
        if (ch === "$" && rest[j + 1] === "{") {
          depth++;
          tpl += "${";
          j += 2;
          continue;
        }
        if (ch === "}" && depth > 0) {
          depth--;
          tpl += "}";
          j++;
          continue;
        }
        if (ch === "`" && depth === 0) {
          closed = true;
          break;
        }
        tpl += ch;
        j++;
      }
      if (closed) shapes.push(tpl.replace(/\$\{[^}]*\}/g, "${...}"));
      k = j + 1;
    }
    entry.messageShapes = shapes;
    entry.messageShape = shapes[0] ?? null;
    if (!out.has(code)) out.set(code, entry);
  }
  return out;
}

function normShape(s: string): string {
  return s.replace(/\$\{[^}]*\}/g, "${...}").replace(/\s+/g, " ").trim();
}

function resolveKey(key: string): boolean {
  const parts = key.split(".");
  let cur: unknown = OPEN_STANDARDS as unknown;
  for (const p of parts) {
    if (cur !== null && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return false;
    }
  }
  return true;
}

describe("explain records gate", () => {
  it("every CUTHOL-G code has a record or an allowlist entry (and no stale entries)", () => {
    const parsed = parseDiagnostics(diagnosticsSrc);
    const allowRaw = fs.readFileSync(path.join(repoRoot, "src", "explain", "missing_records.json"), "utf8");
    const allowlisted = new Set<string>((JSON.parse(allowRaw) as { missing: string[] }).missing);
    const recorded = new Set(ALL_DIAGNOSTIC_DOCS.map((d) => `CUTHOL-${d.code}`));
    for (const code of parsed.keys()) {
      const full = `CUTHOL-${code}`;
      assert.ok(
        recorded.has(full) || allowlisted.has(full),
        `${full} has no record and is not allowlisted`
      );
    }
    for (const listed of allowlisted) {
      assert.ok(!recorded.has(listed), `${listed} now has a record; remove it from missing_records.json`);
    }
  });

  it("every threshold key resolves in OPEN_STANDARDS", () => {
    for (const doc of ALL_DIAGNOSTIC_DOCS) {
      for (const t of doc.thresholds) {
        if ("key" in t) assert.ok(resolveKey(t.key), `${doc.code}: threshold ${t.key} does not resolve`);
      }
    }
  });

  it("record severity/gate/message shape matches diagnostics.ts", () => {
    const parsed = parseDiagnostics(diagnosticsSrc);
    for (const doc of ALL_DIAGNOSTIC_DOCS) {
      const entry = parsed.get(doc.code);
      assert.ok(entry, `${doc.code}: not found in diagnostics.ts`);
      assert.equal(doc.gate, entry!.gate, `${doc.code}: gate mismatch`);
      if (entry!.literalSeverity) {
        assert.equal(doc.severity, entry!.severity, `${doc.code}: severity mismatch`);
      }
      if (entry!.messageShapes.length > 0) {
        const got = normShape(doc.messageShape);
        const okShape = entry!.messageShapes.some((s) => normShape(s) === got);
        assert.ok(okShape, `${doc.code}: message shape mismatch (got ${got})`);
      }
    }
  });

  it("checks/fires_when do not merely repeat the message text", () => {
    const parsed = parseDiagnostics(diagnosticsSrc);
    for (const doc of ALL_DIAGNOSTIC_DOCS) {
      const shape = parsed.get(doc.code)?.messageShape ?? "";
      const nShape = normShape(shape);
      assert.notEqual(
        normShape(doc.checks).toLowerCase(),
        nShape.toLowerCase(),
        `${doc.code}: checks repeats the message`
      );
      assert.notEqual(
        normShape(doc.fires_when).toLowerCase(),
        nShape.toLowerCase(),
        `${doc.code}: fires_when repeats the message`
      );
    }
  });

  it("runExplain finds codes (plain, prefixed, lowercase) and topics; unknown suggests", () => {
    const byCode = runExplain("G512");
    assert.equal(byCode.ok, true);
    assert.match(byCode.text, /CUTHOL-G512/);
    assert.match(byCode.text, /LOUDNESS|no OPEN_STANDARDS threshold|thresholds/);
    const prefixed = runExplain("cuthol-g101");
    assert.equal(prefixed.ok, true);
    assert.match(prefixed.text, /CUTHOL-G101/);
    const topic = runExplain("render-audio-rate");
    assert.equal(topic.ok, true);
    assert.match(topic.text, /48000/);
    for (const t of TOPIC_DOCS) {
      const r = runExplain(t.topic);
      assert.equal(r.ok, true, `topic ${t.topic} not found`);
    }
    const unknown = runExplain("G999");
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /Close codes/);
  });
});
