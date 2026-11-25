import { TopicDoc } from "./docs_types.js";

export const TOPIC_DOCS: TopicDoc[] = [
  {
    topic: "transition-duration",
    title: "Do spine transitions shorten the sequence?",
    body: "No: a spine transition_out is stored on the outgoing clip and rendered as an overlap effect, not as extra or removed time. Sequence length comes only from clip extents (computeSpineEndMs in src/core/timeline.ts: max of timeline_in_ms + duration_ms) and lane ends; no transition term enters that max. Splits keep the transition on the last sub-clip (spine_edit.ts: transition_out is assigned to the final interval only), so cutting does not duplicate or drop transition time either.",
    see: "src/core/timeline.ts (computeSpineEndMs, computeSequenceDurationMs); src/sequence/spine_edit.ts (transition_out handling)",
  },
  {
    topic: "audio-gain-envelopes",
    title: "How audio_chain.gain_db envelopes combine with base gain",
    body: "Base gain comes from the item's audio_chain gain_db; an optional envelope with parameter 'audio_chain.gain_db' (found in compile_audio.ts via envelopes.find) adds a time-varying offset on top of that base. Separately, audio_chain.fade_out_ms applies a fade over the last fade_out_ms of the trimmed duration (outStartMs = postTrimDurationMs - fade_out_ms), and fade_in_ms/fade_out_ms win over the join fade on their side; the join-fade fallback uses max(fade_out_ms, joinFadeOutMs). So final gain(t) = base gain_db + gain_db envelope(t), then fades multiply on top.",
    see: "src/compositor/compile_audio.ts (gainEnv lookup, fade_out_ms windows, join-fade max)",
  },
  {
    topic: "cue-sheet-fields",
    title: "Which cue-sheet fields round-trip (cue export/apply)",
    body: "Cue-sheet entries carry the cue id, timing, asset/kind, typography, composition reference and audio settings including audio_chain.fade_out_ms: bridge export readers (bridge_export_global.ts, bridge_export_local.ts) explicitly read audioChain.fade_out_ms (default 0) and the audio_chain.gain_db envelope alongside it, and apply writes transition_out back when present (cuesheet.ts: entry.transition_out !== undefined). Fields the sheet does not model (internal probe caches, render intermediates) do not round-trip.",
    see: "src/sequence/cuesheet.ts (entry fields, transition_out, apply); src/compositor/bridge_export_global.ts and bridge_export_local.ts (fade_out_ms, gain_db envelope reads)",
  },
  {
    topic: "caption-styles",
    title: "How boxed, active_word and sentence caption styles combine",
    body: "ASS output is built in ass_generator.ts: the style line sets Primary/Secondary/Outline/Back colours, BorderStyle (box vs outline), font size and margins. boxed controls the background box (BackColour / BorderStyle); sentence vs word grouping controls line assembly; when active-word tokens exist and active_word_color_hex is set, the active word interval is recoloured with that colour on top of the base style. So box colour and active-word colour are independent layers: box paints behind, active-word recolours the current word's glyphs.",
    see: "src/compositor/ass_generator.ts (style Format line, active_word_color_hex handling)",
  },
  {
    topic: "render-audio-rate",
    title: "Output sample rate is 48 kHz stereo on every render path",
    body: "Every render path outputs 48 kHz stereo, forced at the final mux: RENDER_AUDIO_OUT_RATE_ARGS (`-ar 48000 -ac 2`) is appended on the segment, single-file and mux ffmpeg commands alike, so source, probe or mix rates never leak into the output file.",
    see: "src/render/render_encode.ts (RENDER_AUDIO_OUT_RATE_ARGS, segment/single-file/mux commands)",
  },
  {
    topic: "output-paths",
    title: "Which flags resolve against the project folder vs the working directory",
    body: "Relative --out paths resolve against the project folder, never the cwd (spine.ts render path comment: 'a relative path resolves against the project folder, never the cwd'). The workspace root itself defaults from --dir/--project flags, falling back to process.cwd() (cli_main.ts), so an absolute --out stays absolute while a bare filename lands inside the project. Cue sheets follow their own rule: `cue export --file` writes under `--dir` (absolute paths unchanged), while `cue apply|plan|diff --file` read the working directory first, then `--dir`, and report CUTHOL-G770 listing both tried paths when neither exists.",
    see: "src/cli_cmd_spine.ts (out-path comment); src/cli_main.ts (workspaceDir default); src/cli_output.ts (activeCliWorkspaceDir); src/cli_cmd_composition.ts (resolveCueSheetWritePath, resolveCueSheetReadPath)",
  },
];
