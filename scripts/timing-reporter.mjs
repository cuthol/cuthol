// node:test reporter that records, per test file, the summed duration of its top-level
// tests and their pass/fail counts, and yields one JSON document at the end.
// Used by scripts/test.mjs next to the normal spec reporter.
export default async function* timingReporter(source) {
  /** @type {Map<string, {ms: number, tests: number, failed: number}>} */
  const files = new Map();
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data;
    if (!d || d.nesting !== 0 || !d.file) continue;
    // A file-level wrapper event repeats the totals of its tests; skip it.
    if (d.details?.type === "suite" && d.name === d.file) continue;
    const key = d.file.split(/[\\/]/).pop();
    const rec = files.get(key) ?? { ms: 0, tests: 0, failed: 0 };
    rec.ms += Number(d.details?.duration_ms ?? 0);
    rec.tests += 1;
    if (event.type === "test:fail") rec.failed += 1;
    files.set(key, rec);
  }
  const rows = [...files.entries()]
    .map(([file, r]) => ({ file, sec: Math.round(r.ms / 100) / 10, tests: r.tests, failed: r.failed }))
    .sort((a, b) => b.sec - a.sec);
  yield `${JSON.stringify({ generated_at: new Date().toISOString(), files: rows }, null, 1)}\n`;
}
