/**
 * Centralized Diagnostic Dictionary for Cuthol.
 *
 * Every error and warning emitted by Cuthol CLI or MCP tools MUST originate from this file
 * and follow the uniform structure:
 *   `[CUTHOL-<CODE>] <What Happened> | Suggestion: <Next Action Hint for the Agent>`
 */

export type DiagnosticSeverity = "ERROR" | "WARN" | "INFO";

export type VerificationGateId =
  | "G1_SCHEMA"
  | "G2_ASSETS"
  | "G3_TIMING"
  | "G4_STAGE"
  | "G5_SIGNAL"
  | "SYS";

export interface CutholDiagnostic {
  code: string;
  gate: VerificationGateId;
  severity: DiagnosticSeverity;
  what: string;
  suggestion: string;
  subject_id?: string;
  subject_ids?: string[];
  formatted: string;
}

export function createDiagnostic(
  code: string,
  gate: VerificationGateId,
  severity: DiagnosticSeverity,
  what: string,
  suggestion: string,
  subject_id?: string,
  subject_ids?: string[]
): CutholDiagnostic {
  const formatted = `[${code}] ${what} | Suggestion: ${suggestion}`;
  const ids = subject_ids ?? (subject_id !== undefined ? [subject_id] : undefined);
  const first = subject_id ?? ids?.[0];
  return { code, gate, severity, what, suggestion, subject_id: first, subject_ids: ids, formatted };
}

/**
 * One repeat occurrence: the affected subject plus the shared detail that groups it.
 * [w1b repeats] loops that collect the same code for many items in one pass push
 * through `pushRepeatDiagnostic`; the first occurrence keeps the single-item text and
 * the second one upgrades the line to the aggregated text (count + id range + shared
 * value, every id in `subject_ids`).
 */
export interface RepeatEntry {
  subjectId: string;
  detail?: string;
}

interface RepeatGroup {
  entries: RepeatEntry[];
  index: number;
}

const repeatGroups = new WeakMap<CutholDiagnostic[], Map<string, RepeatGroup>>();

export function pushRepeatDiagnostic(
  list: CutholDiagnostic[],
  key: string,
  entry: RepeatEntry,
  makeSingle: (entry: RepeatEntry) => CutholDiagnostic,
  makeMany: (entries: RepeatEntry[]) => CutholDiagnostic
): void {
  let groups = repeatGroups.get(list);
  if (!groups) {
    groups = new Map<string, RepeatGroup>();
    repeatGroups.set(list, groups);
  }
  const group = groups.get(key);
  if (!group) {
    const diagnostic = makeSingle(entry);
    groups.set(key, { entries: [entry], index: list.length });
    list.push(diagnostic);
    return;
  }
  if (!group.entries.some((e) => e.subjectId === entry.subjectId && e.detail === entry.detail)) {
    group.entries.push(entry);
  }
  list[group.index] = makeMany(group.entries);
}

/** "cue_004 … cue_386" id range for an aggregated repeat line. */
export function repeatIdRange(ids: string[]): string {
  const sorted = [...ids].sort();
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return sorted[0];
  return `${sorted[0]} … ${sorted[sorted.length - 1]}`;
}

export class CutholError extends Error {
  public readonly diagnostic: CutholDiagnostic;
  public readonly allDiagnostics?: CutholDiagnostic[];

  constructor(diagnostic: CutholDiagnostic, allDiagnostics?: CutholDiagnostic[]) {
    super(diagnostic.formatted);
    this.name = "CutholError";
    this.diagnostic = diagnostic;
    this.allDiagnostics = allDiagnostics;
  }
}

