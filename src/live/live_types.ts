/**
 * Cuthol Live: the shared contract between the CLI, the live server and the window.
 *
 * The window never asks the agent for anything. It reads Cuthol's own state
 * (sequence, journal, coordinate cache, render progress) through the live server,
 * and sends notes / lock changes / human edits back. Notes reach the agent in
 * the next CLI/MCP response (`live_notes` in the envelope).
 *
 * Files under `<project>/.cuthol/live/` (see live_paths.ts):
 *   server.json    LiveServerInfo, written by the running server, removed on exit
 *   lock.json      LiveLock; absent = the agent may write
 *   progress.json  LiveProgress, written by a running render
 *   inbox/         one LiveNotePacket per file (`<id>.json` + optional `<id>.png`)
 *   proxies/       low-res preview proxies (content-addressed)
 */

export const LIVE_SCHEMA = "cuthol.live/1";

/** Who may write the sequence right now. */
export type LiveLockHolder = "agent" | "human";

export interface LiveLock {
  schema: typeof LIVE_SCHEMA;
  holder: LiveLockHolder;
  /** ISO time the lock was taken. */
  since: string;
  /** Sequence revision when the human took the lock. */
  revision: number;
  /** pid of the live server that owns the lock; a dead pid makes the lock stale. */
  server_pid: number;
  /**
   * Pausing lets the agent finish the step it is on: its first write after the
   * pause still goes through (and its response tells it to wait); only writes
   * after that are refused with G601. Set once that grace write happened.
   */
  agent_grace_used?: boolean;
}

export interface LiveServerInfo {
  schema: typeof LIVE_SCHEMA;
  pid: number;
  port: number;
  /** Random per-server token; every HTTP request must carry it (`?t=` or `x-cuthol-live-token`). */
  token: string;
  started_at: string;
  /** Absolute project root the server watches. */
  project_dir: string;
  /** URL the window opens, token included. */
  url: string;
}

/** Window opening behaviour; resolved env > project > user > default. */
export type LiveMode = "ask" | "on" | "off";

export interface LiveConfigResolved {
  mode: LiveMode;
  source: "env" | "project" | "user" | "default";
}

// ---------------------------------------------------------------- events (SSE)

/** Server-sent event names. Each `data:` line is the JSON of the matching type. */
export type LiveEventName = "snapshot" | "delta" | "progress" | "lock" | "notes" | "proxy" | "hello" | "comps";

/** Outside edit of composition directories: which dirs changed plus fresh scene summaries. */
export interface LiveCompChange {
  schema: typeof LIVE_SCHEMA;
  /** Project-relative composition directories that changed. */
  dirs: string[];
  scenes: LiveSceneSummary[];
}

export interface LiveSceneSummary {
  /** Stable id: `sc_<n>` in timeline order. */
  id: string;
  start_ms: number;
  end_ms: number;
  /** Short label (clip asset name, composition name or cue label). */
  label: string;
  /** spine clip / cue handles that make up the scene. */
  members: string[];
  /**
   * Relative URL of the scene thumbnail, served by the live server. It carries
   * the thumbnail's content key (`/api/thumb/sc_3?k=<key>`), so the URL changes
   * only when the picture changes; the window uses it as is (no revision query).
   */
  thumb?: string;
}

/** Full state the window needs; sent on connect and whenever a delta cannot be applied. */
export interface LiveSnapshot {
  schema: typeof LIVE_SCHEMA;
  revision: number;
  project: { title: string; dir: string; fps: number; width: number; height: number; aspect: string; duration_ms: number; backdrop: string; /** Sequence tempo (stage.tempo); absent = 1. */ tempo?: number };
  /** The `cuthol.sequence.json` document as Cuthol stores it (the window reads spine/lanes/library from it). */
  sequence: unknown;
  scenes: LiveSceneSummary[];
  /** Last journal entries, newest first (at most 50). */
  activity: LiveActivityEntry[];
  lock: LiveLock | null;
  progress: LiveProgress | null;
}

export interface LiveActivityEntry {
  revision: number;
  timestamp: string;
  /** Journal operation, e.g. `spine.trim`. */
  operation: string;
  /** One-line human summary, e.g. `spine.trim sp_03 −1.0s`. */
  summary: string;
  /** Handles the change touched (for highlighting). */
  changed: string[];
  actor: LiveLockHolder | "unknown";
}

