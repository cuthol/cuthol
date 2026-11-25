# Changelog

## 0.4.0 — 2026-11-25

An effect stage for agents, much faster commands, a short explanation for every diagnostic, and a choice of local speech engine.

### Added
- **Effects on clips and cues** (`cuthol spine fx catalog|add|set|remove|list`, MCP `spine`). One effect stage per spine clip and lane cue (footage, compositions, plain text), with keyframes on any parameter (`spine envelope`, `spine envelope point add|move|remove`, beat-snapped points) and `spine value` to read the resolved value at any time.
  - **Masks** (`spine mask`: rect, ellipse, split; feather, invert) and **motion blur** (`spine motion-blur`, shutter angle, sub-frames).
  - **Motion layers:** push-ins, punches and drifts stack on top of a clip's placement; motion presets anchor to the clip.
  - **GLSL shader effects** on spine clips, rendered in a pre-pass and shown live in Cuthol Live through the same `.glsl` file; intermediates have a per-project disk cap (`render.shader_cache_cap_gb`, default 2 GB).
  - **Checked before render:** `spine fx try` renders a picture grid of an effect, `spine fx check --full` runs the delivery check; every effect is run once before it can fail a render. Extensions can add effects (`extension fx-new`) and transitions.
- **`cuthol explain <code|topic>`**: a short record per diagnostic (what happened, why, the next command). Diagnostics are specific, and repeats of the same cause collapse into one line with a count (all ids stay in the JSON).
- **Local speech engine choice:** `cuthol setup --local-speech --engine parakeet|whisper --apply` installs only the chosen engine; `speech transcribe --engine` picks one per call. Parakeet covers 25 European languages and is the default for them when installed; Whisper covers every language, including Turkish.
- **Stage:** free stage sizes (`workspace init --size 1080x1350`, `workspace stage --size|--aspect|--from <handle>`, with layout rescale) and **sequence tempo** (`workspace tempo --rate 0.5..2`, applied at output; render, monitor, Live and timeline export follow it).
- `workspace audio-fade --ms` (short fades at every spine join, 10 ms by default).
- `cuthol setup --ffmpeg [--apply]`: a pinned ffmpeg 8.1 build (sha256-verified, not bundled in the npm package), used when `PATH` has none or an older major; `CUTHOL_FFMPEG_DIR` overrides it.
- `render --profile` (per-composition capture time), `monitor frame|sheet --no-hud`, `brief --json --lens <name>`, `speech transcribe --keyterms`, JSON flags from files (`--params file:params.json`).
- Cuthol Live: notes from several frames in one packet, boundary and range notes, audio waveforms on music lanes, shader effects in the preview, the Motion row in the inspector.

### Changed
- **Much faster commands.** Text-only commands (`help`, `explain`, `--version`) answer in about 0.2 s instead of 1 s; `settings list` 744 → 155 ms; edits on a 30-composition project 20 → 3.3 s; `color clusters` 78 → 18 s; contact sheets capture compositions in parallel.
- **Cleaner filler cuts:** filler and repetition cuts are placed as a pair on quiet points around the spoken filler, so joins rarely keep speech-level sound at the cut edge and one-frame ASR fillers are actually removed; a filler that cannot be cut on quiet edges is no longer cut automatically but listed in `review_candidates` with the reason, for the agent to decide; the join-edge check (`CUTHOL-G740`) now counts loud joins, not loud edges.
- No default speech key terms: transcripts no longer receive "Cuthol"/"HyperFrames" unless you pass `--keyterms`.
- Skills are no longer installed automatically; `cuthol skills install --agent <id>` or `cuthol setup --agent <id> --apply` installs them, and commands print a hint when they are missing.
- Node.js ≥ 22.12 (was 22.5).
- Composition runtime gained a sequence clock (`C.seq`): every project's composition overlays render once again after the update.
- Composition scaffolds never overwrite edited files (`CUTHOL-G215`, `--force` writes as one undoable revision).