export const DIAGNOSTICS = {
  // --- External project changes: CUTHOL-G210, CUTHOL-G211 ---
  EXTERNAL_CHANGES_PRESENT: (summary: string) =>
    createDiagnostic(
      "CUTHOL-G210",
      "G2_ASSETS",
      "INFO",
      `Outside-Cuthol edits found in this project (${summary}); the files on disk no longer match Cuthol's last journal state.`,
      `First inspect the diff with 'cuthol workspace changes show', then run 'cuthol workspace changes adopt' (adopt, undoable) or 'cuthol workspace changes revert' (back to Cuthol's last state); rule: 'cuthol explain G210'.`
    ),

  EXTERNAL_CHANGE_WOULD_BE_OVERWRITTEN: (target: string, detail: string, ids?: string[]) =>
    createDiagnostic(
      "CUTHOL-G211",
      "G2_ASSETS",
      "ERROR",
      `External change would be overwritten: '${target}' changed outside Cuthol (${detail}); the operation was stopped and the file was left unchanged so your edit is not lost.`,
      `First inspect the diff with 'cuthol workspace changes show', then run 'cuthol workspace changes adopt' or 'cuthol workspace changes revert' and retry the operation; rule: 'cuthol explain G211'.`,
      ids?.[0] ?? target,
      ids ?? [target]
    ),

  COMPOSITION_SCAFFOLD_WOULD_OVERWRITE: (compDir: string, files: string[], detail?: string) => {
    const shown = files.slice(0, 5).join(", ");
    const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
    const tail = detail ? `; ${detail}` : "";
    return createDiagnostic(
      "CUTHOL-G215",
      "G2_ASSETS",
      "ERROR",
      `Scaffolding '${compDir}' would overwrite ${files.length} edited file(s) (first: ${shown}${more}); nothing was written${tail}.`,
      detail
        ? `Keep the edited files, or move them out of the folder before scaffolding again; rule: 'cuthol explain G215'.`
        : `Keep your edits (pick another '--comp-dir'), or re-run with '--force' to overwrite them; a forced scaffold is one journal revision and 'cuthol workspace journal undo' brings the edited files back; rule: 'cuthol explain G215'.`
    );
  },

  // --- Effect system (reserved, src/effects/effect_types.ts): CUTHOL-G170..G189 definitions,
  // presets, layers and envelopes (schema/verify) · CUTHOL-G530..G549 shader pass and effect
  // render · CUTHOL-G694..G699 effect visibility in Cuthol Live. G119 (envelope on a
  // non-animatable param) keeps its meaning for every backend. ---
  // [fx:A G170–G179] effect catalog, keyframe points, value at t
  ENVELOPE_BEAT_NO_GRID: (assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G170",
      "G1_SCHEMA",
      "ERROR",
      `No cached beat grid for asset '${assetHandle}': beat number '--beat <n>' cannot be resolved to a timeline time.`,
      `Run 'cuthol library beats --asset ${assetHandle}' first, then retry with '--beat <n> --beats-of ${assetHandle}'; rule: 'cuthol explain G170'.`,
      assetHandle
    ),
  ENVELOPE_BEAT_NO_PLACEMENT: (assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G171",
      "G3_TIMING",
      "ERROR",
      `Asset '${assetHandle}' is not placed on any lane cue, so its beat grid has no timeline position.`,
      `Place the asset with 'cuthol lane add-cue --asset ${assetHandle}' first, then retry; rule: 'cuthol explain G171'.`,
      assetHandle
    ),
  ENVELOPE_BEAT_AMBIGUOUS: (assetHandle: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G172",
      "G3_TIMING",
      "ERROR",
      `Asset '${assetHandle}' is placed on ${cueIds.length} cues (${cueIds.join(", ")}), so beat number '--beat <n>' matches ${cueIds.length} timeline times.`,
      `Trim the project to a single placement of '${assetHandle}', or write the keyframe with an explicit '--at <t>' time instead; rule: 'cuthol explain G172'.`,
      assetHandle
    ),
  ENVELOPE_BEAT_INDEX_INVALID: (assetHandle: string, beat: number) =>
    createDiagnostic(
      "CUTHOL-G173",
      "G1_SCHEMA",
      "ERROR",
      `Beat ${beat} is outside the cached grid of asset '${assetHandle}' (valid: 1..grid count).`,
      `List the grid with 'cuthol library beats --asset ${assetHandle}' and pick a beat between 1 and the grid count; rule: 'cuthol explain G173'.`,
      assetHandle
    ),
  ENVELOPE_POINT_MISSING: (targetId: string, parameter: string, offsetMs: number) =>
    createDiagnostic(
      "CUTHOL-G174",
      "G1_SCHEMA",
      "ERROR",
      `No keyframe of '${parameter}' at ${offsetMs}ms on '${targetId}' (the edit targets one exact point).`,
      `List the points with 'cuthol spine envelope --clip ${targetId} --param ${parameter}' (read path), then add or move a point with 'cuthol spine envelope point add --clip ${targetId} --param ${parameter} --at <t> --value <n>'; rule: 'cuthol explain G174'.`,
      targetId
    ),
  ENVELOPE_POINT_VALUE_INVALID: (targetId: string, parameter: string) =>
    createDiagnostic(
      "CUTHOL-G175",
      "G1_SCHEMA",
      "ERROR",
      `Keyframe value of '${parameter}' on '${targetId}' is not a finite number (got a non-numeric/NaN/Infinity value).`,
      `Pass '--value <number>' with a finite value ('cuthol spine envelope point add --clip ${targetId} --param ${parameter} --at <t> --value <n>'); rule: 'cuthol explain G175'.`,
      targetId
    ),
  ENVELOPE_VALUE_UNRESOLVABLE: (targetId: string, parameter: string) =>
    createDiagnostic(
      "CUTHOL-G176",
      "G1_SCHEMA",
      "ERROR",
      `Parameter '${parameter}' on '${targetId}' has no envelope and no static value, so it cannot be evaluated at the requested time.`,
      `Add a keyframe with 'cuthol spine envelope point add --clip ${targetId} --param ${parameter} --at <t> --value <n>'; rule: 'cuthol explain G176'.`,
      targetId
    ),
  // [fx:B G180–G189] mask and motion blur
  INVALID_MASK_SPEC: (clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G180",
      "G1_SCHEMA",
      "ERROR",
      `Invalid mask on '${clipId}': ${detail} (mask is a no-op until valid).`,
      `Use 'cuthol spine mask --clip ${clipId} --shape rect|ellipse|split --center-x 0..200 --center-y 0..200 --width 1..200 --height 1..200 [--feather 0..400] [--invert|--no-invert]'; rule: 'cuthol explain G180'.`,
      clipId
    ),
  INVALID_MOTION_BLUR_SPEC: (clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G181",
      "G1_SCHEMA",
      "ERROR",
      `Invalid motion blur on '${clipId}': ${detail} (the clip renders sharp until valid).`,
      `Use 'cuthol spine motion-blur --clip ${clipId} --shutter 0..360 --subframes 2..16' or '--off'; rule: 'cuthol explain G181'.`,
      clipId
    ),

  // --- Cuthol Live: CUTHOL-G601..G619 ---
  // Blocks: G601 lock (contract) · G602–G605 server/inbox · G606–G608 window/timeline ·
  // G609–G612 live preview/proxies · G613–G615 progress/config · G616–G617 notes · G618–G619 human edits.
  LIVE_PAUSED_BY_USER: (operation: string, since: string) =>
    createDiagnostic(
      "CUTHOL-G601",
      "G1_SCHEMA",
      "ERROR",
      `The user paused the agent in the Cuthol Live window (paused since ${since}) and is editing the timeline, so '${operation}' was not applied in this run; the agent holds the Live lock contract while paused.`,
      `Do not retry yet. Run 'cuthol live wait'; it returns when the user resumes, with a summary of their edits. Read-only commands still work; rule: 'cuthol explain G601'.`
    ),
  // [live:A G602–G605]
  LIVE_SERVER_START_FAILED: (dir: string) =>
    createDiagnostic(
      "CUTHOL-G602",
      "SYS",
      "ERROR",
      `The Cuthol Live server for '${dir}' did not start within 10 s in this run (startup timeout 10 s).`,
      `Check '.cuthol/live/server.log' in the project, stop any stale server with 'cuthol live stop --dir "${dir}"', and retry 'cuthol live open'; rule: 'cuthol explain G602'.`
    ),
  // [live:B G606–G608]
  LIVE_WINDOW_OPEN_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G606",
      "SYS",
      "WARN",
      `The Cuthol Live window could not be opened in this run (${detail}). The live server keeps running; the agent's work continues.`,
      `Open the URL from 'cuthol live open' manually in Edge or Chrome, or retry once the browser is installed; rule: 'cuthol explain G606'.`
    ),
  LIVE_THUMB_FAILED: (sceneId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G607",
      "SYS",
      "WARN",
      `Scene thumbnail for '${sceneId}' could not be rendered in this run (${detail}); the scene list shows a placeholder.`,
      `Check that the scene's source media exists and 'cuthol monitor frame' works for the project, then re-open the Live window; rule: 'cuthol explain G607'.`,
      sceneId
    ),
  // [live:C G609–G612]
  LIVE_PROXY_ENCODE_FAILED: (handle: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G609",
      "G2_ASSETS",
      "WARN",
      `Preview proxy for '${handle}' could not be encoded (${detail}); the window plays the original media instead.`,
      `Check that ffmpeg is on PATH and the source file is readable, then re-open the Live window to retry.`
    ),
  LIVE_PROXY_SOURCE_MISSING: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G610",
      "G2_ASSETS",
      "WARN",
      `Preview proxy for '${handle}' was requested but the library asset file is missing.`,
      `Relink or re-import the asset; the preview falls back to the original media path.`
    ),
  LIVE_COMP_SERVE_BLOCKED: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G611",
      "G1_SCHEMA",
      "WARN",
      `Composition files for cue '${cueId}' could not be served to the Live preview in this run (${detail}); the window falls back to the non-composition preview.`,
      `Check that the cue's composition_dir exists inside the project and entry_html is present; rule: 'cuthol explain G611'.`
    ),
  LIVE_EXACT_FRAME_FAILED: (atMs: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G612",
      "G5_SIGNAL",
      "WARN",
      `Exact preview frame at ${atMs}ms could not be rendered in this run (${detail}); the window shows the approximate preview instead.`,
      `Run 'cuthol monitor frame --at ${atMs}ms' to see the full error; rule: 'cuthol explain G612'.`
    ),
  // [live:D G613–G615]
  LIVE_CONFIG_INVALID_MODE: (where: string, value: string) =>
    createDiagnostic(
      "CUTHOL-G613",
      "G1_SCHEMA",
      "ERROR",
      `Invalid Cuthol Live mode '${value}' in ${where} in this run; expected 'ask', 'on' or 'off'.`,
      `Run 'cuthol live config --mode ask|on|off' (add '--global' for the user-level setting) to fix it; rule: 'cuthol explain G613'.`
    ),
  LIVE_CONFIG_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G614",
      "SYS",
      "ERROR",
      `Could not write the Cuthol Live user setting to '${file}' in this run: ${reason}.`,
      `Check that the folder exists and is writable, or set the project-level mode instead ('cuthol live config --mode ask|on|off'); rule: 'cuthol explain G614'.`
    ),
  // [live:E G616–G617]
  LIVE_NOTE_COORDS_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G616",
      "G5_SIGNAL",
      "WARN",
      `Live note coordinate lookup failed or timed out in this run (${detail}); the note is kept without element names.`,
      `Wait for the coordinate cache to warm up (the window retries automatically), or send the note without elements; rule: 'cuthol explain G616'.`
    ),
  LIVE_NOTE_SHEET_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G617",
      "G5_SIGNAL",
      "WARN",
      `Live note contact sheet could not be rendered in this run (${detail}); the packet is queued without an image.`,
      `Run 'cuthol monitor frame' for the note's timestamp to see the full error; the note text still reaches the agent; rule: 'cuthol explain G617'.`
    ),
  // [live:F G618–G619]
  LIVE_EDIT_REVISION_CONFLICT: (
    action: string,
    detail: string,
    suggestion = "The timeline changed under the Live window; it refreshes automatically. Retry the edit, and use undo only for your own edits made while the agent is paused; rule: 'cuthol explain G618'."
  ) =>
    createDiagnostic(
      "CUTHOL-G618",
      "SYS",
      "ERROR",
      `Live edit '${action}' was not applied in this run: ${detail}.`,
      suggestion
    ),
  LIVE_EDIT_COMMAND_FAILED: (action: string, target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G619",
      "SYS",
      "ERROR",
      `Live edit '${action}' on '${target}' failed in this run: ${detail}.`,
      `Fix the underlying problem (see the command diagnostic above) and retry. If the timeline looks wrong, undo the paused session's edits one step at a time; rule: 'cuthol explain G619'.`
    ),
  // [settings G620–G624]
  SETTINGS_UNKNOWN_KEY: (key: string) =>
    createDiagnostic(
      "CUTHOL-G620",
      "G1_SCHEMA",
      "ERROR",
      `Unknown settings key '${key}' (not in the settings catalog).`,
      `Run 'cuthol settings list' to see the available keys; rule: 'cuthol explain G620'.`
    ),
  SETTINGS_INVALID_VALUE: (key: string, value: string, expected: string) =>
    createDiagnostic(
      "CUTHOL-G621",
      "G1_SCHEMA",
      "ERROR",
      `Invalid value '${value}' for setting '${key}'; expected ${expected}.`,
      `Run 'cuthol settings set ${key} <value>' with a value matching '${expected}' ('cuthol settings get ${key}' shows the current value and source); rule: 'cuthol explain G621'.`
    ),
  SETTINGS_AGENT_READONLY: (key: string) =>
    createDiagnostic(
      "CUTHOL-G622",
      "G1_SCHEMA",
      "ERROR",
      `Setting '${key}' is window-only and cannot be changed by the agent (the settings file ignores it).`,
      `Change it in the Live window (Settings > Shortcuts) instead; rule: 'cuthol explain G622'.`
    ),
  SETTINGS_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G623",
      "SYS",
      "ERROR",
      `Could not write the setting to '${file}' in this run: ${reason} (check that the folder exists and is writable).`,
      `Check that the folder exists and is writable, then retry; rule: 'cuthol explain G623'.`
    ),
  SETTINGS_ENV_LOCKED: (key: string, variable: string) =>
    createDiagnostic(
      "CUTHOL-G624",
      "G1_SCHEMA",
      "ERROR",
      `Setting '${key}' is locked by environment variable ${variable} in this run; unset it to change the stored value.`,
      `Unset ${variable} and re-run, or keep the environment value; rule: 'cuthol explain G624'.`
    ),
  // [doctor G625–G629]
  DOCTOR_FFMPEG_MISSING: () =>
    createDiagnostic(
      "CUTHOL-G625",
      "SYS",
      "ERROR",
      "ffmpeg or ffprobe was not found on PATH.",
      "Install ffmpeg 8.x (ffmpeg and ffprobe) and put it on PATH."
    ),
  DOCTOR_BROWSER_MISSING: () =>
    createDiagnostic(
      "CUTHOL-G626",
      "SYS",
      "ERROR",
      "No Chrome/Chromium browser was found for HyperFrames rendering.",
      "Install Google Chrome or Microsoft Edge and retry."
    ),
  // [setup G630–G634]
  SETUP_CONFIG_UNPARSEABLE: (file: string) =>
    createDiagnostic(
      "CUTHOL-G630",
      "SYS",
      "ERROR",
      `'${file}' cannot be parsed (invalid syntax for its format); left unchanged.`,
      `Fix the file syntax and re-run 'cuthol setup --apply'; rule: 'cuthol explain G630'.`
    ),
  SETUP_UNKNOWN_AGENT: (id: string) =>
    createDiagnostic(
      "CUTHOL-G631",
      "G1_SCHEMA",
      "ERROR",
      `Unknown agent id '${id}' for setup (handled ids: claude-code, codex, cursor, gemini-cli).`,
      `Re-run 'cuthol setup --agent <id> --apply' with one of claude-code, codex, cursor, gemini-cli as '<id>'; rule: 'cuthol explain G631'.`
    ),
  SETUP_MANUAL_ONLY: (id: string, instruction: string) =>
    createDiagnostic(
      "CUTHOL-G632",
      "SYS",
      "INFO",
      `Agent tool '${id}' has no writable config; registration is manual: ${instruction}`,
      `Follow the tool's MCP docs to register the printed command; rule: 'cuthol explain G632'.`
    ),
  SETUP_DIFFERENT_ENTRY: (where: string) =>
    createDiagnostic(
      "CUTHOL-G633",
      "SYS",
      "WARN",
      `An existing cuthol entry in '${where}' runs a different command; not replaced without --force (your current registration is kept).`,
      `Re-run the same 'cuthol setup' command with '--force' to replace it; rule: 'cuthol explain G633'.`
    ),
  SETUP_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G634",
      "SYS",
      "ERROR",
      `Could not write '${file}': ${reason}.`,
      `Check that the folder exists and is writable, then re-run the same 'cuthol setup' command; rule: 'cuthol explain G634'.`
    ),
  // [setup G250–G254] pinned ffmpeg install
  FFMPEG_SETUP_FAILED: (step: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G250",
      "SYS",
      "ERROR",
      `ffmpeg setup failed at step '${step}': ${detail}`,
      `Fix the underlying problem and re-run 'cuthol setup --ffmpeg --apply'; rule: 'cuthol explain G250'.`
    ),
  FFMPEG_SETUP_UNSUPPORTED: (platform: string, hint: string) =>
    createDiagnostic(
      "CUTHOL-G251",
      "SYS",
      "ERROR",
      `No pinned ffmpeg build for platform '${platform}' (${hint}); the pinned manifest only covers the platforms it lists.`,
      `Install ffmpeg 8.x with your package manager and check 'ffmpeg -version' shows 8.x; rule: 'cuthol explain G251'.`
    ),
  FFMPEG_SETUP_HASH_MISMATCH: (actual: string, expected: string) =>
    createDiagnostic(
      "CUTHOL-G252",
      "SYS",
      "ERROR",
      `Downloaded ffmpeg archive failed verification (sha256 ${actual}, expected ${expected}); the file was deleted.`,
      `Re-run 'cuthol setup --ffmpeg --apply' to retry the download; rule: 'cuthol explain G252'.`
    ),
  FFMPEG_SETUP_TRUNCATED: (actual: number, expected: number) =>
    createDiagnostic(
      "CUTHOL-G253",
      "SYS",
      "ERROR",
      `Downloaded ffmpeg archive is truncated (${actual} of ${expected} bytes); the file was deleted.`,
      `Re-run 'cuthol setup --ffmpeg --apply' to retry the download; rule: 'cuthol explain G253'.`
    ),
  FFMPEG_SETUP_VERIFY_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G254",
      "SYS",
      "ERROR",
      `Installed ffmpeg failed its version check: ${detail}`,
      `Remove the install folder and re-run 'cuthol setup --ffmpeg --apply'; rule: 'cuthol explain G254'.`
    ),
  // [lane-mute G125–G126]
  LANE_MUTE_SPINE: () =>
    createDiagnostic(
      "CUTHOL-G125",
      "G1_SCHEMA",
      "ERROR",
      "The spine is not a lane: 'lane mute --lane spine' targets the magnetic storyline, which has no mute switch (lanes are the 'ln_*' overlays).",
      "Mute a spine clip with 'cuthol spine mute --clip <id>', or pass a lane id ('ln_*') to 'cuthol lane mute --lane <id>'; rule: 'cuthol explain G125'.",
      "spine"
    ),
  // [edit-check G140–G149]       envelope parameter names, cue frame-grid alignment, monitor argument checks
  ENVELOPE_UNKNOWN_PARAMETER: (parameter: string, targetId: string, suggestion: string | null) =>
    createDiagnostic(
      "CUTHOL-G140",
      "G1_SCHEMA",
      "ERROR",
      `Unknown envelope parameter '${parameter}' on '${targetId}'; the render compiles no keyframe track for it, so it has no effect (known set: 'placement.*', 'audio_chain.gain_db', 'treatments.color_grade.*', 'fx.<id>.<param>', 'color.*').` +
        (suggestion ? ` Did you mean '${suggestion}'?` : ""),
      `Use one of 'placement.scale_x', 'placement.scale_y', 'placement.x_pct', 'placement.y_pct', 'placement.rotation_deg', 'placement.opacity', 'audio_chain.gain_db', 'treatments.color_grade.*', 'fx.<id>.<param>' or 'color.*'.`,
      targetId
    ),
  ENVELOPE_UNKNOWN_PARAMETER_MANY: (parameter: string, targetIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G140",
      "G1_SCHEMA",
      "ERROR",
      `Unknown envelope parameter '${parameter}' on ${targetIds.length} items (${repeatIdRange(targetIds)}); the render compiles no keyframe track for it, so it has no effect (known set: 'placement.*', 'audio_chain.gain_db', 'treatments.color_grade.*', 'fx.<id>.<param>', 'color.*').`,
      `Rename the parameter on each listed item ('cuthol spine envelope --clip <id> --param <known> --points <...>'), or drop the envelopes; rule: 'cuthol explain G140'.`,
      targetIds[0],
      targetIds
    ),
  CUE_OFF_FRAME_GRID: (cueId: string, atMs: number, frameIdx: number, gridMs: number) =>
    createDiagnostic(
      "CUTHOL-G141",
      "G3_TIMING",
      "INFO",
      `Cue '${cueId}' starts at ${atMs}ms, which is ${(gridMs - atMs).toFixed(3)}ms off the frame grid; it first appears on frame ${frameIdx} (${gridMs}ms).`,
      `Pass an on-grid start with 'cuthol lane update-cue --cue ${cueId} --at ${gridMs}ms' when the boundary must be frame-exact; the stored value is kept as given; rule: 'cuthol explain G141'.`,
      cueId
    ),
  UNITLESS_FRACTION_TIME: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G142",
      "G1_SCHEMA",
      "ERROR",
      `Unitless time '${raw}' is ambiguous (bare numbers read as milliseconds, so '${raw}' would read as ${raw}ms); add a unit.`,
      `Write '${raw}s' for seconds or '${raw}ms' for milliseconds (e.g. '21.1s' or '21100ms'); rule: 'cuthol explain G142'.`,
    ),
  SHEET_AT_WITH_WINDOW: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G143",
      "G1_SCHEMA",
      "ERROR",
      `Monitor sheet takes either explicit 'at' timestamps or a 'start'/'end' window, not both (${detail}).`,
      `Drop 'start'/'end' to sample the 'at' timestamps, or drop 'at' to sample the window; rule: 'cuthol explain G143'.`,
    ),
  SHEET_AT_WITH_WINDOW_WARN: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G144",
      "G1_SCHEMA",
      "WARN",
      `Monitor sheet ignores 'start'/'end' when several 'at' timestamps are given (${detail}).`,
      `Drop 'start'/'end' to silence this, or drop 'at' to sample the window; rule: 'cuthol explain G144'.`,
    ),
  // [boundary G520–G529]         composition boundary frames, boundary continuity (verify), render input hygiene
  BOUNDARY_CONTINUITY_MATCH: (laneId: string, atMs: number, diff: number) =>
    createDiagnostic(
      "CUTHOL-G520",
      "G5_SIGNAL",
      "INFO",
      `Boundary on '${laneId}' at ${atMs}ms is continuous (mean pixel difference ${diff.toFixed(2)} between the last frame of the outgoing composition and the first frame of the incoming one; gate G5 compares boundary frames).`,
      `No action needed; the cut is seamless at this resolution; rule: 'cuthol explain G520'.`,
    ),
  BOUNDARY_CONTINUITY_JUMP: (laneId: string, atMs: number, diff: number) =>
    createDiagnostic(
      "CUTHOL-G521",
      "G5_SIGNAL",
      "INFO",
      `Boundary on '${laneId}' at ${atMs}ms changes the picture (mean pixel difference ${diff.toFixed(2)} between the last frame of the outgoing composition and the first frame of the incoming one; gate G5 compares boundary frames).`,
      `Check the two compositions around ${atMs}ms when the cut should be seamless ('cuthol monitor frame --at ${atMs}ms'); rule: 'cuthol explain G521'.`,
    ),
  // [live-preview G670–G679]     Live preview reloads, preloading, watchdog
  LIVE_PREVIEW_RESYNCED: (reason: string) =>
    createDiagnostic(
      "CUTHOL-G670",
      "SYS",
      "WARN",
      `The Live window missed a sequence update and resynced from the server (${reason}).`,
      `If this repeats, reopen the window with 'cuthol live open' and report the tail of '.cuthol/live/server.log'.`
    ),
  LIVE_PREVIEW_PRELOAD_DROPPED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G671",
      "SYS",
      "INFO",
      `The Live window dropped the preloaded next composition '${cueId}' (${reason}).`,
      `No action needed; the preview loads compositions on demand.`
    ),
  LIVE_PREVIEW_INITIAL_SEEK: () =>
    createDiagnostic(
      "CUTHOL-G672",
      "SYS",
      "INFO",
      `The Live window seeked compositions to the playhead on first open.`,
      `No action needed.`
    ),
  LIVE_PREVIEW_INCIDENT: (reason: string, cueId: string) => {
    const where = cueId ? ` on '${cueId}'` : "";
    return createDiagnostic(
      "CUTHOL-G673",
      "SYS",
      "WARN",
      `The Live window detected a stuck preview (${reason}${where}) and reported it.`,
      `The window reloads its preview automatically; if the notice persists, reopen the window and report the incident from 'cuthol live status'.`,
      cueId
    );
  },
  LIVE_PREVIEW_RELOADED: (outcome: string) =>
    createDiagnostic(
      "CUTHOL-G674",
      "SYS",
      "WARN",
      `The Live window reloaded its preview (${outcome}).`,
      `If the preview keeps stalling, reopen the window and report the incident from 'cuthol live status'.`
    ),
  LIVE_PREVIEW_STILL_STUCK: (cueId: string) => {
    const where = cueId ? ` on '${cueId}'` : "";
    return createDiagnostic(
      "CUTHOL-G675",
      "SYS",
      "ERROR",
      `The Live preview is still stuck${where} after an automatic reload.`,
      `Reload the Live window page, then report the incident from 'cuthol live status' with the console errors it captured.`,
      cueId
    );
  },
  LIVE_PREVIEW_RELOAD_CAPPED: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G676",
      "SYS",
      "WARN",
      `The Live window stopped automatic preview reloads for '${cueId}' (3 reloads in 10 minutes).`,
      `Reload the Live window page manually; the preview keeps running with warnings only.`,
      cueId
    ),
  // [live-notes G680–G689]       Live note measurement, server instances, incident log
  LIVE_NOTE_MEASURE_OFFLOADED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G680",
      "G5_SIGNAL",
      "WARN",
      `Live note measurement runs off the server loop in this run: ${detail}; cached names attach when ready.`,
      "Wait for the cached result (the window asks again) or send the note; names attach when ready; rule: 'cuthol explain G680'."
    ),
  LIVE_OTHER_SERVER_RUNNING: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G681",
      "G5_SIGNAL",
      "WARN",
      `Another Live server is running: ${detail}.`,
      "Stop it first ('cuthol live stop --dir <project>') or reopen with '--replace'."
    ),
  LIVE_INCIDENT_STORED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G682",
      "G5_SIGNAL",
      "WARN",
      `Live window reported a preview incident in this run: ${detail}.`,
      "See the newest file under '.cuthol/live/incidents/' ('cuthol live status' names it); rule: 'cuthol explain G682'."
    ),
  // [comp-runtime G450–G459]     sequence clock, shared project assets, runtime files, lint resolution
  SEQ_TIME_CLAMPED: (helper: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G450",
      "G3_TIMING",
      "WARN",
      `Composition time clamped in '${helper}': ${detail} lies outside the composition window, so it was pinned to the nearest edge instead of failing.`,
      `Pass sequence times with the sequence clock ("clock: 'sequence'") or keep the time inside the composition window; rule: 'cuthol explain G450'.`
    ),
  SHARED_ASSET_SYNCED: (compositionDir: string, files: string[]) =>
    createDiagnostic(
      "CUTHOL-G451",
      "G2_ASSETS",
      "INFO",
      `Project shared files synced into '${compositionDir}': ${files.length} file(s) (${files.slice(0, 5).join(", ") || "none"}).`,
      `Edit shared files in the project 'shared/' folder; compositions that use them re-render automatically; rule: 'cuthol explain G451'.`
    ),
  LINT_FALSE_ALARM_RESOLVED: (code: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G452",
      "G1_SCHEMA",
      "INFO",
      `Lint finding '${code}' downgraded to info: ${reason}; the check fired on a pattern that is safe here.`,
      `No action needed; the finding stays visible as info for inspection; rule: 'cuthol explain G452'.`
    ),
  // [comp-contract G460–G469]    runtime contract probe, script check on add/verify, automatic adopt
  EXTERNAL_COMPOSITION_EDITS_AUTO_ADOPTED: (comps: string[]) =>
    createDiagnostic(
      "CUTHOL-G460",
      "G2_ASSETS",
      "INFO",
      `Adopted outside composition edits: ${comps.join(", ")} (informational; the hand edit is now a journaled revision).`,
      `Undo with 'cuthol workspace journal undo'. Edits to 'cuthol.sequence.json' still need an explicit 'cuthol workspace changes adopt'; rule: 'cuthol explain G460'.`
    ),
  BACKDROP_GAPS_SUMMARY: (count: number, totalMs: number) =>
    createDiagnostic(
      "CUTHOL-G461",
      "G3_TIMING",
      "WARN",
      `${String(count)} empty ranges show only the stage backdrop (${String(totalMs)}ms in total; gate G3 backdrop check).`,
      `Run 'cuthol verify' for the full per-range list, or cover the ranges with spine or lane cues; rule: 'cuthol explain G461'.`
    ),
  // [local-speech G237–G239]
  // [sk-w2 G770–G774]
  CUE_SHEET_FILE_NOT_FOUND: (tried: string[]) =>
    createDiagnostic(
      "CUTHOL-G770",
      "G1_SCHEMA",
      "ERROR",
      `Cue sheet file not found (looked in ${tried.map((t) => `'${t}'`).join(" and ")}).`,
      `Pass an absolute path, or place the file at one of those paths and retry.`
    ),
  // [script-ext G433, G438–G439]
  // [monitor-scaffold G214–G216]
  // [color-schema G130–G139]   colour stage / Look validation, cluster and scope checks (verify)
  COLOR_BLOCK_AMOUNT_RANGE: (subject: string, block: string, amount: unknown) =>
    createDiagnostic(
      "CUTHOL-G130",
      "G1_SCHEMA",
      "ERROR",
      `Colour block '${block}' on '${subject}' has amount '${String(amount)}'; amount must be a number in 0..1 (gate G1 colour-stage schema).`,
      `Set '${block}' amount between 0 and 1, e.g. 'cuthol color set --item ${subject} --amount ${block}=1' (omit amount for full strength); rule: 'cuthol explain G130'.`,
      subject
    ),
  COLOR_LOOK_UNKNOWN: (subject: string, look: string) =>
    createDiagnostic(
      "CUTHOL-G131",
      "G1_SCHEMA",
      "ERROR",
      `Colour stage on '${subject}' binds unknown Look '${look}' (gate G1: the Look id must exist in the project).`,
      `Bind an existing Look ('cuthol color look list' shows them) or create it with 'cuthol color look create --name ${look}'; rule: 'cuthol explain G131'.`,
      subject
    ),
  COLOR_LOOK_DUPLICATE: (look: string) =>
    createDiagnostic(
      "CUTHOL-G132",
      "G1_SCHEMA",
      "ERROR",
      `Duplicate colour Look id '${look}' (gate G1: Look ids must be unique within the project).`,
      `Remove or rename the duplicate Look ('cuthol color look remove --look ${look}'); rule: 'cuthol explain G132'.`,
      look
    ),
  COLOR_LOOK_LUT_MISSING: (look: string, uri: string) =>
    createDiagnostic(
      "CUTHOL-G133",
      "G1_SCHEMA",
      "ERROR",
      `Look '${look}' points to LUT '${uri}', which is missing, outside the project or not a .cube/.3dl file (gate G1: Look LUTs must be readable project files).`,
      `Put the .cube inside the project and recreate the Look ('cuthol color look create --name <n> --lut <file.cube>'), or remove it ('cuthol color look remove --look ${look}'); rule: 'cuthol explain G133'.`,
      look
    ),
  COLOR_LOOKS_OVERLAP: (item: string, looks: string[]) =>
    createDiagnostic(
      "CUTHOL-G134",
      "G1_SCHEMA",
      "WARN",
      `${looks.length} Looks reach '${item}' through apply_to (${looks.join(", ")}); only '${looks[0]}' is used (gate G1: one item takes one Look).`,
      `Bind the one you want ('cuthol color set --item ${item} --look <look_XX>') or narrow apply_to of the others; rule: 'cuthol explain G134'.`,
      item
    ),
  COLOR_LOOK_ON_DESIGNED_SOURCE: (item: string, look: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G135",
      "G1_SCHEMA",
      "WARN",
      `Look '${look}' is bound to '${item}', a ${kind} source; designed colour (screen recordings, graphics) usually should not take a camera Look, so this binding is likely accidental.`,
      `Unbind it ('cuthol color set --item ${item} --remove look') unless the grade was asked for, or correct the kind ('cuthol color kind --handle <vid_XX> --set camera'); rule: 'cuthol explain G135'.`,
      item
    ),
  COLOR_HDR_WITHOUT_TRANSFORM: (handle: string, transfer: string) =>
    createDiagnostic(
      "CUTHOL-G136",
      "G1_SCHEMA",
      "WARN",
      `Source '${handle}' is HDR (transfer ${transfer}) but its input transform is 'none'; it will look washed out or clipped in an SDR edit (gate G1: HDR sources need an input transform).`,
      `Use 'cuthol color kind --handle ${handle} --input auto'; rule: 'cuthol explain G136'.`,
      handle
    ),
  COLOR_SIBLING_UNGRADED: (item: string, asset: string, graded: string[]) =>
    createDiagnostic(
      "CUTHOL-G137",
      "G1_SCHEMA",
      "WARN",
      `'${item}' uses the same source '${asset}' as graded ${graded.join(", ")} but has no colour stage; the cut between them will jump (gate G1 sibling-grade check).`,
      `Copy the grade ('cuthol color set --item ${item} --patch <stage of ${graded[0]}>' or 'cuthol color look create --from-item ${graded[0]}' then bind it), or say why it differs; rule: 'cuthol explain G137'.`,
      item
    ),
  // [color-measure G240–G248]  frame sampling, map, solve, prediction inputs
  COLOR_FRAME_SAMPLE_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G240",
      "G2_ASSETS",
      "ERROR",
      `Colour frame sampling failed for item '${item}' (${detail}); no frames could be measured.`,
      `Check the item id and that its asset file exists, then re-run 'cuthol color map --item ${item}'; rule: 'cuthol explain G240'.`
    ),
  COLOR_MAP_EMPTY: (item: string) =>
    createDiagnostic(
      "CUTHOL-G241",
      "G2_ASSETS",
      "WARN",
      `Colour map of '${item}' has almost no measurable pixels (nearly every sampled frame was empty or unreadable).`,
      `Sample more frames ('cuthol color map --item ${item}') or check the source file; rule: 'cuthol explain G241'.`,
      item
    ),
  COLOR_SOLVE_NO_TARGET: (mode: string) =>
    createDiagnostic(
      "CUTHOL-G242",
      "G2_ASSETS",
      "ERROR",
      `Colour solve '${mode}' needs target frames but got 0; there is nothing to solve against.`,
      `Pass target frames or a reference file to 'cuthol color solve'; rule: 'cuthol explain G242'.`
    ),
  // [color-render G440–G449]   stage compile, LUT self-test, input transform, keyframed colour
  // [color-scan G510–G514]     post-render colour check against the prediction
  COLOR_RENDER_GRADE_OK: (summary: string, subjectIds?: string[]) =>
    createDiagnostic(
      "CUTHOL-G510",
      "G5_SIGNAL",
      "INFO",
      `Post-render colour check matches the prediction: ${summary} (mean dE per item; normal 0.6-1.5).`,
      `No action needed; the grade rendered as predicted; rule: 'cuthol explain G510'.`,
      subjectIds?.[0],
      subjectIds
    ),
  COLOR_RENDER_GRADE_MISMATCH: (item: string, atMs: number, meanDe: number) =>
    createDiagnostic(
      "CUTHOL-G512",
      "G5_SIGNAL",
      "WARN",
      `Rendered colour of '${item}' at ${atMs}ms is not what 'color set' predicted: mean dE ${meanDe} (normal 0.6-1.5).`,
      `Compare 'cuthol color map --item ${item} --graded --at ${(atMs / 1000).toFixed(1)}s' with 'cuthol monitor frame --at ${atMs}ms'; re-run 'cuthol color set' on ${item} if they differ; rule: 'cuthol explain G512'.`,
      item
    ),
  COLOR_RENDER_GRADE_MISMATCH_MANY: (items: Array<{ id: string; atMs: number; meanDe: number }>) =>
    createDiagnostic(
      "CUTHOL-G512",
      "G5_SIGNAL",
      "WARN",
      `${items.length} graded items (${repeatIdRange(items.map((i) => i.id))}) are not what 'color set' predicted (normal mean dE 0.6-1.5; worst '${[...items].sort((a, b) => b.meanDe - a.meanDe)[0].id}' dE ${[...items].sort((a, b) => b.meanDe - a.meanDe)[0].meanDe}): ${items.map((i) => `${i.id} dE ${i.meanDe}`).join(", ")}.`,
      `Compare one item with 'cuthol color map --item <id> --graded --at <t>s' against 'cuthol monitor frame --at <ms>ms'; re-run 'cuthol color set' where they differ; rule: 'cuthol explain G512'.`,
      items[0]?.id,
      items.map((i) => i.id)
    ),
  // [color-cli G640–G649]      `cuthol color` command errors
  COLOR_COMMAND_FAILED: (action: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G640",
      "SYS",
      "ERROR",
      `cuthol color ${action} failed: ${reason} (the arguments did not validate, so nothing was written).`,
      `Re-run 'cuthol brief --lens flow' to see the valid ids and flags, then retry; rule: 'cuthol explain G640'.`
    ),
  COLOR_ITEM_MISSING: (item: string) =>
    createDiagnostic(
      "CUTHOL-G641",
      "G1_SCHEMA",
      "ERROR",
      `Colour item '${item}' does not exist (expected a spine clip sp_XX or a footage/graphic lane cue cue_XX).`,
      `Check the id with 'cuthol brief --lens flow' and retry; rule: 'cuthol explain G641'.`,
      item
    ),
  // [color-live G650–G654]     Live colour endpoints and panel
  COLOR_LIVE_LUT_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G650",
      "G4_STAGE",
      "ERROR",
      `Colour LUT for spine item '${item}' could not be compiled in this run: ${detail}; the Live colour panel shows the ungraded picture.`,
      `Check that the item exists ('cuthol spine show') and its colour stage validates, then retry; rule: 'cuthol explain G650'.`
    ),
  COLOR_LIVE_PREVIEW_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G651",
      "G4_STAGE",
      "ERROR",
      `Colour drag preview for '${item}' failed: ${detail}.`,
      `Release the slider and retry; the saved stage is unchanged.`
    ),
  COLOR_LIVE_EDIT_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G652",
      "G4_STAGE",
      "ERROR",
      `Colour edit on '${item}' failed: ${detail}.`,
      `Pause the agent first, then commit the grade with 'color set --item <id> --patch'.`
    ),
  COLOR_LIVE_SCOPE_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G653",
      "G4_STAGE",
      "WARN",
      `Colour scopes could not be computed: ${detail}.`,
      `The graded picture is unaffected; reopen the scopes panel to retry.`
    ),
  COLOR_LIVE_MAP_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G654",
      "G4_STAGE",
      "ERROR",
      `Colour map for spine item '${item}' is unavailable in this run: ${detail}; the graded preview still works.`,
      `The text map needs the measurement build (sampleItemFrames + colorMap); retry after the render warms the cache; rule: 'cuthol explain G654'.`
    ),
  // [output G515–G519, G660–G664] 4K/alpha presets, timeline export
  OUTPUT_ALPHA_CODEC_SELECTED: (codec: string, container: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G515",
      "G5_SIGNAL",
      "INFO",
      `Transparent master encodes with ${codec} in ${container} (${reason}); alpha is preserved end to end.`,
      `Import the file directly in your editor; rule: 'cuthol explain G515'.`
    ),
  OUTPUT_PRESET_DIMENSIONS: (preset: string, width: number, height: number) =>
    createDiagnostic(
      "CUTHOL-G516",
      "G5_SIGNAL",
      "INFO",
      `Render preset '${preset}' targets ${width}x${height}px; overlays render at the preset size and a following master reuses the cache.`,
      `No action needed; rule: 'cuthol explain G516'.`
    ),
  OUTPUT_EXPORT_WRITTEN: (format: string, outPath: string, clips: number) =>
    createDiagnostic(
      "CUTHOL-G517",
      "G5_SIGNAL",
      "INFO",
      `Timeline exported as ${format} to '${outPath}' (${clips} spine clip(s)).`,
      `Import the file in your editor; check the 'not exported' lines for elements that need manual work; rule: 'cuthol explain G517'.`
    ),
  OUTPUT_EXPORT_SKIPPED_KIND: (kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G518",
      "G5_SIGNAL",
      "WARN",
      `Timeline export skipped ${kind}: ${detail}; those elements are missing from the exported file.`,
      `Recreate these elements by hand in the target editor, or render them from Cuthol with 'cuthol render --preset draft_480p' as overlay files; rule: 'cuthol explain G518'.`
    ),
  OUTPUT_ALPHA_SCAN_SKIPPED: (scan: string) =>
    createDiagnostic(
      "CUTHOL-G519",
      "G5_SIGNAL",
      "INFO",
      `Post-render scan '${scan}' does not run on transparent masters (empty areas are transparent by design, so the scan would false-positive).`,
      `Inspect the alpha file over a contrasting background instead; rule: 'cuthol explain G519'.`
    ),
  EXPORT_UNKNOWN_FORMAT: (got: string, want: string) =>
    createDiagnostic(
      "CUTHOL-G660",
      "G1_SCHEMA",
      "ERROR",
      `Unknown timeline export format '${got}' (expected one of: ${want}).`,
      `Run 'cuthol export timeline [fcpxml|xmeml|edl|otio] [--as <format>] --out <file>'; rule: 'cuthol explain G660'.`
    ),
  EXPORT_NO_SPINE: () =>
    createDiagnostic(
      "CUTHOL-G661",
      "G1_SCHEMA",
      "ERROR",
      `Timeline export needs at least one spine clip; the sequence spine is empty (spine clip count 0).`,
      `Cut spine clips first with 'cuthol spine append --asset <vid_XX>', or export a graphics-only timeline as markers via the overlay references; rule: 'cuthol explain G661'.`
    ),
  EXPORT_MARKER_ONLY: (count: number) =>
    createDiagnostic(
      "CUTHOL-G662",
      "G1_SCHEMA",
      "WARN",
      `${count} composition/caption cue(s) exported as markers (no rendered overlay in the cache).`,
      `Render the project first so the export can reference the overlay files.`
    ),
  EXPORT_MEDIA_MISSING: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G663",
      "G2_ASSETS",
      "WARN",
      `Export references media '${handle}' whose file could not be resolved to a local path.`,
      `Check the library entry, or relink the media before importing the export.`
    ),
  EXPORT_EDL_AUDIO_DROPPED: (audioCues: number) =>
    createDiagnostic(
      "CUTHOL-G664",
      "G1_SCHEMA",
      "WARN",
      `EDL carries spine/video only; ${audioCues} audio cue(s) left out of the file.`,
      `Use fcpxml, xmeml or otio when the mix must travel with the timeline.`
    ),
  BARE_DURATION_AS_MS: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G214",
      "G1_SCHEMA",
      "WARN",
      `Duration '${raw}' was read as ${raw} milliseconds (bare numbers are always ms); did you mean seconds? (e.g. ${raw}s)`,
      `Add a unit to the duration (e.g. '${raw}s' or '${Number(raw) * 1000}ms'). Bare numbers stay milliseconds; rule: 'cuthol explain G214'.`
    ),

  // --- Environment: CUTHOL-G212 ---
  FFMPEG_VERSION_BELOW_SUPPORTED: (tool: string, found: string) =>
    createDiagnostic(
      "CUTHOL-G212",
      "G2_ASSETS",
      "WARN",
      `${tool} ${found} found on PATH; Cuthol is tested with ffmpeg/ffprobe 8.x (tempo, loudness and scene analysis may differ on this version).`,
      `Install ffmpeg and ffprobe 8.x on PATH and re-run, or run 'cuthol setup --ffmpeg --apply'; rule: 'cuthol explain G212'.`
    ),

  // --- Keyless local speech: CUTHOL-G237–G239 ---
  LOCAL_SPEECH_NOT_INSTALLED: (reason: string) =>
    createDiagnostic(
      "CUTHOL-G237",
      "SYS",
      "ERROR",
      `Keyless local speech is not installed, so the requested local ASR/TTS run has no engine (check: ${reason}).`,
      `Run 'cuthol setup --local-speech --apply' to install it, or wire 'CUTHOL_LOCAL_ASR_CMD' / 'CUTHOL_LOCAL_TTS_CMD' instead; rule: 'cuthol explain G237'.`
    ),
  LOCAL_SPEECH_SETUP_FAILED: (step: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G238",
      "SYS",
      "ERROR",
      `Local speech setup failed at step '${step}': ${detail}; the local ASR/TTS engine is not ready.`,
      `Fix the underlying problem and re-run 'cuthol setup --local-speech --apply'; rule: 'cuthol explain G238'.`
    ),
  LOCAL_SPEECH_BRIDGE_FAILED: (op: string, detail: string, suggestion?: string) =>
    createDiagnostic(
      "CUTHOL-G239",
      "SYS",
      "ERROR",
      `Local speech ${op} failed: ${detail}.`,
      suggestion ?? `Re-run 'cuthol setup --local-speech --apply' to repair the installation, then retry; rule: 'cuthol explain G239'.`
    ),

  // --- Speech language: CUTHOL-G213 ---
  ASR_LANGUAGE_REQUIRED: (provider: string) =>
    createDiagnostic(
      "CUTHOL-G213",
      "SYS",
      "ERROR",
      `ASR provider '${provider}' cannot detect the speech language automatically, and no '--lang' was given, so transcription cannot start.`,
      `Re-run with an explicit language, e.g. 'cuthol speech transcribe --handle <id> --lang en --provider ${provider}'; rule: 'cuthol explain G213'.`
    ),

  // --- System & Workspace (SYS) ---
  WORKSPACE_NOT_FOUND: (dir: string) =>
    createDiagnostic(
      "CUTHOL-SYS01",
      "SYS",
      "ERROR",
      `No initialized Cuthol workspace ('cuthol.sequence.json') found in '${dir}'.`,
      `Create the workspace first with 'cuthol workspace init "${dir}"'.`
    ),

  INVALID_TIME_LITERAL: (raw: string) =>
    createDiagnostic(
      "CUTHOL-SYS02",
      "SYS",
      "ERROR",
      `'${raw}' is not a valid time expression.`,
      `Pass a time value with an explicit unit ('1250ms', '1.25s', '0.5min') or in 'MM:SS.mmm' form.`
    ),

  INVALID_COLOR: (raw: string) =>
    createDiagnostic(
      "CUTHOL-SYS07",
      "SYS",
      "ERROR",
      `'${raw}' is not a valid color.`,
      `Pass the color as 6-digit hex '#RRGGBB' (e.g. '#F7C531').`
    ),

  JOURNAL_REVISION_UNAVAILABLE: (direction: "undo" | "redo") =>
    createDiagnostic(
      "CUTHOL-SYS03",
      "SYS",
      "ERROR",
      `No further revision to go to in the '${direction}' direction in the journal.`,
      `Check the revision history with 'cuthol workspace journal list'.`
    ),

  EXTERNAL_TOOL_FAILED: (tool: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-SYS04",
      "SYS",
      "ERROR",
      `'${tool}' subprocess failed: ${detail}`,
      `Verify the input file is not corrupt and '${tool}' is on the system PATH.`
    ),

  MISSING_API_KEY: (envVarName: string, serviceName: string) =>
    createDiagnostic(
      "CUTHOL-SYS05",
      "SYS",
      "ERROR",
      `Environment variable '${envVarName}' is not set for the ${serviceName} service.`,
      `Add the '${envVarName}=...' key to the '.env' file in the working directory.`
    ),

  TRANSCRIPT_NOT_FOUND: (handle: string) =>
    createDiagnostic(
      "CUTHOL-SYS06",
      "SYS",
      "ERROR",
      `No cached transcript found for source '${handle}'.`,
      `Run 'cuthol speech transcribe --handle ${handle}' first.`
    ),

  // --- Gate 1: Schema & Handle Integrity (G1_SCHEMA) ---
  UNKNOWN_HANDLE: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G101",
      "G1_SCHEMA",
      "ERROR",
      `Handle '${handle}' matches no media, spine clip or lane cue in this sequence (gate G1: every referenced handle must exist).`,
      `List the available handles with 'cuthol brief --lens overview', then retry with a handle from that list; rule: 'cuthol explain G101'.`,
      handle
    ),

  DUPLICATE_HANDLE: (handle: string, occurrences?: number) =>
    createDiagnostic(
      "CUTHOL-G102",
      "G1_SCHEMA",
      "ERROR",
      occurrences === undefined
        ? `Handle '${handle}' is defined on more than one item in the sequence (handles must be unique).`
        : `Handle '${handle}' is defined on ${occurrences} items in the sequence (handles must be unique).`,
      `Rename the duplicates so every media item ('vid_*', 'aud_*'), spine clip ('sp_*') and lane cue ('cue_*') has a unique handle; rule: 'cuthol explain G102'.`,
      handle
    ),
  DUPLICATE_HANDLE_MANY: (dups: Array<{ id: string; occurrences: number }>) =>
    createDiagnostic(
      "CUTHOL-G102",
      "G1_SCHEMA",
      "ERROR",
      `${dups.length === 1 ? `Handle '${dups[0].id}' is defined on ${dups[0].occurrences} items` : `${dups.length} handles are defined on more than one item (${repeatIdRange(dups.map((d) => d.id))}: ${dups.map((d) => `'${d.id}' x${d.occurrences}`).join(", ")})`} (handles must be unique).`,
      `Rename the duplicates so every media item ('vid_*', 'aud_*'), spine clip ('sp_*') and lane cue ('cue_*') has a unique handle; rule: 'cuthol explain G102'.`,
      dups[0]?.id,
      dups.map((d) => d.id)
    ),

  DANGLING_ASSET_REF: (ownerId: string, assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G103",
      "G1_SCHEMA",
      "ERROR",
      `Item '${ownerId}' refers to source '${assetHandle}', which is not in the library (gate G1: every spine clip and lane cue must point at a known library handle).`,
      `Add the media first with 'cuthol library ingest --file <path>', or point the item at a valid handle ('cuthol brief --lens overview' lists them); rule: 'cuthol explain G103'.`,
      ownerId
    ),

  DANGLING_ANCHOR_REF: (cueId: string, anchorRef: string) =>
    createDiagnostic(
      "CUTHOL-G104",
      "G1_SCHEMA",
      "ERROR",
      `Lane cue '${cueId}' is anchored to spine clip '${anchorRef}', which does not exist (gate G1: the anchor must name a clip on the magnetic spine).`,
      `Point the anchor at an existing clip ('cuthol brief --lens overview' lists 'sp_*' ids), or convert the cue to an absolute 'at_ms' time; rule: 'cuthol explain G104'.`,
      cueId
    ),

  INVALID_COMPOSITION_CONTRACT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G105",
      "G1_SCHEMA",
      "ERROR",
      `HyperFrames composition '${cueId}' failed the contract check: ${detail} (gate G1: every composition must expose its id, timelines and deterministic render rules).`,
      `Fix 'data-composition-id', 'window.__timelines' and the determinism rules in the composition HTML file, then re-run 'cuthol verify'; rule: 'cuthol explain G105'.`,
      cueId
    ),

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  MISSING_FILE_ON_DISK: (handle: string, uri: string) =>
    createDiagnostic(
      "CUTHOL-G201",
      "G2_ASSETS",
      "ERROR",
      `Source '${handle}' points to '${uri}', which is not on disk (gate G2 requires every library uri to resolve to a readable file).`,
      `Restore the file at '${uri}', or re-ingest with 'cuthol library ingest --file <path>'; rule: 'cuthol explain G201'.`,
      handle
    ),

  SOURCE_RANGE_EXCEEDED: (clipId: string, outMs: number, assetDurationMs: number) =>
    createDiagnostic(
      "CUTHOL-G202",
      "G2_ASSETS",
      "ERROR",
      `Clip '${clipId}' source out-point (${outMs}ms) exceeds the media's physical duration (${assetDurationMs}ms); gate G2 clips every out-point to the probed file length.`,
      `Bring 'source_out_ms' down to ${assetDurationMs}ms or less ('cuthol spine trim --clip ${clipId} --out <ms>'); rule: 'cuthol explain G202'.`,
      clipId
    ),

  NO_AUDIO_STREAM: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G203",
      "G2_ASSETS",
      "ERROR",
      `Source '${handle}' has no audio stream (probe found 0 audio streams), so audio analysis, separation and speech transcription have no signal to work on.`,
      `Run audio analysis, separation or transcription only on sources with 'has_audio: true'; rule: 'cuthol explain G203'.`,
      handle
    ),

  VARIABLE_FRAME_RATE_SOURCE: (
    handle: string,
    avgFps: number,
    stageFps: number,
    rFrameRate?: string | null,
    avgFrameRate?: string | null
  ) => {
    const rateDetail =
      rFrameRate && avgFrameRate
        ? `, avg=${avgFps} fps [${avgFrameRate}], r_frame_rate=${rFrameRate}`
        : `, avg ${avgFps} fps`;
    const frameStepMs = Math.round((1000 / Math.max(1, stageFps)) * 10) / 10;
    return createDiagnostic(
      "CUTHOL-G207",
      "G2_ASSETS",
      "INFO",
      `Source '${handle}' is variable frame rate (VFR${rateDetail}); during compilation Cuthol converts video to the stage frame rate (${stageFps} fps CFR, 'settb=AVTB,fps=${stageFps}:eof_action=pass') and audio with 'aresample=async=1:first_pts=0'. If the source has sudden frame-rate drops, expect frame duplication/drops there and ±${frameStepMs}ms (1 frame) rounding at cut boundaries; this line is informational, no threshold is applied.`,
      `No action needed; check critical cuts or screen-recording transitions with 'cuthol monitor frame --at <ms>ms'; rule: 'cuthol explain G207'.`,
      handle
    );
  },

  BT2020_COLOR_SPACE_SOURCE: (
    handle: string,
    colorSpace: string,
    colorTransfer?: string | null,
    colorPrimaries?: string | null
  ) => {
    const trcDetail = colorTransfer ? `, color_transfer=${colorTransfer}` : "";
    const primDetail = colorPrimaries ? `, color_primaries=${colorPrimaries}` : "";
    return createDiagnostic(
      "CUTHOL-G208",
      "G2_ASSETS",
      "INFO",
      `Source '${handle}' is tagged BT.2020 (color_space=${colorSpace}${trcDetail}${primDetail}); Cuthol converts YCbCr with the 'in_color_matrix=bt2020:out_color_matrix=bt709' matrix but applies no HDR gamma/primaries tone mapping, so PQ/HLG highlights may clip; this line is informational, no threshold is applied.`,
      `For SDR BT.2020 sources the matrix conversion is enough; for HDR (PQ/HLG) sources apply external SDR tone mapping if needed, or check colors with 'cuthol monitor frame --at <ms>ms'; rule: 'cuthol explain G208'.`,
      handle
    );
  },

  AV_STREAM_DURATION_MISMATCH: (videoMs: number, audioMs: number, frameMs: number, handle?: string) =>
    createDiagnostic(
      "CUTHOL-G209",
      "G2_ASSETS",
      "WARN",
      `In the processor output the video stream is ${Math.round(videoMs)} ms and audio is ${Math.round(audioMs)} ms; the gap of ${Math.abs(Math.round(videoMs - audioMs))} ms is larger than one frame (${Math.max(1, Math.round(frameMs))} ms), so the muxed output would drift (a duration-changing video filter with unadjusted audio is the usual cause).`,
      `Add "audio": "drop" to the processor to drop audio on a duration-changing video filter, or write an audio_filter that equalizes the durations; rule: 'cuthol explain G209'.`,
      handle
    ),

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  SUB_FRAME_DURATION: (itemId: string, durationMs: number, minMs: number) =>
    createDiagnostic(
      "CUTHOL-G301",
      "G3_TIMING",
      "ERROR",
      `Item '${itemId}' duration (${durationMs}ms) is below the 2-frame minimum (${minMs}ms) at the stage frame rate (gate G3: every item must cover at least 2 frames).`,
      `Delete the item ('cuthol spine remove --clips ${itemId}') or extend its duration to at least ${minMs}ms; rule: 'cuthol explain G301'.`,
      itemId
    ),

  SPINE_DISCONTINUITY: (clipId: string, expectedStartMs: number, actualStartMs: number) =>
    createDiagnostic(
      "CUTHOL-G302",
      "G3_TIMING",
      "ERROR",
      `Clip '${clipId}' on the magnetic spine starts at ${actualStartMs}ms instead of ${expectedStartMs}ms (gap or overlap of ${actualStartMs - expectedStartMs}ms; gate G3 requires a gapless spine).`,
      `Repair spine continuity ('cuthol spine reorder --clip ${clipId} --after <sp_XX>' moves it; check neighbors with 'cuthol brief --lens timing'); rule: 'cuthol explain G302'.`,
      clipId
    ),

  TRANSITION_TOO_LONG: (clipId: string, transMs: number, maxAllowedMs: number) =>
    createDiagnostic(
      "CUTHOL-G303",
      "G3_TIMING",
      "ERROR",
      `Out-transition of '${clipId}' (${transMs}ms) exceeds the maximum allowed by the neighboring clips (${maxAllowedMs}ms; gate G3: a transition cannot be longer than either neighbor).`,
      `Lower the transition duration to ${maxAllowedMs}ms or less ('cuthol spine transition --clip ${clipId} --duration ${maxAllowedMs}ms'); rule: 'cuthol explain G303'.`,
      clipId
    ),

  INVALID_PLAYBACK_RATE: (clipId: string, rate: number) =>
    createDiagnostic(
      "CUTHOL-G304",
      "G3_TIMING",
      "ERROR",
      `Playback rate (${rate}x) for clip '${clipId}' is outside the valid range (0.1x .. 16.0x, gate G3 speed limit).`,
      `Set a rate between 0.1 and 16.0 ('cuthol spine speed --clip ${clipId} --rate 1'); rule: 'cuthol explain G304'.`,
      clipId
    ),

  ENVELOPE_OUT_OF_RANGE: (ownerId: string, param: string, offsetMs: number, durationMs: number) =>
    createDiagnostic(
      "CUTHOL-G305",
      "G3_TIMING",
      "ERROR",
      `Keyframe of '${param}' on '${ownerId}' (${offsetMs}ms) is outside the item duration (0..${durationMs}ms; gate G3: keyframes must sit inside their item).`,
      `Define keyframe times within 0ms..${durationMs}ms ('cuthol spine envelope --clip ${ownerId} --param ${param} --points <...>'); rule: 'cuthol explain G305'.`,
      ownerId
    ),

  LANE_EXTENDS_PAST_SPINE: (cueId: string, cueEndMs: number, spineEndMs: number) =>
    createDiagnostic(
      "CUTHOL-G306",
      "G3_TIMING",
      "WARN",
      `Lane cue '${cueId}' ends at ${cueEndMs}ms, ${cueEndMs - spineEndMs}ms past the spine duration (${spineEndMs}ms); gate G3 ends every lane cue at or before the spine end (no spine picture in ${spineEndMs}..${cueEndMs}ms).`,
      `Append/extend spine clips to cover ${cueEndMs}ms, or trim the cue ('cuthol lane update-cue --cue ${cueId} --duration <ms>'); rule: 'cuthol explain G306'.`,
      cueId,
      [cueId]
    ),

  LANE_EXTENDS_PAST_SPINE_MANY: (entries: Array<{ cueId: string; cueEndMs: number; spineEndMs: number }>) => {
    const ids = entries.map((e) => e.cueId);
    const worst = [...entries].sort((a, b) => b.cueEndMs - a.cueEndMs - (b.spineEndMs - a.spineEndMs))[0];
    const spineEndMs = entries[0]?.spineEndMs ?? 0;
    return createDiagnostic(
      "CUTHOL-G306",
      "G3_TIMING",
      "WARN",
      `${entries.length} lane cues (${repeatIdRange(ids)}) end past the spine duration (${spineEndMs}ms); worst '${worst.cueId}' ends at ${worst.cueEndMs}ms (${worst.cueEndMs - worst.spineEndMs}ms past; gate G3 ends every lane cue at or before the spine end).`,
      `Append/extend spine clips past ${worst.cueEndMs}ms, or trim the cues ('cuthol lane update-cue --cue <cue_XX> --duration <ms>'); rule: 'cuthol explain G306'.`,
      ids[0],
      ids
    );
  },

  EMPTY_SEQUENCE: (severity: DiagnosticSeverity) =>
    createDiagnostic(
      "CUTHOL-G307",
      "G3_TIMING",
      severity,
      `Empty edit: no clips on the spine and no cues on any unmuted lane, so the sequence duration is 0ms (a render or export needs duration > 0ms).`,
      `For a footage edit run 'cuthol spine append --asset <vid_XX>'; for a graphics-only video add a composition ('cuthol lane add-composition --lane <ln_XX> --comp-dir <dir>') and audio with 'cuthol lane add-cue --lane ln_vo --kind voiceover --asset <aud_XX>'; rule: 'cuthol explain G307'.`
    ),

  BACKDROP_ONLY_SPAN: (startMs: number, endMs: number) =>
    createDiagnostic(
      "CUTHOL-G308",
      "G3_TIMING",
      "WARN",
      `Spine is empty and no visual cue is on screen in ${startMs}..${endMs}ms (${endMs - startMs}ms); only the stage backdrop shows during this span (gate G3 backdrop check).`,
      `Fill the span with a composition/title/visual cue ('cuthol lane add-cue --lane <ln_XX> --at ${startMs}ms --duration ${endMs - startMs}ms'), or extend the adjacent cue; if the empty backdrop is intentional, this warning is informational; rule: 'cuthol explain G308'.`
    ),

  BARE_BACKDROP_UNDER_TRANSPARENT_COMPOSITION: (
    spans: Array<{ start_ms: number; end_ms: number }>,
    backdropColor: string,
    cueIds: string[],
    severity: "WARN" | "INFO" = "INFO"
  ) => {
    const spanList = spans.map((s) => `${s.start_ms}..${s.end_ms}ms`).join(", ");
    const cueList = cueIds.map((id) => `'${id}'`).join(", ");
    return createDiagnostic(
      "CUTHOL-G316",
      "G3_TIMING",
      severity,
      `Spine is empty and in ${spanList} the only picture comes from transparent composition cue(s) ${cueList} with mostly-empty alpha, so the bare stage backdrop (${backdropColor}) shows through (gate G3 backdrop check).`,
      `Set a base color with 'cuthol workspace backdrop --color #RRGGBB', or add an opaque background layer under the composition; rule: 'cuthol explain G316'.`
    );
  },

  SHORT_SPINE_CLIP: (clipId: string, durationMs: number, recommendedMinMs: number) =>
    createDiagnostic(
      "CUTHOL-G309",
      "G3_TIMING",
      "WARN",
      `Spine clip '${clipId}' is ${durationMs}ms, at most ${recommendedMinMs}ms; a leftover sliver may remain between cuts (gate G3 flags clips this short for review).`,
      `If it is a leftover, delete it with 'cuthol spine remove --clips ${clipId}' or merge it with the neighboring cut; rule: 'cuthol explain G309'.`,
      clipId
    ),

  SHORT_SPEECH_FRAGMENT: (clipId: string, durationMs: number, maxMs: number) =>
    createDiagnostic(
      "CUTHOL-G312",
      "G3_TIMING",
      "INFO",
      `Spine clip '${clipId}' (${durationMs}ms) is a short speech fragment, possibly a restart leftover (gate G3: speech between 150ms and ${maxMs}ms with audio above the silence floor).`,
      `If it is a restart leftover, delete it with 'cuthol spine remove --clips ${clipId}'; if intentional, ignore this note; rule: 'cuthol explain G312'.`,
      clipId
    ),

  // --- Gate 4: Stage Geometry, Safe Zones & Legibility (G4_STAGE) ---
  SAFE_ZONE_VIOLATION: (cueId: string, edge: string, overflowPx: number) =>
    createDiagnostic(
      "CUTHOL-G401",
      "G4_STAGE",
      "WARN",
      `Caption/title '${cueId}' crosses the '${edge}' title-safe edge by ${Math.round(overflowPx)}px (10% of the stage edge; rule: 'cuthol explain G401').`,
      `Move it toward the center, e.g. 'cuthol lane update-cue --cue ${cueId} --y -=5' (negative y moves up), or lower '--size'; rule: 'cuthol explain G401'.`,
      cueId
    ),

  SAFE_ZONE_VIOLATION_MANY: (
    laneId: string,
    edge: string,
    entries: Array<{ cueId: string; overflowPx: number; boxEdgePx: number; safeEdgePx: number }>
  ) => {
    const ids = entries.map((e) => e.cueId);
    const worst = [...entries].sort((a, b) => b.overflowPx - a.overflowPx)[0];
    const sharedPx = Math.round(worst.overflowPx);
    return createDiagnostic(
      "CUTHOL-G401",
      "G4_STAGE",
      "WARN",
      `${entries.length} cues on ${laneId} (${repeatIdRange(ids)}) cross the '${edge}' title-safe edge by ${sharedPx}px: box ${edge}=${Math.round(worst.boxEdgePx)}px, title-safe ${edge}=${Math.round(worst.safeEdgePx)}px (10% of the stage edge; rule: 'cuthol explain G401').`,
      `Move them up, e.g. 'cuthol lane update-cue --cue ${ids[0]} --y -=5' (negative y moves up), or lower '--size'; rule: 'cuthol explain G401'.`,
      ids[0],
      ids
    );
  },

  CAPTION_READING_SPEED_HIGH: (cueId: string, cps: number, maxCps: number) =>
    createDiagnostic(
      "CUTHOL-G402",
      "G4_STAGE",
      "WARN",
      `Caption '${cueId}' reads at ${cps.toFixed(1)} cps, above the ${maxCps} cps ceiling (Netflix Timed Text / TR adaptation; rule: 'cuthol explain G402').`,
      `Shorten the caption text or give it more on-screen time ('cuthol lane update-cue --cue ${cueId} --duration <ms>'); rule: 'cuthol explain G402'.`,
      cueId
    ),

  CAPTION_READING_SPEED_HIGH_MANY: (
    laneId: string,
    entries: Array<{ cueId: string; cps: number; maxCps: number }>
  ) => {
    const ids = entries.map((e) => e.cueId);
    const worst = [...entries].sort((a, b) => b.cps - a.cps)[0];
    return createDiagnostic(
      "CUTHOL-G402",
      "G4_STAGE",
      "WARN",
      `${entries.length} captions on ${laneId} (${repeatIdRange(ids)}) read above the ${worst.maxCps} cps ceiling (Netflix Timed Text / TR adaptation; worst '${worst.cueId}' ${worst.cps.toFixed(1)} cps; rule: 'cuthol explain G402').`,
      `Shorten the caption texts or give them more on-screen time ('cuthol lane update-cue --cue <cue_XX> --duration <ms>'); or regenerate the track with fewer words per cue so durations are re-fit to the ceiling ('cuthol speech captions --replace --max-words <n>'); rule: 'cuthol explain G402'.`,
      ids[0],
      ids
    );
  },

  TEXT_OCCLUDED_BY_LAYER: (textCueId: string, occluderCueId: string) =>
    createDiagnostic(
      "CUTHOL-G403",
      "G4_STAGE",
      "WARN",
      `Text item '${textCueId}' is covered by layer '${occluderCueId}' with a higher z_index (over a quarter of the text box overlaps while both are on screen; rule: 'cuthol explain G403').`,
      `Raise the text lane's 'z_index', or shift the covering layer ('cuthol lane update-cue --cue ${occluderCueId} ...'); rule: 'cuthol explain G403'.`,
      textCueId
    ),

  SCENE_HOST_RECOMMENDED: (cueId: string, detectedFeatures: string[]) =>
    createDiagnostic(
      "CUTHOL-G406",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' uses '${detectedFeatures.join(", ")}' but runs in 'overlay_alpha' (Mode A), so these effects cannot see the video pixels underneath (gate G4: pixel effects need scene_host).`,
      `Re-add it in scene-host mode ('cuthol lane add-composition --comp-dir <dir> --mode scene_host --duration <ms>ms') so the effect processes the video pixels underneath; rule: 'cuthol explain G406'.`,
      cueId
    ),

  COMPOSITION_LINT_FINDING: (
    cueId: string,
    ruleCode: string,
    message: string,
    fixHint?: string,
    severity: DiagnosticSeverity = "WARN"
  ) =>
    createDiagnostic(
      "CUTHOL-G407",
      "G4_STAGE",
      severity,
      `HyperFrames lint finding in composition '${cueId}' (rule '${ruleCode}'; gate G4 lints the composition HTML/GSAP): ${message}; rule: 'cuthol explain G407'.`,
      fixHint && fixHint.trim()
        ? `${fixHint.trim()}; rule: 'cuthol explain G407'.`
        : `Fix the composition HTML/GSAP code per rule '${ruleCode}' ('cuthol composition preview --cue ${cueId}' shows the page); rule: 'cuthol explain G407'.`,
      cueId
    ),

  RENDER_FIELD_NOT_APPLIED: (itemId: string, field: string) =>
    createDiagnostic(
      "CUTHOL-G409",
      "G4_STAGE",
      "WARN",
      `'${field}' on '${itemId}' is not applied to the render in this version (gate G4: only masks, motion blur, static and enveloped brightness/contrast/saturation, color temperature and LUT, and block-based 'color.*' envelopes reach the render).`,
      `Leave this field at its default on '${itemId}', or move the look into a supported field; rule: 'cuthol explain G409'.`,
      itemId
    ),

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  TRUE_PEAK_CEILING_EXCEEDED: (itemId: string, peakDbtp: number, ceilingDbtp: number) =>
    createDiagnostic(
      "CUTHOL-G501",
      "G5_SIGNAL",
      "WARN",
      `True peak of audio signal '${itemId}' reaches ${peakDbtp.toFixed(1)} dBTP, above the ${ceilingDbtp.toFixed(1)} dBTP ceiling (ITU-R BS.1770-4; gate G5 measures the mixed signal).`,
      `Run 'cuthol mix normalize --target-lufs -14' on '${itemId}', or lower its gain ('gain_db'); rule: 'cuthol explain G501'.`,
      itemId
    ),

  BLANK_FRAME_DETECTED: (timestampMs: number, lumaMean: number, lumaStd: number) =>
    createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      `Sampled frame at ${timestampMs}ms is almost fully dark/blank or flat backdrop color (luma mean=${lumaMean.toFixed(1)}, std=${lumaStd.toFixed(2)}; a normal picture has std well above 5).`,
      `Check the frame with 'cuthol monitor frame --at ${timestampMs}ms'; if it is not an intentional fade, fix the source range; rule: 'cuthol explain G502'.`
    ),

  RENDER_EDGE_STRIP: (edges: string[], width: number, height: number) =>
    createDiagnostic(
      "CUTHOL-G506",
      "G5_SIGNAL",
      "WARN",
      `There is an 8px black strip on the ${edges.join(" and ")} edge of the render output (${width}x${height}px); the content does not reach the edge (expected: picture across the full ${width}x${height}px frame).`,
      `This is usually caused by an ffmpeg build zeroing the last columns when converting planar RGB to yuv420p at widths that are not multiples of 16 (e.g. 1080). Check the ffmpeg/HyperFrames version and re-render; if the problem persists, set the stage width to a multiple of 16; rule: 'cuthol explain G506'.`
    ),

  RENDER_BLANK_FRAMES_DETECTED: (
    events: Array<{ start_s: number; start_ms: number; frame_count: number; clip_id?: string }>
  ) => {
    const totalFrames = events.reduce((acc, e) => acc + e.frame_count, 0);
    const timeList = events
      .map((e) => `${e.start_s}s (${e.start_ms}ms${e.clip_id ? `, ${e.clip_id}` : ""})`)
      .join(", ");
    const firstMs = events[0]?.start_ms ?? 0;
    return createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      events.every((e) => e.clip_id)
        ? `Blank flat/backdrop-colored frames detected in the render output at ${events.length} point(s) (${totalFrames} frames) during an active spine clip: ${timeList}.`
        : `Blank frames in the render output in ${events.length} span(s) (${totalFrames} frames) with no visual cue (only the stage backdrop visible): ${timeList}.`,
      events.every((e) => e.clip_id)
        ? `Check the cut point with 'cuthol monitor frame --at ${firstMs}ms'; if it is not an intentional fade, fix the source clip range or the transition boundaries.`
        : `Check with 'cuthol monitor frame --at ${firstMs}ms'; fill the span with a composition/visual cue, or extend the adjacent cue.`
    );
  },

  HYPERFRAMES_RENDER_FAILED: (compositionDir: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G503",
      "G5_SIGNAL",
      "ERROR",
      `HyperFrames composition '${compositionDir}' failed to render; the render stopped with no fallback image substituted: ${reason}.`,
      `Open the page with 'cuthol composition preview --cue <cue_XX>' to see the error, then re-render with 'cuthol render --preset draft_480p'; rule: 'cuthol explain G503'.`,
      compositionDir
    ),

  // --- Unprobed compositions: CUTHOL-G509 ---
  COMPOSITIONS_NEVER_PROBED_IN_BROWSER: (count: number) =>
    createDiagnostic(
      "CUTHOL-G509",
      "G4_STAGE",
      "INFO",
      count === 1
        ? `1 composition was never opened in a browser, so its script is unchecked (no probe record; rule: 'cuthol explain G509').`
        : `${count} compositions were never opened in a browser, so their scripts are unchecked (no probe records; rule: 'cuthol explain G509').`,
      `Run 'cuthol verify' (it checks every unchecked composition in one browser run). If verify itself reports this, its browser check could not run: run 'cuthol composition preview --cue <cue_XX>' to see why; rule: 'cuthol explain G509'.`
    ),

  DUCKING_WITHOUT_TRANSCRIPT: (clipIds: string[], mode: "skipped" | "acoustic_vad") =>
    createDiagnostic(
      "CUTHOL-G504",
      "G5_SIGNAL",
      "WARN",
      mode === "skipped"
        ? `${clipIds.length} spine clip(s) (${repeatIdRange(clipIds)}) have no transcript, so ducking was timed from transcribed clips and 'ln_vo' voiceovers only; untranscribed speech in these clips is not ducked around.`
        : `${clipIds.length} spine clip(s) (${repeatIdRange(clipIds)}) have no transcript, so ducking was timed from signal-based acoustic energy (VAD) instead of word timings; boundaries may be early or late vs the spoken words.`,
      `For word-accurate ducking, run 'cuthol speech transcribe --handle <vid_XX>' first on clips containing speech; rule: 'cuthol explain G504'.`,
      clipIds[0],
      clipIds
    ),

  OPAQUE_OVERLAY_LEAK: (cueId: string, opaqueRatio: number, cornerAlphaMax: number) =>
    createDiagnostic(
      "CUTHOL-G505",
      "G5_SIGNAL",
      "WARN",
      `Background leak in transparent overlay composition '${cueId}': fully-opaque ratio ${(opaqueRatio * 100).toFixed(1)}% with corner alpha ${cornerAlphaMax}/255, so the alpha gate treats the background as visible (opaque corners should read 0).`,
      `Set 'body, #root { background: transparent; }' in the composition of '${cueId}', remove any '[data-cuthol-preview]' element, then re-check with 'cuthol composition preview --cue ${cueId}'; rule: 'cuthol explain G505'.`,
      cueId
    ),

  COMPOSITION_AUDIO_UNAVAILABLE: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G507",
      "G5_SIGNAL",
      "WARN",
      `Composition '${cueId}' reads 'C.audio' but no audio-energy envelope could be produced in its window (${detail}), so 'C.audio' returns 0 every frame (gate G5: the cue window needs an audible source).`,
      `Put an audible source (spine, voiceover, effect or music) in the cue window and check the file ('cuthol library waveform --handle <aud_XX|vid_XX>'); rule: 'cuthol explain G507'.`,
      cueId
    ),

  RENDER_AUDIO_ALIGNMENT_MISMATCH: (
    issues: Array<{
      item_id: string;
      check_at_ms: number;
      measured_offset_ms: number;
      similarity: number;
      detail: string;
    }>
  ) => {
    const summary = issues
      .map(
        (x) =>
          `${x.item_id}@${Math.round(x.check_at_ms)}ms (${x.detail}, offset=${x.measured_offset_ms >= 0 ? "+" : ""}${x.measured_offset_ms.toFixed(1)}ms, similarity=${x.similarity.toFixed(2)})`
      )
      .join("; ");
    const firstId = issues[0]?.item_id;
    return createDiagnostic(
      "CUTHOL-G508",
      "G5_SIGNAL",
      "WARN",
      `Post-render audio health check of '${firstId ?? "cue/clip"}' found audio drift or signal loss at ${issues.length} point(s): ${summary} (offsets in ms vs the planned chain, similarity 0..1).`,
      `Check the segment-boundary transition and start time of '${firstId ?? "cue/clip"}' with 'cuthol spine show' and re-render with 'cuthol render --preset draft_480p'; rule: 'cuthol explain G508'.`,
      firstId
    );
  },

  REVISION_MISMATCH: (expectedRev: number, actualRev: number) =>
    createDiagnostic(
      "CUTHOL-G109",
      "G1_SCHEMA",
      "ERROR",
      `Stale revision guard: the command passed --expect-rev r${expectedRev} but the sequence is at r${actualRev} (another command advanced the journal since this one was planned); nothing was written.`,
      `See what changed with 'cuthol workspace journal list', then re-run the same command with '--expect-rev ${actualRev}'; rule: 'cuthol explain G109'.`
    ),

  // [fxcheck:A G320–G329] fx instance check (card run + sentinel) and frozen-param check
  FX_CHECK_SKIPPED_NO_FFMPEG: () =>
    createDiagnostic(
      "CUTHOL-G320",
      "G4_STAGE",
      "WARN",
      "ffmpeg is not on PATH in this run; the fx instance check was skipped (no card render, nothing validated).",
      "Install ffmpeg 8.x (ffmpeg and ffprobe) and put it on PATH, then retry; rule: 'cuthol explain G320'."
    ),
  FX_CHECK_TIMEOUT: (itemId: string, fxId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G321",
      "G4_STAGE",
      "WARN",
      `fx instance check timed out for '${itemId}' fx '${fxId}' (${kind}) in this run; skipped, never blocking, so this instance is unchecked.`,
      "Retry the check with 'cuthol spine fx check --kind <kind>'; a persistent timeout means the filter hangs on real frames too; rule: 'cuthol explain G321'.",
      itemId
    ),
  FX_CHECK_FAILED: (itemId: string, fxId: string, kind: string, filter: string | undefined, detail: string, template?: string) => {
    const filterPart = filter ? ` in filter '${filter}'` : "";
    const templatePart = template ? ` [template: ${template}]` : "";
    return createDiagnostic(
      "CUTHOL-G322",
      "G4_STAGE",
      "ERROR",
      `fx instance check failed on '${itemId}' fx '${fxId}' (${kind})${filterPart}: ${detail}${templatePart} (gate G4: the card probe renders one frame; rule: 'cuthol explain G322').`,
      "Fix the effect template or parameters (unknown option, bad expression syntax) and retry 'cuthol spine fx check --kind <kind>' for an isolated probe. Options of one filter are separated by ':' (',' starts a new filter); an envelope placeholder inside single quotes needs no extra quotes of its own; rule: 'cuthol explain G322'.",
      itemId
    );
  },
  FX_CHECK_PROBE_FAILED: (filterName: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G323",
      "G4_STAGE",
      "WARN",
      `frozen-param probe for filter '${filterName}' could not render (${detail}), so the envelope check was skipped for this filter (gate G4 needs one rendered frame).`,
      "Check that ffmpeg runs ('ffmpeg -version') and retry 'cuthol spine fx check --kind <kind>'; rule: 'cuthol explain G323'."
    ),
  FX_PARAM_FROZEN: (filterName: string, itemId?: string) =>
    createDiagnostic(
      "CUTHOL-G324",
      "G4_STAGE",
      "ERROR",
      itemId
        ? `envelope on '${itemId}' does not change per frame in filter '${filterName}' (evaluated once per filter instance); the envelope has no visible effect.`
        : `parameter does not change per frame in filter '${filterName}' (evaluated once per filter instance); the envelope has no visible effect.`,
      itemId
        ? `Add the filter's per-frame evaluation flag to the template (e.g. ':eval=frame' for 'eq'), or remove the envelope from the non-animatable option on '${itemId}'; rule: 'cuthol explain G324'.`
        : "Add the filter's per-frame evaluation flag to the template (e.g. ':eval=frame' for 'eq') or remove the envelope from the non-animatable option; rule: 'cuthol explain G324'.",
      itemId
    ),
  FX_PARAM_FROZEN_MANY: (filterName: string, itemIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G324",
      "G4_STAGE",
      "ERROR",
      `parameter does not change per frame in filter '${filterName}' on ${itemIds.length} items (${repeatIdRange(itemIds)}); evaluated once per filter instance, so the envelopes have no visible effect.`,
      "Add the filter's per-frame evaluation flag to the template (e.g. ':eval=frame' for 'eq') or remove the envelopes from the non-animatable option; rule: 'cuthol explain G324'.",
      itemIds[0],
      itemIds
    ),
  FX_CHECK_NATIVE_BACKEND: (kind: string, via: string) =>
    createDiagnostic(
      "CUTHOL-G325",
      "G4_STAGE",
      "INFO",
      `kind '${kind}' uses the native backend: validated by ${via} (no render card needed).`,
      "No card probe is needed for this kind; rule: 'cuthol explain G325'."
    ),
  FX_CHECK_UNKNOWN_KIND: (kind: string, detail: string, suggestion?: string) =>
    createDiagnostic(
      "CUTHOL-G326",
      "G4_STAGE",
      "ERROR",
      `fx check for kind '${kind}' failed: ${detail} (the kind string names no builtin, motion layer or registered extension fx).`,
      suggestion ??
        "List checkable kinds with 'cuthol spine fx catalog' (clip kinds are 'ffmpeg', 'motion' or 'ext:<extension>/<name>'); rule: 'cuthol explain G326'."
    ),
  // [fxtry:D G345–G359] fx sandbox, `spine fx try` grid and `spine fx check --full`
  FX_TRY_FAILED: (kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G345",
      "G4_STAGE",
      "ERROR",
      `fx try for kind '${kind}' failed in this run: ${detail}`,
      "Check the kind with 'cuthol spine fx check --kind <kind>'; list kinds with 'cuthol spine fx catalog'; rule: 'cuthol explain G345'."
    ),
  FX_TRY_UNKNOWN_ITEM: (item: string) =>
    createDiagnostic(
      "CUTHOL-G346",
      "G4_STAGE",
      "ERROR",
      `fx try --on '${item}' matches no spine clip in this project (the sandbox needs a real clip or the generated card).`,
      "Pass a spine clip id (sp_XX) from this project, or drop '--on' to use the generated card; rule: 'cuthol explain G346'."
    ),
  FX_FULL_NEUTRAL_FAIL: (kind: string, param: string, psnr: number) =>
    createDiagnostic(
      "CUTHOL-G347",
      "G4_STAGE",
      "ERROR",
      `fx full check for kind '${kind}': neutral value of '${param}' is not neutral (rendered Y-PSNR ${psnr.toFixed(1)} dB vs no-fx baseline, rule >= 60 dB); the default would visibly change the picture.`,
      `Fix the manifest 'neutral' value of '${param}' for kind '${kind}' so it renders (near-)identically to no fx, or remove it; re-check with 'cuthol spine fx check --kind ${kind} --full'; rule: 'cuthol explain G347'.`
    ),
  FX_FULL_TEMPORAL_CHANGE: (kind: string, what: string) =>
    createDiagnostic(
      "CUTHOL-G348",
      "G4_STAGE",
      "WARN",
      `fx full check for kind '${kind}' measured a duration/frame-count change in this run: ${what}.`,
      "Declare 'temporal: true' in the manifest fx entry when the effect changes duration or frame count on purpose; rule: 'cuthol explain G348'."
    ),
  FX_FULL_COST_MISMATCH: (kind: string, declared: string, measured: string) =>
    createDiagnostic(
      "CUTHOL-G349",
      "G4_STAGE",
      "WARN",
      `fx full check for kind '${kind}' in this run: manifest cost_class '${declared}' contradicts the measured '${measured}' (1080p per-frame probe).`,
      "Update the manifest 'cost_class' to the measured value, then re-run 'cuthol spine fx check --kind' on this kind; rule: 'cuthol explain G349'."
    ),
  // [preset:P G360–G374] motion presets anchored to the clip and extension fx-new
  PRESET_UNKNOWN: (preset: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G360",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' cannot be applied in this run: ${detail}`,
      "List available presets with 'cuthol spine fx catalog', then retry with a listed preset ref; rule: 'cuthol explain G360'."
    ),
  PRESET_BAD_PARAM: (preset: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G361",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' got a bad parameter in this run: ${detail} (value must be a number inside the declared min/max range).`,
      `Re-run with '--param name=value' inside the declared range for preset '${preset}'; rule: 'cuthol explain G361'.`
    ),
  PRESET_BAD_CHANNEL: (preset: string, channel: string) =>
    createDiagnostic(
      "CUTHOL-G362",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' targets unknown channel '${channel}' in this run (allowed: the target kind's channels).`,
      "Use one of the target kind's channels (x_pct, y_pct, rotation_deg, scale_x, scale_y, opacity for 'motion'); rule: 'cuthol explain G362'."
    ),
  PRESET_VALUE_OUT_OF_RANGE: (preset: string, channel: string, value: number) =>
    createDiagnostic(
      "CUTHOL-G363",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' computes value ${value} on channel '${channel}' in this run, outside the parameter's min/max range.`,
      `Adjust the '--param' values of preset '${preset}' so every generated point stays within range; rule: 'cuthol explain G363'.`
    ),
  PRESET_ANCHORS_CROSS: (preset: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G364",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' anchors cross on this clip in this run: ${detail}`,
      "Use a longer clip or smaller offsets so start-anchored points stay before end-anchored points; rule: 'cuthol explain G364'."
    ),
  PRESET_LANE_CUE: (item: string) =>
    createDiagnostic(
      "CUTHOL-G365",
      "G4_STAGE",
      "ERROR",
      `presets apply to spine clips in this version, not to '${item}' in this run.`,
      `Pass a spine clip id (sp_XX) from this project instead of '${item}'; rule: 'cuthol explain G365'.`
    ),
  PRESET_BEATS_MISSING: (preset: string) =>
    createDiagnostic(
      "CUTHOL-G366",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' repeats on every beat in this run but no beat grid was given.`,
      `Pass '--beats <aud_XX>' with a music asset that has a beat grid (run 'cuthol library beats' first); rule: 'cuthol explain G366'.`
    ),
  PRESET_BAD_EXPRESSION: (preset: string, expr: string) =>
    createDiagnostic(
      "CUTHOL-G367",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' has a bad value expression '${expr}' in this run (only numbers, declared param names, 'rand(i)', parentheses and + - * /).`,
      "Fix the expression in the preset manifest to that grammar; rule: 'cuthol explain G367'."
    ),
  PRESET_TOO_MANY_POINTS: (preset: string, count: number, extraSec: string) =>
    createDiagnostic(
      "CUTHOL-G368",
      "G4_STAGE",
      "WARN",
      `preset '${preset}' writes ${count} points on one channel in this run (estimated extra render time ${extraSec} at draft_480p; warn threshold is more than 150 points on one channel).`,
      "Reduce the repetition count or pattern length if the render gets too slow; rule: 'cuthol explain G368'."
    ),
  PRESET_DRIFTED: (fxId: string, what: string, item: string) =>
    createDiagnostic(
      "CUTHOL-G369",
      "G4_STAGE",
      "WARN",
      `Preset points of '${fxId}' no longer match their anchors: ${what} (reapply overwrites hand edits; gate G4 compares the points against the anchors).`,
      `Regenerate with 'cuthol spine fx preset --item ${item} --fx ${fxId} --reapply'; rule: 'cuthol explain G369'.`
    ),
  FX_NEW_EXISTS: (extName: string, fxName: string) =>
    createDiagnostic(
      "CUTHOL-G370",
      "G4_STAGE",
      "ERROR",
      `extension '${extName}' already has an fx entry '${fxName}' in this run, so 'fx-new' refused to overwrite it.`,
      "Pick a different name or edit the existing entry; rule: 'cuthol explain G370'."
    ),
  FX_NEW_UNKNOWN_ROLE: (role: string) =>
    createDiagnostic(
      "CUTHOL-G371",
      "G4_STAGE",
      "ERROR",
      `unknown fx role '${role}' in this run (allowed: clip, transition, motion).`,
      "Re-run with '--role clip', '--role transition' or '--role motion'; rule: 'cuthol explain G371'."
    ),
  FX_NEW_WROTE_SKELETON: (extName: string, fxName: string) =>
    createDiagnostic(
      "CUTHOL-G372",
      "G4_STAGE",
      "INFO",
      `fx skeleton '${fxName}' added to extension '${extName}' in this run (kind 'ext:${extName}/${fxName}').`,
      `Try it with 'cuthol spine fx try --kind ext:${extName}/${fxName}' and check it with 'cuthol spine fx check --kind ext:${extName}/${fxName}'; rule: 'cuthol explain G372'.`
    ),
  // [fxtpl:C G340–G344] fx template placeholder and quoting rules (one rule per template)
  FX_TEMPLATE_UNTERMINATED_QUOTE: (extName: string, fxName: string) =>
    createDiagnostic(
      "CUTHOL-G340",
      "G4_STAGE",
      "ERROR",
      `extension '${extName}' fx '${fxName}': 'fx.${fxName}.video_filter' has an unterminated single-quoted region (a ' without its closing ') in this run, so quoting cannot be checked past that point.`,
      `Close the quoted region in 'fx.${fxName}.video_filter' or remove the stray quote; rule: 'cuthol explain G340'.`
    ),
  FX_TEMPLATE_QUOTED_STATIC_QUOTE: (extName: string, fxName: string, param: string) =>
    createDiagnostic(
      "CUTHOL-G341",
      "G4_STAGE",
      "ERROR",
      `extension '${extName}' fx '${fxName}': '${param}' parameter value contains a single quote (') and cannot go inside a single-quoted template region (the filter would parse it as the region end).`,
      `Remove the quote from the '${param}' value or move the placeholder outside the quoted region; rule: 'cuthol explain G341'.`
    ),
  // [fxfix:F G375–G379] effect-authoring fixes (delivery verdict, console window, guide CLI)
  GUIDE_TOPIC_UNKNOWN: (topic: string) =>
    createDiagnostic(
      "CUTHOL-G375",
      "G1_SCHEMA",
      "ERROR",
      `guide topic '${topic}' is not available (no such skill, reference or extension README).`,
      "Run 'cuthol guide' for the catalog of topics, or pass a skill name, '<skill>/<reference>' or 'ext:<name>'; rule: 'cuthol explain G375'."
    ),
  // [sk-w0a G765-G769] Catalog-driven CLI help/parsing/explain range.
  EXPLAIN_MISSING_QUERY: () =>
    createDiagnostic(
      "CUTHOL-G765",
      "G1_SCHEMA",
      "ERROR",
      "explain needs a diagnostic code or topic.",
      "Use this command: cuthol explain <code|topic> (e.g. cuthol explain CUTHOL-G110)."
    ),
  // [kz1 G778–G779] JSON flag file references and quote-stripped JSON
  JSON_FLAG_FAILED: (flag: string, command: string, received: string, expected: string, fixCommand: string) => {
    const stripped = received.trim().length > 0 && /[{,[]\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(received);
    const preview = received.length > 60 ? `${received.slice(0, 60)}…` : received;
    return createDiagnostic(
      "CUTHOL-G778",
      "G1_SCHEMA",
      "ERROR",
      `Flag '--${flag}' of '${command}' got text that is not JSON (got '${preview}'; expected ${expected}).${stripped ? " The shell stripped the double quotes (typical: Windows PowerShell to cuthol.cmd turns quoted keys into bare words)." : ""}`,
      `Retry as '${fixCommand}' (write the JSON into the file first)${stripped ? ", or pass one '--param k=v' pair per value where the command takes '--param'" : ""}; rule: 'cuthol explain G778'.`
    );
  },
  JSON_FLAG_FILE_FAILED: (flag: string, command: string, ref: string, resolved: string, detail: string, fixCommand: string) =>
    createDiagnostic(
      "CUTHOL-G779",
      "G1_SCHEMA",
      "ERROR",
      `Flag '--${flag}' of '${command}' points at a file that cannot be read ('${ref}' resolved to '${resolved}': ${detail}).`,
      `Write the JSON into that file and retry as '${fixCommand}'; rule: 'cuthol explain G779'.`
    ),
  UNKNOWN_FLAG: (flag: string, command: string, suggestionFix: string) =>
    createDiagnostic(
      "CUTHOL-G110",
      "G1_SCHEMA",
      "ERROR",
      `Unknown or conflicting flag '${flag}' in command '${command}'.`,
      suggestionFix.trimStart().startsWith("`") ? suggestionFix : `Use this command: ${suggestionFix}`
    ),

  PROTECTED_TARGET: (targetIds: string[], operation: string) =>
    createDiagnostic(
      "CUTHOL-G111",
      "G1_SCHEMA",
      "ERROR",
      `Operation '${operation}' stopped: ${targetIds.length} locked/protected item(s) would be deleted or modified (${repeatIdRange(targetIds)}); nothing changed.`,
      `Inspect the plan with '--dry-run' on the same '${operation}' command; to proceed, add '--allow-protected ${targetIds.join(",")}'; rule: 'cuthol explain G111'.`,
      targetIds[0],
      targetIds
    ),

  INVALID_EXTENSION_MANIFEST: (extNameOrPath: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G112",
      "G1_SCHEMA",
      "ERROR",
      `Manifest file ('cuthol-extension.json') of extension '${extNameOrPath}' is invalid in this run: ${detail} (the manifest schema is closed: unknown keys are rejected).`,
      `Check the manifest schema ('name', 'version', 'description' and optional 'network', 'helper', 'assets', 'processors', 'recipes', 'guide'); run 'cuthol guide --topic extensions' for the guide; rule: 'cuthol explain G112'.`,
      extNameOrPath
    ),

  EXTENSION_ALREADY_EXISTS: (name: string, dirPath: string) =>
    createDiagnostic(
      "CUTHOL-G113",
      "G1_SCHEMA",
      "ERROR",
      `Extension '${name}' already exists at '${dirPath}' in this run, so 'create' refused to overwrite it.`,
      `Pick a different name, edit the existing extension, or delete it first with 'cuthol extension remove --name ${name}'; rule: 'cuthol explain G113'.`,
      name
    ),

  EXTENSION_NOT_FOUND: (name: string, searchedPaths: string[]) =>
    createDiagnostic(
      "CUTHOL-G204",
      "G2_ASSETS",
      "ERROR",
      `Extension '${name}' found in neither the project extensions folder nor the persistent extensions folder in this run (searched: ${searchedPaths.join(", ") || "none"}); the referencing manifest, provider or fx kind cannot load.`,
      `List existing extensions with 'cuthol extension list', or create it with 'cuthol extension create --name ${name}'; rule: 'cuthol explain G204'.`,
      name
    ),

  EXTENSION_HASH_MISMATCH: (
    name: string,
    expectedVersion: string,
    expectedHash: string,
    actualVersion: string,
    actualHash: string,
    severity: DiagnosticSeverity = "WARN",
    detail?: string
  ) =>
    createDiagnostic(
      "CUTHOL-G205",
      "G2_ASSETS",
      severity,
      detail
        ? `Extension '${name}' enabled in the project, or its copy in the composition, differs from its source (${detail}; pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}; gate G2 requires the pinned hash to match disk); the render is stopped so it does not go out with the stale copy.`
        : `Extension '${name}' enabled in the project changed on disk (pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}; gate G2 requires the pinned hash to match disk); the render is stopped so it does not go out with the stale copy.`,
      `Refresh with 'cuthol extension enable --name ${name}' to accept the change and move to the new content hash; if you delete your edited copy inside the composition, Cuthol writes it again; rule: 'cuthol explain G205'.`,
      name
    ),

  EXTENSION_SECURITY_VIOLATION: (name: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G206",
      "G2_ASSETS",
      "ERROR",
      `Extension '${name}' violated the security boundary in this run and was stopped: ${detail}`,
      `An extension may only read files inside its own folder, and only write to the output path given by Cuthol or to CUTHOL_EXT_TMP; rule: 'cuthol explain G206'.`,
      name
    ),

  EXTENSION_EXECUTION_FAILED: (name: string, target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-SYS08",
      "SYS",
      "ERROR",
      `Run of '${target}' by extension '${name}' failed: ${detail}`,
      `Check the extension script/filter and the input parameters ('cuthol extension show --name ${name}').`,
      name
    ),

  COMMAND_LINE_TOO_LONG: (
    tool: string,
    commandLength: number,
    limitChars: number,
    clipCount?: number,
    errnoCode?: string
  ) => {
    const clipInfo =
      typeof clipCount === "number" ? `, clip count: ${clipCount}` : "";
    const codeInfo = errnoCode ? ` (${errnoCode})` : "";
    return createDiagnostic(
      "CUTHOL-SYS09",
      "SYS",
      "ERROR",
      `Could not start the '${tool}' subprocess${codeInfo}: command line too long (${commandLength} chars, OS limit: ${limitChars} chars${clipInfo}).`,
      `Pass the filter graph from a file ('-/filter_complex <file>'), or process the multi-clip sequence via time-segmented compilation.`
    );
  },

  SUBPROCESS_STALLED: (options: {
    step: string;
    stalledMs: number;
    thresholdMs: number;
    lastProgress: string;
    commandSummary: string;
  }) => {
    const stalledSec = (Math.max(0, options.stalledMs) / 1000).toFixed(1);
    const threshSec = (Math.max(0, options.thresholdMs) / 1000).toFixed(1);
    const lastProg = options.lastProgress?.trim() || "no progress/output produced";
    const cmdSum = options.commandSummary?.trim() || options.step;
    return createDiagnostic(
      "CUTHOL-SYS10",
      "SYS",
      "ERROR",
      `Subprocess '${options.step}' was terminated because progress stalled (no progress for ${stalledSec}s, threshold=${threshSec}s; last progress: ${lastProg}; command: ${cmdSum}).`,
      `The hardware encoder (NVENC/AMF/QSV/VAAPI/VideoToolbox) or a browser subprocess may be stuck; retry the operation, use 'CUTHOL_ENCODER=x264' to disable GPU encoding, or set the progress threshold with 'CUTHOL_STALL_TIMEOUT_SEC'.`
    );
  },

  INVALID_EXCISE_RANGE: (piece: string) =>
    createDiagnostic(
      "CUTHOL-G311",
      "G3_TIMING",
      "ERROR",
      `'${piece}' is not a cut range; every piece must be in 'start..end' form (the '..' separator with a time on each side is required).`,
      `Write the broken piece '${piece}' as 'start..end' (e.g. '2s..3s'); separate multiple ranges with commas: '--ranges 2s..3s,6s..7s' on the same command; rule: 'cuthol explain G311'.`
    ),

  UNITLESS_TIME_AS_MS: () =>
    createDiagnostic(
      "CUTHOL-G114",
      "G1_SCHEMA",
      "WARN",
      "Unitless 'at' values were read as milliseconds (e.g. 100 means 100ms); did you mean seconds? (e.g. 21.1s).",
      "Add units to time values (e.g. '21.1s' or '00:21.1'); rule: 'cuthol explain G114'. Unitless numbers stay milliseconds."
    ),

  QUERY_PAGE_TOKEN_TRUNCATED: (returned: number, matched: number, tokensEst: number, maxTokens: number, nextCursor: string) =>
    createDiagnostic(
      "CUTHOL-G115",
      "G1_SCHEMA",
      "WARN",
      `Library query page cut at the token budget (~${tokensEst} tokens over the --max-tokens ${maxTokens} budget): returned ${returned} of ${matched} matched items; item ${nextCursor}..${matched - 1} still unread.`,
      `Continue the same query with '--cursor ${nextCursor}', or re-run with a higher '--max-tokens ${maxTokens}' value; rule: 'cuthol explain G115'.`
    ),

  INVALID_CUE_EXCISE_KIND: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G310",
      "G3_TIMING",
      "ERROR",
      `Item '${cueId}' ('${kind}') has no linear source media stream, so no range can be excised from it with 'lane excise' (only 'voiceover', 'music', 'sfx' and 'broll' cues carry an excisable media range).`,
      `To change the duration of compositions, titles, captions or stills use 'cuthol lane update-cue --cue ${cueId} --duration <duration>', or 'cuthol lane remove-cue --cues ${cueId}' to delete; rule: 'cuthol explain G310'.`,
      cueId
    ),

  CLEANUP_CUE_NOT_AUDIO: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G313",
      "G3_TIMING",
      "ERROR",
      `Cue '${cueId}' (kind '${kind}') is not an audio cue; speech cleanup only cuts 'voiceover', 'music' and 'sfx' cues carrying an audio file.`,
      `Place the recording with 'cuthol lane add-cue --lane ln_vo --kind voiceover --asset <aud_XX>'. To clean footage on the spine use 'cuthol speech cleanup --clip <sp_XX>'. Compositions, titles, captions, b-roll and stills are not cut by this command; rule: 'cuthol explain G313'.`,
      cueId
    ),

  CLEANUP_TARGET_CONFLICT: () =>
    createDiagnostic(
      "CUTHOL-G314",
      "G3_TIMING",
      "ERROR",
      `Speech cleanup cannot take both a spine clip ('--clip') and an audio cue ('--cue'/'--cues') in the same call; the two targets cut different timelines.`,
      `Use 'cuthol speech cleanup --cue <cue_XX>' (or '--cues a,b') for an audio cue, 'cuthol speech cleanup --clip <sp_XX>' for the spine; rule: 'cuthol explain G314'.`
    ),

  CLEANUP_BAD_ACROSS: (value: string) =>
    createDiagnostic(
      "CUTHOL-G315",
      "G3_TIMING",
      "ERROR",
      `'--across ${value}' is not a valid shift scope (got '${value}').`,
      `In audio-cue cleanup '--across' must be 'lane' (default), 'all_lanes', 'all', 'spine' or 'none'. This means the same as 'lane excise --across'; rule: 'cuthol explain G315'.`
    ),


  // --- Speed ramp: codes CUTHOL-G116, CUTHOL-G117, CUTHOL-G410 ---
  INVALID_SPEED_RAMP: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G116",
      "G1_SCHEMA",
      "ERROR",
      `'--ramp' is invalid: ${detail} (rule: offsets strictly increasing, rate 0.1..16, offsets within the clip's 0..source range, at least 2 points).`,
      `Correct form: '--ramp "0s:1,1s:1,2.5s:4"' (source offset:rate pairs). '--ramp none' removes it. Example: 'cuthol spine speed --clip sp_01 --ramp "0s:1,2s:4"'. Cannot be combined with '--rate'; rule: 'cuthol explain G116'.`
    ),

  SPEED_RAMP_AUDIO_APPROX: (clipId: string, minRate: number, maxRate: number) =>
    createDiagnostic(
      "CUTHOL-G410",
      "G4_STAGE",
      "WARN",
      `Speed ramp on '${clipId}' spans rates ${minRate.toFixed(2)}..${maxRate.toFixed(2)}, outside the clean-audio band 0.5..2.0; audio follows the ramp but quality drops at extreme rates (chained atempo or large pitch shift).`,
      `Listen to the audio in the draft render; on clips with speech keep the ramp ends within 0.5..2.0: 'cuthol spine speed --clip ${clipId} --ramp "0s:1,..."'; rule: 'cuthol explain G410'.`,
      clipId
    ),

  SPEED_RAMP_BEYOND_SOURCE: (clipId: string, offsetMs: number, spanMs: number) =>
    createDiagnostic(
      "CUTHOL-G117",
      "G4_STAGE",
      "WARN",
      `Offset ${offsetMs}ms in the speed ramp of '${clipId}' exceeds the source range (0..${spanMs}ms); clamped to ${spanMs}ms, so the ramp end holds the last source frame.`,
      `Bring the ramp offsets into 0..${spanMs}ms: 'cuthol spine speed --clip ${clipId} --ramp "0s:1,..."'; rule: 'cuthol explain G117'.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Spine fx: codes CUTHOL-G118, CUTHOL-G119, CUTHOL-G411 ---
  // The G118/G119 texts name the owner id, so the same codes serve spine clips (`sp_XX`)
  // and lane cues (`cue_XX`) sharing the one fx stage.
  SPINE_FX_INVALID: (ownerId: string, fxId: string, kind: string, detail: string, suggestion?: string) =>
    createDiagnostic(
      "CUTHOL-G118",
      "G1_SCHEMA",
      "ERROR",
      `Effect '${fxId}' ('${kind}') on '${ownerId}' is invalid: ${detail} (the effect is skipped at render until fixed).`,
      suggestion ??
        (ownerId.startsWith("cue_")
          ? `Remove it with 'cuthol spine fx remove --item ${ownerId} --fx ${fxId}', or fix it with 'cuthol spine fx set --item ${ownerId} --fx ${fxId} --param name=value'.`
          : `Remove it with 'cuthol spine fx remove --item ${ownerId} --fx ${fxId}', or fix it with 'cuthol spine fx set --item ${ownerId} --fx ${fxId} --param name=value'.`),
      ownerId
    ),

  SPINE_FX_ENVELOPE_UNSUPPORTED: (ownerId: string, parameter: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G119",
      "G1_SCHEMA",
      "ERROR",
      `Envelope '${parameter}' on '${ownerId}' cannot be applied: ${reason} (only the extension's 'animatable' parameters accept envelopes).`,
      `Drop the envelope from '${parameter}', or move it to an envelopable parameter with 'cuthol spine envelope --clip ${ownerId} --param <name> --points <...>'; rule: 'cuthol explain G119'.`,
      ownerId
    ),

  SPINE_FX_EXTENSION_DRIFTED: (
    clipId: string,
    fxId: string,
    ref: string,
    extName: string,
    pinnedLabel: string,
    actualLabel: string
  ) =>
    createDiagnostic(
      "CUTHOL-G411",
      "G4_STAGE",
      "WARN",
      `Effect '${fxId}' (${ref}) on clip '${clipId}' compiles against a different extension than pinned (in sequence: ${pinnedLabel}, on disk: ${actualLabel}; gate G4 pins the extension hash).`,
      `Run 'cuthol extension enable --name ${extName}' to accept the change and move to the new version; rule: 'cuthol explain G411'.`,
      clipId
    ),

  // [p1fx:W0 G264–G266] cue fx stage
  CUE_FX_TEXT_UNSUPPORTED: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G264",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on text cue '${cueId}' is not supported yet; the cue carries an 'fx' entry but text cues have no fx stage in this version, so the chain would never execute (not emitted by the current code; kept for older projects).`,
      `Remove the 'fx' list from cue '${cueId}' in the sequence JSON; text cue fx arrives in a later wave; rule: 'cuthol explain G264'.`,
      cueId
    ),
  CUE_FX_AUDIO_UNSUPPORTED: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G265",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on audio cue '${cueId}' (kind '${kind}') is not supported: audio cues have no pixel chain for fx to run on, so the chain would never execute.`,
      `Remove the 'fx' list from cue '${cueId}' in the sequence JSON (audio shaping lives in the audio chain); rule: 'cuthol explain G265'.`,
      cueId
    ),
  CUE_FX_KIND_UNSUPPORTED: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G266",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on cue '${cueId}' (kind '${kind}') is not supported: this cue kind has no pixel chain for fx to run on, so the chain would never execute.`,
      `Remove the 'fx' list from cue '${cueId}' in the sequence JSON, or move the effect to a spine clip with 'cuthol spine fx add --clip <sp_XX> --kind <kind>'; rule: 'cuthol explain G266'.`,
      cueId
    ),
  CUE_FX_AUDIO_NOT_ALLOWED: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G271",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on audio cue '${cueId}' (kind '${kind}') is not supported: audio cues have no pixel chain, so the fx would never execute.`,
      `Use 'cuthol spine fx' on a spine clip or a visual lane cue instead; audio shaping lives in the audio chain; rule: 'cuthol explain G271'.`,
      cueId
    ),
  // [p1fx:A G267–G270] fx stage render
  COMPOSITION_TEMPORAL_FX_SINGLEFRAME: (cueId: string, filter: string) =>
    createDiagnostic(
      "CUTHOL-G267",
      "G1_SCHEMA",
      "WARN",
      `Temporal effect '${filter}' on composition cue '${cueId}' sees one repeated frame in a single-frame compile ('monitor frame'); a single frame carries no motion, so temporal filters there differ from 'render'.`,
      `Compare the temporal effect on cue '${cueId}' with a multi-frame render ('cuthol render --preset draft_480p') instead of 'monitor frame'; rule: 'cuthol explain G267'.`,
      cueId
    ),
  COMPOSITION_TEMPORAL_FX_SINGLEFRAME_MANY: (filter: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G267",
      "G1_SCHEMA",
      "WARN",
      `${cueIds.length} composition cues (${repeatIdRange(cueIds)}) carry temporal effect '${filter}' in a single-frame compile ('monitor frame'); a single frame carries no motion, so temporal filters there differ from 'render'.`,
      `Compare the temporal effects with a multi-frame render ('cuthol render --preset draft_480p') instead of 'monitor frame'; rule: 'cuthol explain G267'.`,
      cueIds[0],
      cueIds
    ),
  // [p1fx:B G271–G275] fx surface
  // [p1fx:C G276–G279] text cue fx
  CUE_FX_TEXT_LAYER_EMPTY: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G276",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on text cue '${cueId}' produced no text layer: the cue carries active fx but its text is empty, so there is nothing to shade.`,
      `Give cue '${cueId}' text, or remove the 'fx' list from the cue in the sequence JSON; rule: 'cuthol explain G276'.`,
      cueId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Easing: codes CUTHOL-G120 ---
  EASING_NAME_INVALID: (subject: string, name: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `Unknown easing name '${name}' for '${subject}'; the render never falls back to linear, so the keyframe is rejected.`,
      `Use one of 'linear', 'ease_in', 'ease_out', 'ease_in_out', 'hold', 'cubic_bezier' (e.g. '--easing ease_in_out'), or a curve '--easing "cubic-bezier(x1,y1,x2,y2)"' with x1,x2 in 0..1; rule: 'cuthol explain G120'.`,
      subject
    ),

  EASING_HOLD_IN_TRANSITION: (subject: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `'hold' easing cannot be used in the out-transition of clip '${subject}': the step curve ends the transition unseen (progress stalls at 0, then jumps to 1 at the end).`,
      `Use 'linear', 'ease_in', 'ease_out', 'ease_in_out' or 'cubic_bezier' for the transition (e.g. 'cuthol spine transition --clip ${subject} --easing ease_in_out'); rule: 'cuthol explain G120'.`,
      subject
    ),

  CUBIC_BEZIER_INVALID: (subject: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `cubic-bezier curve for '${subject}' is invalid: ${detail}.`,
      `Pass the curve as '--easing "cubic-bezier(x1,y1,x2,y2)"'; x1 and x2 must be within 0..1 (e.g. 'cubic-bezier(0.25,0.1,0.25,1)'); rule: 'cuthol explain G120'.`,
      subject
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Edge mode: codes CUTHOL-G121, CUTHOL-G412 ---
  EDGE_LANE_CUE_UNSUPPORTED: (cueId: string, edge: string) =>
    createDiagnostic(
      "CUTHOL-G121",
      "G1_SCHEMA",
      "ERROR",
      `'edge=${edge}' on lane cue '${cueId}' is not supported in this version; mirrored/extended edge fill only works on spine clips, so this setting is ignored (gate G1: lane cues have no edge-fill stage).`,
      `Remove the 'edge' field from the lane cue ('cuthol lane update-cue --cue ${cueId}'); apply the fill to the spine clip underneath with 'cuthol spine transform --clip <sp_XX> --edge ${edge}'; rule: 'cuthol explain G121'.`,
      cueId
    ),

  EDGE_INEFFECTIVE: (clipId: string) =>
    createDiagnostic(
      "CUTHOL-G412",
      "G4_STAGE",
      "WARN",
      `Edge fill on clip '${clipId}' changes nothing in the picture: the clip already covers the stage fully and does not move (gate G4: edge fill only shows on shifted/shrunk clips).`,
      `Remove the ineffective setting with 'cuthol spine transform --clip ${clipId} --edge transparent', or shrink/shift the clip to make the fill visible; rule: 'cuthol explain G412'.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Extension transitions: codes CUTHOL-G122, CUTHOL-G123, CUTHOL-G413 ---
  EXTENSION_TRANSITION_UNAVAILABLE: (kind: string, detail: string, subjectId?: string) =>
    createDiagnostic(
      "CUTHOL-G122",
      "G1_SCHEMA",
      "ERROR",
      `Extension transition '${kind}' is unavailable: ${detail} (gate G1: the transition must be installed, defined and enabled).`,
      `Verify the extension is installed with 'cuthol extension list' and the transition is defined in the 'transitions' section with 'cuthol extension show --name <name>'; if the extension is not enabled in the project, run 'cuthol extension enable --name <name>'; rule: 'cuthol explain G122'.`,
      subjectId
    ),

  EXTENSION_TRANSITION_EASING_UNSUPPORTED: (kind: string, easing: string, subjectId?: string) =>
    createDiagnostic(
      "CUTHOL-G122",
      "G1_SCHEMA",
      "ERROR",
      `Easing '${easing}' is not supported in extension transition '${kind}' in this version (gate G1: only 'linear', 'ease_in', 'ease_out' and 'ease_in_out' are accepted).`,
      `Use 'linear', 'ease_in', 'ease_out' or 'ease_in_out' for the transition (e.g. 'cuthol spine transition --clip <sp_XX> --kind ${kind} --easing ease_in_out'); rule: 'cuthol explain G122'.`,
      subjectId
    ),

  EXTENSION_TRANSITION_PARAM_INVALID: (kind: string, clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G123",
      "G1_SCHEMA",
      "ERROR",
      `Parameters of transition '${kind}' on clip '${clipId}' are invalid: ${detail} (gate G1: params must match the extension manifest schema).`,
      `Fix the parameters per the 'transitions' definition in the extension manifest ('cuthol extension show --name <name>'); e.g. 'cuthol spine transition --clip ${clipId} --kind ${kind} --param name=value'; rule: 'cuthol explain G123'.`,
      clipId
    ),

  EXTENSION_TRANSITION_PIN_MISMATCH: (
    name: string,
    expectedVersion: string,
    expectedHash: string,
    actualVersion: string,
    actualHash: string,
    subjectId?: string
  ) =>
    createDiagnostic(
      "CUTHOL-G413",
      "G4_STAGE",
      "WARN",
      `Extension '${name}' whose transition you use changed on disk (pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}; gate G4 pins the extension hash; the render goes out with the current extension).`,
      `Run 'cuthol extension enable --name ${name}' to accept the change and move to the new content hash; rule: 'cuthol explain G413'.`,
      subjectId
    ),

  // [fxcheck:B G330–G339]
  EXTENSION_TRANSITION_FIELD_UNQUOTED_PROGRESS: (extName: string, trName: string, field: string) =>
    createDiagnostic(
      "CUTHOL-G330",
      "G1_SCHEMA",
      "ERROR",
      `Transition '${trName}' in extension '${extName}' uses '{{p}}' outside single quotes in '${field}' in this run: the eased-progress expansion contains commas that split ffmpeg filter options.`,
      `Quote the '{{p}}' expansion in '${field}' (e.g. "eq=brightness='0.5*({{p}})'"), so the commas stay inside one filter option; 'cuthol extension show --name ${extName}' prints the manifest section; rule: 'cuthol explain G330'.`,
      trName
    ),

  EXTENSION_TRANSITION_BACKSTOP_FAILED: (kind: string, clipId: string, detail: string, field?: string) => {
    const failingPart = field ? ` (failing part: '${field}')` : "";
    const templateField = field ? ` field '${field}'` : "";
    return createDiagnostic(
      "CUTHOL-G331",
      "G1_SCHEMA",
      "ERROR",
      `Extension transition '${kind}' on clip '${clipId}' fails a short encoder-free render over its own window${failingPart}: ${detail} (gate G1 backstop: the render would fail the same way).`,
      `Fix the transition template${templateField} ('cuthol extension show --name <name>') so the windowed render passes, or replace the transition ('cuthol spine transition --clip ${clipId} --kind <kind>'); rule: 'cuthol explain G331'.`,
      clipId
    );
  },

  EXTENSION_TRANSITION_BACKSTOP_SKIPPED: (reason: string) =>
    createDiagnostic(
      "CUTHOL-G332",
      "SYS",
      "WARN",
      `The extension-transition backstop render was skipped (${reason}), so 'ext:' transitions are unchecked in this run (gate G1 backstop needs one encoder-free render).`,
      `Install ffmpeg 8.x on PATH and retry 'cuthol verify' so the transition window is actually rendered once; a skipped backstop hides a render-time crash; rule: 'cuthol explain G332'.`
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Colour (LUT, temperature, colour envelopes): codes CUTHOL-G124, CUTHOL-G414 ---
  INVALID_COLOR_TEMPERATURE: (clipId: string, kelvin: number) =>
    createDiagnostic(
      "CUTHOL-G124",
      "G1_SCHEMA",
      "ERROR",
      `Color temperature of clip '${clipId}' (${String(kelvin)} K) is outside the supported range (1000..40000 K, gate G1 schema limit).`,
      `Return to the neutral value (6500 K, no filter) with 'cuthol spine grade --clip ${clipId} --temperature 6500'; rule: 'cuthol explain G124'.`,
      clipId
    ),

  LUT_FILE_NOT_READABLE: (clipId: string, lutUri: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G414",
      "G4_STAGE",
      "ERROR",
      `LUT file '${lutUri}' of clip '${clipId}' is unusable: ${detail}; the grade falls back to no LUT for this clip.`,
      `Place the LUT file under the project folder as '.cube' or '.3dl' and re-attach it with 'cuthol spine grade --clip ${clipId} --lut <path>' (use '--lut none' to drop it); rule: 'cuthol explain G414'.`,
      clipId
    ),

  // --- Colour stage (render): codes CUTHOL-G440–G449 ---
  COLOR_LUT_SELFTEST_ABOVE_LIMIT: (itemId: string, p99: number) =>
    createDiagnostic(
      "CUTHOL-G440",
      "G4_STAGE",
      "WARN",
      `Colour stage LUT of '${itemId}' still mismatches the block math at the fine 65 grid (p99 CIEDE2000 ${p99.toFixed(2)}, limit 1.0); the render uses the closest LUT, so saturated hues may shift slightly.`,
      `Simplify the stage of '${itemId}' (narrow HSL qualifiers need the fine grid) and re-render with 'cuthol render --preset draft_480p'; rule: 'cuthol explain G440'.`,
      itemId
    ),

  COLOR_LUT_SELFTEST_ABOVE_LIMIT_MANY: (limit: number, items: Array<{ id: string; p99: number }>) =>
    createDiagnostic(
      "CUTHOL-G440",
      "G4_STAGE",
      "WARN",
      `Colour stage LUTs of ${items.length} items (${repeatIdRange(items.map((i) => i.id))}) still mismatch the block math at the fine 65 grid (limit p99 ${limit}; worst '${[...items].sort((a, b) => b.p99 - a.p99)[0].id}' p99 ${[...items].sort((a, b) => b.p99 - a.p99)[0].p99.toFixed(2)}); the render uses the closest LUTs.`,
      `Simplify the stages (narrow HSL qualifiers need the fine grid) and re-render with 'cuthol render --preset draft_480p'; rule: 'cuthol explain G440'.`,
      items[0]?.id,
      items.map((i) => i.id)
    ),
  COLOR_LOOK_LUT_UNREADABLE: (itemId: string, lutUri: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G441",
      "G4_STAGE",
      "ERROR",
      `Look LUT '${lutUri}' of '${itemId}' is unusable: ${detail}; the Look does not apply to this item.`,
      `Place the Look LUT file under the project folder as '.cube' and re-attach it, or remove the Look binding from '${itemId}' with 'cuthol color set --item ${itemId} --remove look'; rule: 'cuthol explain G441'.`,
      itemId
    ),

  COLOR_ENVELOPE_TOO_MANY_FRAMES: (itemId: string, frames: number, limit: number) =>
    createDiagnostic(
      "CUTHOL-G442",
      "G4_STAGE",
      "ERROR",
      `Keyframed colour of '${itemId}' needs ${frames} baked frames, above the cache limit of ${limit} per item, so the LUTs cannot bake.`,
      `Shorten the keyframed range of '${itemId}' to under ${limit} frames or split it across items, then re-render; rule: 'cuthol explain G442'.`,
      itemId
    ),

  COLOR_INPUT_TRANSFORM_UNAVAILABLE: (itemId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G443",
      "G4_STAGE",
      "ERROR",
      `Input transform '${kind}' of '${itemId}' needs the ffmpeg filters 'zscale' and 'tonemap', which this build lacks; the source stays unconverted.`,
      `Install an ffmpeg 8.x build with 'zscale' and 'tonemap', or turn the transform off with 'cuthol color kind --handle <handle> --input none'; rule: 'cuthol explain G443'.`,
      itemId
    ),

  COLOR_HALD_RENDER_FAILED: (itemId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G444",
      "G4_STAGE",
      "ERROR",
      `Keyframed colour of '${itemId}' could not bake its frame LUTs: ${detail}.`,
      `Re-run the render (baked frames cache under '.cuthol/blobs/color'); if it persists, simplify the colour envelopes of '${itemId}' with 'cuthol spine envelope --clip ${itemId} --param <name> --points <...>'; rule: 'cuthol explain G444'.`,
      itemId
    ),

  // ---------------------------------------------------------------------------------------------------
  // --- Composition renderer (script errors, composition audio): codes CUTHOL-G415, CUTHOL-G416 ---
  SCRIPT_ERROR_ISOLATED: (
    subject: string,
    elementId: string,
    compositionId: string | null,
    error: string
  ) => {
    const sub = compositionId && compositionId !== elementId ? ` ('${compositionId}' sub-composition)` : "";
    return createDiagnostic(
      "CUTHOL-G415",
      "G4_STAGE",
      "WARN",
      `Silent gap in overlay '${subject}': the script of element '${elementId}'${sub} threw (${error}); HyperFrames skipped this element with an empty timeline, so its part is missing from the picture while the rest renders.`,
      `Fix the error in the '${compositionId ?? elementId}' script, then re-render with 'cuthol render --preset draft_480p' (a file change triggers the re-render); rule: 'cuthol explain G415'.`,
      subject
    );
  },

  COMPOSITION_AUDIO_SILENT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "WARN",
      `Audio playing in composition cue '${cueId}' (${detail}) is not in the Cuthol mix yet: no audio stem has been extracted for the current composition files (gate G4: the cue renders silent until the stem exists).`,
      `Run 'cuthol render' (or a mix measurement such as 'cuthol mix normalize') once; it extracts the stem and mixes it at the cue's lane time. To keep the composition silent, run 'cuthol lane update-cue --cue ${cueId} --composition-audio off'; to manage the sound as a separate cue instead, place it on the 'ln_sfx' or 'ln_bgm' lane ('cuthol lane add-cue --lane ln_sfx --kind sfx --asset <handle> ...'); rule: 'cuthol explain G416'.`,
      cueId
    ),

  // --- Composition audio stems: CUTHOL-G416 (in-mix/off info), CUTHOL-G435, CUTHOL-G436, CUTHOL-G437 ---
  COMPOSITION_AUDIO_IN_MIX: (cueId: string, stemMs: number, offHint: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "INFO",
      `Composition cue '${cueId}' brings ${stemMs}ms of engine-rendered audio into the Cuthol mix as a per-cue stem (lane gain, mute, envelopes and ducking apply; informational, no threshold).`,
      `${offHint}; rule: 'cuthol explain G416'.`,
      cueId
    ),

  COMPOSITION_AUDIO_OFF: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "INFO",
      `Audio in composition cue '${cueId}' (${detail}) stays out of the Cuthol mix because 'composition_audio' is 'off' on this cue (informational, no threshold).`,
      `To mix it, run 'cuthol lane update-cue --cue ${cueId} --composition-audio mix'; rule: 'cuthol explain G416'.`,
      cueId
    ),

  COMPOSITION_STEM_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G435",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' has audio, but its stem could not be extracted (${reason}); the cue renders silent until the extraction succeeds (gate G4: the mix needs the stem file).`,
      `Fix the cause (usually a missing or unreadable audio file inside the composition), then re-render ('cuthol render --preset draft_480p') so the stem is retried; rule: 'cuthol explain G435'.`,
      cueId
    ),

  COMPOSITION_RENDER_SILENT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G436",
      "G4_STAGE",
      "INFO",
      `Composition cue '${cueId}' shows audio elements (${detail}), but the engine render produced no audible sound, so no stem enters the mix (informational; gate G4 only mixes rendered sound).`,
      `If the silence is unintended, check the audio file paths and timing inside the composition ('cuthol composition preview --cue ${cueId}'); otherwise no action is needed; rule: 'cuthol explain G436'.`,
      cueId
    ),

  INVALID_COMPOSITION_AUDIO: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G437",
      "G1_SCHEMA",
      "ERROR",
      `Cue '${cueId}' has an invalid 'composition_audio' setting: ${detail} (gate G1: only 'mix' or 'off', only on composition cues).`,
      `Set 'composition_audio' to 'mix' or 'off' ('cuthol lane update-cue --cue ${cueId} --composition-audio mix|off'), only on composition cues; rule: 'cuthol explain G437'.`,
      cueId
    ),

  // --- Composition coordinates: codes CUTHOL-G417, CUTHOL-G418, CUTHOL-G419, CUTHOL-G428, CUTHOL-G429 ---
  COORDS_MEASUREMENT_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G417",
      "G4_STAGE",
      "WARN",
      `Coordinate measurement failed for cue '${cueId}' (${reason}); the cue was skipped and the remaining cues continue.`,
      `Re-run the failed cue alone with 'cuthol composition coords --cue ${cueId} --refresh'; if it still fails, open the page with 'cuthol composition preview --cue ${cueId}' to see the error; rule: 'cuthol explain G417'.`,
      cueId
    ),

  COORDS_MEASUREMENT_FAILED_MANY: (reason: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G417",
      "G4_STAGE",
      "WARN",
      `Coordinate measurement failed for ${cueIds.length} cues (${repeatIdRange(cueIds)}): ${reason}; the cues were skipped and the remaining cues continue.`,
      `Re-run the failed cues with 'cuthol composition coords --cue <cue_XX> --refresh'; if they still fail, open a page with 'cuthol composition preview --cue <cue_XX>' to see the error; rule: 'cuthol explain G417'.`,
      cueIds[0],
      cueIds
    ),
  // [kz2 G780–G781] browser launch failures (non-default home): launch names
  // browser path, profile folder and the browser's own error with a fitting fix.
  BROWSER_LAUNCH_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G780",
      "G4_STAGE",
      "ERROR",
      `Browser launch failed for cue '${cueId}' (${reason}); the cue was skipped and no measurement covers it.`,
      `Run 'hyperframes browser ensure' so the headless shell is installed for this home directory, then re-run the failed cue with 'cuthol composition coords --cue ${cueId} --refresh'; rule: 'cuthol explain G780'.`,
      cueId
    ),
  BROWSER_LAUNCH_FAILED_MANY: (reason: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G780",
      "G4_STAGE",
      "ERROR",
      `Browser launch failed for ${cueIds.length} cues (${repeatIdRange(cueIds)}): ${reason}; the cues were skipped and no measurement covers them.`,
      `Run 'hyperframes browser ensure' so the headless shell is installed for this home directory, then re-run with 'cuthol composition coords --all --refresh'; rule: 'cuthol explain G780'.`,
      cueIds[0],
      cueIds
    ),
  BROWSER_SYSTEM_CHROME_ONLY: (foundPath: string) =>
    createDiagnostic(
      "CUTHOL-G781",
      "G4_STAGE",
      "ERROR",
      `Only a system Chrome was found at '${foundPath}': no HyperFrames headless shell exists for this home directory, so no browser step (coordinates, script probe, shader pre-pass) can run.`,
      `Run 'hyperframes browser ensure' to download the headless shell for this home directory, then retry; rule: 'cuthol explain G781'.`
    ),
  COORDS_FONTS_NOT_BUNDLED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G418",
      "G4_STAGE",
      "WARN",
      `Font bundling was unavailable for cue '${cueId}' (${reason}); measured with raw HTML, so text boxes may differ from the render by a few px.`,
      `Re-run the cue with 'cuthol composition coords --cue ${cueId} --refresh'; if fonts still miss, check the composition's font URLs with 'cuthol composition preview --cue ${cueId}'; rule: 'cuthol explain G418'.`,
      cueId
    ),
  COORDS_FONTS_NOT_BUNDLED_MANY: (reason: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G418",
      "G4_STAGE",
      "WARN",
      `Font bundling was unavailable for ${cueIds.length} cues (${repeatIdRange(cueIds)}): ${reason}; measured with raw HTML, so text boxes may differ from the render by a few px.`,
      `Re-run the cues with 'cuthol composition coords --cue <cue_XX> --refresh'; rule: 'cuthol explain G418'.`,
      cueIds[0],
      cueIds
    ),

  COORDS_PAGE_ISSUES: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G419",
      "G4_STAGE",
      "INFO",
      `Page issues while measuring cue '${cueId}': ${detail}; the boxes from this pass may be off.`,
      `Inspect the same page with 'cuthol composition preview --cue ${cueId}', fix the reported script error, then re-run 'cuthol composition coords --cue ${cueId} --refresh'; rule: 'cuthol explain G419'.`,
      cueId
    ),

  COORDS_UNKNOWN_ELEMENT: (ref: string, cueId: string, nearest: string | null) => {
    const hint = nearest ? `; nearest key is '${nearest}'` : "";
    return createDiagnostic(
      "CUTHOL-G428",
      "G4_STAGE",
      "ERROR",
      `Unknown element '${ref}' in cue '${cueId}' (no such key in the measured boxes)${hint}.`,
      nearest
        ? `Use '${nearest}', or list keys with 'cuthol composition coords --at <moment> --cue ${cueId}'; rule: 'cuthol explain G428'.`
        : `List keys with 'cuthol composition coords --at <moment> --cue ${cueId}'; rule: 'cuthol explain G428'.`,
      ref
    );
  },

  COORDS_QUERY_MISUSE: (detail: string, fix: string) =>
    createDiagnostic(
      "CUTHOL-G429",
      "G4_STAGE",
      "ERROR",
      `Geometry query misuse: ${detail}.`,
      `Use: ${fix}; rule: 'cuthol explain G429'.`
    ),

  COORDS_PAGE_ISSUES_MANY: (detail: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G419",
      "G4_STAGE",
      "INFO",
      `Page issues while measuring ${cueIds.length} cues (${repeatIdRange(cueIds)}): ${detail}; the boxes from this pass may be off.`,
      `Inspect a page with 'cuthol composition preview --cue <cue_XX>', fix the reported script error, then re-run 'cuthol composition coords --cue <cue_XX> --refresh'; rule: 'cuthol explain G419'.`,
      cueIds[0],
      cueIds
    ),
  // CUTHOL-G420..CUTHOL-G427 retired with the layout warning system; never reused (may appear in old projects/logs).

  // --- Media and speech providers (selection, extension providers, media sources): codes CUTHOL-G230 .. CUTHOL-G249 ---

  PROVIDER_UNKNOWN: (kind: string, id: string, valid: string) =>
    createDiagnostic(
      "CUTHOL-G230",
      "G1_SCHEMA",
      "ERROR",
      `Unknown ${kind} provider '${id}' (valid values: ${valid}).`,
      `Re-run with a valid ${kind} provider id, e.g. the first of: ${valid}; rule: 'cuthol explain G230'.`
    ),

  PROVIDER_CAPABILITY_MISSING: (extName: string, kind: string, available: string) =>
    createDiagnostic(
      "CUTHOL-G231",
      "G2_ASSETS",
      "ERROR",
      `Extension '${extName}' does not provide a '${kind}' provider in this run (it provides: ${available || "nothing"}), so the request cannot be served by this extension.`,
      `Check the extension manifest 'providers' section with 'cuthol extension show --name ${extName}'; rule: 'cuthol explain G231'.`
    ),

  PROVIDER_ENV_MISSING: (extName: string, kind: string, missingVars: string[]) =>
    createDiagnostic(
      "CUTHOL-G232",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) cannot run in this run: ${missingVars.length === 1 ? "environment variable" : "environment variables"} ${missingVars.map((v) => `'${v}'`).join(", ")}, which ${missingVars.length === 1 ? "is" : "are"} not set.`,
      `Set ${missingVars.length === 1 ? "it" : "them"} in your shell environment or in the project '.env' file ('${missingVars[0]}=...'), then retry; rule: 'cuthol explain G232'. Values are read from the environment only and are never written to the sequence, journal, cache, or logs.`
    ),

  PROVIDER_BAD_OUTPUT: (extName: string, kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G233",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) returned invalid output: ${detail}; the response does not match the documented JSON contract.`,
      `Fix the provider script to return the documented JSON contract (see 'extensions' guide, providers section); rule: 'cuthol explain G233'.`
    ),

  PROVIDER_EXECUTION_FAILED: (extName: string, kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G234",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) failed in this run: ${detail}`,
      `Check the provider script and its configuration with 'cuthol extension show --name ${extName}'; rule: 'cuthol explain G234'.`
    ),

  PROVIDER_TTS_NO_ALIGNMENT: (extName: string) =>
    createDiagnostic(
      "CUTHOL-G235",
      "SYS",
      "WARN",
      `Extension TTS provider '${extName}' returned audio with no word or character alignment (0 timed words/characters), so no word timings are available for this voiceover.`,
      `Captions, cleanup, and word-locked animation cannot use this voiceover. Use a provider with alignment, or transcribe the voiceover with 'cuthol speech transcribe --handle <aud_XX>'; rule: 'cuthol explain G235'.`
    ),

  MEDIA_FETCH_NOT_FOUND: (extName: string, id: string) =>
    createDiagnostic(
      "CUTHOL-G236",
      "G2_ASSETS",
      "ERROR",
      `Media provider '${extName}' has no candidate with id '${id}' (0 matches for that id).`,
      `List candidates with 'cuthol library search --provider ext:${extName} --kind music|sfx --query "<text>"'; rule: 'cuthol explain G236'.`
    ),

  // --- end of provider block ---

  // [a1 G760–G764] speech provider notes
  DEEPGRAM_AUTO_ENGLISH_NO_FILLERS: () =>
    createDiagnostic(
      "CUTHOL-G760",
      "G2_ASSETS",
      "INFO",
      `Deepgram language auto-detection settled on English but the response holds 0 filler tokens (fillers are not returned in auto mode), so filler-based cleanup has nothing to cut.`,
      `Re-run 'cuthol speech transcribe --handle <id> --lang en' to transcribe with nova-2 and get filler tokens; rule: 'cuthol explain G760'.`
    ),

  SCRIPT_ERROR_ISOLATED_MANY: (subject: string, elements: string[], firstError: string) =>
    createDiagnostic(
      "CUTHOL-G415",
      "G4_STAGE",
      "WARN",
      `Silent gaps in overlay '${subject}': the scripts of ${elements.length} elements (${repeatIdRange(elements)}) threw (first: ${firstError}); HyperFrames skipped these elements with empty timelines, so their parts are missing from the picture while the rest renders.`,
      `Fix the errors starting with the first one, then re-render with 'cuthol render --preset draft_480p' (a file change triggers the re-render); rule: 'cuthol explain G415'.`,
      subject,
      elements.map((e) => `${subject}/${e}`)
    ),
  // --- Composition script errors: CUTHOL-G430 .. CUTHOL-G434 ---
  // (G434 is reserved for future composition page diagnostics.)

  COMPOSITION_SCRIPT_FAILED_BEFORE_TIMELINE: (cueId: string, error: string, where: string | null) => {
    const at = where ? ` at ${where}` : "";
    const scope = where ? ` (${where})` : "";
    return createDiagnostic(
      "CUTHOL-G430",
      "G4_STAGE",
      "ERROR",
      `Composition '${cueId}' page script threw before its timeline registered ('${error}'${at}); the overlay cannot render (render stops with CUTHOL-G503) and monitor frames show the static unanimated page.`,
      `Fix the script${scope}, then re-check with 'cuthol composition preview --cue ${cueId}' (preview re-runs the page); 'cuthol verify' stays red while the recorded error matches the current composition files; rule: 'cuthol explain G430'.`,
      cueId
    );
  },

  COMPOSITION_SCRIPT_FAILED_AFTER_TIMELINE: (cueId: string, error: string, where: string | null) => {
    const at = where ? ` at ${where}` : "";
    const scope = where ? ` (${where})` : "";
    return createDiagnostic(
      "CUTHOL-G431",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' page script threw while its timeline was running ('${error}'${at}); the render output is unaffected, but the throwing code path never completes.`,
      `Fix the callback${scope}, then re-check with 'cuthol composition preview --cue ${cueId}'; rule: 'cuthol explain G431'.`,
      cueId
    );
  },

  COMPOSITION_CONSOLE_ERROR: (cueId: string, error: string, where: string | null) => {
    const at = where ? ` at ${where}` : "";
    const scope = where ? ` (${where})` : "";
    return createDiagnostic(
      "CUTHOL-G432",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' page logged a console error ('${error}'${at}); the render output is unaffected, but the message signals a real page problem (for example a failed shader compile or a missing asset).`,
      `Inspect the cause${scope}, then re-check with 'cuthol composition preview --cue ${cueId}'; rule: 'cuthol explain G432'.`,
      cueId
    );
  },

  COMPOSITION_CONSOLE_WARNING_ONLY: (cueId: string, warning: string, where: string | null) => {
    const at = where ? ` at ${where}` : "";
    return createDiagnostic(
      "CUTHOL-G433",
      "G4_STAGE",
      "INFO",
      `Composition '${cueId}' page logged only shader/compiler warnings ('${warning}'${at}); nothing threw and the render output is unaffected.`,
      `No action needed; re-check with 'cuthol composition preview --cue ${cueId}' if the message changes; rule: 'cuthol explain G433'.`,
      cueId
    );
  },

  // [mcp-reload G635–G639]       MCP server noticing a newer Cuthol build on disk
  MCP_RELOADED_NEWER_BUILD: (from: string, to: string) =>
    createDiagnostic(
      "CUTHOL-G635",
      "SYS",
      "INFO",
      `Cuthol was rebuilt on disk while this MCP session ran (server build ${from} -> ${to}); the MCP server restarted itself on the new build and the tool list was refreshed.`,
      `Continue with the MCP tools; their arguments now match the CLI on disk. Re-open your project (workspace action=open) if a call reports no project; rule: 'cuthol explain G635'.`
    ),
  MCP_RELOAD_FAILED: (running: string, onDisk: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G636",
      "SYS",
      "WARN",
      `Cuthol on disk (build ${onDisk}) is newer than this MCP process (build ${running}) and the automatic restart failed: ${detail}. MCP tool arguments may not match the CLI on disk.`,
      `Reconnect the cuthol MCP server in your agent (for Claude Code: /mcp -> cuthol -> Reconnect); until then avoid mixing MCP calls with CLI calls; rule: 'cuthol explain G636'.`
    ),
  INVALID_STAGE_SIZE: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G150",
      "G1_SCHEMA",
      "ERROR",
      `Invalid stage size '${raw}': the stage needs WIDTHxHEIGHT with even numbers in 16..8192 (e.g. 1920x800).`,
      `Pass '--size WIDTHxHEIGHT' with even numbers between 16 and 8192 (e.g. 'cuthol workspace stage --size 1920x800'); rule: 'cuthol explain G150'.`
    ),
  STAGE_ADOPTED_FROM_SOURCE: (size: string, undo: string) =>
    createDiagnostic(
      "CUTHOL-G151",
      "G1_SCHEMA",
      "INFO",
      `Stage set to ${size} from the first visual source (no explicit --size/--aspect was given). Undo: ${undo}.`,
      `Pass '--aspect' or '--size' at init to fix the stage instead (e.g. 'cuthol workspace init --size ${size}'); rule: 'cuthol explain G151'.`
    ),
  STAGE_SIZE_SUGGESTED: (size: string, command: string) =>
    createDiagnostic(
      "CUTHOL-G152",
      "G1_SCHEMA",
      "INFO",
      `First visual source suggests stage ${size} (stage is still the default; adopting avoids a rescale of every placed item). Run: '${command}'.`,
      `Run the suggested command to adopt the source size; rule: 'cuthol explain G152'.`
    ),
  STAGE_RESIZED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G153",
      "G1_SCHEMA",
      "INFO",
      `Stage resized: ${detail} (not emitted by the current code; kept for older projects and logs).`,
      `Undo with 'cuthol workspace journal undo' if the new layout is wrong; rule: 'cuthol explain G153'.`
    ),
  STAGE_COMPOSITION_SIZE_MISMATCH: (cueId: string, compSize: string, stageSize: string) =>
    createDiagnostic(
      "CUTHOL-G154",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' declares ${compSize} but the stage is ${stageSize}; the composition HTML is not rewritten, so the picture is scaled to fit.`,
      `Resize the composition or match the stage ('cuthol workspace stage --size ${stageSize}'); rule: 'cuthol explain G154'.`
    ),
  // [canvas G150–G159]           free stage size, size suggestion from sources, stage resize and rescale
  // [tempo G160–G169]            sequence tempo (stage.tempo): validation, render/monitor/export mapping
  INVALID_TEMPO: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G160",
      "G1_SCHEMA",
      "ERROR",
      `Invalid tempo '${raw}': sequence rate must be 0.5..2.0 (1 = realtime; applied at render/monitor/export, absent = 1).`,
      `Run 'cuthol workspace tempo --rate 1.1' with a rate in 0.5..2.0, or '--rate 1' to clear it; rule: 'cuthol explain G160'.`
    ),
  // [u1 G750–G754]               spine-join audio fade setting (stage.audio_join_fade_ms)
  INVALID_AUDIO_JOIN_FADE: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G750",
      "G1_SCHEMA",
      "ERROR",
      `Invalid audio join fade '${raw}': fade length must be 0..100 ms (0 turns the join fades off; absent = 10 ms).`,
      `Run 'cuthol workspace audio-fade --ms 10' with a value in 0..100, or '--ms 0' to turn the join fades off; rule: 'cuthol explain G750'.`
    ),
  // [multi-notes G690–G699]      Live notes across frames, scene boundaries, scene ranges
  LIVE_MULTI_NOTES_QUEUED: (id: string, cells: number, frames: number) =>
    createDiagnostic(
      "CUTHOL-G690",
      "G5_SIGNAL",
      "INFO",
      `Multi-scene note packet '${id}' queued in this run with ${cells} contact-sheet cells across ${frames} frames; the sheet attaches to the stored packet when ready.`,
      "Read the note lines with the next command result; the sheet image follows on disk; rule: 'cuthol explain G690'."
    ),
  LIVE_SHEET_CELLS_DROPPED: (dropped: number, total: number, cap: number) =>
    createDiagnostic(
      "CUTHOL-G691",
      "G5_SIGNAL",
      "WARN",
      `Contact sheet keeps ${total - dropped} of ${total} cells in this run (cap ${cap} cells); the packet names the ${dropped} dropped cells.`,
      "Open the sheet for the kept cells; read the remaining pins from the note lines; rule: 'cuthol explain G691'."
    ),

  // [p2mo:W0 G280–G282] motion layers on placement: resolver, `motion` kind, pixel-stage predicate
  // [p2mo:A G283-G287] layer combination and expressions
  PLACEMENT_EXPR_TOO_COMPLEX: (points: number, cap: number) =>
    createDiagnostic(
      "CUTHOL-G283",
      "G4_STAGE",
      "ERROR",
      `Placement envelope with ${points} points exceeds the ffmpeg expression budget (cap ${cap} points); the combined graph would fail in ffmpeg, so the render stops.`,
      `Split the envelope into fewer than ${cap} points or shorter clips before rendering; rule: 'cuthol explain G283'.`
    ),
  // [p2mo:B G288–G291] motion surface and verify
  MOTION_OPACITY_CLAMPED: (item: string, range: string, layers: string) =>
    createDiagnostic(
      "CUTHOL-G288",
      "G4_STAGE",
      "WARN",
      `Item '${item}' channel opacity combined range ${range} rises above 1 (it is clamped) via layers ${layers}; gate G4 keeps the combined opacity within [0, 1].`,
      `Lower the base or layer opacity so the combined range stays within [0, 1] ('cuthol spine envelope --clip ${item} --param opacity --points <...>'); rule: 'cuthol explain G288'.`
    ),
  MOTION_SCALE_ZERO: (item: string, channel: string, range: string, layers: string) =>
    createDiagnostic(
      "CUTHOL-G289",
      "G4_STAGE",
      "WARN",
      `Item '${item}' channel ${channel} combined range ${range} crosses or touches 0 via layers ${layers}; a zero scale collapses the item to nothing (gate G4 motion check).`,
      `Keep the combined scale away from 0 ('cuthol spine envelope --clip ${item} --param ${channel} --points <...>'); rule: 'cuthol explain G289'.`
    ),
  // [p2mo:C G292–G293] live window
  // [p2mo:D G294–G297] moving text
  // [shader:W0 G700–G704] fx pre-pass split: a spine clip chain cut at an fx entry runs its prefix as a separate ffmpeg pass
  FX_PREPASS_FAILED: (id: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G700",
      "G4_STAGE",
      "ERROR",
      `Fx pre-pass '${id}' failed (${detail}); the main graph cannot render without its intermediate file.`,
      "Re-run the render; the pre-pass retries from scratch. If it keeps failing, inspect the pre-pass filter graph."
    ),
  FX_PREPASS_OUTPUT_MISSING: (id: string, outPath: string) =>
    createDiagnostic(
      "CUTHOL-G701",
      "G4_STAGE",
      "ERROR",
      `Fx pre-pass '${id}' finished without a complete intermediate file at '${outPath}'.`,
      "Re-run the render; the pre-pass retries from scratch."
    ),
  FX_PREPASS_UNAVAILABLE: (where: string) =>
    createDiagnostic(
      "CUTHOL-G702",
      "G4_STAGE",
      "ERROR",
      `Render path '${where}' compiled a plan with fx pre-passes but cannot run them; rendering without the cut would silently change the picture.`,
      "Run the render through a path that executes plan pre-passes first."
    ),
  FX_PREPASS_INPUT_MISMATCH: (id: string) =>
    createDiagnostic(
      "CUTHOL-G703",
      "G4_STAGE",
      "ERROR",
      `Fx pre-pass '${id}' does not replay exactly one source input; refusing to guess the pre-pass input mapping.`,
      "Report this as a compiler bug with the clip id and the plan dump."
    ),
  FX_PREPASS_LOCKED: (id: string, outPath: string) =>
    createDiagnostic(
      "CUTHOL-G704",
      "G4_STAGE",
      "ERROR",
      `Fx pre-pass '${id}' could not take the lock for '${outPath}' and the file never completed.`,
      "Re-run the render; check for a stale '.lock' file next to the intermediate if it keeps failing."
    ),
  // [shader:E1A G705–G719] shader clip effects (GLSL) on spine clips, rendered through the pre-pass
  SHADER_CHECK_DEFERRED: (kind: string) =>
    createDiagnostic(
      "CUTHOL-G705",
      "G4_STAGE",
      "WARN",
      `fx definition check passed with a warning on 'definition' fx '${kind}' in this run: shader effects are not checked by spine fx check yet, so this shader is unchecked.`,
      "No action needed; the shader is compiled when the clip renders; rule: 'cuthol explain G705'."
    ),
  SHADER_MANIFEST: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G706",
      "G4_STAGE",
      "ERROR",
      `Invalid shader effect: ${detail}`,
      "Fix the extension manifest or the '.glsl' file and re-enable the extension."
    ),
  SHADER_WORKER_FAILED: (id: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G707",
      "G4_STAGE",
      "ERROR",
      `Shader pre-pass '${id}' failed (${detail}); the main graph cannot render without its intermediate file, so the render stopped with no fallback image.`,
      `Fix the '.glsl' file at the reported line, then re-run with 'cuthol render --preset draft_480p' (the shader pass retries from scratch); rule: 'cuthol explain G707'.`
    ),
  SHADER_FRAME_TIMEOUT: (id: string, frame: number, timeoutMs: number) =>
    createDiagnostic(
      "CUTHOL-G708",
      "G4_STAGE",
      "ERROR",
      `Shader pre-pass '${id}' timed out on frame ${frame} after ${timeoutMs}ms in this run (the shader may loop forever); the main graph cannot render without its intermediate file.`,
      "Fix the shader so every invocation terminates, then re-run the render; rule: 'cuthol explain G708'."
    ),
  SHADER_LANE_REJECTED: (item: string, fxId: string) =>
    createDiagnostic(
      "CUTHOL-G709",
      "G4_STAGE",
      "ERROR",
      `Shader effect '${fxId}' on '${item}' is not supported: shader effects apply to spine clips in this version (gate G1: lane cues have no shader stage).`,
      "Move the effect to a spine clip ('cuthol spine fx add --clip <sp_XX> ...'), or use an ffmpeg effect on the lane cue; rule: 'cuthol explain G709'."
    ),
  SHADER_COMPILE_ERROR: (file: string, line: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G710",
      "G4_STAGE",
      "ERROR",
      `Shader '${file}' failed to compile (line ${line}): ${detail} (gate G4: the extension cannot shade until this compiles).`,
      "Fix the '.glsl' file at the reported line and re-enable the extension ('cuthol extension enable --name <name>'); rule: 'cuthol explain G710'."
    ),
  SHADER_SINGLE_FRAME_LOST: (atMs: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G712",
      "G4_STAGE",
      "ERROR",
      `Single-frame render at ${atMs}ms failed: its shader intermediate vanished and re-running the shader pre-pass did not bring it back (${detail}); no neighbouring frame is substituted.`,
      "Re-run the command; if it keeps failing, inspect the shader file and the blobs directory for disk or lock problems."
    ),
  SHADER_CACHE_ENFORCED: (deleted: number, beforeMb: string, afterMb: string) =>
    createDiagnostic(
      "CUTHOL-G713",
      "G4_STAGE",
      "INFO",
      `Shader intermediates exceeded the render.shader_cache_cap_gb cap: deleted ${deleted} file(s) (${beforeMb} MB -> ${afterMb} MB).`,
      "No action needed; intermediates re-shade on demand. Raise render.shader_cache_cap_gb to keep more."
    ),
  // Browser compile result missing for a shader content hash: the static scan ran instead.
  SHADER_NOT_COMPILED_YET: (file: string) =>
    createDiagnostic(
      "CUTHOL-G711",
      "G4_STAGE",
      "WARN",
      `Shader '${file}' was not compiled in a browser yet (no cached result for its content hash), so only the static scan ran (gate G4 needs the browser compile for the full check).`,
      "Run 'cuthol extension enable --name <name>' for its extension to compile it, then re-run this command; rule: 'cuthol explain G711'."
    ),
  // [fix:A G530–G534] render output
  // [fix:B G692–G696] live server (reserved; B1 needs no new diagnostic: failures keep the G612 contract)
  LIVE_NOTE_COORDS_PIN_SCOPED: (frame: number, kept: number, total: number) =>
    createDiagnostic(
      "CUTHOL-G692",
      "G5_SIGNAL",
      "INFO",
      `Pin measurement for frame ${frame} scoped to ${kept} of ${total} compositions whose stage box covers the pin in this run.`,
      "Pin again elsewhere if the element name looks stale; each pin measures only its own compositions; rule: 'cuthol explain G692'."
    ),
  LIVE_NOTE_COORDS_PIN_FALLBACK: (frame: number) =>
    createDiagnostic(
      "CUTHOL-G693",
      "G5_SIGNAL",
      "INFO",
      `Pin measurement for frame ${frame} found nothing in the covering compositions in this run, so the remaining compositions were measured too.`,
      "No action needed; the element answer matches the whole-frame measurement; rule: 'cuthol explain G693'."
    ),
  // [fix:C G642–G646] live window
  // [fix:D G250–G254] ingest, brief, scaffold
  // [b040:A G255–G256] placement readers
  // [b040:B G257–G259] fx chain checks
  // [b040:C G260–G261] motion blur across segments
  // [b040:D G262–G263] composition transparency staging

  // [k79w2:K G720–G724] small fixes: speech test isolation, faster first verify, empty composition warning
  EMPTY_COMPOSITION_RENDER: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G720",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' draws nothing: the captured transparent overlay is empty across sampled frames (alpha ~0 everywhere it is on screen).`,
      `Check that the timeline of '${cueId}' starts visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue ${cueId}'); rule: 'cuthol explain G720'.`,
      cueId
    ),
  EMPTY_COMPOSITION_RENDER_MANY: (cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G720",
      "G4_STAGE",
      "WARN",
      `${cueIds.length} composition cues (${repeatIdRange(cueIds)}) draw nothing: their captured transparent overlays are empty across sampled frames (alpha ~0 everywhere they are on screen).`,
      `Check that the timelines start visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue ${cueIds[0]}'); rule: 'cuthol explain G720'.`,
      cueIds[0],
      cueIds
    ),
  EMPTY_COMPOSITION_VERIFY: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G721",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' draws nothing: its cached overlay sidecar is marked empty and composition files are unchanged (gate G4 verify reuses the cached capture).`,
      "Check that the timeline starts visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue <cue_XX>'); rule: 'cuthol explain G721'."
    ),
  EMPTY_COMPOSITION_FRAME: (cueId: string, at: string) =>
    createDiagnostic(
      "CUTHOL-G722",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' draws nothing at ${at}: the transparent capture alpha is empty there (it may not have entered yet).`,
      `Check that the timeline of '${cueId}' starts visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue ${cueId}'); rule: 'cuthol explain G722'.`,
      cueId
    ),
  EMPTY_COMPOSITION_FRAME_MANY: (cueIds: string[], at: string) =>
    createDiagnostic(
      "CUTHOL-G722",
      "G4_STAGE",
      "WARN",
      `${cueIds.length} compositions (${repeatIdRange(cueIds)}) draw nothing at ${at}: the transparent capture alpha is empty there (they may not have entered yet).`,
      `Check that the timelines start visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue ${cueIds[0]}'); rule: 'cuthol explain G722'.`,
      cueIds[0],
      cueIds
    ),
  EMPTY_COMPOSITION_SHEET: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G723",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' draws nothing in any sheet tile where it is active (transparent capture alpha empty in every tile).`,
      `Check that the timeline of '${cueId}' starts visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue ${cueId}'); rule: 'cuthol explain G723'.`,
      cueId
    ),
  EMPTY_COMPOSITION_SHEET_MANY: (cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G723",
      "G4_STAGE",
      "WARN",
      `${cueIds.length} composition cues (${repeatIdRange(cueIds)}) draw nothing in any sheet tile where they are active (transparent capture alpha empty in every tile).`,
      `Check that the timelines start visible, GSAP is loaded and nothing hides the root ('cuthol composition preview --cue ${cueIds[0]}'); rule: 'cuthol explain G723'.`,
      cueIds[0],
      cueIds
    ),
  SCRIPT_PROBE_BATCH: (count: number) =>
    createDiagnostic(
      "CUTHOL-G724",
      "SYS",
      "INFO",
      `Script probe ran ${count} composition jobs with shared-browser concurrency.`,
      "No action needed."
    ),
  // [live-shader:E1BL G730–G734]
  LIVE_SHADER_UNKNOWN_ITEM: (item: string) =>
    createDiagnostic(
      "CUTHOL-G730",
      "G5_SIGNAL",
      "ERROR",
      `Live shader request for unknown spine item '${item}' in this run.`,
      `List clip ids with 'cuthol spine show' and retry with a spine clip id; rule: 'cuthol explain G730'.`,
      item
    ),
  LIVE_SHADER_SOURCE_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G731",
      "G5_SIGNAL",
      "ERROR",
      `Live shader sources for spine item '${item}' could not be resolved in this run (${detail}).`,
      `Re-enable the extension ('cuthol extension enable --name <ext>') and retry; rule: 'cuthol explain G731'.`,
      item
    ),
  LIVE_SHADER_COMPILE_FAILED: (fxId: string, file: string, line: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G732",
      "G5_SIGNAL",
      "WARN",
      `Live shader '${fxId}' ('${file}') failed to compile (line ${line}): ${detail}. The preview shows the unshaded video.`,
      `Fix the '.glsl' file at the reported line and re-enable the extension.`,
      fxId
    ),
  LIVE_SHADER_ENTRY_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G733",
      "G5_SIGNAL",
      "ERROR",
      `Live shader entry '${item}' failed in this run (${detail}).`,
      `Check the clip's fx list ('cuthol spine show') and the extension state; rule: 'cuthol explain G733'.`,
      item
    ),
  LIVE_SHADER_APPROXIMATED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G734",
      "G5_SIGNAL",
      "INFO",
      `Live preview of '${item}' is approximate for shaders (${detail}).`,
      `Use the Exact frame button to compare with the render.`,
      item
    ),

  // ---------------------------------------------------------------------------------------------------

  // [ed G380–G389] silent-edit guards: orphan fx envelopes, empty splits, transcript-less captions.
  ENVELOPE_FX_ORPHAN: (ownerId: string, parameter: string, fxId: string, fxIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G380",
      "G1_SCHEMA",
      "ERROR",
      `Envelope '${parameter}' on '${ownerId}' cannot be written: no effect with id '${fxId}' exists on '${ownerId}', so the envelope would never execute.`,
      fxIds.length > 0
        ? `'${ownerId}' carries fx: ${fxIds.join(", ")}. Envelope one of their parameters instead ('cuthol spine envelope --item ${ownerId} --param fx.<fx-id>.<param> --points <...>'), or add the effect first ('cuthol spine fx add --item ${ownerId} ...'); rule: 'cuthol explain G380'.`
        : `'${ownerId}' carries no fx entries. Add the effect first ('cuthol spine fx add --item ${ownerId} ...'), then envelope its parameter; rule: 'cuthol explain G380'.`,
      ownerId
    ),
  ENVELOPE_FX_PARAM_NOT_ANIMATABLE: (
    ownerId: string, parameter: string, fxId: string, kind: string, animatable: string[]
  ) =>
    createDiagnostic(
      "CUTHOL-G381",
      "G1_SCHEMA",
      "ERROR",
      `Envelope '${parameter}' on '${ownerId}' cannot be written: '${parameter.split(".").slice(2).join(".") || parameter}' is not an envelopable parameter of effect '${fxId}' ('${kind}'), so the envelope would never execute.`,
      animatable.length > 0
        ? `Envelopable parameters of '${fxId}': ${animatable.join(", ")}. Envelope one of those instead ('cuthol spine envelope --item ${ownerId} --param fx.${fxId}.<param> --points <...>'); rule: 'cuthol explain G381'.`
        : `Effect '${fxId}' ('${kind}') declares no envelopable parameter, so it cannot carry an envelope. Remove the envelope or pick another effect; rule: 'cuthol explain G381'.`,
      ownerId
    ),
  VERIFY_FX_ENVELOPE_ORPHAN: (ownerId: string, parameter: string, fxId: string) =>
    createDiagnostic(
      "CUTHOL-G382",
      "G1_SCHEMA",
      "WARN",
      `Envelope '${parameter}' on '${ownerId}' is orphaned: no effect with id '${fxId}' exists on '${ownerId}' (written by an older build; it has no effect on the render; rule: 'cuthol explain G382').`,
      `Delete the orphaned '${parameter}' envelope from '${ownerId}' in the sequence JSON, or re-add the effect it belonged to ('cuthol spine fx add --clip <sp_XX> --kind <kind>'); rule: 'cuthol explain G382'.`,
      ownerId
    ),
  SPINE_SPLIT_NO_POINT: (
    clipId: string, givenMs: number[], localMinMs: number, localMaxMs: number, seqMinMs: number, seqMaxMs: number
  ) =>
    createDiagnostic(
      "CUTHOL-G383",
      "G1_SCHEMA",
      "ERROR",
      `Split of '${clipId}' wrote nothing: no split point falls strictly inside the clip (given: ${givenMs.join(", ")}ms; clip-local inside: ${localMinMs}..${localMaxMs}ms).`,
      `'--at' is clip-local: use a point in ${localMinMs}..${localMaxMs}ms, or pass a sequence time in ${seqMinMs}..${seqMaxMs}ms with '--sequence-time'; rule: 'cuthol explain G383'.`,
      clipId
    ),
  CAPTIONS_NO_TRANSCRIPT: (itemIds: string[], handles: string[]) =>
    createDiagnostic(
      "CUTHOL-G384",
      "G2_ASSETS",
      "WARN",
      `Caption run wrote 0 cues: all ${itemIds.length} spine item(s) (${repeatIdRange(itemIds)}) have no transcript (sources: ${handles.join(", ")}).`,
      `Transcribe first ('cuthol speech transcribe --handle <h>'), then re-run captions; rule: 'cuthol explain G384'.`,
      itemIds[0],
      itemIds
    ),
  CAPTIONS_PARTIAL_TRANSCRIPT: (itemIds: string[], handles: string[]) =>
    createDiagnostic(
      "CUTHOL-G385",
      "G2_ASSETS",
      "WARN",
      `Caption run skipped ${itemIds.length} untranscribed spine item(s) (${repeatIdRange(itemIds)}, sources: ${handles.join(", ")}); captions cover the transcribed items only.`,
      `Transcribe the rest ('cuthol speech transcribe --handle <h>') and re-run captions for full coverage; rule: 'cuthol explain G385'.`,
      itemIds[0],
      itemIds
    ),

  // ---------------------------------------------------------------------------------------------------

  // [u3 G740–G749] cleanup join-edge loudness: `speech verify-cleanup` summary and `verify` INFO
  JOIN_EDGE_SUMMARY: (summaryLine: string) =>
    createDiagnostic(
      "CUTHOL-G740",
      "G5_SIGNAL",
      "INFO",
      `Join-edge loudness below the WARN threshold: ${summaryLine} (WARN threshold: 40% loud joins; clean edits measured 16-17%, the reference bad edit 59%).`,
      `No action needed; rule: 'cuthol explain G740'.`
    ),
  JOIN_EDGE_LOUD_SHARE_HIGH: (summaryLine: string) =>
    createDiagnostic(
      "CUTHOL-G741",
      "G5_SIGNAL",
      "WARN",
      `Excise join edges are loud: ${summaryLine} (WARN threshold: 40% loud joins; clean edits measured 16-17%, the reference bad edit 59%). Audible clicks at the cut points are likely.`,
      `Re-run 'cuthol speech cleanup' with acoustic edge placement, or fix the worst joins by hand ('cuthol spine excise --snap'); rule: 'cuthol explain G741'.`
    ),
} as const;

