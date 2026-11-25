# Effects: transform, grade, fx, transitions, envelopes, reframe

## Static placement and edges (`spine.transform`)

`transform(clip, x, y, scale, scale_x, scale_y, rotation, opacity, fit,
mirror_x, mirror_y, edge)` — all values absolute (`"1.2"`) or relative
(`"+=0.1"`, `"-=5"`). `fit`: `cover` (fill, crop), `contain` (letterbox),
`fill` (stretch). `edge`: `transparent` (default, layer below shows), `mirror`
(reflected copy fills the uncovered area), `clamp` (stretched edge pixels);
spine clips only (G121 on lane cues). A clip that already covers the stage and
never moves makes any edge mode a no-op (G412).

## Colour (`spine.grade`)

`grade(clip, brightness?, contrast?, saturation?, temperature?, lut?)` —
constant grade of a spine clip. `brightness` −1..1 (default 0),
`contrast`/`saturation` multipliers (default 1), `temperature` white balance
1000..40000 K (default 6500 = neutral, no filter; out of range is G124), `lut`
a project-relative `.cube`/`.3dl` file applied last (`'none'` clears;
missing/unreadable/outside-project is G414 and blocks render). A keyframed
brightness/contrast/saturation envelope (CLI `cuthol spine envelope --param
treatments.color_grade.*`) overrides the matching constant in the render.

## Effect catalog (`spine.fx_catalog`)

`fx_catalog()` — every available effect on one line:
`kind role=<clip|transition> backend=<ffmpeg|shader|spine> live=<native|server>
animatable=[...] params={name:type[min..max]=default,...}`. Builtins: transitions
`dissolve`, `fade`, `wipe_left`, `wipe_right`, `slide_up`, `zoom_in` and the raw
`ffmpeg` chain (`params.filter`); plus each enabled extension's `fx` and
`transitions` (`ext:<ext>/<name>` with manifest params/`animatable`).

## Per-clip effects (`spine.fx`)

