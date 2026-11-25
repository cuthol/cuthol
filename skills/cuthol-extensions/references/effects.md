# Effect per-frame evaluation and `spine fx check`

## Per-frame options (`eval=frame` for `eq`)

An envelope on `fx.<id>.<param>` becomes a per-frame ffmpeg expression substituted
into the template — but only filters whose options accept expressions evaluate it
per frame. Most numeric filter options are read **once at init**: the envelope
run then renders a **constant** (equal to the constant-initial value), every gate
says OK, and only the picture is wrong. If the filter supports per-frame
evaluation, the template must turn it on (for `eq`, append `:eval=frame` to the
filter). `spine fx check` catches the frozen case at write time (CUTHOL-G324);
check the filter's docs for whether its options accept expressions.

## Placeholders and quotes

A `{{param}}` placeholder either sits **outside** single quotes (an envelope
becomes a quoted expression `'expr'`; a static value is escaped as before) or
**inside** a single-quoted region (an envelope becomes the bare `expr`; a
static value is escaped as before, but a value containing `'` is rejected).
Quoted `{{param}}` is required wherever the option value needs quotes (as in
transitions' `outgoing_filter`); an unterminated quote in the template is a
manifest error. Static values keep today's escaping inside quotes too: ffmpeg
parses twice (the graph level keeps `,` inside quotes; the option level still
splits on `:`), so a bare `:` inside quotes breaks the option list — escape it
(`\:`), while `\,` reaches the expression as `,`. Options of one filter are
separated by `:` (`eval=frame` included); `,` starts a new filter.

## `spine fx check`

`cuthol spine fx check --kind <kind> [--item <id>]` runs one item's fx stage (or
one kind definition: every param at min / default / max, every animatable param
with a min→max envelope, both alpha variants) on a generated card with a
sentinel filter, before any render. Failure policy: non-zero exit names the item,
fx id, kind and the offending filter/option (CUTHOL-G322, ERROR, blocks);
timeout (~10 s) or missing ffmpeg is WARN (CUTHOL-G320/G321), never blocking.
Results are cached under `.cuthol/fx_check_cache.json` (extension fx: definition
hash + which params carry envelopes + ffmpeg version; raw `--filter`: chain
text + ffmpeg version). Core kinds whose backend is not ffmpeg pass with a
"native backend" note. (Agent C placeholder kept: the try/full delivery check
section below.)

## `spine fx try` and `spine fx check --full`

