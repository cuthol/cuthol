# Treatments: mask and motion blur (spine clips)

Both render on spine clips (`verify` stays silent: no G409). They apply in the
clip's own frame, before placement, so they move with the clip.

## Mask (`spine.mask`)

`mask(clip, shape?, center_x?, center_y?, width?, height?, feather?,
invert?, clear?)` — multiplies the clip's alpha, so the layer below (or the
backdrop) shows through outside the mask. `shape`: `rect` (axis-aligned box),
`ellipse`, `split` (vertical half-plane through the center: the left side is
kept, the right side cut; `invert` swaps). Center/size are percent of the clip
frame (`50` = middle). `feather` is a soft edge in pixels at render size
(`0` = hard). `invert` keeps the outside instead of the inside. `clear`
removes the mask. Partial edits keep the other fields (e.g. `--shape`
alone); ranges outside the CLI help are rejected (G180).

Animate `center_x_pct`, `center_y_pct`, `width_pct`, `height_pct`,
`feather_px` with `envelope(clip, param="treatments.mask.<field>", ...)`
(clip-local ms offsets, same as placement envelopes).

Example: `cuthol spine mask --clip sp_04 --shape ellipse --center-x 50
--center-y 50 --width 60 --height 60 --feather 12`

Cost: hard `rect`/`split` masks (no feather) render at ~1.1x plain speed.
Soft or shaped masks evaluate per pixel: ~18x a 1080p segment on the test
machine, so prefer hard masks for long masters.

## Motion blur (`spine(action="motion_blur")`, CLI `spine motion-blur`)

`motion_blur(clip, shutter?, subframes?, off?)` — a shutter over source
frames: `tmix` blends the current frame with the previous `subframes - 1`
source frames; `shutter` (0..360 deg) scales the past frames' contribution
from sharp (`0`) to uniform (`360`). `off` disables. Ranges outside the CLI
help are rejected (G181).

Example: `cuthol spine motion-blur --clip sp_02 --shutter 180 --subframes 4`

Limits: frame count and A/V timing never change (the blend keeps every
frame; audio untouched). Blur caused only by placement envelopes — a still
image panned by keyframes — is NOT covered: the source frames are identical,
so a source-frame blend is a no-op. That would need a post-placement temporal
blend and is out of scope.
