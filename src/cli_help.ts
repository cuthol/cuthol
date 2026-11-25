// Plain-text `cuthol help` output (split out of cli.ts).
import { CutholError, DIAGNOSTICS } from "./core/diagnostics.js";
import { strFlag } from "./cli_args.js";
import { getGuideText } from "./mcp/server.js";

const HELP_LINES: string[] = [
      "Cuthol — Agent-First Open-Source Non-Linear Video Editor (NLE)",
      "",
      "Usage:",
      "  cuthol workspace init [dir] [--aspect 9:16|16:9|1:1|4:5] [--size WxH] [--fps 30] [--title <name>]",
      "  cuthol workspace stage [--size WxH | --aspect 9:16|16:9|1:1|4:5 | --from <handle>] [--dir <dir>]",
      "  cuthol workspace backdrop --color <#RRGGBB> [--dir <dir>]",
  "  cuthol workspace tempo --rate <0.5..2.0> [--dir <dir>] (--rate 1 clears)",
  "  cuthol workspace audio-fade --ms <0..100> [--dir <dir>] (--ms 10 is the default, --ms 0 turns join fades off)",
      "  cuthol workspace journal [list | undo [--steps N | --to <rev>] [--expect-rev <rev>] [--dry-run] | redo [--steps N] | tag <name>] [--dir <dir>]",
      "  cuthol workspace changes [show | adopt | revert] [--comp <composition_dir|cue_XX>] [--dir <dir>]",
      "  cuthol library ingest <files...> [--handle <vid_01>] [--dir <dir>]",
      "  cuthol library loudness --handle <vid_01> [--target-lufs -14] [--dir <dir>]",
      "  cuthol library waveform --handle <vid_01> [--bins 160] [--png <out.png>] [--verbose] [--dir <dir>]",
      "  cuthol library beats --handle <aud_01> [--sensitivity 1.35] [--verbose] [--dir <dir>]",
      "  cuthol library scenes --handle <vid_01> [--threshold 10.0] [--verbose] [--dir <dir>]",
      "  cuthol library detach-audio --handle <vid_01> [--target-handle <aud_01>] [--dir <dir>]",
      "  cuthol library search --provider ext:<name> --kind music|sfx --query \"<text>\" [--min <10s>] [--max <60s>] [--limit <N>] [--dir <dir>]",
      "  cuthol library fetch --provider ext:<name> --id <candidate> [--dir <dir>]",
      "  cuthol library query --handle <vid_01|ln_captions> [--kind transcript|beats|waveform|scenes|captions] [--range 0s..5s] [--text <q>] [--limit 40] [--cursor <idx>] [--max-tokens 2000]",
      "  cuthol spine [append|split|trim|excise|remove|reorder|transform|speed|transition|envelope|grade|fx] ...",
      "  cuthol spine excise --clip <sp_XX> --ranges <a..b,c..d> [--snap] (snap moves ASR-derived range edges to quiet points; omit it to excise ranges exactly as given)",
      "  cuthol spine transform --clip <sp_XX> [--x N] [--y N] [--scale N] [--rotation N] [--opacity N] [--fit cover|contain|fill] [--edge transparent|mirror|clamp]",
      "  cuthol spine speed --clip <sp_XX> [--rate <1.5>] [--ramp \"0s:1,2s:4\"|none] [--preserve-pitch true|false]",
      "  cuthol spine transition --clip <sp_01> --kind <dissolve|fade|wipe_left|wipe_right|slide_up|zoom_in|ext:<ext>/<name>|none> [--duration 400ms] [--easing linear|ease_in|ease_out|ease_in_out|\"cubic-bezier(x1,y1,x2,y2)\"] [--param name=value,...] [--params '{\"name\":\"value\"}']",
      "  cuthol spine envelope --clip <sp_XX|cue_XX> --param <name> --points <0ms:1.0,4s:1.15> [--easing linear|ease_in|ease_out|ease_in_out|\"cubic-bezier(x1,y1,x2,y2)\"]",
      "  cuthol spine envelope point [add|move|remove] --clip <sp_XX|cue_XX> --param <name> --at <t> [--value <n>] [--to <t>] [--sequence-time] [--beat <n> --beats-of <aud_XX>]",
      "  cuthol spine value --item <sp_XX|cue_XX> --param <name> --at <t> [--sequence-time]",
      "  cuthol spine fx [catalog|add|set|remove|list] --item <sp_XX|cue_XX> [--kind ext:<ext>/<name>|--filter \"<chain>\"] [--param k=v] [--fx <fx_XX>]",
      "  cuthol spine mask --clip <sp_XX> [--shape rect|ellipse|split] [--center-x <pct>] [--center-y <pct>] [--width <pct>] [--height <pct>] [--feather <px>] [--invert] [--clear]",
      "  cuthol spine motion-blur --clip <sp_XX> [--shutter <deg>] [--subframes <n>] [--off]",
      "  cuthol lane [add-cue|add-composition|update-cue|remove-cue|lock|unlock|mute|unmute] ...",
      "  cuthol composition [scaffold|sync|preview|check] --comp-dir <dir> ...",
      "  cuthol composition coords --cue <cue_XX> | --all [--frames <a..b> | --at <s>[,<s>...]] [--refresh] [--dir <dir>]",
      "  cuthol composition coords --at <1500ms|1.5s|45f> [--cue <cue_XX>] [--elements <ref>[,<ref>...]] [--refresh] [--dir <dir>] (geometry query)",
      "  cuthol cue [plan|apply|diff|export] --file <cuthol.cues.json>",
      "  cuthol speech [transcribe|synthesize|providers|cleanup|verify-cleanup|captions] ...",
      "  cuthol speech transcribe --handle <vid_01|aud_01> [--lang <auto|tr|en>] [--refresh] [--provider deepgram|local|ext:<name>] [--dir <dir>]",
      "  cuthol speech synthesize --text \"<text>\" [--provider elevenlabs|local|ext:<name>] [--voice <id>] [--model <id>] [--speed <x>] [--lang <code>] [--place-on-lane ln_vo] [--at <t>|--anchor <sp_XX>] [--dir <dir>]",
      "  cuthol speech providers [--asr <id>|builtin] [--tts <id>|builtin] [--dir <dir>]",
      "  cuthol speech cleanup [--clip <sp_XX> | --cue <cue_XX> | --cues <a,b>] [--across lane|all_lanes|all|spine|none] [--dry-run]",
      "  cuthol mix [normalize|polish-voice|duck|beat-align] ...",
      "  cuthol verify [--gates all|G1_SCHEMA,G2_ASSETS,G3_TIMING,G4_STAGE,G5_SIGNAL]",
      "  cuthol monitor frame --at <2400ms> [--boxes true] [--no-hud] [--out <frame.png>] [--dir <dir>]",
      "  cuthol monitor sheet [--start 0s] [--end 12s] [--grid 3x3] [--boxes true] [--no-hud] [--out <sheet.png>] [--dir <dir>]",
      "  cuthol monitor timeline [--width 1400] [--include-empty] [--out <timeline.png>] [--dir <dir>]",
      "  cuthol render [--preset draft_480p|master_1080p|master_2160p|master_alpha] [--out <render.mp4>] [--profile] [--dir <dir>]",
      "  cuthol export timeline [fcpxml|xmeml|edl|otio] [--as <format>] --out <timeline file> [--dir <dir>]",
      // [export help lines]
      // [color help lines]
      "  cuthol color map --item <sp_XX|cue_XX> [--frames N] [--at 1s,4s] [--graded] | --image <file>",
      "  cuthol color diff --a <item|file> --b <item|file>",
      "  cuthol color solve --item <id> --to <item|file> | --mode technical [--targets exposure,white_balance,legal_range] | --mode pair --before <file> --after <file> [--name <n>]",
      "  cuthol color set --item <id>|--items <a,b>|--cluster <cN> [--wb <mired>[,<tint>]] [--exposure <stops>] [--tone contrast=0.2,shadows=-0.1] [--curve \"master=0:0,0.25:0.2,1:1\"] [--wheel \"lift=200,0.15\"] [--hsl \"hsl_01=center:25,width:30,shift:-6,sat:1.15\"] [--sat <x>] [--vibrance <x>] [--look <id>[:amount]] [--amount <block>=<0..1>] [--remove <block|hsl:id>] [--patch <json>] [--reason match|technical|taste]",
      "  cuthol color compare --item <id> --variants '[{\"label\":\"warm\",\"white_balance\":{\"temp_mired\":20,\"tint\":0}}]' [--out <png>]",
      "  cuthol color look [list | create --name <n> (--from-item <id>|--lut <file.cube>|--blocks <json>) [--apply-to all|<ids>] [--kinds camera,screen,graphic] [--amount x] | from-pair --name <n> --before <f> --after <f> | bind --look <id> --items <ids>|all | remove --look <id>]",
      "  cuthol color kind --handle <vid_XX> [--set camera|screen|graphic] [--input auto|none|hlg_to_sdr|pq_to_sdr]",
      "  cuthol color clusters",
      "  cuthol color migrate --item <sp_XX> | --all",
      "  cuthol brief [--lens overview|flow|canvas|detail] [--id <id1,id2>] [--window 0s..10s] [--json] [--dir <dir>]",
      "  cuthol extension [list|create|show|enable|disable|promote|remove|run] --name <ext> ...",
      "  cuthol skills list [--agent <id>[,<id>]] [--dir <skills-dir>]",
      "  cuthol skills install [--agent <id>[,<id>]] [--dir <skills-dir>] [--force]",
      "  cuthol skills check [--agent <id>[,<id>]] [--dir <skills-dir>]",
      "  cuthol skills remove [--agent <id>[,<id>]] [--dir <skills-dir>]",
      "  cuthol doctor [--json]",
      "  cuthol setup [--agent <id>[,<id>]] [--ffmpeg] [--apply] [--force]",
      "  cuthol mcp",
      "  cuthol live open [--no-window] [--dir <dir>]",
      "  cuthol live status [--dir <dir>]",
      "  cuthol live wait [--timeout <sec>] [--dir <dir>]",
      "  cuthol live config [--mode ask|on|off] [--global] [--dir <dir>]",
      "  cuthol live stop [--dir <dir>]",
      "  cuthol settings [list | get <key> | set <key> <value> | reset <key>] [--dir <dir>]",
      "  cuthol guide [--topic <name>]",
      "",
      "Global output flags: [--compact | --format text|json]",
];

/**
 * `cuthol <group> --help` (or `<group> <action> --help`) prints only that
 * group/action's usage lines and exits 0: the existing global text filtered,
 * no new hand-written text.
 */
export function printHelp(group?: string, action?: string): void {
  if (!group || group === "help") {
    console.log(HELP_LINES.join("\n"));
    return;
  }
  const needle = `cuthol ${group}`;
  const kept = HELP_LINES.filter(
    (l) =>
      l.includes(needle) &&
      (!action || l.includes(` ${action}`) || l.includes(`cuthol ${group} [`))
  );
  console.log([...HELP_LINES.slice(0, 3), ...kept, "", ...HELP_LINES.slice(-1)].join("\n"));
}

/**
 * `cuthol guide [--topic <name>]`: the same content as the MCP `guide` tool
 * (same resolution function), printed as text. Unknown topics are an error.
 */
export function runGuideCommand(
  workspaceDir: string,
  flags: Record<string, string | boolean>
): void {
  const topic = strFlag(flags, "topic") ?? "cuthol";
  const shared = getGuideText(topic, workspaceDir);
  if (!shared.ok) throw new CutholError(DIAGNOSTICS.GUIDE_TOPIC_UNKNOWN(topic));
  console.log(shared.text);
}