export function estimateCommandLineLength(executable: string, args: readonly string[]): number {
  let len = executable.length;
  for (const arg of args) {
    len += 1 + arg.length;
    if (arg.length === 0 || /[\s"]/u.test(arg)) {
      len += 2;
    }
  }
  return len;
}

export function getPlatformCommandLineLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 32_767 : 131_072;
}

export function summarizeCommandForDiagnostic(
  executable: string,
  args: readonly string[],
  maxChars = 160
): string {
  const exeBase = executable.replace(/\\/g, "/").split("/").pop() || executable;
  const compactArgs = args.map((a) => {
    if (a.length > 48) {
      const normalized = a.replace(/\\/g, "/");
      if (normalized.includes("/")) {
        const parts = normalized.split("/");
        const tail2 = parts.slice(-2).join("/");
        if (tail2.length <= 56) return `.../${tail2}`;
        const base = parts[parts.length - 1] || "";
        if (base.length <= 48) return `.../${base}`;
      }
      return `${a.slice(0, 20)}...${a.slice(-24)}`;
    }
    return a;
  });
  const full = [exeBase, ...compactArgs].join(" ");
  if (full.length <= maxChars) return full;
  const headLen = Math.max(40, Math.floor(maxChars * 0.55));
  const tailLen = Math.max(30, maxChars - headLen - 5);
  return `${full.slice(0, headLen)} ... ${full.slice(-tailLen)}`;
}

