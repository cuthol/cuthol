import fs from "node:fs";
import path from "node:path";
import { userStateDir } from "./live_incidents.js";

export interface LiveServerRecord {
  pid: number;
  port: number;
  project_dir: string;
  started_at: string;
}

function registryFile(): string {
  return path.join(userStateDir(), "live-servers.json");
}

function readAll(): LiveServerRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as LiveServerRecord[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(records: LiveServerRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
    const tmp = `${registryFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, registryFile());
  } catch {
    // registry is best-effort; the per-project server.json stays authoritative
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes dead pids and returns the live records. */
export function listLiveServers(): LiveServerRecord[] {
  const live = readAll().filter((r) => alive(r.pid));
  if (live.length !== readAll().length) writeAll(live);
  return live;
}

export function othersRunning(projectDir: string): LiveServerRecord[] {
  const root = path.resolve(projectDir);
  return listLiveServers().filter((r) => path.resolve(r.project_dir) !== root);
}

export function registerLiveServer(record: LiveServerRecord): void {
  const rest = readAll().filter((r) => !(r.pid === record.pid && path.resolve(r.project_dir) === path.resolve(record.project_dir)));
  rest.push(record);
  writeAll(rest.filter((r) => alive(r.pid)));
}

export function unregisterLiveServer(pid: number, projectDir: string): void {
  const root = path.resolve(projectDir);
  writeAll(readAll().filter((r) => !(r.pid === pid && path.resolve(r.project_dir) === root)));
}
