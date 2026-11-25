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
  formatted: string;
}

export function createDiagnostic(
  code: string,
  gate: VerificationGateId,
  severity: DiagnosticSeverity,
  what: string,
  suggestion: string,
  subject_id?: string
): CutholDiagnostic {
  const formatted = `[${code}] ${what} | Suggestion: ${suggestion}`;
  return { code, gate, severity, what, suggestion, subject_id, formatted };
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
      `External changes detected in the project folder (made outside Cuthol): ${summary}`,
      `First inspect the diff with 'cuthol workspace changes show', then run 'cuthol workspace changes adopt' (adopt, undoable) or 'cuthol workspace changes revert' (back to Cuthol's last state).`
    ),

  EXTERNAL_CHANGE_WOULD_BE_OVERWRITTEN: (target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G211",
      "G2_ASSETS",
      "ERROR",
      `'${target}' was changed outside Cuthol; this operation would have overwritten it and was stopped (${detail}). The file was left unchanged so your edit is not lost.`,
      `First inspect the diff with 'cuthol workspace changes show', then run 'cuthol workspace changes adopt' or 'cuthol workspace changes revert' and retry the operation.`
    ),

  COMPOSITION_SCAFFOLD_WOULD_OVERWRITE: (compDir: string, files: string[], detail?: string) =>
    createDiagnostic(
      "CUTHOL-G215",
      "G2_ASSETS",
      "ERROR",
      `Scaffolding '${compDir}' would overwrite ${files.length} file(s) that were edited after Cuthol wrote them: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5})` : ""}. Nothing was written${detail ? `; ${detail}` : ""}.`,
      detail
        ? `Keep the edited files, or move them out of the folder before scaffolding again.`
        : `Keep your edits (pick another --comp-dir), or pass --force to overwrite them; a forced scaffold is one journal revision and 'cuthol workspace journal undo' brings the edited files back.`
    ),

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
      `No cached beat grid for asset '${assetHandle}'; beat times cannot be resolved.`,
      `Run 'cuthol library beats --asset ${assetHandle}' first, then retry with '--beat <n> --beats-of ${assetHandle}'.`,
      assetHandle
    ),
  ENVELOPE_BEAT_NO_PLACEMENT: (assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G171",
      "G3_TIMING",
      "ERROR",
      `Asset '${assetHandle}' is not placed on any lane cue; a beat time has no timeline position.`,
      `Place the asset with 'cuthol lane add-cue --asset ${assetHandle}' first, then retry.`,
      assetHandle
    ),
  ENVELOPE_BEAT_AMBIGUOUS: (assetHandle: string, cueIds: string[]) =>
    createDiagnostic(
      "CUTHOL-G172",
      "G3_TIMING",
      "ERROR",
      `Asset '${assetHandle}' is placed on ${cueIds.length} cues (${cueIds.join(", ")}); a beat number is ambiguous.`,
      `Trim the project to a single placement of '${assetHandle}', or write the keyframe with an explicit '--at <t>' time instead.`,
      assetHandle
    ),
  ENVELOPE_BEAT_INDEX_INVALID: (assetHandle: string, beat: number) =>
    createDiagnostic(
      "CUTHOL-G173",
      "G1_SCHEMA",
      "ERROR",
      `Beat ${beat} is outside the cached grid of asset '${assetHandle}'.`,
      `List the grid with 'cuthol library beats --asset ${assetHandle}' and pick a beat between 1 and the grid count.`,
      assetHandle
    ),
  ENVELOPE_POINT_MISSING: (targetId: string, parameter: string, offsetMs: number) =>
    createDiagnostic(
      "CUTHOL-G174",
      "G1_SCHEMA",
      "ERROR",
      `No keyframe of '${parameter}' at ${offsetMs}ms on '${targetId}'.`,
      `List the points with 'cuthol spine envelope --clip ${targetId} --param ${parameter}' (read path) or add one with 'cuthol spine envelope point add'.`,
      targetId
    ),
  ENVELOPE_POINT_VALUE_INVALID: (targetId: string, parameter: string) =>
    createDiagnostic(
      "CUTHOL-G175",
      "G1_SCHEMA",
      "ERROR",
      `Keyframe value of '${parameter}' on '${targetId}' is not a finite number.`,
      `Pass '--value <number>' with a finite value.`,
      targetId
    ),
  ENVELOPE_VALUE_UNRESOLVABLE: (targetId: string, parameter: string) =>
    createDiagnostic(
      "CUTHOL-G176",
      "G1_SCHEMA",
      "ERROR",
      `Parameter '${parameter}' on '${targetId}' has no envelope and no static value.`,
      `Add a keyframe with 'cuthol spine envelope point add --clip ${targetId} --param ${parameter} --at <t> --value <n>'.`,
      targetId
    ),
  // [fx:B G180–G189] mask and motion blur
  INVALID_MASK_SPEC: (clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G180",
      "G1_SCHEMA",
      "ERROR",
      `Invalid mask on '${clipId}' (${detail}).`,
      `Use 'cuthol spine mask --clip ${clipId} --shape rect|ellipse|split --center-x 0..200 --center-y 0..200 --width 1..200 --height 1..200 [--feather 0..400] [--invert|--no-invert]'.`,
      clipId
    ),
  INVALID_MOTION_BLUR_SPEC: (clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G181",
      "G1_SCHEMA",
      "ERROR",
      `Invalid motion blur on '${clipId}' (${detail}).`,
      `Use 'cuthol spine motion-blur --clip ${clipId} --shutter 0..360 --subframes 2..16' or '--off'.`,
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
      `The user paused the agent in the Cuthol Live window (since ${since}) and is editing the timeline; '${operation}' was not applied.`,
      `Do not retry yet. Run 'cuthol live wait' (MCP: workspace action=live_wait); it returns when the user resumes, with a summary of their edits. Read-only commands still work.`
    ),
  // [live:A G602–G605]
  LIVE_SERVER_START_FAILED: (dir: string) =>
    createDiagnostic(
      "CUTHOL-G602",
      "SYS",
      "ERROR",
      `The Cuthol Live server for '${dir}' did not start within 10 s.`,
      `Check '.cuthol/live/server.log' in the project, stop any stale server with 'cuthol live stop --dir "${dir}"', and retry 'cuthol live open'.`
    ),
  // [live:B G606–G608]
  LIVE_WINDOW_OPEN_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G606",
      "SYS",
      "WARN",
      `The Cuthol Live window could not be opened (${detail}). The live server keeps running; the agent's work continues.`,
      `Open the URL from 'cuthol live open' manually in Edge or Chrome, or retry once the browser is installed.`
    ),
  LIVE_THUMB_FAILED: (sceneId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G607",
      "SYS",
      "WARN",
      `Scene thumbnail for '${sceneId}' could not be rendered (${detail}); the scene list shows a placeholder.`,
      `Check that the scene's source media exists and 'monitor frame' works for the project, then re-open the Live window.`,
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
      `Composition files for cue '${cueId}' could not be served to the Live preview (${detail}).`,
      `Check that the cue's composition_dir exists inside the project and entry_html is present.`
    ),
  LIVE_EXACT_FRAME_FAILED: (atMs: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G612",
      "G5_SIGNAL",
      "WARN",
      `Exact preview frame at ${atMs}ms could not be rendered (${detail}).`,
      `Run 'cuthol monitor frame --at ${atMs}ms' to see the full error.`
    ),
  // [live:D G613–G615]
  LIVE_CONFIG_INVALID_MODE: (where: string, value: string) =>
    createDiagnostic(
      "CUTHOL-G613",
      "G1_SCHEMA",
      "ERROR",
      `Invalid Cuthol Live mode '${value}' in ${where}; expected 'ask', 'on' or 'off'.`,
      `Run 'cuthol live config --mode ask|on|off' (add '--global' for the user-level setting) to fix it.`
    ),
  LIVE_CONFIG_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G614",
      "SYS",
      "ERROR",
      `Could not write the Cuthol Live user setting to '${file}': ${reason}.`,
      `Check that the folder exists and is writable, or set the project-level mode instead ('cuthol live config --mode ask|on|off').`
    ),
  // [live:E G616–G617]
  LIVE_NOTE_COORDS_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G616",
      "G5_SIGNAL",
      "WARN",
      `Live note coordinate lookup failed or timed out (${detail}); the note is kept without element names.`,
      `Wait for the coordinate cache to warm up (the window retries automatically), or send the note without elements.`
    ),
  LIVE_NOTE_SHEET_FAILED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G617",
      "G5_SIGNAL",
      "WARN",
      `Live note contact sheet could not be rendered (${detail}); the packet is queued without an image.`,
      `Run 'cuthol monitor frame' for the note's timestamp to see the full error; the note text still reaches the agent.`
    ),
  // [live:F G618–G619]
  LIVE_EDIT_REVISION_CONFLICT: (
    action: string,
    detail: string,
    suggestion = "The timeline changed under the Live window; it refreshes automatically. Retry the edit, and use undo only for your own edits made while the agent is paused."
  ) =>
    createDiagnostic(
      "CUTHOL-G618",
      "SYS",
      "ERROR",
      `Live edit '${action}' was not applied: ${detail}.`,
      suggestion
    ),
  LIVE_EDIT_COMMAND_FAILED: (action: string, target: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G619",
      "SYS",
      "ERROR",
      `Live edit '${action}' on '${target}' failed: ${detail}.`,
      `Fix the underlying problem (see the command diagnostic above) and retry. If the timeline looks wrong, undo the paused session's edits one step at a time.`
    ),
  // [settings G620–G624]
  SETTINGS_UNKNOWN_KEY: (key: string) =>
    createDiagnostic(
      "CUTHOL-G620",
      "G1_SCHEMA",
      "ERROR",
      `Unknown settings key '${key}'.`,
      `Run 'cuthol settings list' to see the available keys.`
    ),
  SETTINGS_INVALID_VALUE: (key: string, value: string, expected: string) =>
    createDiagnostic(
      "CUTHOL-G621",
      "G1_SCHEMA",
      "ERROR",
      `Invalid value ${value} for setting '${key}'; expected ${expected}.`,
      `Run 'cuthol settings get ${key}' to see the current value and source.`
    ),
  SETTINGS_AGENT_READONLY: (key: string) =>
    createDiagnostic(
      "CUTHOL-G622",
      "G1_SCHEMA",
      "ERROR",
      `Setting '${key}' cannot be changed by the agent; it is window-only.`,
      `Change it in the Live window (Settings > Shortcuts) instead.`
    ),
  SETTINGS_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G623",
      "SYS",
      "ERROR",
      `Could not write the setting to '${file}': ${reason}.`,
      `Check that the folder exists and is writable.`
    ),
  SETTINGS_ENV_LOCKED: (key: string, variable: string) =>
    createDiagnostic(
      "CUTHOL-G624",
      "G1_SCHEMA",
      "ERROR",
      `Setting '${key}' is locked by environment variable ${variable}; unset it to change the stored value.`,
      `Unset ${variable} and re-run, or keep the environment value.`
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
      `'${file}' cannot be parsed; left unchanged.`,
      `Fix the file syntax and re-run 'cuthol setup --apply'.`
    ),
  SETUP_UNKNOWN_AGENT: (id: string) =>
    createDiagnostic(
      "CUTHOL-G631",
      "G1_SCHEMA",
      "ERROR",
      `Unknown agent id '${id}' for setup.`,
      `Use one of: claude-code, codex, cursor, gemini-cli.`
    ),
  SETUP_MANUAL_ONLY: (id: string, instruction: string) =>
    createDiagnostic(
      "CUTHOL-G632",
      "SYS",
      "INFO",
      `Agent tool '${id}' has no writable config; registration is manual: ${instruction}`,
      `Follow the tool's MCP docs to register the printed command.`
    ),
  SETUP_DIFFERENT_ENTRY: (where: string) =>
    createDiagnostic(
      "CUTHOL-G633",
      "SYS",
      "WARN",
      `An existing cuthol entry in '${where}' runs a different command; not replaced without --force.`,
      `Re-run with '--force' to replace it.`
    ),
  SETUP_WRITE_FAILED: (file: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G634",
      "SYS",
      "ERROR",
      `Could not write '${file}': ${reason}.`,
      `Check that the folder exists and is writable.`
    ),
  // [lane-mute G125–G126]
  LANE_MUTE_SPINE: () =>
    createDiagnostic(
      "CUTHOL-G125",
      "G1_SCHEMA",
      "ERROR",
      "The spine is not a lane: 'lane mute' cannot target 'spine'.",
      "Mute a spine clip with 'cuthol spine mute --clip <id>', or pass a lane id ('ln_*') to 'cuthol lane mute --lane <id>'.",
      "spine"
    ),
  // [edit-check G140–G149]       envelope parameter names, cue frame-grid alignment, monitor argument checks
  ENVELOPE_UNKNOWN_PARAMETER: (parameter: string, targetId: string, suggestion: string | null) =>
    createDiagnostic(
      "CUTHOL-G140",
      "G1_SCHEMA",
      "ERROR",
      `Unknown envelope parameter '${parameter}' on '${targetId}'; the render ignores it.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : ""),
      `Use one of 'placement.scale_x', 'placement.scale_y', 'placement.x_pct', 'placement.y_pct', 'placement.rotation_deg', 'placement.opacity', 'audio_chain.gain_db', 'treatments.color_grade.*', 'fx.<id>.<param>' or 'color.*'.`,
      targetId
    ),
  CUE_OFF_FRAME_GRID: (cueId: string, atMs: number, frameIdx: number, gridMs: number) =>
    createDiagnostic(
      "CUTHOL-G141",
      "G3_TIMING",
      "INFO",
      `Cue '${cueId}' starts at ${atMs}ms, which is not on the frame grid; it first appears on frame ${frameIdx} (${gridMs}ms).`,
      `Pass an on-grid start ('${gridMs}ms') when the boundary must be frame-exact; the stored value is kept as given.`,
      cueId
    ),
  UNITLESS_FRACTION_TIME: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G142",
      "G1_SCHEMA",
      "ERROR",
      `Unitless time '${raw}' is ambiguous ('${raw}' would read as milliseconds); add a unit.`,
      `Write '${raw}s' for seconds or '${raw}ms' for milliseconds (e.g. '21.1s' or '21100ms').`,
    ),
  SHEET_AT_WITH_WINDOW: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G143",
      "G1_SCHEMA",
      "ERROR",
      `Monitor sheet takes either explicit 'at' timestamps or a 'start'/'end' window, not both (${detail}).`,
      `Drop 'start'/'end' to sample the 'at' timestamps, or drop 'at' to sample the window.`,
    ),
  SHEET_AT_WITH_WINDOW_WARN: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G144",
      "G1_SCHEMA",
      "WARN",
      `Monitor sheet ignores 'start'/'end' when several 'at' timestamps are given (${detail}).`,
      `Drop 'start'/'end' to silence this, or drop 'at' to sample the window.`,
    ),
  // [boundary G520–G529]         composition boundary frames, boundary continuity (verify), render input hygiene
  BOUNDARY_CONTINUITY_MATCH: (laneId: string, atMs: number, diff: number) =>
    createDiagnostic(
      "CUTHOL-G520",
      "G5_SIGNAL",
      "INFO",
      `Boundary on '${laneId}' at ${atMs}ms is continuous (mean pixel difference ${diff} between the last frame of the outgoing composition and the first frame of the incoming one).`,
      `No action needed; the cut is seamless at this resolution.`,
    ),
  BOUNDARY_CONTINUITY_JUMP: (laneId: string, atMs: number, diff: number) =>
    createDiagnostic(
      "CUTHOL-G521",
      "G5_SIGNAL",
      "INFO",
      `Boundary on '${laneId}' at ${atMs}ms changes the picture (mean pixel difference ${diff} between the last frame of the outgoing composition and the first frame of the incoming one).`,
      `Check the two compositions around ${atMs}ms when the cut should be seamless.`,
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
  LIVE_PREVIEW_INCIDENT: (reason: string, cueId: string) =>
    createDiagnostic(
      "CUTHOL-G673",
      "SYS",
      "WARN",
      `The Live window detected a stuck preview (${reason}${cueId ? ` on '${cueId}'` : ""}) and reported it.`,
      `The window reloads its preview automatically; if the notice persists, reopen the window and report the incident from 'cuthol live status'.`,
      cueId
    ),
  LIVE_PREVIEW_RELOADED: (outcome: string) =>
    createDiagnostic(
      "CUTHOL-G674",
      "SYS",
      "WARN",
      `The Live window reloaded its preview (${outcome}).`,
      `If the preview keeps stalling, reopen the window and report the incident from 'cuthol live status'.`
    ),
  LIVE_PREVIEW_STILL_STUCK: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G675",
      "SYS",
      "ERROR",
      `The Live preview is still stuck${cueId ? ` on '${cueId}'` : ""} after an automatic reload.`,
      `Reload the Live window page, then report the incident from 'cuthol live status' with the console errors it captured.`,
      cueId
    ),
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
      `Live note measurement runs off the server loop: ${detail}.`,
      "Wait for the cached result (the window asks again) or send the note; names attach when ready."
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
      `Live window reported a preview incident: ${detail}.`,
      "See the newest file under '.cuthol/live/incidents/' ('cuthol live status' names it)."
    ),
  // [comp-runtime G450–G459]     sequence clock, shared project assets, runtime files, lint resolution
  SEQ_TIME_CLAMPED: (helper: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G450",
      "G3_TIMING",
      "WARN",
      `Composition time clamped in '${helper}': ${detail} lies outside the composition window.`,
      `Pass sequence times with the sequence clock ("clock: 'sequence'") or keep the time inside the composition window.`
    ),
  SHARED_ASSET_SYNCED: (compositionDir: string, files: string[]) =>
    createDiagnostic(
      "CUTHOL-G451",
      "G2_ASSETS",
      "INFO",
      `Project shared files synced into '${compositionDir}': ${files.join(", ") || "none"}.`,
      `Edit shared files in the project 'shared/' folder; compositions that use them re-render automatically.`
    ),
  LINT_FALSE_ALARM_RESOLVED: (code: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G452",
      "G1_SCHEMA",
      "INFO",
      `Lint finding '${code}' downgraded to info: ${reason}.`,
      `No action needed; the finding stays visible as info for inspection.`
    ),
  // [comp-contract G460–G469]    runtime contract probe, script check on add/verify, automatic adopt
  EXTERNAL_COMPOSITION_EDITS_AUTO_ADOPTED: (comps: string[]) =>
    createDiagnostic(
      "CUTHOL-G460",
      "G2_ASSETS",
      "INFO",
      `Adopted outside composition edits: ${comps.join(", ")}.`,
      `The hand edit is now a journaled revision; undo with 'cuthol workspace journal undo'. Edits to 'cuthol.sequence.json' still need an explicit 'cuthol workspace changes adopt'.`
    ),
  BACKDROP_GAPS_SUMMARY: (count: number, totalMs: number) =>
    createDiagnostic(
      "CUTHOL-G461",
      "G3_TIMING",
      "WARN",
      `${String(count)} empty ranges show only the stage backdrop (${String(totalMs)}ms in total).`,
      `Run 'cuthol verify' for the full per-range list, or cover the ranges with spine or lane cues.`
    ),
  // [local-speech G237–G239]
  // [script-ext G433, G438–G439]
  // [monitor-scaffold G214–G216]
  // [color-schema G130–G139]   colour stage / Look validation, cluster and scope checks (verify)
  COLOR_BLOCK_AMOUNT_RANGE: (subject: string, block: string, amount: unknown) =>
    createDiagnostic(
      "CUTHOL-G130",
      "G1_SCHEMA",
      "ERROR",
      `Colour block '${block}' on '${subject}' has amount '${String(amount)}'; amount must be a number in 0..1.`,
      `Set '${block}' amount between 0 and 1, e.g. 'cuthol color set --item ${subject} --amount ${block}=1' (omit amount for full strength).`,
      subject
    ),
  COLOR_LOOK_UNKNOWN: (subject: string, look: string) =>
    createDiagnostic(
      "CUTHOL-G131",
      "G1_SCHEMA",
      "ERROR",
      `Colour stage on '${subject}' binds unknown Look '${look}'.`,
      `Bind an existing Look ('cuthol color look list') or create it with 'cuthol color look create --name ${look}'.`,
      subject
    ),
  COLOR_LOOK_DUPLICATE: (look: string) =>
    createDiagnostic(
      "CUTHOL-G132",
      "G1_SCHEMA",
      "ERROR",
      `Duplicate colour Look id '${look}'.`,
      `Remove or rename the duplicate Look ('cuthol color look remove --look ${look}').`,
      look
    ),
  COLOR_LOOK_LUT_MISSING: (look: string, uri: string) =>
    createDiagnostic(
      "CUTHOL-G133",
      "G1_SCHEMA",
      "ERROR",
      `Look '${look}' points to LUT '${uri}', which is missing, outside the project or not a .cube/.3dl file.`,
      `Put the .cube inside the project and recreate the Look ('cuthol color look create --name <n> --lut <file.cube>'), or remove it ('cuthol color look remove --look ${look}').`,
      look
    ),
  COLOR_LOOKS_OVERLAP: (item: string, looks: string[]) =>
    createDiagnostic(
      "CUTHOL-G134",
      "G1_SCHEMA",
      "WARN",
      `${looks.length} Looks reach '${item}' through apply_to (${looks.join(", ")}); only '${looks[0]}' is used.`,
      `Bind the one you want ('cuthol color set --item ${item} --look <look_XX>') or narrow apply_to of the others.`,
      item
    ),
  COLOR_LOOK_ON_DESIGNED_SOURCE: (item: string, look: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G135",
      "G1_SCHEMA",
      "WARN",
      `Look '${look}' is bound to '${item}', a ${kind} source; designed colour (screen recordings, graphics) usually should not take a camera Look.`,
      `Unbind it ('cuthol color set --item ${item} --remove look') unless the user asked for it, or correct the kind ('cuthol color kind --handle <vid_XX> --set camera').`,
      item
    ),
  COLOR_HDR_WITHOUT_TRANSFORM: (handle: string, transfer: string) =>
    createDiagnostic(
      "CUTHOL-G136",
      "G1_SCHEMA",
      "WARN",
      `Source '${handle}' is HDR (transfer ${transfer}) but its input transform is 'none'; it will look washed out or clipped in an SDR edit.`,
      `Use 'cuthol color kind --handle ${handle} --input auto'.`,
      handle
    ),
  COLOR_SIBLING_UNGRADED: (item: string, asset: string, graded: string[]) =>
    createDiagnostic(
      "CUTHOL-G137",
      "G1_SCHEMA",
      "WARN",
      `'${item}' uses the same source '${asset}' as graded ${graded.join(", ")} but has no colour stage; the cut between them will jump.`,
      `Copy the grade ('cuthol color set --item ${item} --patch <stage of ${graded[0]}>' or 'cuthol color look create --from-item ${graded[0]}' then bind it), or say why it differs.`,
      item
    ),
  // [color-measure G240–G248]  frame sampling, map, solve, prediction inputs
  COLOR_FRAME_SAMPLE_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G240",
      "G2_ASSETS",
      "ERROR",
      `Colour frame sampling failed for item '${item}' (${detail}).`,
      `Check the item id and that its asset file exists, then re-run.`
    ),
  COLOR_MAP_EMPTY: (item: string) =>
    createDiagnostic(
      "CUTHOL-G241",
      "G2_ASSETS",
      "WARN",
      `Colour map of '${item}' has almost no measurable pixels.`,
      `Sample more frames or check the source file.`
    ),
  COLOR_SOLVE_NO_TARGET: (mode: string) =>
    createDiagnostic(
      "CUTHOL-G242",
      "G2_ASSETS",
      "ERROR",
      `Colour solve '${mode}' needs target frames.`,
      `Pass target frames or a reference file.`
    ),
  // [color-render G440–G449]   stage compile, LUT self-test, input transform, keyframed colour
  // [color-scan G510–G514]     post-render colour check against the prediction
  COLOR_RENDER_GRADE_OK: (summary: string) =>
    createDiagnostic(
      "CUTHOL-G510",
      "G5_SIGNAL",
      "INFO",
      `Post-render colour check matches the prediction: ${summary} (mean dE per item; 0.6-1.5 is normal).`,
      `No action needed; the grade rendered as predicted.`
    ),
  COLOR_RENDER_GRADE_MISMATCH: (item: string, atMs: number, meanDe: number) =>
    createDiagnostic(
      "CUTHOL-G512",
      "G5_SIGNAL",
      "WARN",
      `Rendered colour of '${item}' at ${atMs}ms differs from the render-free prediction (mean dE ${meanDe}; 0.6-1.5 is normal).`,
      `Re-measure with the colour map and check the stage LUT.`,
      item
    ),
  // [color-cli G640–G649]      `cuthol color` command errors
  COLOR_COMMAND_FAILED: (action: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G640",
      "SYS",
      "ERROR",
      `cuthol color ${action} failed: ${reason}`,
      `Re-run with valid arguments ('cuthol help' lists the 'cuthol color ...' commands).`
    ),
  COLOR_ITEM_MISSING: (item: string) =>
    createDiagnostic(
      "CUTHOL-G641",
      "G1_SCHEMA",
      "ERROR",
      `Colour item '${item}' does not exist (expected sp_XX or cue_XX).`,
      `Check the id with 'cuthol brief --lens flow' and retry.`,
      item
    ),
  // [color-live G650–G654]     Live colour endpoints and panel
  COLOR_LIVE_LUT_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G650",
      "G4_STAGE",
      "ERROR",
      `Colour LUT for '${item}' could not be compiled: ${detail}.`,
      `Check that the item exists and its colour stage validates, then retry.`
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
      `Colour map for '${item}' is unavailable: ${detail}.`,
      `The text map needs the measurement build (sampleItemFrames + colorMap); the graded preview still works.`
    ),
  // [output G515–G519, G660–G664] 4K/alpha presets, timeline export
  OUTPUT_ALPHA_CODEC_SELECTED: (codec: string, container: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G515",
      "G5_SIGNAL",
      "INFO",
      `Transparent master encodes with ${codec} in ${container} (${reason}).`,
      `Import the file directly in your editor; alpha is preserved end to end.`
    ),
  OUTPUT_PRESET_DIMENSIONS: (preset: string, width: number, height: number) =>
    createDiagnostic(
      "CUTHOL-G516",
      "G5_SIGNAL",
      "INFO",
      `Render preset '${preset}' targets ${width}x${height}.`,
      `Overlays render at the preset size; a following master reuses the cache.`
    ),
  OUTPUT_EXPORT_WRITTEN: (format: string, outPath: string, clips: number) =>
    createDiagnostic(
      "CUTHOL-G517",
      "G5_SIGNAL",
      "INFO",
      `Timeline exported as ${format} to '${outPath}' (${clips} spine clip(s)).`,
      `Import the file in your editor; check the 'not exported' lines for elements that need manual work.`
    ),
  OUTPUT_EXPORT_SKIPPED_KIND: (kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G518",
      "G5_SIGNAL",
      "WARN",
      `Timeline export skipped ${kind}: ${detail}.`,
      `Recreate these elements by hand in the target editor, or render them from Cuthol as overlay files.`
    ),
  OUTPUT_ALPHA_SCAN_SKIPPED: (scan: string) =>
    createDiagnostic(
      "CUTHOL-G519",
      "G5_SIGNAL",
      "INFO",
      `Post-render scan '${scan}' does not run on transparent masters (empty areas are transparent by design).`,
      `Inspect the alpha file over a contrasting background instead.`
    ),
  EXPORT_UNKNOWN_FORMAT: (got: string, want: string) =>
    createDiagnostic(
      "CUTHOL-G660",
      "G1_SCHEMA",
      "ERROR",
      `Unknown timeline export format '${got}' (expected one of: ${want}).`,
      `Run 'cuthol export timeline [fcpxml|xmeml|edl|otio] [--as <format>] --out <file>'.`
    ),
  EXPORT_NO_SPINE: () =>
    createDiagnostic(
      "CUTHOL-G661",
      "G1_SCHEMA",
      "ERROR",
      `Timeline export needs at least one spine clip; the sequence spine is empty.`,
      `Cut spine clips first, or export a graphics-only timeline as markers via the overlay references.`
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
      `Duration '${raw}' was read as ${raw} milliseconds; did you mean seconds? (e.g. ${raw}s)`,
      `Add a unit to the duration (e.g. '${raw}s' or '${Number(raw) * 1000}ms'). Bare numbers stay milliseconds.`
    ),

  // --- Environment: CUTHOL-G212 ---
  FFMPEG_VERSION_BELOW_SUPPORTED: (tool: string, found: string) =>
    createDiagnostic(
      "CUTHOL-G212",
      "G2_ASSETS",
      "WARN",
      `${tool} ${found} found; Cuthol is tested with ffmpeg/ffprobe 8.x (tempo, loudness and scene analysis may differ).`,
      `Install ffmpeg and ffprobe 8.x on PATH and re-run.`
    ),

  // --- Keyless local speech: CUTHOL-G237–G239 ---
  LOCAL_SPEECH_NOT_INSTALLED: (reason: string) =>
    createDiagnostic(
      "CUTHOL-G237",
      "SYS",
      "ERROR",
      `Keyless local speech is not installed (${reason}).`,
      `Run 'cuthol setup --local-speech --apply' to install it, or wire 'CUTHOL_LOCAL_ASR_CMD' / 'CUTHOL_LOCAL_TTS_CMD' instead.`
    ),
  LOCAL_SPEECH_SETUP_FAILED: (step: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G238",
      "SYS",
      "ERROR",
      `Local speech setup failed at '${step}': ${detail}`,
      `Fix the underlying problem and re-run 'cuthol setup --local-speech --apply'.`
    ),
  LOCAL_SPEECH_BRIDGE_FAILED: (op: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G239",
      "SYS",
      "ERROR",
      `Local speech ${op} failed: ${detail}`,
      `Re-run 'cuthol setup --local-speech --apply' to repair the installation, then retry.`
    ),

  // --- Speech language: CUTHOL-G213 ---
  ASR_LANGUAGE_REQUIRED: (provider: string) =>
    createDiagnostic(
      "CUTHOL-G213",
      "SYS",
      "ERROR",
      `ASR provider '${provider}' cannot detect the speech language automatically, and no language was given.`,
      `Re-run with an explicit language, e.g. 'cuthol speech transcribe --handle <id> --lang en --provider ${provider}'.`
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
      `Handle '${handle}' not found in the active sequence.`,
      `List the available media, clip and lane handles with 'cuthol brief --lens overview'.`,
      handle
    ),

  DUPLICATE_HANDLE: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G102",
      "G1_SCHEMA",
      "ERROR",
      `Handle '${handle}' is defined on more than one item in the sequence.`,
      `Every media item ('vid_*', 'aud_*'), spine clip ('sp_*') and lane cue ('cue_*') must have a unique handle.`,
      handle
    ),

  DANGLING_ASSET_REF: (ownerId: string, assetHandle: string) =>
    createDiagnostic(
      "CUTHOL-G103",
      "G1_SCHEMA",
      "ERROR",
      `Item '${ownerId}' refers to source '${assetHandle}', which is not in the library.`,
      `Add the media first with 'cuthol library ingest', or use a valid library handle.`,
      ownerId
    ),

  DANGLING_ANCHOR_REF: (cueId: string, anchorRef: string) =>
    createDiagnostic(
      "CUTHOL-G104",
      "G1_SCHEMA",
      "ERROR",
      `Lane cue '${cueId}' is anchored to spine clip '${anchorRef}', which does not exist.`,
      `Point the anchor at an existing 'sp_*' clip, or convert it to an absolute 'at_ms' time.`,
      cueId
    ),

  INVALID_COMPOSITION_CONTRACT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G105",
      "G1_SCHEMA",
      "ERROR",
      `HyperFrames composition '${cueId}' failed the contract check: ${detail}`,
      `Fix 'data-composition-id', 'window.__timelines' and the determinism rules in the composition HTML file.`,
      cueId
    ),

  // --- Gate 2: Physical Asset & Boundary Integrity (G2_ASSETS) ---
  MISSING_FILE_ON_DISK: (handle: string, uri: string) =>
    createDiagnostic(
      "CUTHOL-G201",
      "G2_ASSETS",
      "ERROR",
      `File '${uri}' for source '${handle}' not found on disk.`,
      `Fix the file path, or re-ingest the file with 'cuthol library ingest'.`,
      handle
    ),

  SOURCE_RANGE_EXCEEDED: (clipId: string, outMs: number, assetDurationMs: number) =>
    createDiagnostic(
      "CUTHOL-G202",
      "G2_ASSETS",
      "ERROR",
      `Clip '${clipId}' source out-point (${outMs}ms) exceeds the media's physical duration (${assetDurationMs}ms).`,
      `Bring 'source_out_ms' down to ${assetDurationMs}ms or less.`,
      clipId
    ),

  NO_AUDIO_STREAM: (handle: string) =>
    createDiagnostic(
      "CUTHOL-G203",
      "G2_ASSETS",
      "ERROR",
      `Source '${handle}' has no audio stream.`,
      `Run audio analysis or audio separation only on sources with 'has_audio: true'.`,
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
      `Source '${handle}' is variable frame rate (VFR${rateDetail}); during compilation Cuthol converts video to the stage frame rate (${stageFps} fps CFR, 'settb=AVTB,fps=${stageFps}:eof_action=pass') and audio with 'aresample=async=1:first_pts=0'. If the source has sudden frame-rate drops, expect frame duplication/drops there and ±${frameStepMs}ms (1 frame) rounding at cut boundaries.`,
      `Constant-frame-rate conversion is applied automatically; check critical cuts or screen-recording transitions with 'cuthol monitor frame'.`,
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
      `Source '${handle}' is tagged BT.2020 (color_space=${colorSpace}${trcDetail}${primDetail}); Cuthol uses the 'in_color_matrix=bt2020:out_color_matrix=bt709' matrix for the YCbCr->BT.709 conversion, but applies no HDR gamma/primaries tone mapping.`,
      `For SDR BT.2020 sources the matrix conversion is enough; for HDR (PQ/HLG) sources apply external SDR tone mapping if needed, or check colors with 'cuthol monitor frame'.`,
      handle
    );
  },

  AV_STREAM_DURATION_MISMATCH: (videoMs: number, audioMs: number, frameMs: number, handle?: string) =>
    createDiagnostic(
      "CUTHOL-G209",
      "G2_ASSETS",
      "WARN",
      `In the processor output the video stream is ${Math.round(videoMs)} ms and audio is ${Math.round(audioMs)} ms; the gap is larger than one frame (${Math.max(1, Math.round(frameMs))} ms).`,
      `Add "audio": "drop" to the processor to drop audio on a duration-changing video filter, or write an audio_filter that equalizes the durations.`,
      handle
    ),

  // --- Gate 3: Temporal Continuity & Frame Budget (G3_TIMING) ---
  SUB_FRAME_DURATION: (itemId: string, durationMs: number, minMs: number) =>
    createDiagnostic(
      "CUTHOL-G301",
      "G3_TIMING",
      "ERROR",
      `Item '${itemId}' duration (${durationMs}ms) is below the 2-frame minimum (${minMs}ms) at the stage frame rate.`,
      `Delete the item or extend its duration to at least ${minMs}ms.`,
      itemId
    ),

  SPINE_DISCONTINUITY: (clipId: string, expectedStartMs: number, actualStartMs: number) =>
    createDiagnostic(
      "CUTHOL-G302",
      "G3_TIMING",
      "ERROR",
      `Clip '${clipId}' on the magnetic spine starts at ${actualStartMs}ms instead of ${expectedStartMs}ms (gap or overlap).`,
      `Use the 'cuthol spine' commands to repair spine continuity.`,
      clipId
    ),

  TRANSITION_TOO_LONG: (clipId: string, transMs: number, maxAllowedMs: number) =>
    createDiagnostic(
      "CUTHOL-G303",
      "G3_TIMING",
      "ERROR",
      `Out-transition of '${clipId}' (${transMs}ms) exceeds the maximum allowed by the neighboring clips (${maxAllowedMs}ms).`,
      `Lower the transition duration to ${maxAllowedMs}ms or less.`,
      clipId
    ),

  INVALID_PLAYBACK_RATE: (clipId: string, rate: number) =>
    createDiagnostic(
      "CUTHOL-G304",
      "G3_TIMING",
      "ERROR",
      `Playback rate (${rate}x) for clip '${clipId}' is outside the valid range (0.1x .. 16.0x).`,
      `Set '--rate' between 0.1 and 16.0.`,
      clipId
    ),

  ENVELOPE_OUT_OF_RANGE: (ownerId: string, param: string, offsetMs: number, durationMs: number) =>
    createDiagnostic(
      "CUTHOL-G305",
      "G3_TIMING",
      "ERROR",
      `Keyframe of '${param}' on '${ownerId}' (${offsetMs}ms) is outside the item duration (0..${durationMs}ms).`,
      `Define keyframe times within 0ms..${durationMs}ms.`,
      ownerId
    ),

  LANE_EXTENDS_PAST_SPINE: (cueId: string, cueEndMs: number, spineEndMs: number) =>
    createDiagnostic(
      "CUTHOL-G306",
      "G3_TIMING",
      "WARN",
      `Lane cue '${cueId}' ends at ${cueEndMs}ms, ${cueEndMs - spineEndMs}ms past the spine duration (${spineEndMs}ms) (no spine picture in ${spineEndMs}..${cueEndMs}ms).`,
      `Append/extend spine clips, or trim '${cueId}' to the ${spineEndMs}ms boundary.`,
      cueId
    ),

  EMPTY_SEQUENCE: (severity: DiagnosticSeverity) =>
    createDiagnostic(
      "CUTHOL-G307",
      "G3_TIMING",
      severity,
      `Empty edit: no clips on the spine and no cues on any unmuted lane (duration 0ms).`,
      `For a footage edit add clips with 'spine append'; for a graphics-only video add a composition with 'lane add-composition' (and audio with 'lane add-cue'). With an empty spine the duration comes from the latest-ending cue.`
    ),

  BACKDROP_ONLY_SPAN: (startMs: number, endMs: number) =>
    createDiagnostic(
      "CUTHOL-G308",
      "G3_TIMING",
      "WARN",
      `Spine is empty and no visual cue is on screen in ${startMs}..${endMs}ms (${endMs - startMs}ms); only the stage backdrop shows during this span.`,
      `Fill the span with a composition/title/visual cue, or extend the adjacent cue; if the empty backdrop is intentional, this warning is informational.`
    ),

  BARE_BACKDROP_UNDER_TRANSPARENT_COMPOSITION: (
    spans: Array<{ start_ms: number; end_ms: number }>,
    backdropColor: string,
    cueIds: string[]
  ) =>
    createDiagnostic(
      "CUTHOL-G316",
      "G3_TIMING",
      "INFO",
      `Spine is empty and in ${spans.map((s) => `${s.start_ms}..${s.end_ms}ms`).join(", ")} the only picture comes from transparent composition cue(s) ${cueIds.map((id) => `'${id}'`).join(", ")} with mostly-empty alpha; bare stage backdrop (${backdropColor}) shows through.`,
      `Set a base color with 'cuthol workspace backdrop --color #RRGGBB', or add an opaque background layer under the composition.`
    ),

  SHORT_SPINE_CLIP: (clipId: string, durationMs: number, recommendedMinMs: number) =>
    createDiagnostic(
      "CUTHOL-G309",
      "G3_TIMING",
      "WARN",
      `Spine clip '${clipId}' is ${durationMs}ms, at most ${recommendedMinMs}ms; a leftover sliver may remain between cuts.`,
      `If it is a leftover, delete it with 'cuthol spine remove --clips ${clipId}' or merge it with the neighboring cut.`,
      clipId
    ),

  SHORT_SPEECH_FRAGMENT: (clipId: string, durationMs: number, maxMs: number) =>
    createDiagnostic(
      "CUTHOL-G312",
      "G3_TIMING",
      "INFO",
      `Spine clip '${clipId}' (${durationMs}ms) is a short speech fragment, possibly a restart leftover.`,
      `Duration is between 150 ms and ${maxMs} ms with audio above the silence floor. If it is a restart leftover, delete it with 'cuthol spine remove --clips ${clipId}'; if intentional, ignore this note.`,
      clipId
    ),

  // --- Gate 4: Stage Geometry, Safe Zones & Legibility (G4_STAGE) ---
  SAFE_ZONE_VIOLATION: (cueId: string, edge: string, overflowPx: number) =>
    createDiagnostic(
      "CUTHOL-G401",
      "G4_STAGE",
      "WARN",
      `Item '${cueId}' crosses the '${edge}' safe-area boundary by ${Math.round(overflowPx)}px (EBU R95 / 9:16 UI margin).`,
      `Move the item closer to the center, or reduce its width/font size.`,
      cueId
    ),

  CAPTION_READING_SPEED_HIGH: (cueId: string, cps: number, maxCps: number) =>
    createDiagnostic(
      "CUTHOL-G402",
      "G4_STAGE",
      "WARN",
      `Caption '${cueId}' reading speed (${cps.toFixed(1)} cps) exceeds the recommended ceiling (${maxCps} cps — Netflix Timed Text / TR adaptation).`,
      `Split the caption text in two, or extend its on-screen duration.`,
      cueId
    ),

  TEXT_OCCLUDED_BY_LAYER: (textCueId: string, occluderCueId: string) =>
    createDiagnostic(
      "CUTHOL-G403",
      "G4_STAGE",
      "WARN",
      `Text item '${textCueId}' is covered by layer '${occluderCueId}' with a higher z_index.`,
      `Raise the text lane's 'z_index', or shift the position of the covering layer.`,
      textCueId
    ),

  SCENE_HOST_RECOMMENDED: (cueId: string, detectedFeatures: string[]) =>
    createDiagnostic(
      "CUTHOL-G406",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' contains '${detectedFeatures.join(", ")}' but runs in 'overlay_alpha' (Mode A); these effects cannot see the video pixels underneath.`,
      `Pass '--mode scene_host' explicitly so the effect processes the video pixels underneath.`,
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
      `HyperFrames lint finding in composition '${cueId}' (${ruleCode}): ${message}`,
      fixHint && fixHint.trim()
        ? fixHint.trim()
        : `Fix the composition HTML/GSAP code per rule '${ruleCode}'.`,
      cueId
    ),

  RENDER_FIELD_NOT_APPLIED: (itemId: string, field: string) =>
    createDiagnostic(
      "CUTHOL-G409",
      "G4_STAGE",
      "WARN",
      `'${field}' on '${itemId}' is not applied to the render in this version.`,
      `Leave this field at its default. On spine clips, masks, motion blur, static and enveloped brightness/contrast/saturation, color temperature and LUT reach the render, as do block-based 'color.*' envelopes.`,
      itemId
    ),

  // --- Gate 5: Audio Signal & Render Frame Sanity (G5_SIGNAL) ---
  TRUE_PEAK_CEILING_EXCEEDED: (itemId: string, peakDbtp: number, ceilingDbtp: number) =>
    createDiagnostic(
      "CUTHOL-G501",
      "G5_SIGNAL",
      "WARN",
      `True peak of audio signal '${itemId}' (${peakDbtp.toFixed(1)} dBTP) exceeds the ITU-R BS.1770-4 ceiling (${ceilingDbtp.toFixed(1)} dBTP).`,
      `Run 'cuthol mix normalize --target-lufs -14', or lower the clip gain ('gain_db').`,
      itemId
    ),

  BLANK_FRAME_DETECTED: (timestampMs: number, lumaMean: number, lumaStd: number) =>
    createDiagnostic(
      "CUTHOL-G502",
      "G5_SIGNAL",
      "WARN",
      `Sampled frame at ${timestampMs}ms is almost fully dark/blank or flat backdrop color (luma mean=${lumaMean.toFixed(1)}, std=${lumaStd.toFixed(2)}).`,
      `Check the frame with 'cuthol monitor frame --at ${timestampMs}ms'; if it is not an intentional fade, fix the source range.`
    ),

  RENDER_EDGE_STRIP: (edges: string[], width: number, height: number) =>
    createDiagnostic(
      "CUTHOL-G506",
      "G5_SIGNAL",
      "WARN",
      `There is an 8px black strip on the ${edges.join(" and ")} edge of the render output (${width}x${height}); the content does not reach the edge.`,
      `This is usually caused by an ffmpeg build zeroing the last columns when converting planar RGB to yuv420p at widths that are not multiples of 16 (e.g. 1080). Check the ffmpeg/HyperFrames version and re-render; if the problem persists, set the stage width to a multiple of 16.`
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
      `HyperFrames composition '${compositionDir}' failed to render; the render was stopped (no fallback image is substituted): ${reason}`,
      `Open the composition with 'composition preview' to see the error, check the HTML/GSAP code with 'npx hyperframes check'; verify browser (Chrome/Edge) access with 'npx hyperframes doctor'.`,
      compositionDir
    ),

  // --- Unprobed compositions: CUTHOL-G509 ---
  COMPOSITIONS_NEVER_PROBED_IN_BROWSER: (count: number) =>
    createDiagnostic(
      "CUTHOL-G509",
      "G4_STAGE",
      "INFO",
      count === 1
        ? `1 composition was never opened in a browser, so its script is unchecked (no record).`
        : `${count} compositions were never opened in a browser, so their scripts are unchecked (no record).`,
      `Run 'cuthol verify' (it checks every unchecked composition in one browser run). If verify itself reports this, its browser check could not run: run 'cuthol composition preview --cue <cue_XX>' to see why.`
    ),

  DUCKING_WITHOUT_TRANSCRIPT: (clipIds: string[], mode: "skipped" | "acoustic_vad") =>
    createDiagnostic(
      "CUTHOL-G504",
      "G5_SIGNAL",
      "WARN",
      mode === "skipped"
        ? `Spine clips '${clipIds.join(", ")}' have no transcript, so ducking was applied from transcribed clips and 'ln_vo' voiceovers only.`
        : `Spine clips '${clipIds.join(", ")}' have no transcript, so ducking was computed from signal-based acoustic energy (VAD).`,
      `For word-accurate ducking, run 'cuthol speech transcribe --handle <vid_XX>' first on clips containing speech.`
    ),

  OPAQUE_OVERLAY_LEAK: (cueId: string, opaqueRatio: number, cornerAlphaMax: number) =>
    createDiagnostic(
      "CUTHOL-G505",
      "G5_SIGNAL",
      "WARN",
      `Background leak detected in transparent overlay composition '${cueId}' (fully-opaque ratio=${(opaqueRatio * 100).toFixed(1)}%, corner alpha=${cornerAlphaMax}/255).`,
      `Make sure the composition HTML/CSS has 'body, #root { background: transparent; }' and no '[data-cuthol-preview]' element remains.`,
      cueId
    ),

  COMPOSITION_AUDIO_UNAVAILABLE: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G507",
      "G5_SIGNAL",
      "WARN",
      `Composition '${cueId}' uses 'C.audio' but no audio-energy envelope could be produced in its window (${detail}); 'C.audio' returns 0 every frame.`,
      `Make sure an active audio source (spine, voiceover, effect or music) is in the composition window and the media file is readable ('cuthol library waveform --handle <aud_XX|vid_XX>').`,
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
      `Post-render audio health check found audio drift or signal loss at ${issues.length} point(s): ${summary}.`,
      `Check the segment-boundary transition, start time and audio chain of the affected audio item ('${firstId ?? "cue/clip"}') and re-render.`,
      firstId
    );
  },

  REVISION_MISMATCH: (expectedRev: number, actualRev: number) =>
    createDiagnostic(
      "CUTHOL-G109",
      "G1_SCHEMA",
      "ERROR",
      `Expected revision (r${expectedRev}) does not match the active sequence revision (r${actualRev}).`,
      `Check the current revision with 'cuthol brief --lens overview' or 'cuthol workspace journal list' and use '--expect-rev ${actualRev}'.`
    ),

  // [fxcheck:A G320–G329] fx instance check (card run + sentinel) and frozen-param check
  FX_CHECK_SKIPPED_NO_FFMPEG: () =>
    createDiagnostic(
      "CUTHOL-G320",
      "G4_STAGE",
      "WARN",
      "ffmpeg is not on PATH; the fx instance check was skipped.",
      "Install ffmpeg 8.x (ffmpeg and ffprobe) and put it on PATH, then retry."
    ),
  FX_CHECK_TIMEOUT: (itemId: string, fxId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G321",
      "G4_STAGE",
      "WARN",
      `fx instance check timed out for '${itemId}' fx '${fxId}' (${kind}); skipped, never blocking.`,
      "Retry the check with 'cuthol spine fx check --kind <kind>'; a persistent timeout means the filter hangs on real frames too.",
      itemId
    ),
  FX_CHECK_FAILED: (itemId: string, fxId: string, kind: string, filter: string | undefined, detail: string, template?: string) =>
    createDiagnostic(
      "CUTHOL-G322",
      "G4_STAGE",
      "ERROR",
      `fx instance check failed on '${itemId}' fx '${fxId}' (${kind})${filter ? ` in filter '${filter}'` : ""}: ${detail}${template ? ` [template: ${template}]` : ""}`,
      "Fix the effect template or parameters (unknown option, bad expression syntax) and retry; run 'cuthol spine fx check --kind <kind>' for an isolated probe. Options of one filter are separated by ':' (',' starts a new filter); an envelope placeholder inside single quotes needs no extra quotes of its own.",
      itemId
    ),
  FX_CHECK_PROBE_FAILED: (filterName: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G323",
      "G4_STAGE",
      "WARN",
      `frozen-param probe for filter '${filterName}' could not render (${detail}); skipped.`,
      "Check that ffmpeg runs ('ffmpeg -version') and retry 'cuthol spine fx check --kind <kind>'."
    ),
  FX_PARAM_FROZEN: (filterName: string) =>
    createDiagnostic(
      "CUTHOL-G324",
      "G4_STAGE",
      "ERROR",
      `parameter does not change per frame in filter '${filterName}' (evaluated once); check whether its options accept per-frame expressions (for 'eq' add 'eval=frame').`,
      "Add the filter's per-frame evaluation flag to the template (e.g. ':eval=frame' for 'eq') or remove the envelope from the non-animatable option."
    ),
  FX_CHECK_NATIVE_BACKEND: (kind: string, via: string) =>
    createDiagnostic(
      "CUTHOL-G325",
      "G4_STAGE",
      "INFO",
      `kind '${kind}' uses the native backend: validated by ${via}.`,
      "No card probe is needed for this kind."
    ),
  FX_CHECK_UNKNOWN_KIND: (kind: string, detail: string, suggestion?: string) =>
    createDiagnostic(
      "CUTHOL-G326",
      "G4_STAGE",
      "ERROR",
      `fx check for kind '${kind}' failed: ${detail}`,
      suggestion ??
        "List checkable kinds with 'cuthol spine fx catalog' (clip kinds are 'ffmpeg', 'motion' or 'ext:<extension>/<name>')."
    ),
  // [fxtry:D G345–G359] fx sandbox, `spine fx try` grid and `spine fx check --full`
  FX_TRY_FAILED: (kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G345",
      "G4_STAGE",
      "ERROR",
      `fx try for kind '${kind}' failed: ${detail}`,
      "Check the kind with 'cuthol spine fx check --kind <kind>'; list kinds with 'cuthol spine fx catalog'."
    ),
  FX_TRY_UNKNOWN_ITEM: (item: string) =>
    createDiagnostic(
      "CUTHOL-G346",
      "G4_STAGE",
      "ERROR",
      `fx try --on '${item}' matches no spine clip in this project.`,
      "Pass a spine clip id (sp_XX) from this project, or drop '--on' to use the generated card."
    ),
  FX_FULL_NEUTRAL_FAIL: (kind: string, param: string, psnr: number) =>
    createDiagnostic(
      "CUTHOL-G347",
      "G4_STAGE",
      "ERROR",
      `fx full check for kind '${kind}': neutral value of '${param}' is not neutral (Y PSNR ${psnr.toFixed(1)} dB < 60 dB against no fx).`,
      "Fix the manifest 'neutral' value for the parameter so it renders (near-)identically to no fx, or remove it."
    ),
  FX_FULL_TEMPORAL_CHANGE: (kind: string, what: string) =>
    createDiagnostic(
      "CUTHOL-G348",
      "G4_STAGE",
      "WARN",
      `fx full check for kind '${kind}': ${what}.`,
      "Declare 'temporal: true' in the manifest fx entry when the effect changes duration or frame count on purpose."
    ),
  FX_FULL_COST_MISMATCH: (kind: string, declared: string, measured: string) =>
    createDiagnostic(
      "CUTHOL-G349",
      "G4_STAGE",
      "WARN",
      `fx full check for kind '${kind}': manifest cost_class '${declared}' contradicts the measured '${measured}'.`,
      "Update the manifest 'cost_class' to the measured value."
    ),
  // [preset:P G360–G374] motion presets anchored to the clip and extension fx-new
  PRESET_UNKNOWN: (preset: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G360",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' cannot be applied: ${detail}`,
      "List available presets with 'cuthol spine fx catalog'."
    ),
  PRESET_BAD_PARAM: (preset: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G361",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' got a bad parameter: ${detail}`,
      "Pass the preset parameters as '--param name=value' within the declared min/max range."
    ),
  PRESET_BAD_CHANNEL: (preset: string, channel: string) =>
    createDiagnostic(
      "CUTHOL-G362",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' targets unknown channel '${channel}'.`,
      "Use one of the target kind's channels (x_pct, y_pct, rotation_deg, scale_x, scale_y, opacity for 'motion')."
    ),
  PRESET_VALUE_OUT_OF_RANGE: (preset: string, channel: string, value: number) =>
    createDiagnostic(
      "CUTHOL-G363",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' computes value ${value} on channel '${channel}', outside the parameter range.`,
      "Adjust the '--param' values so every generated point stays within the parameter's min/max range."
    ),
  PRESET_ANCHORS_CROSS: (preset: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G364",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' anchors cross on this clip: ${detail}`,
      "Use a longer clip or smaller offsets so start-anchored points stay before end-anchored points."
    ),
  PRESET_LANE_CUE: (item: string) =>
    createDiagnostic(
      "CUTHOL-G365",
      "G4_STAGE",
      "ERROR",
      `presets apply to spine clips in this version, not to '${item}'.`,
      "Pass a spine clip id (sp_XX) from this project."
    ),
  PRESET_BEATS_MISSING: (preset: string) =>
    createDiagnostic(
      "CUTHOL-G366",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' repeats on every beat but no beat grid was given.`,
      "Pass '--beats <aud_XX>' with a music asset that has a beat grid (run 'library beats' first)."
    ),
  PRESET_BAD_EXPRESSION: (preset: string, expr: string) =>
    createDiagnostic(
      "CUTHOL-G367",
      "G4_STAGE",
      "ERROR",
      `preset '${preset}' has a bad value expression '${expr}'.`,
      "Use only numbers, declared param names, 'rand(i)', parentheses and + - * /."
    ),
  PRESET_TOO_MANY_POINTS: (preset: string, count: number, extraSec: string) =>
    createDiagnostic(
      "CUTHOL-G368",
      "G4_STAGE",
      "WARN",
      `preset '${preset}' writes ${count} points on one channel (estimated extra render time ${extraSec} at draft_480p; higher presets cost more).`,
      "Reduce the repetition count or pattern length if the render gets too slow."
    ),
  PRESET_DRIFTED: (fxId: string, what: string, item: string) =>
    createDiagnostic(
      "CUTHOL-G369",
      "G4_STAGE",
      "WARN",
      `preset points of '${fxId}' no longer match their anchors: ${what} (reapply overwrites hand edits).`,
      `Regenerate with 'cuthol spine fx preset --item ${item} --fx ${fxId} --reapply'.`
    ),
  FX_NEW_EXISTS: (extName: string, fxName: string) =>
    createDiagnostic(
      "CUTHOL-G370",
      "G4_STAGE",
      "ERROR",
      `extension '${extName}' already has an fx entry '${fxName}'.`,
      "Pick a different name or edit the existing entry."
    ),
  FX_NEW_UNKNOWN_ROLE: (role: string) =>
    createDiagnostic(
      "CUTHOL-G371",
      "G4_STAGE",
      "ERROR",
      `unknown fx role '${role}'.`,
      "Use one of: clip, transition, motion."
    ),
  FX_NEW_WROTE_SKELETON: (extName: string, fxName: string) =>
    createDiagnostic(
      "CUTHOL-G372",
      "G4_STAGE",
      "INFO",
      `fx skeleton '${fxName}' added to extension '${extName}'.`,
      "Try it with 'cuthol spine fx try' and check it with 'cuthol spine fx check --kind'."
    ),
  // [fxtpl:C G340–G344] fx template placeholder and quoting rules (one rule per template)
  FX_TEMPLATE_UNTERMINATED_QUOTE: (extName: string, fxName: string) =>
    createDiagnostic(
      "CUTHOL-G340",
      "G4_STAGE",
      "ERROR",
      `extension '${extName}' fx '${fxName}': 'fx.${fxName}.video_filter' has an unterminated single-quoted region (a ' without its closing ').`,
      `Close the quoted region in 'fx.${fxName}.video_filter' or remove the stray quote.`
    ),
  FX_TEMPLATE_QUOTED_STATIC_QUOTE: (extName: string, fxName: string, param: string) =>
    createDiagnostic(
      "CUTHOL-G341",
      "G4_STAGE",
      "ERROR",
      `extension '${extName}' fx '${fxName}': '${param}' parameter value contains a single quote (') and cannot go inside a quoted template region.`,
      `Remove the quote from the '${param}' value or move the placeholder outside the quoted region.`
    ),
  // [fxfix:F G375–G379] effect-authoring fixes (delivery verdict, console window, guide CLI)
  GUIDE_TOPIC_UNKNOWN: (topic: string) =>
    createDiagnostic(
      "CUTHOL-G375",
      "G1_SCHEMA",
      "ERROR",
      `guide topic '${topic}' is not available.`,
      "Run 'cuthol guide' for the catalog of topics, or pass a skill name, '<skill>/<reference>' or 'ext:<name>'."
    ),
  UNKNOWN_FLAG: (flag: string, command: string, suggestionFix: string) =>
    createDiagnostic(
      "CUTHOL-G110",
      "G1_SCHEMA",
      "ERROR",
      `Unknown or conflicting flag '${flag}' in command '${command}'.`,
      `Use this command: ${suggestionFix}`
    ),

  PROTECTED_TARGET: (targetIds: string[], operation: string) =>
    createDiagnostic(
      "CUTHOL-G111",
      "G1_SCHEMA",
      "ERROR",
      `Operation '${operation}' would delete or modify locked/protected items ('${targetIds.join(", ")}').`,
      `Inspect the plan first with '--dry-run'; if you really want to delete/modify them, add '--allow-protected ${targetIds.join(",")}'.`
    ),

  INVALID_EXTENSION_MANIFEST: (extNameOrPath: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G112",
      "G1_SCHEMA",
      "ERROR",
      `Manifest file ('cuthol-extension.json') of extension '${extNameOrPath}' is invalid: ${detail}`,
      `Check the manifest schema ('name', 'version', 'description' and optional 'network', 'helper', 'assets', 'processors', 'recipes', 'guide'); run 'cuthol guide --topic extensions' for the guide.`,
      extNameOrPath
    ),

  EXTENSION_ALREADY_EXISTS: (name: string, dirPath: string) =>
    createDiagnostic(
      "CUTHOL-G113",
      "G1_SCHEMA",
      "ERROR",
      `Extension '${name}' already exists at '${dirPath}'.`,
      `Pick a different name, edit the existing extension, or delete it first with 'cuthol extension remove --name ${name}'.`,
      name
    ),

  EXTENSION_NOT_FOUND: (name: string, searchedPaths: string[]) =>
    createDiagnostic(
      "CUTHOL-G204",
      "G2_ASSETS",
      "ERROR",
      `Extension '${name}' found in neither the project extensions folder nor the persistent extensions folder (searched: ${searchedPaths.join(", ") || "none"}).`,
      `List existing extensions with 'cuthol extension list', or create it with 'cuthol extension create --name ${name}'.`,
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
        ? `Extension '${name}' enabled in the project, or its copy in the composition, differs from its source (${detail}; pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}); the render is stopped so it does not go out with the stale copy.`
        : `Extension '${name}' enabled in the project changed on disk (pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}); the render is stopped so it does not go out with the stale copy.`,
      `Refresh with 'cuthol extension enable --name ${name}' to accept the change and move to the new content hash; if you delete your edited copy inside the composition, Cuthol writes it again.`,
      name
    ),

  EXTENSION_SECURITY_VIOLATION: (name: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G206",
      "G2_ASSETS",
      "ERROR",
      `Extension '${name}' violated the security boundary: ${detail}`,
      `An extension may only read files inside its own folder, and only write to the output path given by Cuthol or to CUTHOL_EXT_TMP.`,
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
      `'${piece}' is not a cut range; every piece must be in 'start..end' form.`,
      `Write the broken piece as '2s..3s'. Separate multiple ranges with commas: '--ranges 2s..3s,6s..7s'.`
    ),

  UNITLESS_TIME_AS_MS: () =>
    createDiagnostic(
      "CUTHOL-G114",
      "G1_SCHEMA",
      "WARN",
      "Unitless values were read as milliseconds; did you mean seconds? (e.g. 21.1s)",
      "Add units to time values (e.g. '21.1s' or '00:21.1'). Unitless numbers stay milliseconds."
    ),

  QUERY_PAGE_TOKEN_TRUNCATED: (returned: number, nextCursor: string) =>
    createDiagnostic(
      "CUTHOL-G115",
      "G1_SCHEMA",
      "WARN",
      `Page cut at the token budget, returned ${returned} items; use next_cursor=${nextCursor} to continue`,
      `Use '--cursor ${nextCursor}' to continue where you left off, or raise the '--max-tokens' budget.`
    ),

  INVALID_CUE_EXCISE_KIND: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G310",
      "G3_TIMING",
      "ERROR",
      `Item '${cueId}' ('${kind}') has no linear source media stream, so no range can be excised from it with 'lane excise'.`,
      `'lane excise' only works on audio ('voiceover', 'music', 'sfx') and video ('broll') media cues. To change the duration of compositions, titles, captions or stills use 'cuthol lane update-cue --cue ${cueId} --duration <duration>', or 'cuthol lane remove-cue --cues ${cueId}' to delete.`,
      cueId
    ),

  CLEANUP_CUE_NOT_AUDIO: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G313",
      "G3_TIMING",
      "ERROR",
      `'${cueId}' ('${kind}') is not an audio cue; speech cleanup only runs on 'voiceover', 'music' and 'sfx' cues carrying an audio file.`,
      `Place the recording with 'cuthol lane add-cue --lane ln_vo --kind voiceover --asset <aud_XX>'. To clean footage on the spine use 'cuthol speech cleanup --clip <sp_XX>'. Compositions, titles, captions, b-roll and stills are not cut by this command.`,
      cueId
    ),

  CLEANUP_TARGET_CONFLICT: () =>
    createDiagnostic(
      "CUTHOL-G314",
      "G3_TIMING",
      "ERROR",
      "Speech cleanup cannot take both a spine clip and an audio cue in the same call.",
      `Use 'cuthol speech cleanup --cue <cue_XX>' (or '--cues a,b') for an audio cue, 'cuthol speech cleanup --clip <sp_XX>' for the spine.`
    ),

  CLEANUP_BAD_ACROSS: (value: string) =>
    createDiagnostic(
      "CUTHOL-G315",
      "G3_TIMING",
      "ERROR",
      `'${value}' is not a valid shift scope.`,
      `In audio-cue cleanup '--across' must be 'lane' (default), 'all_lanes', 'all', 'spine' or 'none'. This means the same as 'lane excise --across'.`
    ),


  // --- Speed ramp: codes CUTHOL-G116, CUTHOL-G117, CUTHOL-G410 ---
  INVALID_SPEED_RAMP: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G116",
      "G1_SCHEMA",
      "ERROR",
      `'--ramp' is invalid: ${detail}`,
      `Correct form: '--ramp "0s:1,1s:1,2.5s:4"' (source offset:rate pairs; offsets strictly increasing, rate 0.1..16, offsets within the clip's 0..source range, at least 2 points). '--ramp none' removes it. Example: 'cuthol spine speed --clip sp_01 --ramp "0s:1,2s:4"'. Cannot be combined with '--rate'.`
    ),

  SPEED_RAMP_AUDIO_APPROX: (clipId: string, minRate: number, maxRate: number) =>
    createDiagnostic(
      "CUTHOL-G410",
      "G4_STAGE",
      "WARN",
      `Speed ramp on '${clipId}' has rates outside 0.5..2.0 (${minRate.toFixed(2)}..${maxRate.toFixed(2)}); audio follows the ramp but quality drops at extreme rates (chained atempo or large pitch shift).`,
      `Listen to the audio in the draft render; on clips with speech keep the ramp ends within 0.5..2.0: 'cuthol spine speed --clip ${clipId} --ramp "0s:1,..."'.`,
      clipId
    ),

  SPEED_RAMP_BEYOND_SOURCE: (clipId: string, offsetMs: number, spanMs: number) =>
    createDiagnostic(
      "CUTHOL-G117",
      "G4_STAGE",
      "WARN",
      `Offset ${offsetMs}ms in the speed ramp of '${clipId}' exceeds the source range (0..${spanMs}ms); clamped to ${spanMs}ms.`,
      `Bring the ramp offsets into 0..${spanMs}ms: 'cuthol spine speed --clip ${clipId} --ramp "0s:1,..."'.`,
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
      `Effect '${fxId}' ('${kind}') on '${ownerId}' is invalid: ${detail}`,
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
      `Envelope '${parameter}' on '${ownerId}' cannot be applied: ${reason}`,
      ownerId.startsWith("cue_")
        ? `Remove the envelope or move it to an envelopable parameter ('cuthol spine envelope --item ${ownerId} --param <name> --points <...>'); the extension declares which parameters are envelopable ('animatable').`
        : `Remove the envelope or move it to an envelopable parameter ('cuthol spine envelope --item ${ownerId} --param <name> --points <...>'); the extension declares which parameters are envelopable ('animatable').`,
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
      `Effect '${fxId}' (${ref}) on clip '${clipId}' is compiling against a different extension than pinned (in sequence: ${pinnedLabel}, on disk: ${actualLabel}).`,
      `Run 'cuthol extension enable --name ${extName}' to accept the change and move to the new version.`,
      clipId
    ),

  // [p1fx:W0 G264–G266] cue fx stage
  CUE_FX_TEXT_UNSUPPORTED: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G264",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on text cue '${cueId}' is not supported yet; the cue carries an 'fx' entry but text cues have no fx stage in this version.`,
      `Remove the 'fx' list from the cue in the sequence JSON; text cue fx arrives in a later wave.`,
      cueId
    ),
  CUE_FX_AUDIO_UNSUPPORTED: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G265",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on audio cue '${cueId}' (kind '${kind}') is not supported: audio cues have no pixel chain for fx to run on.`,
      `Remove the 'fx' list from the cue in the sequence JSON.`,
      cueId
    ),
  CUE_FX_KIND_UNSUPPORTED: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G266",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on cue '${cueId}' (kind '${kind}') is not supported: this cue kind has no pixel chain for fx to run on.`,
      `Remove the 'fx' list from the cue in the sequence JSON.`,
      cueId
    ),
  CUE_FX_AUDIO_NOT_ALLOWED: (cueId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G271",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on audio cue '${cueId}' (kind '${kind}') is not supported: audio cues have no pixel chain for fx to run on.`,
      `Use 'cuthol spine fx' on a spine clip or a visual lane cue instead; audio shaping lives in the audio chain.`,
      cueId
    ),
  // [p1fx:A G267–G270] fx stage render
  COMPOSITION_TEMPORAL_FX_SINGLEFRAME: (cueId: string, filter: string) =>
    createDiagnostic(
      "CUTHOL-G267",
      "G1_SCHEMA",
      "WARN",
      `Temporal effect '${filter}' on composition cue '${cueId}' sees one repeated frame in a single-frame compile ('monitor frame'): 'monitor frame' differs from 'render' there.`,
      `Compare temporal effects on composition cues with a multi-frame render instead of 'monitor frame'.`,
      cueId
    ),
  // [p1fx:B G271–G275] fx surface
  // [p1fx:C G276–G279] text cue fx
  CUE_FX_TEXT_LAYER_EMPTY: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G276",
      "G1_SCHEMA",
      "ERROR",
      `Effect chain on text cue '${cueId}' produced no text layer; the cue carries active fx but its text is empty.`,
      `Give the cue text or remove the 'fx' list from the cue in the sequence JSON.`,
      cueId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Easing: codes CUTHOL-G120 ---
  EASING_NAME_INVALID: (subject: string, name: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `Easing name '${name}' for '${subject}' is invalid.`,
      `Valid easing names: 'linear', 'ease_in', 'ease_out', 'ease_in_out', 'hold', 'cubic_bezier'. For a curve use '--easing "cubic-bezier(x1,y1,x2,y2)"' (x1 and x2 within 0..1; e.g. 'cubic-bezier(0.25,0.1,0.25,1)').`,
      subject
    ),

  EASING_HOLD_IN_TRANSITION: (subject: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `'hold' easing cannot be used in the out-transition of clip '${subject}': the step curve ends the transition unseen (progress stalls at 0, then jumps to 1 at the end).`,
      `Use 'linear', 'ease_in', 'ease_out', 'ease_in_out' or 'cubic_bezier' for the transition (e.g. 'cuthol spine transition --clip ${subject} --easing ease_in_out').`,
      subject
    ),

  CUBIC_BEZIER_INVALID: (subject: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G120",
      "G1_SCHEMA",
      "ERROR",
      `cubic-bezier curve for '${subject}' is invalid: ${detail}.`,
      `Pass the curve as '--easing "cubic-bezier(x1,y1,x2,y2)"'; x1 and x2 must be within 0..1 (e.g. 'cubic-bezier(0.25,0.1,0.25,1)').`,
      subject
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Edge mode: codes CUTHOL-G121, CUTHOL-G412 ---
  EDGE_LANE_CUE_UNSUPPORTED: (cueId: string, edge: string) =>
    createDiagnostic(
      "CUTHOL-G121",
      "G1_SCHEMA",
      "ERROR",
      `'edge=${edge}' on lane cue '${cueId}' is not supported in this version; mirrored/extended edge fill only works on spine clips, so this setting is ignored.`,
      `Remove the 'edge' field from the lane cue; apply the fill to the spine clip underneath with 'cuthol spine transform --clip <sp_XX> --edge ${edge}'.`,
      cueId
    ),

  EDGE_INEFFECTIVE: (clipId: string) =>
    createDiagnostic(
      "CUTHOL-G412",
      "G4_STAGE",
      "WARN",
      `Clip '${clipId}' already covers the stage fully and does not move; the given edge mode changes nothing in the picture.`,
      `Remove the ineffective setting with 'cuthol spine transform --clip ${clipId} --edge transparent', or shrink/shift the clip to make the fill visible.`,
      clipId
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Extension transitions: codes CUTHOL-G122, CUTHOL-G123, CUTHOL-G413 ---
  EXTENSION_TRANSITION_UNAVAILABLE: (kind: string, detail: string, subjectId?: string) =>
    createDiagnostic(
      "CUTHOL-G122",
      "G1_SCHEMA",
      "ERROR",
      `Extension transition '${kind}' is unavailable: ${detail}`,
      `Verify the extension is installed with 'cuthol extension list' and the transition is defined in the 'transitions' section with 'cuthol extension show --name <name>'; if the extension is not enabled in the project, run 'cuthol extension enable --name <name>'.`,
      subjectId
    ),

  EXTENSION_TRANSITION_EASING_UNSUPPORTED: (kind: string, easing: string, subjectId?: string) =>
    createDiagnostic(
      "CUTHOL-G122",
      "G1_SCHEMA",
      "ERROR",
      `Easing '${easing}' is not supported in extension transition '${kind}' in this version.`,
      `Use 'linear', 'ease_in', 'ease_out' or 'ease_in_out' for the transition (e.g. 'cuthol spine transition --clip <sp_XX> --kind ${kind} --easing ease_in_out').`,
      subjectId
    ),

  EXTENSION_TRANSITION_PARAM_INVALID: (kind: string, clipId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G123",
      "G1_SCHEMA",
      "ERROR",
      `Parameters of transition '${kind}' on clip '${clipId}' are invalid: ${detail}`,
      `Fix the parameters per the 'transitions' definition in the extension manifest ('cuthol extension show --name <name>'); e.g. 'cuthol spine transition --clip ${clipId} --kind ${kind} --param name=value'.`,
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
      `Extension '${name}' whose transition you use changed on disk (pinned in sequence: v${expectedVersion} ${expectedHash}, current on disk: v${actualVersion} ${actualHash}); the render goes out with the current extension.`,
      `Run 'cuthol extension enable --name ${name}' to accept the change and move to the new content hash.`,
      subjectId
    ),

  // [fxcheck:B G330–G339]
  EXTENSION_TRANSITION_FIELD_UNQUOTED_PROGRESS: (extName: string, trName: string, field: string) =>
    createDiagnostic(
      "CUTHOL-G330",
      "G1_SCHEMA",
      "ERROR",
      `Transition '${trName}' in extension '${extName}' uses '{{p}}' outside single quotes in '${field}': the eased-progress expansion contains commas that split ffmpeg filter options.`,
      `Quote the '{{p}}' expansion in '${field}' (e.g. "eq=brightness='0.5*({{p}})'"), so the commas stay inside one filter option; 'cuthol extension show --name ${extName}' prints the manifest section.`,
      trName
    ),

  EXTENSION_TRANSITION_BACKSTOP_FAILED: (kind: string, clipId: string, detail: string, field?: string) =>
    createDiagnostic(
      "CUTHOL-G331",
      "G1_SCHEMA",
      "ERROR",
      `Extension transition '${kind}' on clip '${clipId}' fails a short encoder-free render over its own window${field ? ` (failing part: '${field}')` : ""}: ${detail}`,
      `Fix the transition template${field ? ` field '${field}'` : ""} ('cuthol extension show --name <name>') so the windowed render passes, or replace the transition; the render would fail the same way.`,
      clipId
    ),

  EXTENSION_TRANSITION_BACKSTOP_SKIPPED: (reason: string) =>
    createDiagnostic(
      "CUTHOL-G332",
      "SYS",
      "WARN",
      `The extension-transition backstop render was skipped (${reason}); ext: transitions are unchecked in this run.`,
      `Install ffmpeg 8.x on PATH and retry 'verify' so the transition window is actually rendered once; a skipped backstop hides a render-time crash.`
    ),

  // ---------------------------------------------------------------------------------------------------

  // --- Colour (LUT, temperature, colour envelopes): codes CUTHOL-G124, CUTHOL-G414 ---
  INVALID_COLOR_TEMPERATURE: (clipId: string, kelvin: number) =>
    createDiagnostic(
      "CUTHOL-G124",
      "G1_SCHEMA",
      "ERROR",
      `Color temperature of clip '${clipId}' (${String(kelvin)} K) is outside the supported range (1000..40000 K).`,
      `Return to the neutral value (6500 K, no filter) with 'cuthol spine grade --clip ${clipId} --temperature 6500'.`,
      clipId
    ),

  LUT_FILE_NOT_READABLE: (clipId: string, lutUri: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G414",
      "G4_STAGE",
      "ERROR",
      `LUT file ('${lutUri}') of clip '${clipId}' is unusable: ${detail}.`,
      `Place the LUT file under the project folder as '.cube' or '.3dl' and re-attach it with 'cuthol spine grade --clip ${clipId} --lut <path>'; use '--lut none' to remove it.`,
      clipId
    ),

  // --- Colour stage (render): codes CUTHOL-G440–G449 ---
  COLOR_LUT_SELFTEST_ABOVE_LIMIT: (itemId: string, p99: number) =>
    createDiagnostic(
      "CUTHOL-G440",
      "G4_STAGE",
      "WARN",
      `Colour stage LUT of '${itemId}' still mismatches the block math at the fine 65 grid (p99 CIEDE2000 ${p99.toFixed(2)}); the render uses the closest LUT.`,
      `Simplify the stage of '${itemId}' (narrow HSL qualifiers need the fine grid) and re-render.`,
      itemId
    ),

  COLOR_LOOK_LUT_UNREADABLE: (itemId: string, lutUri: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G441",
      "G4_STAGE",
      "ERROR",
      `Look LUT ('${lutUri}') of '${itemId}' is unusable: ${detail}.`,
      `Place the Look LUT file under the project folder as '.cube' and re-attach it, or remove the Look binding from '${itemId}'.`,
      itemId
    ),

  COLOR_ENVELOPE_TOO_MANY_FRAMES: (itemId: string, frames: number, limit: number) =>
    createDiagnostic(
      "CUTHOL-G442",
      "G4_STAGE",
      "ERROR",
      `Keyframed colour of '${itemId}' needs ${frames} baked frames, above the cache limit (${limit} per item).`,
      `Shorten the keyframed range of '${itemId}' or split it across items, then re-render.`,
      itemId
    ),

  COLOR_INPUT_TRANSFORM_UNAVAILABLE: (itemId: string, kind: string) =>
    createDiagnostic(
      "CUTHOL-G443",
      "G4_STAGE",
      "ERROR",
      `Input transform '${kind}' of '${itemId}' needs ffmpeg filters this build lacks ('zscale', 'tonemap').`,
      `Install an ffmpeg 8.x build with 'zscale' and 'tonemap', or set the asset input to 'none'.`,
      itemId
    ),

  COLOR_HALD_RENDER_FAILED: (itemId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G444",
      "G4_STAGE",
      "ERROR",
      `Keyframed colour of '${itemId}' could not bake its frame LUTs: ${detail}.`,
      `Re-run the render (the baked frames cache under '.cuthol/blobs/color'); if it persists, simplify the colour envelopes of '${itemId}'.`,
      itemId
    ),

  // ---------------------------------------------------------------------------------------------------
  // --- Composition renderer (script errors, composition audio): codes CUTHOL-G415, CUTHOL-G416 ---
  SCRIPT_ERROR_ISOLATED: (
    subject: string,
    elementId: string,
    compositionId: string | null,
    error: string
  ) =>
    createDiagnostic(
      "CUTHOL-G415",
      "G4_STAGE",
      "WARN",
      `Silent gap in overlay '${subject}': the script of element '${elementId}'${compositionId && compositionId !== elementId ? ` ('${compositionId}' sub-composition)` : ""} threw (${error}); HyperFrames skipped this element with an empty timeline, its part is missing from the picture.`,
      `Fix the error in the '${compositionId ?? elementId}' script, then re-render the overlay with 'cuthol render' (a file change triggers the re-render).`,
      subject
    ),

  COMPOSITION_AUDIO_SILENT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "WARN",
      `Audio playing in composition cue '${cueId}' (${detail}) is not in the Cuthol mix yet: no audio stem has been extracted for the current composition files.`,
      `Run 'cuthol render' (or a mix measurement such as 'cuthol mix normalize') once; it extracts the stem and mixes it at the cue's lane time. To keep the composition silent, run 'cuthol lane update-cue --cue ${cueId} --composition-audio off'; to manage the sound as a separate cue instead, place it on the 'ln_sfx' or 'ln_bgm' lane ('cuthol lane add-cue --lane ln_sfx --kind sfx --asset <handle> ...').`,
      cueId
    ),

  // --- Composition audio stems: CUTHOL-G416 (in-mix/off info), CUTHOL-G435, CUTHOL-G436, CUTHOL-G437 ---
  COMPOSITION_AUDIO_IN_MIX: (cueId: string, stemMs: number, offHint: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "INFO",
      `Composition cue '${cueId}' brings ${stemMs}ms of engine-rendered audio into the Cuthol mix as a per-cue stem (lane gain, mute, envelopes and ducking apply).`,
      offHint,
      cueId
    ),

  COMPOSITION_AUDIO_OFF: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G416",
      "G4_STAGE",
      "INFO",
      `Audio in composition cue '${cueId}' (${detail}) stays out of the Cuthol mix because 'composition_audio' is 'off' on this cue.`,
      `To mix it, run 'cuthol lane update-cue --cue ${cueId} --composition-audio mix'.`,
      cueId
    ),

  COMPOSITION_STEM_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G435",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' has audio, but its stem could not be extracted (${reason}); the cue renders silent until the extraction succeeds.`,
      `Fix the cause (usually a missing or unreadable audio file inside the composition), then re-render so the stem is retried.`,
      cueId
    ),

  COMPOSITION_RENDER_SILENT: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G436",
      "G4_STAGE",
      "INFO",
      `Composition cue '${cueId}' shows audio elements (${detail}), but the engine render produced no audible sound, so no stem enters the mix.`,
      `If the silence is unintended, check the audio file paths and timing inside the composition; otherwise no action is needed.`,
      cueId
    ),

  INVALID_COMPOSITION_AUDIO: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G437",
      "G1_SCHEMA",
      "ERROR",
      `Cue '${cueId}' has an invalid 'composition_audio' setting: ${detail}`,
      `Set 'composition_audio' to 'mix' or 'off' ('cuthol lane update-cue --cue ${cueId} --composition-audio mix|off'), only on composition cues.`,
      cueId
    ),

  // --- Composition coordinates: codes CUTHOL-G417, CUTHOL-G418, CUTHOL-G419, CUTHOL-G428, CUTHOL-G429 ---
  COORDS_MEASUREMENT_FAILED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G417",
      "G4_STAGE",
      "WARN",
      `Coordinate measurement failed for cue '${cueId}' (${reason}); the cue was skipped and the remaining cues continue.`,
      `Re-run the failed cue alone: 'cuthol composition coords --cue ${cueId} --refresh'. If it still fails, open the composition with 'cuthol composition preview --cue ${cueId}' to see the page error.`,
      cueId
    ),

  COORDS_FONTS_NOT_BUNDLED: (cueId: string, reason: string) =>
    createDiagnostic(
      "CUTHOL-G418",
      "G4_STAGE",
      "WARN",
      `Font bundling was unavailable for cue '${cueId}' (${reason}); measured with raw HTML, so text boxes may differ from render.`,
      `Re-run the cue after checking the renderer version ('npx hyperframes --version'): 'cuthol composition coords --cue ${cueId} --refresh'.`,
      cueId
    ),

  COORDS_PAGE_ISSUES: (cueId: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G419",
      "G4_STAGE",
      "INFO",
      `Page issues while measuring cue '${cueId}': ${detail}.`,
      `Inspect the same page with 'cuthol composition preview --cue ${cueId}', fix the reported script error, then re-run 'cuthol composition coords --cue ${cueId} --refresh'.`,
      cueId
    ),

  COORDS_UNKNOWN_ELEMENT: (ref: string, cueId: string, nearest: string | null) =>
    createDiagnostic(
      "CUTHOL-G428",
      "G4_STAGE",
      "ERROR",
      `Unknown element '${ref}' in cue '${cueId}'.`,
      nearest
        ? `Did you mean '${nearest}'? List keys with 'cuthol composition coords --at <moment> --cue ${cueId}'.`
        : `List keys with 'cuthol composition coords --at <moment> --cue ${cueId}'.`,
      ref
    ),

  COORDS_QUERY_MISUSE: (detail: string, fix: string) =>
    createDiagnostic(
      "CUTHOL-G429",
      "G4_STAGE",
      "ERROR",
      `Geometry query misuse: ${detail}.`,
      `Use: ${fix}`
    ),

  // CUTHOL-G420..CUTHOL-G427 retired with the layout warning system; never reused (may appear in old projects/logs).

  // --- Media and speech providers (selection, extension providers, media sources): codes CUTHOL-G230 .. CUTHOL-G249 ---

  PROVIDER_UNKNOWN: (kind: string, id: string, valid: string) =>
    createDiagnostic(
      "CUTHOL-G230",
      "G1_SCHEMA",
      "ERROR",
      `Unknown ${kind} provider '${id}'.`,
      `Use one of: ${valid}.`
    ),

  PROVIDER_CAPABILITY_MISSING: (extName: string, kind: string, available: string) =>
    createDiagnostic(
      "CUTHOL-G231",
      "G2_ASSETS",
      "ERROR",
      `Extension '${extName}' does not provide a '${kind}' provider (it provides: ${available || "nothing"}).`,
      `Check the extension manifest 'providers' section with 'cuthol extension show --name ${extName}'.`
    ),

  PROVIDER_ENV_MISSING: (extName: string, kind: string, missingVars: string[]) =>
    createDiagnostic(
      "CUTHOL-G232",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) needs ${missingVars.length === 1 ? "environment variable" : "environment variables"} ${missingVars.map((v) => `'${v}'`).join(", ")}, which ${missingVars.length === 1 ? "is" : "are"} not set.`,
      `Set ${missingVars.length === 1 ? "it" : "them"} in your shell environment or in the project '.env' file ('${missingVars[0]}=...'), then retry. Values are read from the environment only and are never written to the sequence, journal, cache, or logs.`
    ),

  PROVIDER_BAD_OUTPUT: (extName: string, kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G233",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) returned invalid output: ${detail}`,
      `Fix the provider script to return the documented JSON contract (see 'extensions' guide, providers section).`
    ),

  PROVIDER_EXECUTION_FAILED: (extName: string, kind: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G234",
      "SYS",
      "ERROR",
      `Extension provider '${extName}' (${kind}) failed: ${detail}`,
      `Check the provider script and its configuration with 'cuthol extension show --name ${extName}'.`
    ),

  PROVIDER_TTS_NO_ALIGNMENT: (extName: string) =>
    createDiagnostic(
      "CUTHOL-G235",
      "SYS",
      "WARN",
      `Extension TTS provider '${extName}' returned audio without word or character alignment, so no word timings are available.`,
      `Captions, cleanup, and word-locked animation cannot use this voiceover. Use a provider with alignment, or transcribe the voiceover with 'cuthol speech transcribe'.`
    ),

  MEDIA_FETCH_NOT_FOUND: (extName: string, id: string) =>
    createDiagnostic(
      "CUTHOL-G236",
      "G2_ASSETS",
      "ERROR",
      `Media provider '${extName}' has no candidate with id '${id}'.`,
      `List candidates with 'cuthol library search --provider ext:${extName} --kind music|sfx --query "<text>"'.`
    ),

  // --- end of provider block ---

  // --- Composition script errors: CUTHOL-G430 .. CUTHOL-G434 ---
  // (G434 is reserved for future composition page diagnostics.)

  COMPOSITION_SCRIPT_FAILED_BEFORE_TIMELINE: (cueId: string, error: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G430",
      "G4_STAGE",
      "ERROR",
      `Composition '${cueId}' page script threw before its timeline registered ('${error}'${where ? ` at ${where}` : ""}); the overlay cannot render (render stops with CUTHOL-G503) and monitor frames show the static unanimated page.`,
      `Fix the script${where ? ` (${where})` : ""}, then re-check with 'cuthol composition preview --cue ${cueId}' (preview re-runs the page); 'cuthol verify' stays red while the recorded error matches the current composition files.`,
      cueId
    ),

  COMPOSITION_SCRIPT_FAILED_AFTER_TIMELINE: (cueId: string, error: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G431",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' page script threw while its timeline was running ('${error}'${where ? ` at ${where}` : ""}); the render output is unaffected, but the throwing code path never completes.`,
      `Fix the callback${where ? ` (${where})` : ""}, then re-check with 'cuthol composition preview --cue ${cueId}'.`,
      cueId
    ),

  COMPOSITION_CONSOLE_ERROR: (cueId: string, error: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G432",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' page logged a console error ('${error}'${where ? ` at ${where}` : ""}); the render output is unaffected, but the message signals a real page problem (for example a failed shader compile or a missing asset).`,
      `Inspect the cause${where ? ` (${where})` : ""}, then re-check with 'cuthol composition preview --cue ${cueId}'.`,
      cueId
    ),

  COMPOSITION_CONSOLE_WARNING_ONLY: (cueId: string, warning: string, where: string | null) =>
    createDiagnostic(
      "CUTHOL-G433",
      "G4_STAGE",
      "INFO",
      `Composition '${cueId}' page logged only shader/compiler warnings ('${warning}'${where ? ` at ${where}` : ""}); nothing threw and the render output is unaffected.`,
      `No action needed; re-check with 'cuthol composition preview --cue ${cueId}' if the message changes.`,
      cueId
    ),

  // [mcp-reload G635–G639]       MCP server noticing a newer Cuthol build on disk
  MCP_RELOADED_NEWER_BUILD: (from: string, to: string) =>
    createDiagnostic(
      "CUTHOL-G635",
      "SYS",
      "INFO",
      `Cuthol was rebuilt on disk while this MCP session ran (${from} -> ${to}); the MCP server restarted itself on the new build and the tool list was refreshed.`,
      `Continue with the MCP tools; their arguments now match the CLI on disk. Re-open your project with workspace open if a call reports no project.`
    ),
  MCP_RELOAD_FAILED: (running: string, onDisk: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G636",
      "SYS",
      "WARN",
      `Cuthol on disk (${onDisk}) is newer than this MCP process (${running}) and the automatic restart failed: ${detail}. MCP tool arguments may not match the CLI on disk.`,
      `Reconnect the cuthol MCP server in your agent (for Claude Code: /mcp -> cuthol -> Reconnect); until then avoid mixing MCP calls with CLI calls.`
    ),
  INVALID_STAGE_SIZE: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G150",
      "G1_SCHEMA",
      "ERROR",
      `Invalid stage size '${raw}'. Use WIDTHxHEIGHT with even numbers, e.g. --size 1920x800.`,
      `Pass --size WIDTHxHEIGHT with even numbers between 16 and 8192 (e.g. --size 1920x800).`
    ),
  STAGE_ADOPTED_FROM_SOURCE: (size: string, undo: string) =>
    createDiagnostic(
      "CUTHOL-G151",
      "G1_SCHEMA",
      "INFO",
      `Stage set to ${size} from the first visual source. Undo: ${undo}.`,
      `Pass --aspect or --size at init (or run the suggested command) to fix the stage instead.`
    ),
  STAGE_SIZE_SUGGESTED: (size: string, command: string) =>
    createDiagnostic(
      "CUTHOL-G152",
      "G1_SCHEMA",
      "INFO",
      `First visual source suggests stage ${size}. Run: ${command}.`,
      `Run the suggested command to adopt the source size.`
    ),
  STAGE_RESIZED: (detail: string) =>
    createDiagnostic(
      "CUTHOL-G153",
      "G1_SCHEMA",
      "INFO",
      `Stage resized: ${detail}.`,
      `Undo with workspace journal undo if the new layout is wrong.`
    ),
  STAGE_COMPOSITION_SIZE_MISMATCH: (cueId: string, compSize: string, stageSize: string) =>
    createDiagnostic(
      "CUTHOL-G154",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' declares ${compSize} but the stage is ${stageSize}; the composition HTML is not rewritten.`,
      `Resize the composition or run workspace stage to match it.`
    ),
  // [canvas G150–G159]           free stage size, size suggestion from sources, stage resize and rescale
  // [tempo G160–G169]            sequence tempo (stage.tempo): validation, render/monitor/export mapping
  INVALID_TEMPO: (raw: string) =>
    createDiagnostic(
      "CUTHOL-G160",
      "G1_SCHEMA",
      "ERROR",
      `Invalid tempo '${raw}': rate must be between 0.5 and 2.0 (sequence rate applied at output; absent = 1).`,
      `Run 'cuthol workspace tempo --rate 1.1' with a rate in 0.5..2.0, or '--rate 1' to clear it.`
    ),
  // [multi-notes G690–G699]      Live notes across frames, scene boundaries, scene ranges
  LIVE_MULTI_NOTES_QUEUED: (id: string, cells: number, frames: number) =>
    createDiagnostic(
      "CUTHOL-G690",
      "G5_SIGNAL",
      "INFO",
      `Multi-scene note packet '${id}' queued with ${cells} contact-sheet cells across ${frames} frames; the sheet attaches to the stored packet when ready.`,
      "Read the note lines with the next command result; the sheet image follows on disk."
    ),
  LIVE_SHEET_CELLS_DROPPED: (dropped: number, total: number, cap: number) =>
    createDiagnostic(
      "CUTHOL-G691",
      "G5_SIGNAL",
      "WARN",
      `Contact sheet keeps ${total - dropped} of ${total} cells (cap ${cap}); the packet names the dropped count.`,
      "Open the sheet for the kept cells; read the remaining pins from the note lines."
    ),

  // [p2mo:W0 G280–G282] motion layers on placement: resolver, `motion` kind, pixel-stage predicate
  // [p2mo:A G283-G287] layer combination and expressions
  PLACEMENT_EXPR_TOO_COMPLEX: (points: number, cap: number) =>
    createDiagnostic(
      "CUTHOL-G283",
      "G4_STAGE",
      "ERROR",
      `Placement envelope with ${points} points exceeds the expression budget (cap ${cap}); the combined graph would fail in ffmpeg.`,
      "Split the envelope into fewer points or shorter clips before rendering."
    ),
  // [p2mo:B G288–G291] motion surface and verify
  MOTION_OPACITY_CLAMPED: (item: string, range: string, layers: string) =>
    createDiagnostic(
      "CUTHOL-G288",
      "G4_STAGE",
      "WARN",
      `Item ${item} channel opacity combined range ${range} above 1 (it is clamped) via layers ${layers}.`,
      "Lower the base or layer opacity so the combined range stays within [0, 1]."
    ),
  MOTION_SCALE_ZERO: (item: string, channel: string, range: string, layers: string) =>
    createDiagnostic(
      "CUTHOL-G289",
      "G4_STAGE",
      "WARN",
      `Item ${item} channel ${channel} combined range ${range} crosses or touches 0 via layers ${layers}.`,
      "Keep the combined scale away from 0; a zero scale collapses the item."
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
      `fx definition check passed with a warning on 'definition' fx '${kind}': shader effects are not checked by spine fx check yet.`,
      "No action needed; the shader is compiled when the clip renders."
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
      `Shader pre-pass '${id}' failed (${detail}); the main graph cannot render without its intermediate file.`,
      "Re-run the render; the shader pass retries from scratch. If it keeps failing, inspect the shader file and line."
    ),
  SHADER_FRAME_TIMEOUT: (id: string, frame: number, timeoutMs: number) =>
    createDiagnostic(
      "CUTHOL-G708",
      "G4_STAGE",
      "ERROR",
      `Shader pre-pass '${id}' timed out on frame ${frame} after ${timeoutMs}ms (the shader may loop forever).`,
      "Fix the shader so every invocation terminates, then re-run the render."
    ),
  SHADER_LANE_REJECTED: (item: string, fxId: string) =>
    createDiagnostic(
      "CUTHOL-G709",
      "G4_STAGE",
      "ERROR",
      `Shader effect '${fxId}' on '${item}' is not supported: shader effects apply to spine clips in this version.`,
      "Move the effect to a spine clip, or use an ffmpeg effect on the lane cue."
    ),
  SHADER_COMPILE_ERROR: (file: string, line: number, detail: string) =>
    createDiagnostic(
      "CUTHOL-G710",
      "G4_STAGE",
      "ERROR",
      `Shader '${file}' failed to compile (line ${line}): ${detail}`,
      "Fix the '.glsl' file at the reported line and re-enable the extension (or re-run the check)."
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
      `Shader '${file}' was not compiled in a browser yet (no cached result for its content hash): only the static scan ran.`,
      "Run 'extension enable' for its extension to compile it, then re-run this command."
    ),
  // [fix:A G530–G534] render output
  // [fix:B G692–G696] live server (reserved; B1 needs no new diagnostic: failures keep the G612 contract)
  LIVE_NOTE_COORDS_PIN_SCOPED: (frame: number, kept: number, total: number) =>
    createDiagnostic(
      "CUTHOL-G692",
      "G5_SIGNAL",
      "INFO",
      `Pin measurement for frame ${frame} scoped to ${kept} of ${total} compositions whose stage box covers the pin.`,
      "Pin again elsewhere if the element name looks stale; each pin measures only its own compositions."
    ),
  LIVE_NOTE_COORDS_PIN_FALLBACK: (frame: number) =>
    createDiagnostic(
      "CUTHOL-G693",
      "G5_SIGNAL",
      "INFO",
      `Pin measurement for frame ${frame} found nothing in the covering compositions, so the remaining compositions were measured too.`,
      "No action needed; the element answer matches the whole-frame measurement."
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
      `Composition cue '${cueId}' draws nothing: the captured transparent overlay is empty across sampled frames.`,
      "Check that the timeline starts visible, GSAP is loaded and nothing hides the root."
    ),
  EMPTY_COMPOSITION_VERIFY: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G721",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' draws nothing: its cached overlay sidecar is marked empty and composition files are unchanged.`,
      "Check that the timeline starts visible, GSAP is loaded and nothing hides the root."
    ),
  EMPTY_COMPOSITION_FRAME: (cueId: string, at: string) =>
    createDiagnostic(
      "CUTHOL-G722",
      "G4_STAGE",
      "WARN",
      `Composition '${cueId}' draws nothing at ${at}: the transparent capture alpha is empty there (it may not have entered yet).`,
      "Check that the timeline starts visible, GSAP is loaded and nothing hides the root."
    ),
  EMPTY_COMPOSITION_SHEET: (cueId: string) =>
    createDiagnostic(
      "CUTHOL-G723",
      "G4_STAGE",
      "WARN",
      `Composition cue '${cueId}' draws nothing in any sheet tile where it is active.`,
      "Check that the timeline starts visible, GSAP is loaded and nothing hides the root."
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
      `Live shader request for unknown spine item '${item}'.`,
      `List clip ids with 'cuthol spine show' and retry with a spine clip id.`,
      item
    ),
  LIVE_SHADER_SOURCE_FAILED: (item: string, detail: string) =>
    createDiagnostic(
      "CUTHOL-G731",
      "G5_SIGNAL",
      "ERROR",
      `Live shader sources for '${item}' could not be resolved (${detail}).`,
      `Re-enable the extension ('cuthol extension enable --name <ext>') and retry.`,
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
      `Live shader entry '${item}' failed (${detail}).`,
      `Check the clip's fx list ('cuthol spine fx --clip ${item}') and the extension state.`,
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