export function createSubprocessFailureDiagnostic(options: {
  tool: string;
  executable?: string;
  args?: readonly string[];
  proc: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
    stderr?: string | Buffer | null;
    stdout?: string | Buffer | null;
    stalled?: boolean;
    stalledMs?: number;
    stallThresholdMs?: number;
    lastProgress?: string;
    commandSummary?: string;
  };
  clipCount?: number;
  fallbackDetail?: string;
}): CutholDiagnostic {
  const executable = options.executable ?? options.tool.split(/\s+/)[0] ?? "ffmpeg";
  const args = options.args ?? [];

  if (options.proc.stalled) {
    return DIAGNOSTICS.SUBPROCESS_STALLED({
      step: options.tool,
      stalledMs: options.proc.stalledMs ?? options.proc.stallThresholdMs ?? 0,
      thresholdMs: options.proc.stallThresholdMs ?? options.proc.stalledMs ?? 0,
      lastProgress: options.proc.lastProgress ?? "no progress/output produced",
      commandSummary:
        options.proc.commandSummary ?? summarizeCommandForDiagnostic(executable, args),
    });
  }

  const commandLength = estimateCommandLineLength(executable, args);
  const limitChars = getPlatformCommandLineLimit();
  const singleArgMax = args.reduce((max, a) => (a.length > max ? a.length : max), 0);
  const err = options.proc.error as NodeJS.ErrnoException | undefined;
  const errCode = err?.code ?? "";

  if (
    errCode === "ENAMETOOLONG" ||
    errCode === "E2BIG" ||
    (err && (commandLength >= limitChars || singleArgMax >= limitChars))
  ) {
    return DIAGNOSTICS.COMMAND_LINE_TOO_LONG(
      options.tool,
      Math.max(commandLength, singleArgMax),
      limitChars,
      options.clipCount,
      errCode || undefined
    );
  }

  const stderrStr =
    typeof options.proc.stderr === "string"
      ? options.proc.stderr
      : Buffer.isBuffer(options.proc.stderr)
        ? options.proc.stderr.toString("utf8")
        : "";
  const stdoutStr =
    typeof options.proc.stdout === "string"
      ? options.proc.stdout
      : Buffer.isBuffer(options.proc.stdout)
        ? options.proc.stdout.toString("utf8")
        : "";

  if (err) {
    const clipInfo =
      typeof options.clipCount === "number" ? `, clip_count=${options.clipCount}` : "";
    const detail = `Subprocess failed to start (${errCode || err.name}: ${err.message}; command=${ executable }, command_length=${commandLength}/${limitChars} chars${clipInfo})${stderrStr.trim() ? ` — ${stderrStr.trim().slice(-360)}` : ""}`;
    return DIAGNOSTICS.EXTERNAL_TOOL_FAILED(options.tool, detail);
  }

  const outTail = (stderrStr || stdoutStr || "").trim().slice(-600);
  const statusInfo =
    options.proc.status !== null && options.proc.status !== undefined
      ? `exit_code=${options.proc.status}`
      : options.proc.signal
        ? `signal=${options.proc.signal}`
        : "status=null";
  const detail = outTail
    ? `${outTail} (${statusInfo})`
    : `${options.fallbackDetail ?? "subprocess failed"} (${statusInfo}, command_length=${commandLength} chars)`;
  return DIAGNOSTICS.EXTERNAL_TOOL_FAILED(options.tool, detail);
}
