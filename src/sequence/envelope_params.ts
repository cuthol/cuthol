// Envelope parameter validation: the names the compiler actually applies.
// `fx.<id>.<param>` carries its own check in compile_spine_fx.ts; `color.*`
// is an open template. Everything else must be a known literal.
const KNOWN_ENVELOPE_PARAMETERS = [
  "placement.x_pct",
  "placement.y_pct",
  "placement.scale_x",
  "placement.scale_y",
  "placement.rotation_deg",
  "placement.opacity",
  "audio_chain.gain_db",
  "treatments.mask.center_x_pct",
  "treatments.mask.center_y_pct",
  "treatments.mask.width_pct",
  "treatments.mask.height_pct",
  "treatments.mask.feather_px",
  "treatments.color_grade.brightness",
  "treatments.color_grade.contrast",
  "treatments.color_grade.saturation",
] as const;

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[] = new Array(rows * cols).fill(0);
  for (let i = 0; i < rows; i++) dp[i * cols] = i;
  for (let j = 0; j < cols; j++) dp[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i * cols + j] = Math.min(
        dp[(i - 1) * cols + j] + 1,
        dp[i * cols + (j - 1)] + 1,
        dp[(i - 1) * cols + (j - 1)] + cost
      );
    }
  }
  return dp[a.length * cols + b.length];
}

export function isKnownEnvelopeParameter(parameter: string): boolean {
  if ((KNOWN_ENVELOPE_PARAMETERS as readonly string[]).includes(parameter)) return true;
  if (parameter.startsWith("fx.") || parameter.startsWith("color.")) return true;
  return false;
}

export function suggestEnvelopeParameter(parameter: string): string | null {
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const known of KNOWN_ENVELOPE_PARAMETERS) {
    const d = editDistance(parameter, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  if (best !== null && bestDist <= Math.max(3, Math.floor(parameter.length / 3))) return best;
  return null;
}

export function knownEnvelopeParameters(): string[] {
  return [...KNOWN_ENVELOPE_PARAMETERS];
}