### Fixed
- **Windows MCP:** `cuthol-mcp` did not start on Windows; it now has its own entry (`dist/mcp_bin.js`) and `cuthol setup` writes a shell-free registration.
- **Audio/video sync:** sources whose audio stream starts after the file start (phones, cameras) played audio up to 176 ms early; sources whose video starts late now hold the first frame; `library detach-audio` keeps the offset. Projects ingested before this release keep the old timing until the file is re-ingested.
- Rotated clips no longer leave stale pixels in the corners; neutral effects keep the clip's pixels; JPG stills and video react the same to YUV filters.
- Windowed renders with text layers could hang at the end.
- Silent no-ops now report a diagnostic (envelope on a missing effect, `spine split` outside the clip, captions without a transcript).
- Parakeet transcripts no longer skip whole stretches of speech: word-less speech gaps are decoded again in one extra pass (fewer missing caption words and false "missing words" in `speech verify-cleanup`). Local transcripts are re-made once after the update (cache revision bump).
- Parakeet transcription of long recordings (about 25 minutes and more, or on a busy machine) no longer fails on a fixed 290 s limit; the limit scales with the audio, and a timeout reports itself as one.
- `cuthol doctor` and other status commands no longer write HyperFrames' first-run files into the home folder.
- **npm installs:** local Parakeet could not find HyperFrames when npm hoisted it (`CUTHOL-G239 Cannot find module`); `cuthol setup --local-speech` now reports a missing HyperFrames CLI instead of "nothing to do". Local Parakeet without `--lang` asks for one (`CUTHOL-G213`) with the supported languages and the Whisper option.
- **Transcripts:** a whole sentence could still go missing in long recordings (the dropped-gap retry now tries once more when it comes back empty); English words were lowercased with Turkish rules ("I" → "ı"); words stretched over a silence hid the pause from `speech cleanup` (word ends now follow the audio); with an explicit `--provider local` the transcript cache never hit.
- **Captions:** editing an active-word caption's text (`lane update-cue --text`, `cue apply`) now updates the highlighted words; hand-edited captions survive a `speech captions` re-run without `--replace`.
- **Mix:** `mix normalize` keeps a manually set voiceover/clip gain as an offset instead of overwriting it; renders warn when the delivered file peaks above the true-peak ceiling.
- **Render:** a render whose audio is digitally silent where the sources have sound now fails (`CUTHOL-G790`) instead of passing with a warning; a stalled encode is stopped after 90 s without progress (was 300 s) with the frame it stopped at, and the progress line no longer repeats or claims completion; the post-render audio gap scan no longer re-decodes the file from the start for every gap.
- **Contact sheets:** `monitor sheet` reuses the render overlay cache instead of starting a browser per composition (12 cells about 5× faster when overlays are cached).
- **Cuthol Live:** deleting and re-copying a composition folder no longer starts an endless reload loop; audio-only spine clips show a waveform instead of "Loading thumbnail…"; caption style changes show without a reload, and captions in the preview match the render's size, weight and outline.
- Help: `--z-index` orders cues within their lane (lanes stack by lane order); `spine append` accepts audio handles.
- Many smaller fixes in colour, timeline export, Live and help text.

### Known issues
- Many composition cues overlapping in time (for example 6–8 staggered full-frame overlays) can make ffmpeg 8.1 stop producing frames during the encode. Cuthol stops the step after 90 s without progress (`CUTHOL-SYS10`); use fewer composition cues at the same time or merge neighbouring compositions into one.

## 0.3.9 — 2026-11-14

Colour grading for agents, transparent and 4K masters, timeline export, and keyless speech.

