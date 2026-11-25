import { DiagnosticDoc } from "./docs_types.js";

export const JSON_FLAG_DOCS: DiagnosticDoc[] = [
  {
    code: "G778",
    title: "JSON flag is not usable JSON",
    checks: "Parses one JSON-valued CLI flag (inline JSON, file:path or @path) and reports the flag, the command and the received text on failure.",
    fires_when: "A JSON-valued CLI flag (--props, --params, --patch, --blocks, --variants) gets inline text that is not a JSON object/array of the expected shape.",
    source: "src/cli_args.ts (parseJsonFlag; color compare --variants calls it directly)",
    severity: "ERROR",
    gate: "G1_SCHEMA",
    messageShape: "Flag '--${...}' of '${...}' got text that is not JSON (got '${...}'; expected ${...}).${...}",
    thresholds: [{ none: true, why: "Pure argument parsing; no numeric threshold applies." }],
    fix: ["'cuthol spine fx add --item sp_01 --params file:params.json'", "'cuthol color compare --item sp_01 --variants file:variants.json'", "'cuthol explain G778'"],
  },
  {
    code: "G779",
    title: "JSON flag file reference cannot be read",
    checks: "Resolves a file:path / @path JSON flag reference against the working directory and reports the reference and resolved path when unreadable.",
    fires_when: "A JSON-valued CLI flag uses the file:path or @path form and the file is missing, empty-pathed or unreadable.",
    source: "src/cli_args.ts (parseJsonFlag; src/color/cli_parse.ts for --patch/--blocks)",
    severity: "ERROR",
    gate: "G1_SCHEMA",
    messageShape: "Flag '--${...}' of '${...}' points at a file that cannot be read ('${...}' resolved to '${...}': ${...}).",
    thresholds: [{ none: true, why: "Pure file resolution; no numeric threshold applies." }],
    fix: ["'cuthol color compare --item sp_01 --variants file:variants.json'", "'cuthol explain G779'"],
  },
];
