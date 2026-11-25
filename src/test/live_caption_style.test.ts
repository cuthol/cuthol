/**
 * Live caption style: typography revisions re-draw, font matches renderer.
 * Fails on old builds (live_captions.ts did not exist; preview.js cached
 * captions by cue id only and used a bare `?? "Arial"` font fallback).
 */
import "./test_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  RENDERER_CAPTION_FONT_FALLBACK,
  captionStyleKey,
  resolveLiveCaptionFontFamily,
} from "../live/live_captions.js";

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "../..",
);

test("renderer fallback is Arial (read, not changed)", () => {
  assert.equal(RENDERER_CAPTION_FONT_FALLBACK, "Arial");
  const ass = fs.readFileSync(path.join(REPO, "src/compositor/ass_generator.ts"), "utf8");
  assert.ok(ass.includes('|| "Arial"'), "renderer still falls back to Arial");
});

test("live font pick mirrors the renderer", () => {
  assert.equal(resolveLiveCaptionFontFamily({ font_family: "Verdana" }), "Verdana");
  assert.equal(resolveLiveCaptionFontFamily({}), "Arial");
  assert.equal(resolveLiveCaptionFontFamily(null), "Arial");
  assert.equal(resolveLiveCaptionFontFamily({ font_family: "" }), "Arial");
  assert.equal(resolveLiveCaptionFontFamily({ font_family: "  " }), "Arial");
  assert.equal(resolveLiveCaptionFontFamily({ font_family: "a,b" }), "ab");
});

test("typography change alters the caption cache key", () => {
  const base = { font_family: "Arial", font_size_px: 42, font_weight: 800 };
  assert.notEqual(
    captionStyleKey(base),
    captionStyleKey({ ...base, font_family: "Verdana" }),
  );
  assert.notEqual(
    captionStyleKey(base),
    captionStyleKey({ ...base, font_size_px: 60 }),
  );
  assert.equal(captionStyleKey(base), captionStyleKey({ ...base }));
});

test("preview re-draws on typography-only revision without reload", () => {
  const src = fs.readFileSync(path.join(REPO, "src/live/ui/preview.js"), "utf8");
  const fn = src.slice(src.indexOf("function renderCaptions"));
  assert.ok(fn.length > 0, "renderCaptions exists");
  // Cache key carries a typography signature, not just cue id + word + size.
  assert.ok(fn.includes("typoSig"), "caption key includes typography signature");
  assert.ok(
    fn.includes("typo.font_family") && fn.includes("typo.font_size_px"),
    "signature covers font family and size",
  );
  // Font resolution sanitizes like the renderer (commas stripped, Arial fallback).
  assert.ok(src.includes('replace(/,/g, "")'), "font pick strips commas like the renderer");
});