### Added
- **Colour (`cuthol color`, MCP tool `color`).** Cuthol measures and describes colour; it never changes it by itself.
  - `color map` gives an agent a ~100-token text map of a clip or a reference image (tone percentiles and clipping, neutral axis, colourfulness, hue sectors, evidence), so it can grade without opening frames.
  - `color set` writes editable blocks in a fixed order (white balance, exposure, tone, curves, colour wheels, HSL secondaries, saturation/vibrance, Look) on spine clips and b-roll cues, and answers with a render-free prediction of the result and its side effects (for example a white wall turning pink).
  - `color solve` proposes blocks toward an objective target (another clip, a reference, exposure or white-balance limits) and prints the exact `color set` arguments; a before/after pair becomes an exact LUT for a named Look (`color look from-pair`).
  - `color compare` renders a variant sheet with the untouched picture first; `color diff`, `color clusters`, `color kind` (camera / screen recording / graphic) and `color migrate` (from the old `spine grade`) complete the set.
  - Every item's blocks compile to one 3D LUT, so the render, the Live preview and the prediction agree. Keyframed colour (`spine envelope --param color.exposure.stops` …), HDR (HLG/PQ) sources tone-mapped to SDR, technical verify gates (G130–G137) and a post-render colour check (G510/G512).
  - New agent skill `cuthol-color` with a word-to-block guide ("warmer", "crushed blacks", "teal shadows", "pink skin" …).
- **Cuthol Live: Effects tab.** Effects are listed next to Clip Info and Notes; Color opens over the right column with before/after, waveform, parade, vectorscope and histogram, and sliders that work while the agent is paused (the change reaches the agent like any other edit). The preview shows the grade exactly as it renders.
- **Render presets** `master_2160p` (UHD for every aspect) and `master_alpha` (ProRes 4444 with a real alpha channel for compositions over a transparent backdrop).
- **Timeline export** to other editors: `cuthol export timeline fcpxml|xmeml|edl|otio --out <file>` (Final Cut Pro, Premiere, DaVinci Resolve, OpenTimelineIO). Anything that cannot travel (compositions, captions) is listed, never dropped silently. Also `render.export_timeline` over MCP.
- **Keyless speech.** `cuthol setup --local-speech --apply` installs a private local engine (faster-whisper for transcription, Piper for voiceover) and `--provider local` uses it; `cuthol doctor` reports it.
- Ready-made HyperFrames registry blocks work on lanes (`npx hyperframes add <block>` inside a composition), documented in `cuthol-motion`.

### Changed
- `--provider local` without an installation or an explicit `CUTHOL_LOCAL_*_CMD` now fails with `CUTHOL-G237` and the setup command, instead of producing a placeholder tone.

## 0.3.7 — 2026-11-14

### Fixed
- `cuthol doctor` reported GSAP as missing (and exited with 1) when npm installed it in a parent `node_modules` — the usual layout for `npx cuthol` and for installing Cuthol inside a project. It now finds GSAP the same way the renderer does. Rendering was not affected.

## 0.3.6 — 2026-11-14

Getting started takes one install and two commands.

### Added
- **`cuthol setup`** registers the Cuthol MCP server with the agent tools on your machine: Claude Code (through the `claude` CLI), Codex, Cursor and Gemini CLI. It shows the plan first; `--apply` writes it, with a backup of every config file, other entries kept byte for byte, and a different existing `cuthol` entry replaced only with `--force`. Running it twice changes nothing.
- **`cuthol doctor`** checks Node.js, ffmpeg/ffprobe 8.x, a Chromium browser for motion graphics, HyperFrames and GSAP, the optional speech keys (presence only, never the value) and the installed agent skills, with a one-line fix for each problem. `--json` returns the checks as data; the exit code is 1 when a required tool is missing.
- **npm package.** The package now ships only what runs (about 1.3 MB packed), and HyperFrames and GSAP are found even when npm installs them in a parent `node_modules`. `npm install -g cuthol` and `npx cuthol` work without a clone.

### Fixed
- `lane add-cue` without `--duration` caps the default length (3 s) at the media left after the in-point, so a sound shorter than three seconds is accepted instead of failing with `CUTHOL-G202`. Longer media keep the 3 s default.
