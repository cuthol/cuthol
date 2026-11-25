/**
 * Fresh-process probe for the acoustic profile cache test.
 * Usage: node dist/test/acoustic_windows_cache_probe.js <workspaceDir> <handle>
 * Prints a single JSON line: { ok, digest, floor, flags, duration_ms, windows,
 * mean_db, windows_b64 } where windows_b64 is the base64 of the raw
 * Float64Array window bytes (little-endian), so the caller can compare every
 * window value bit-exactly.
 * Any child process it opens is awaited synchronously; nothing is left running.
 */
import os from "node:os";
import { measureAssetAcousticWindows } from "../library/waveform.js";

const workspaceDir = process.argv[2] as string;
const handle = process.argv[3] as string;
const profile = measureAssetAcousticWindows({ workspaceDir, handle });
if (!profile) {
  process.stdout.write(JSON.stringify({ ok: false }) + "\n");
} else {
  let sum = 0;
  for (let i = 0; i < profile.window_dbfs.length; i++) sum += profile.window_dbfs[i];
  const raw = Buffer.from(
    profile.window_dbfs.buffer,
    profile.window_dbfs.byteOffset,
    profile.window_dbfs.byteLength
  );
  const le = Buffer.alloc(raw.length);
  if (os.endianness() === "LE") {
    raw.copy(le);
  } else {
    for (let i = 0; i < raw.length; i += 8) {
      for (let b = 0; b < 8; b++) le[i + b] = raw[i + 7 - b];
    }
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      floor: profile.silence_floor_dbfs,
      flags: profile.has_silence_variation,
      window_ms: profile.window_ms,
      duration_ms: profile.duration_ms,
      windows: profile.window_dbfs.length,
      mean_db: sum / Math.max(1, profile.window_dbfs.length),
      first_db: profile.window_dbfs.length > 0 ? profile.window_dbfs[0] : null,
      last_db: profile.window_dbfs.length > 0 ? profile.window_dbfs[profile.window_dbfs.length - 1] : null,
      windows_b64: le.toString("base64"),
    }) + "\n"
  );
}
