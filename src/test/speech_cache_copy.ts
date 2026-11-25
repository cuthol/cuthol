import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Copy a speech cache folder into a fresh temp dir and return its path. */
export function copySpeechCacheToTemp(sharedDir: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuthol-speech-cache-"));
  fs.cpSync(sharedDir, tmp, { recursive: true });
  return tmp;
}
