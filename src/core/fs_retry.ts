/**
 * Shared temp-folder cleanup for product code.
 *
 * `fs.rmSync` `maxRetries` does not retry a locked-file `EPERM` on Windows
 * (fails in ~1 ms against a file held open by another process), so product
 * cleanup lines use this explicit poll instead.
 */
import fs from "node:fs";

/** Remove a temp folder, retrying while it is briefly locked (up to `timeoutMs`). */
export function rmRetrySync(dir: string, timeoutMs = 2000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
