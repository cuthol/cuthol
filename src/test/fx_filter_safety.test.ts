/**
 * Per-clip fx chain safety: extension `video_filter` templates reject the same
 * banned filters and file-reading options as raw chains, and a raw chain with
 * several filters gets an accurate converter before every filter (not just the
 * first), so no filter runs behind ffmpeg's inexact auto-inserted converter.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildSpineClipFxFilters, SPINE_FX_ENTRY_CONVERTER } from "../compositor/compile_spine_fx.js";
import type { VideoGraphCompileContext } from "../compositor/compiler.js";
import type { CutholSequence } from "../core/schema.js";
import { parseManifestFxSection } from "../extensions/ext_fx.js";

function fakeClip(over: Partial<CutholSequence["spine"]["clips"][number]>): CutholSequence["spine"]["clips"][number] {
  return {
    id: "sp_01",
    placement: { x_pct: 0, y_pct: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1, fit_mode: "fill", crop: null, mirror_x: false, mirror_y: false },
    envelopes: [],
    ...over,
  } as CutholSequence["spine"]["clips"][number];
}

const CTX = {} as VideoGraphCompileContext;
const P = {
  asset: {} as never,
  absAssetPath: "",
  clipColorSpec: {} as never,
  targetW: 854,
  targetH: 480,
  receivedPixFmt: "yuv420p",
};
const CONV = SPINE_FX_ENTRY_CONVERTER;
const EXIT = `${CONV}:out_range=tv,format=yuv420p`;

function rawFilters(chain: string): string[] {
  return buildSpineClipFxFilters(CTX, {
    ...P,
    clip: fakeClip({ fx: [{ id: "fx_01", kind: "ffmpeg", params: { filter: chain } }] }),
  });
}

test("extension templates with a banned filter or a file option fail to load", () => {
  assert.throws(
    () => parseManifestFxSection({ evil: { params: {}, video_filter: "movie=filename=x.mp4" } }, "demo"),
    /'fx\.evil\.video_filter'.*'movie'/,
  );
  assert.throws(
    () => parseManifestFxSection({ lut: { params: {}, video_filter: "eq=brightness=0,lut3d=file=x.cube" } }, "demo"),
    /'fx\.lut\.video_filter'.*'file='.*'lut3d'/,
  );
  assert.throws(
    () => parseManifestFxSection({ evil: { params: {}, video_filter: "sendcmd=c=cmd" } }, "demo"),
    /'fx\.evil\.video_filter'.*'sendcmd'/,
  );
  // Placeholders sit in value position: ordinary templates still load.
  const ok = parseManifestFxSection(
    { soft: { params: { sigma: { type: "number", default: 4 } }, video_filter: "gblur=sigma={{sigma}}" } },
    "demo",
  );
  assert.equal(ok?.soft.video_filter, "gblur=sigma={{sigma}}");
});

test("a raw chain gets an accurate converter before every filter", () => {
  assert.deepEqual(rawFilters("eq=brightness=0,rgbashift=rh=0:bh=0"), [CONV, "eq=brightness=0", CONV, "rgbashift=rh=0:bh=0", EXIT]);
  assert.deepEqual(rawFilters("gblur=sigma=3"), [CONV, "gblur=sigma=3", EXIT]);
});

test("commas inside quotes or escaped do not split the chain", () => {
  const chain = "eq=brightness='if(gt(t,1),0.1,0)'";
  assert.deepEqual(rawFilters(chain), [CONV, chain, EXIT]);
  const escaped = "eq=brightness=0\\,hue=h=0";
  assert.deepEqual(rawFilters(escaped), [CONV, escaped, EXIT]);
});