`fx_add(clip, kind|filter, params?)` / `fx_set(clip, fx, params?|filter?)` /
`fx_remove(clip, fx)` / `fx_list(clip)` — a chain compiled in the clip's own
filter graph after colour (source asset untouched, transcript bindings stay).
`kind="ext:<ext>/<fx>"` (enable the extension first) or raw
`filter="gblur=sigma=3"` (no `[` `]` `;`, no file-reading/command filters).
Params merge on set; ids are `fx_XX` per clip. Animate only manifest-declared
`animatable` params via `envelope(clip, param="fx.<id>.<param>", ...)` —
any other envelope is refused at write time with nothing written (no such fx
on the item: G380 with the item's fx ids; not an `animatable` param: G381 with
the effect's `animatable` list; G119 otherwise). Unknown kinds/params are
G118, drifted extensions warn G411. An envelope on a disabled entry stays
dormant (accepted, no effect); orphaned envelopes from older builds warn G382
in `verify`.
`fx_set(clip, fx, enabled=false)` disables an entry without removing it
(`true` re-enables); `fx_list` groups `motion` layers separately.

## Motion layers (`kind="motion"`)

A `motion` fx entry is not a pixel effect: it is a placement layer on the same
item (spine clip or lane cue). Add one per moving part, animate it with points
on `fx.<id>.<channel>`, stack two or more; list order is the combine order.
Channels: `x_pct`, `y_pct`, `scale_x`, `scale_y`, `rotation_deg`, `opacity`.
`x_pct`/`y_pct`/`rotation_deg` add onto the base (and onto each other);
`scale_x`/`scale_y`/`opacity` multiply; combined opacity clamps to `[0, 1]`.
Params hold the static layer value (additive channels default 0,
multiplicative default 1); a `fx.<id>.<channel>` envelope overrides the static
value while it has points. `spine.transform` stays the base; layers never touch
the source asset.

Verify warns (never blocks): combined opacity above 1 is G288 (it is clamped);
a combined `scale_x`/`scale_y` range crossing or touching 0 is G289.

Read the result: `value(item, param="placement.<channel>", at)` returns the
effective value plus its breakdown (base value and each layer's value at that
time; the terms combine to the effective value by the rule above);
`value(item, param="fx.<id>.<channel>", at)` returns that layer's own value.
The `brief` canvas lens shows the combined static values with a
`motion: fx_02(scale_x, opacity), fx_03(x_pct~)` note (`~` = animated);
`fx_list` shows the same grouping.

Worked example — slow zoom plus a beat punch on one clip (8 s, 30 fps,
punch at 3.2 s):

```
cuthol spine fx add --item sp_01 --kind motion --param scale_x=1 --param scale_y=1
cuthol spine envelope --item sp_01 --param fx.fx_02.scale_x --points "0ms:1.0,8000ms:1.15" --easing ease_in_out
cuthol spine envelope --item sp_01 --param fx.fx_02.scale_y --points "0ms:1.0,8000ms:1.15" --easing ease_in_out
cuthol spine fx add --item sp_01 --kind motion --param scale_x=1 --param scale_y=1
cuthol spine envelope point add --item sp_01 --param fx.fx_03.scale_x --at 0ms --value 1.0
cuthol spine envelope point add --item sp_01 --param fx.fx_03.scale_y --at 0ms --value 1.0
cuthol spine envelope point add --item sp_01 --param fx.fx_03.scale_x --at 3200ms --value 1.08
cuthol spine envelope point add --item sp_01 --param fx.fx_03.scale_y --at 3200ms --value 1.08
cuthol spine envelope point add --item sp_01 --param fx.fx_03.scale_x --at 3233ms --value 1.0
cuthol spine envelope point add --item sp_01 --param fx.fx_03.scale_y --at 3233ms --value 1.0
cuthol spine value --item sp_01 --param placement.scale_x --at 0ms
cuthol spine value --item sp_01 --param placement.scale_x --at 3200ms
cuthol spine value --item sp_01 --param placement.scale_x --at 8000ms
```

The zoom layer multiplies the base scale by 1.0 → 1.15; the punch layer
multiplies by 1.0 except one frame of 1.08 at the beat (the leading 0 ms
point matters: envelope evaluation holds the first point value before it, so
without it the punch would read 1.08 from the start). The 3200 ms readout is
`zoom(3200ms) x 1.08` and the other two are the zoom value alone.

## Transitions (`spine.transition`)

`transition(clip, kind, duration, easing, params?)` — outgoing transition into
the next clip. Builtins: `dissolve`, `fade`, `wipe_left`, `wipe_right`,
`slide_up`, `zoom_in`, `none`; or an extension transition
`ext:<extension>/<name>` (see `cuthol-extensions`, manifest `transitions`
section). Extension transitions take `params` (`{"name": value}`; CLI
`--param name=value,...`); builtins take none (G123). Duration ≤ half of the
shorter neighbouring clip (G303, also for `ext:`). Unknown/disabled `ext:`
kinds are G122 (edits and render refuse); `cubic_bezier` easing on `ext:` takes
control points (CLI `--easing "cubic-bezier(x1,y1,x2,y2)"`; bad curves are
G120). The blend happens after the cut point (it overlaps the start of the
next clip). Transitions are video-only: spine audio hard-cuts at the boundary.

## Keyframe envelopes (`spine.envelope`)

`envelope(clip, param, points=["0ms:1.0","4s:1.15"], easing, bezier?)` —
keyframes over the item's own time (0 = its start), on spine clips and lane
cues. Params: `placement.x_pct`, `placement.y_pct`, `placement.scale_x`,
`placement.scale_y`, `placement.rotation_deg`, `placement.opacity`,
`audio_chain.gain_db`, `treatments.color_grade.brightness|contrast|saturation`,
`fx.<id>.<param>` (animatable only). A slow zoom needs both `scale_x` and
`scale_y` (compiled with sub-pixel interpolation, so slow ramps advance
smoothly without stepping or aspect wobble).

`easing`: `linear`, `ease_in`, `ease_out`, `ease_in_out`, `hold` (step: previous
value until the keyframe, jumps at it; envelopes only, G120 in transitions), or
CSS `cubic-bezier(x1,y1,x2,y2)` (CLI: `--easing "cubic-bezier(0.25,0.1,0.25,1)"`;
MCP: `bezier="0.25,0.1,0.25,1"`; x1,x2 in 0..1, else G120). Invalid curves are
rejected at input and by verify.

Envelope uses beyond motion: duck a music hit with a short `audio_chain.gain_db`
dip, dip to black with an `opacity` envelope, cut music instantly with a 50 ms
gain drop, punch in with two scale points 1 frame apart.

## Single keyframes (`spine.envelope_point_add|move|remove`)

`envelope_point_add(clip, param, at, value?, sequence_time?, beat?, beats_of?, easing?)`
— one keyframe at a time (same validation as `envelope`: unknown params G140,
times within the item G305); adding at an existing time replaces that point.
`envelope_point_move(clip, param, at|from, to, value?)` moves one point;
`envelope_point_remove(clip, param, at)` deletes one point (last point removes
the envelope entry). `--at` is item-local by default; `--sequence-time` takes
timeline time (stage tempo included); `--beat <n> --beats-of <aud_XX>` takes a
beat from that asset's cached grid (no grid: G170; unplaced: G171; placed twice:
G172). Example: `cuthol spine envelope point add --clip sp_01 --param
placement.opacity --at 500ms --value 0.5`.