/** Sent when a new revision lands. The window patches its copy or asks for a snapshot. */
export interface LiveDelta {
  schema: typeof LIVE_SCHEMA;
  from_revision: number;
  revision: number;
  entry: LiveActivityEntry;
  /** JSON-path level changes, same format as `workspace changes show`. */
  paths: string[];
  /** The new sequence document (small enough to send whole; the window replaces its copy). */
  sequence: unknown;
  scenes: LiveSceneSummary[];
  /** Sequence duration at this revision (spine and lanes), the window's single source of truth. */
  duration_ms: number;
}

export interface LiveProgressStage {
  name: string;
  done: number;
  total: number;
  state: "queued" | "running" | "done" | "failed";
}

export interface LiveProgress {
  schema: typeof LIVE_SCHEMA;
  /** `render` today; room for long analyses later. */
  kind: "render";
  preset: string;
  state: "running" | "done" | "failed" | "cancelled";
  started_at: string;
  updated_at: string;
  stages: LiveProgressStage[];
  /** 0..1 across all stages, weighted. */
  fraction: number;
  eta_sec: number | null;
  elapsed_sec: number;
  encoder?: string;
  workers?: number;
  output?: string;
  /** Post-render scan results (codes only) once done. */
  findings?: string[];
  /** Set when `state` is "failed": the diagnostic that stopped the render. */
  error?: { code: string; message: string; suggestion?: string };
}

// ---------------------------------------------------------------- playhead + prewarm (window -> server)

/** The window's playhead, posted when playback pauses or a scrub settles. */
export interface LivePlayhead {
  schema: typeof LIVE_SCHEMA;
  /** Playhead position in ms. */
  ms: number;
}

/**
 * Idle pre-production: when Live is idle the server runs the render's overlay
 * stage over a window around the playhead in a background child, so the next
 * exact frames hit cached composition overlays. Default on (`live.prewarm`);
 * the disk cap is `live.prewarm_cap_gb` (default 2 GB, never deletes).
 */

// ---------------------------------------------------------------- notes (window -> agent)

export interface LiveNoteElement {
  /** `cue_12/#title` style reference, as `composition coords --elements` accepts. */
  ref: string;
  /** Stage-pixel box [x, y, w, h]. */
  box: [number, number, number, number];
  z?: number;
}

export interface LiveNote {
  /** 1-based number shown on the pin. */
  n: number;
  text: string;
  at_ms: number;
  frame: number;
  /** Stage pixels and 0..1 normalized position of the click (or area center). Absent for a general note with no pin. */
  point?: { x: number; y: number; nx: number; ny: number };
  /** Optional dragged area, stage pixels [x, y, w, h]. */
  area?: [number, number, number, number];
  /** Elements under the point, topmost first, from the coordinate engine. */
  elements: LiveNoteElement[];
  /** Overlap between the two topmost elements, if any (px²). */
  overlap_px2?: number;
  /** Composition cue under the note's time (topmost visible), when there is one. */
  cue?: string;
  /**
   * What the note is about. Absent = the single frame at `at_ms` (the original
   * behaviour). `boundary`: the cut between two consecutive cues (`at_ms` = the
   * boundary time). `range`: every cue from `from` to `to` inclusive, in sequence
   * order. `all`: every composition cue in the sequence.
   */
  scope?: LiveNoteScope;
}

export type LiveNoteScope =
  | { kind: "boundary"; from: string; to: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "all" };

/**
 * One packet = everything the human sent in one go: several notes, possibly on
 * different frames and cues. `n` numbers the notes 1..N across the whole packet.
 */
export interface LiveNotePacket {
  schema: typeof LIVE_SCHEMA;
  id: string;
  created_at: string;
  revision: number;
  notes: LiveNote[];
  /** Relative path (from the project root) of one contact sheet PNG with the pins drawn, if any. */
  sheet?: string;
  /** Present when contact-sheet cells were dropped by the sheet cap (e.g. "2 of 8 cells dropped"). */
  sheet_note?: string;
  /** Present when the packet reports human edits made while the agent was paused. */
  human_edits?: { from_revision: number; to_revision: number; entries: LiveActivityEntry[] };
  /** Present when the packet reports a human settings change from the Live window. */
  setting?: LiveSettingNotice;
}

