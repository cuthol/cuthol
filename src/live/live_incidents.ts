import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LiveIncidentReport } from "./live_types.js";

export const INCIDENTS_KEEP = 50;
export const INCIDENT_SNAPSHOT_MAX = 2 * 1024 * 1024;

function incidentsDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".cuthol", "live", "incidents");
}

function safeName(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "report";
}

function listFiles(projectDir: string): string[] {
  try {
    return fs.readdirSync(incidentsDir(projectDir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function readReport(file: string): LiveIncidentReport | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LiveIncidentReport;
  } catch {
    return null;
  }
}

export interface IncidentStoreResult {
  file: string;
  updated: boolean;
}

/** Validates a window incident report, caps the snapshot, and stores it (follow-up with same id updates outcome). */
export function storeIncidentReport(projectDir: string, raw: unknown): IncidentStoreResult {
  const r = raw as Partial<LiveIncidentReport>;
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  if (!r || typeof r !== "object") fail("incident needs an object body");
  if (typeof r.id !== "string" || r.id.trim() === "") fail("incident id is required");
  const reasons = ["no_frames", "clock_stalled", "revision_behind", "load_failed"];
  if (!reasons.includes(String(r.reason))) fail("incident reason must be no_frames|clock_stalled|revision_behind|load_failed");
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) fail("incident at must be an ISO time");
  if (typeof r.playhead_ms !== "number" || !Number.isFinite(r.playhead_ms) || r.playhead_ms < 0) fail("incident playhead_ms must be >= 0");
  if (typeof r.playing !== "boolean") fail("incident playing must be a boolean");
  if (!Array.isArray(r.recent_events)) fail("incident recent_events must be an array");
  if (!Array.isArray(r.console_errors)) fail("incident console_errors must be an array");
  if (r.action !== "reloaded_preview" && r.action !== "warned_user") fail("incident action must be reloaded_preview|warned_user");
  if (r.outcome !== undefined && r.outcome !== "recovered" && r.outcome !== "still_stuck") fail("incident outcome must be recovered|still_stuck");
  const id = r.id as string;
  const reason = r.reason as LiveIncidentReport["reason"];
  const at = r.at as string;
  const playhead_ms = r.playhead_ms as number;
  const playing = r.playing as boolean;
  const action = r.action as LiveIncidentReport["action"];
  const recent_events = (r.recent_events as unknown[]).map(String).slice(-20);
  const console_errors = (r.console_errors as unknown[]).map(String).map((s) => s.slice(0, 500)).slice(-20);
  const report: LiveIncidentReport = {
    id: id.slice(0, 64),
    reason,
    at,
    window_revision: typeof r.window_revision === "number" ? r.window_revision : null,
    server_revision: typeof r.server_revision === "number" ? r.server_revision : null,
    playhead_ms,
    playing,
    ...(typeof r.cue_id === "string" ? { cue_id: r.cue_id.slice(0, 200) } : {}),
    ...(typeof r.iframe_url === "string" ? { iframe_url: r.iframe_url.slice(0, 500) } : {}),
    ...(typeof r.comp_clock_sec === "number" || r.comp_clock_sec === null ? { comp_clock_sec: r.comp_clock_sec } : {}),
    recent_events,
    console_errors,
    ...(typeof r.snapshot_png === "string" && r.snapshot_png.length <= INCIDENT_SNAPSHOT_MAX ? { snapshot_png: r.snapshot_png } : {}),
    action,
    ...(r.outcome ? { outcome: r.outcome } : {}),
  };
  const dir = incidentsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const names = listFiles(projectDir);
  const stamp = (r.at as string).replace(/[:.]/g, "-");
  const fileName = `${stamp}_${safeName(report.id)}.json`;
  const existing = names.find((n) => n.endsWith(`_${safeName(report.id)}.json`));
  const file = path.join(dir, existing ?? fileName);
  if (existing) {
    const prev = readReport(file);
    const merged: LiveIncidentReport = { ...(prev ?? {}), ...report } as LiveIncidentReport;
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    return { file, updated: true };
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const after = listFiles(projectDir);
  for (const extra of after.slice(0, Math.max(0, after.length - INCIDENTS_KEEP))) {
    try {
      fs.unlinkSync(path.join(dir, extra));
    } catch {
      // already gone
    }
  }
  return { file, updated: false };
}

export interface IncidentSummary {
  total: number;
  recovered: number;
  still_stuck: number;
  open: number;
  last_reason: string | null;
  newest: string | null;
}

export function summarizeIncidents(projectDir: string, sinceMs: number = 3600_000): IncidentSummary {
  const cutoff = Date.now() - sinceMs;
  let total = 0;
  let recovered = 0;
  let still_stuck = 0;
  let last_reason: string | null = null;
  let newest: string | null = null;
  for (const n of listFiles(projectDir)) {
    const rep = readReport(path.join(incidentsDir(projectDir), n));
    if (!rep) continue;
    const t = Date.parse(rep.at);
    if (Number.isNaN(t) || t < cutoff) continue;
    total++;
    if (rep.outcome === "recovered") recovered++;
    else if (rep.outcome === "still_stuck") still_stuck++;
    last_reason = rep.reason;
    newest = n;
  }
  return { total, recovered, still_stuck, open: Math.max(0, total - recovered - still_stuck), last_reason, newest };
}

export function newestIncidentFile(projectDir: string): string | null {
  const names = listFiles(projectDir);
  return names.length ? path.join(incidentsDir(projectDir), names[names.length - 1]) : null;
}

/** Test hook: user-level server registry home override. */
export function userStateDir(): string {
  const override = process.env.CUTHOL_STATE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".cuthol");
}
