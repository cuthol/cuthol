import { DiagnosticDoc } from "./docs_types.js";

export const COLOR_DOCS: DiagnosticDoc[] = [
  {
    code: "G640",
    title: "Color command failed",
    checks: "Validates color command arguments (item ids, amounts, flags) and reports the first validation failure as reason.",
    fires_when: "Any `cuthol color ...` command fails argument or state validation; the action and reason are embedded.",
    source: "src/cli_cmd_color.ts (wraps ColorFlagError and missing-handle cases)",
    severity: "ERROR",
    gate: "SYS",
    messageShape: "cuthol color ${action} failed: ${reason} (the arguments did not validate, so nothing was written).",
    thresholds: [{ none: true, why: "Argument/state validation; numeric ranges (amount 0..1) live in the color schema, not OPEN_STANDARDS." }],
    fix: ["'cuthol brief --lens flow'", "'cuthol explain G640'"],
  },
];