`cuthol spine fx try --kind <kind> [--param k=v ...] [--sweep p=a..b[:n]]
[--at t1,t2,...] [--on card|<sp_XX>] [--out <png>]` renders one PNG grid
through a throw-away one-clip sandbox project (generated card, or a copy of one
item's source with `--on`; the user project is never written): rows are sweep
values (default 5), columns are times (default 3 spread over the card). The grid
layout (row -> value, column -> time) is in the JSON; no text is drawn into the
image. Output also carries per-frame cost at 1080p in ms (measured, not
estimated). Target: a 5x3 grid in <= 15 s on the 480p card. `try` works without
a project for the card; `--on <sp_XX>` needs one.

`cuthol spine fx check --kind <kind> --full` is the delivery check: the quick
check plus, through the sandbox, every card variant at default params (renders;
frame count and duration unchanged unless the manifest declares `temporal: true`
or the filter changes duration on purpose), alpha kept for `alpha: keep|process`,
neutral (all `neutral` values at once must reach Y PSNR >= 60 dB against no fx;
a lying `neutral` fails), the same effect twice in a row, every `animatable`
param with a 20-point Bezier envelope (`easing: "cubic_bezier"` plus a `bezier`
array, as `spine envelope` writes them), and per-frame cost at 1080p mapped to a
cost class (`light` < 2 ms, `medium` < 8 ms, `heavy` otherwise). A manifest
`cost_class` that contradicts the measurement is a WARN. Output: one table in
the JSON (variant x check -> ok/fail + number). Optional manifest fields:
per-param `neutral` (a finite number inside `params.<name>`), `temporal`
(boolean), `cost_class` (`light`/`medium`/`heavy`). They are validated at
manifest load and exposed on the resolved effect definition.

## Shader effects

A shader effect is a GLSL fragment shader run by Cuthol's own shader pass
(render and Live), declared as an `fx` entry with `"backend": "shader"` and
a `"shader"` file. It applies to **spine clips only**; on a lane cue the
write is refused and `verify` reports CUTHOL-G709.

File layout: the manifest entry names the `.glsl` file inside the extension
folder; the file carries the uniforms, each with its default in a trailing
`// = ...` comment and an optional `// @range(lo, hi)` line above:

```glsl shader-docs-example
precision highp float;
uniform float time;
uniform float ratio;
// @range(0, 1)
uniform float amount; // = 0.5
uniform vec2 center; // = (0.5, 0.5)
vec4 getInput(vec2 uv);
vec4 effect(vec2 uv) {
  vec4 px = getInput(uv);
  float d = distance(uv * vec2(ratio, 1.0), center * vec2(ratio, 1.0));
  float v = 1.0 - amount * smoothstep(0.2, 0.9, d);
  return vec4(px.rgb * v, px.a);
}
```

```json shader-docs-manifest
{
  "name": "shdemo",
  "version": "1.0.0",
  "description": "Shader docs example.",
  "fx": {
    "vignette": {
      "description": "Vignette darkening away from a center point.",
      "backend": "shader",
      "shader": "shaders/vignette.glsl"
    }
  }
}
```

Uniforms: `float` (also `int` and `bool`, exposed as numbers). `vec2` /
`vec3` / `vec4` (and `ivec*`, rounded) become per-component params
`<name>_x`, `<name>_y` (`_z`, `_w`) with the vector default split across
them, e.g. `center` above becomes `center_x` / `center_y` defaulting to
0.5 / 0.5. The `@range` line above a uniform sets the param's min/max.
Every param is animatable (uniforms are set per frame), including each
vector component. Reserved host uniforms `time` and `ratio` (canvas
width / height) are set by the runner and are never params; `effect` and
`getInput` are entry points, never params.

Colour and coordinate contract: shader inputs are gamma-encoded BT.709,
full-range float RGBA, straight (not premultiplied) alpha; shader outputs
are expected back in the same contract. `uv` runs 0..1 across the frame;
multiply x by `ratio` before taking distances so circles stay round.
An effect entry copies alpha itself (the shader pass is `process` for
assembly: the fx entry converter + `format=rgba` / `rgba64le` feeds the
pass, which the worker shades frame by frame).

`try` / `check`: `spine fx try --kind ext:<ext>/<name>` renders a sweep
grid through the real shader pass (sandbox pre-passes run first);
`spine fx check --kind <shader>` reads the browser compile cache written
by `extension enable` (file and line, no browser opens here); a content
hash with no cached result gets the static scan plus a WARN (CUTHOL-G711,
"not compiled yet, run extension enable"). `--full` renders every card
variant, the stacked and envelope rows through the sandbox like ffmpeg
kinds. A syntax error fails at `extension enable`, in `verify`, and in the
worker with file and line (CUTHOL-G710 at check time); an endless loop
ends in a per-frame timeout diagnostic (CUTHOL-G708), never a hang.
Missing `.glsl` file is CUTHOL-G112 at write time and in `verify`.
The sandbox skips the enable compile check (its cache would always be
empty): its render reports compile errors itself.

`extension enable` browser-compiles every shader fx of the extension in
one short-lived browser child and caches each result by content hash
before the sequence is touched, so a bad shader blocks the enable naming
file and line. `--dry-run` compiles too and reports the result without
writing (no cache, no enable). When no browser can start, the enable
still succeeds with a warning and only the static scan ran (check then
reports G711). Extensions without shader fx pay no compile cost.

Cost note: shader intermediates (`.cuthol/blobs/sh_fxshad_<key>.nut`)
are content-keyed and reused across renders. Shading runs one browser for
all shader pre-passes of a render (two pages pull frames over HTTP):
measured ~0.22 s per 1080p frame on SwiftShader (identity shader, 3-clip
1080p project: 100.4 s pre-pass for 450 frames + 8.2 s main graph).
A windowed compile (a `monitor frame`, a render segment, Live prewarm)
shades only the frames its window needs, with per-frame uniforms evaluated
at each frame's item-local time, so the main graph reads the intermediate
unchanged. Single-frame intermediates are named `sh_fxshad1_<clip>_<key>`
and only the latest per clip is kept. Measure with `try` (per-frame cost
at 1080p) before shipping a heavy shader. Disk cap: `render.shader_cache_cap_gb`
(default 2) deletes oldest-unused intermediates past the cap
(`cuthol settings set render.shader_cache_cap_gb <gb>`).

Enable and use:

```
cuthol extension enable shdemo
cuthol spine fx add --item <sp_XX> --kind ext:shdemo/vignette --param amount=0.5
cuthol spine envelope --item <sp_XX> --param fx.fx_01.amount --points '0ms:0,2s:0.8'
```

## Presets

A `presets.<name>` manifest entry is a keyframe template anchored to the
clip (not absolute times): one `motion` entry (or an extension motion kind
declaring `spine.channels`) plus `keys` (channel -> point list). Each point
is `{ at, value, easing?, bezier? }`; `at` is `"start"`, `"start+<ms>"`,
`"end"`, `"end-<ms>"`, `"<n>%"` (percent of the clip), or ms from the clip
start. `value` is a number or a small expression over the preset `params`
(numbers, param names, `rand(i)`, `+ - * / ( )`; no other names or calls;
`rand(i)` is deterministic, seeded by preset name + point index). `params`
are numbers with `default`/`min`/`max`. Optional `repeat: { every, pattern_ms }`
restarts the key pattern inside the clip: `every: "beat"` on every beat of
the grid given at apply time, `every: "<N>ms"` every N ms. In a repeated
pattern `at` is relative to the repetition start (`start[+<ms>]` or ms).

`cuthol spine fx preset --item <sp_XX> --preset ext:<ext>/<name>
[--param k=v ...] [--beats <aud_XX>]` writes one fx entry plus explicit
envelope points (item-local ms) and the entry's `preset` record in one
journal revision (the write-time fx checks run). Presets apply to spine
clips only (lane cues are an ERROR). Wrong input (unknown channel, a value
outside the target param's range, anchors that cross on a short clip,
`repeat: beat` without `--beats` or a beat grid) is an ERROR and nothing is
written. Over 150 points on one channel the apply prints a WARN with the
estimated extra render time (measured slope ~0.16 s per point per minute of
clip, two channels, at `draft_480p`; higher presets cost more). Long point
lists can also go through `spine envelope point add --points-file <json>`
(a JSON array of `{ at_ms | at, value, easing?, bezier? }`, one revision).

Complete manifest example (a `punch_out` preset with one `entries` item of
`kind: "motion"` and `keys` for `scale_x`/`scale_y` at `end-300ms`/`end`).
This manifest enables and applies as written:

```json preset-example
{
  "name": "punch",
  "version": "1.0.0",
  "description": "Punch-in preset example.",
  "presets": {
    "punch_out": {
      "description": "Punch in over the last 300 ms.",
      "params": {
        "amount": { "type": "number", "default": 1, "min": 0, "max": 2 }
      },
      "entries": [
        {
          "kind": "motion",
          "keys": {
            "scale_x": [
              { "at": "end-300ms", "value": 1 },
              { "at": "end", "value": "1+0.3*amount" }
            ],
            "scale_y": [
              { "at": "end-300ms", "value": 1 },
              { "at": "end", "value": "1+0.3*amount" }
            ]
          }
        }
      ]
    }
  }
}
```

Apply and reapply:

```
cuthol extension enable punch
cuthol spine fx preset --item <sp_XX> --preset ext:punch/punch_out --param amount=1
cuthol spine fx preset --item <sp_XX> --fx <fx_XX> --reapply
cuthol spine fx preset --item <sp_XX> --reapply --all
```

The record (`preset: { preset, version, args, apply_id, points, beats? }`)
stores every generated point with its anchor (`start`/`end`/`ratio`/`beat`).
`verify` recomputes the expected points from the record with the item's
current duration (and the current beat grid) and WARNs per drifted entry
(G369, "preset points no longer match their anchors" + what moved), with
`suggestion: cuthol spine fx preset --item <id> --fx <fx_id> --reapply`;
beat-anchored drifts on several entries collapse into one WARN suggesting
`--reapply --all` (one revision). Reapply overwrites hand edits (the WARN
says so). Splits and excisions drop the record on halves whose generated
points were sliced (those halves stay silent); trims keep it, so a trim
that cuts generated points warns. Hand-edited points warn too.