/** A human settings change queued for the agent. */
export interface LiveSettingNotice {
  key: string;
  old_value: string;
  new_value: string;
}

/** What a CLI/MCP response carries when the inbox was not empty (field `live_notes`). */
export interface LiveNotesPayload {
  packets: LiveNotePacket[];
  /** Ready-to-print compact lines (one per note / edit summary). */
  lines: string[];
  /** Absolute paths of contact sheets to show the agent (MCP attaches them as images). */
  images: string[];
  /** Present while the user has paused the agent; the lines then start with the wait instruction. */
  paused?: { since: string };
}

/**
 * Why the Live window decided its preview stopped responding (watchdog).
 * - `no_frames`: a visible composition iframe reported no timeline clock for several seconds.
 * - `clock_stalled`: playing, but the composition's main timeline time did not advance.
 * - `revision_behind`: the window's sequence revision stayed behind the server's.
 * - `load_failed`: a composition iframe failed to load or threw during boot.
 */
export type LiveIncidentReason = "no_frames" | "clock_stalled" | "revision_behind" | "load_failed";

/**
 * Body of `POST /api/incident` (window -> server). The server stores each report as one JSON file
 * under `.cuthol/live/incidents/<iso-time>.json` and lists recent ones in `cuthol live status`.
 * The window posts one report before it self-reloads the preview, then a second one with the same
 * `id` and `outcome` once it knows whether the reload helped.
 */
export interface LiveIncidentReport {
  /** Stable id chosen by the window; the follow-up outcome report reuses it. */
  id: string;
  reason: LiveIncidentReason;
  /** ISO time the window detected the problem. */
  at: string;
  /** Sequence revision the window holds, and the server's last revision the window saw. */
  window_revision: number | null;
  server_revision: number | null;
  playhead_ms: number;
  playing: boolean;
  /** Cue id and iframe URL of the composition that stalled, when one is known. */
  cue_id?: string;
  iframe_url?: string;
  /** `__timelines.main.time()` of that iframe in seconds, or null when unreadable. */
  comp_clock_sec?: number | null;
  /** Last event types the window received from the server, newest last (at most 20). */
  recent_events: string[];
  /** Console errors captured in the window since the previous report (at most 20, each trimmed). */
  console_errors: string[];
  /** Optional PNG data URL of the frozen preview. */
  snapshot_png?: string;
  /** What the window did: `reloaded_preview` before the outcome is known. */
  action: "reloaded_preview" | "warned_user";
  /** Filled by the follow-up report: did the reload bring the preview back? */
  outcome?: "recovered" | "still_stuck";
}

/** Environment variable the live server sets when it runs a human edit through the CLI. */
export const LIVE_ACTOR_ENV = "CUTHOL_LIVE_ACTOR";

/**
 * One audio asset's waveform for the Live timeline (`GET /api/waveform/<handle>`).
 *
 * The snapshot never carries peaks: the window fetches each audio asset's
 * waveform once (lazily, when an audio cue is first drawn) and slices the bins
 * covering each cue's source range itself. `peaks` holds one normalized peak
 * per bin (0..1, the same scale `drawWave` paints).
 */
export interface LiveWaveformResponse {
  ok: true;
  handle: string;
  /** Bin count the server chose from the asset duration (~20 bins/s, clamped to 16..2000). */
  bins_count: number;
  duration_ms: number;
  peaks: number[];
}

/** Ordered shader fx entry source of GET /api/live/shader?item=<id>. */
export interface LiveShaderEntry {
  id: string;
  kind: string;
  file: string;
  source: string;
  hash: string;
  uniforms: string[];
  params: Record<string, number | boolean | string>;
}

/** Graded-preview LUT payload of GET /api/color/lut and POST /api/color/preview. */
export interface LiveColorLut {
  ok: true;
  item: string;
  hash: string;
  size: number;
  data: string;
  identity: boolean;
  selftest: { samples: number; mean_de: number; p99_de: number; max_de: number };
  bake_ms: number;
}
