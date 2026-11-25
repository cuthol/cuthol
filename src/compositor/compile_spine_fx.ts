// Spine clip fx entry points, kept for existing importers and tests.
// The implementation moved to `./compile_fx_stage.js` (one stage shared by spine clips
// and lane cues); this module only re-exports the old names.
export {
  SPINE_FX_ENTRY_CONVERTER,
  SPINE_FX_RGBA_EXIT,
  BUILTIN_FX_KIND,
  checkBuiltinFxFilterChain,
  resolveFxParams,
  formatFxParamValue,
  spineFxReceivedPixFmt,
  spineClipNeedsFxCheck,
  buildSpineClipFxFilters,
} from "./compile_fx_stage.js";