## Value at t (`spine.value`)

`value(item, param, at, sequence_time?)` — render-free value at a time:
placement params through the placement resolver, other envelopes through the
envelope evaluator, else the static field or fx param (`source: envelope |
static`). Example: `cuthol spine value --item sp_01 --param placement.opacity
--at 500ms`.

## Reframe (`spine.reframe`)

When wider footage (e.g. 16:9) is placed on a narrower stage (e.g. 9:16, where
`asset_aspect / stage_aspect > 1.03`), the default centre crop (`fit="cover"`,
`x=0`) shows roughly the middle third and can cut off a subject standing left
or right. Call `spine(action="reframe", clip="sp_01")` (or omit `clip` / pass
`all_spine=true` for all spine clips). On a `16:9` stage (or when the subject
stays centred within `deadband`) it leaves `scale_x=1, x_pct=0` and writes zero
unnecessary pan keyframes.

What it writes: `placement.fit_mode="cover"`, `placement.scale_x =
asset_aspect / stage_aspect` (`scale_y=1`), `treatments.reframe`
(`focal_points`), and a smooth `placement.x_pct` envelope (`ease_in_out` ramps
between stationary plateaus controlled by hysteresis `deadband`, default
`3.2`%). Later `spine.split`, `spine.excise` and `spine.speed` edits slice and
rescale both focal points and the envelope.

Modes: `mode="subject_track"` (default, automatic horizontal tracking),
`mode="center_lock"` (static crop at `x`, 0..100 in source width, default 50),
`mode="off"` (reset). Manual points (`points=["0ms:50", "40s:64"]`,
`offset:center_x_pct` with 0 = left edge, 100 = right edge) patch the auto
track within ±1.2 s with `replace=false` (default), or rebuild the envelope
from points alone with `replace=true`.

Limits: no neural detector — tracking uses a deterministic low-resolution
signal pipeline (skin-cluster + head silhouette, foreground motion,
border-contrast saliency) at 160 px wide @ 4 fps (8 fps for clips ≤ 4 s). It
assumes a **single primary subject**; multiple people, skin-coloured clutter or
heavy lighting shifts can pull the crop. Check `mean_confidence`,
`min_confidence` and `low_confidence_ranges_ms`, look at frames with
`monitor.frame` (especially around pan transitions), and pin bad spans with
`points` / `replace=true` / `mode="center_lock"`. Reframing is horizontal only.
