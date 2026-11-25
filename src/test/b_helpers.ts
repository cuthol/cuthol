/**
 * Shared helpers for the `b_live` speed brief (live window + render files).
 *
 * Only polling granularity is tightened here: every helper waits on the same
 * event with the same upper time limit as the per-file versions it replaces.
 * No thresholds, durations, presets or assertions are changed by this file.
 */

/** Wait until `fn` returns truthy (poll 50 ms) or throw after `timeoutMs`. */
export async function waitFor<T>(
  fn: () => T | Promise<T> | null | undefined | false,
  timeoutMs: number,
  what: string
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
