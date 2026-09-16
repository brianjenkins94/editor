// @brianjenkins94/bablr — the bablr parse surface (`cstSpans`), bundled with @bablr/record's validation
// neutralized at build time (see ../build.mjs). Consumers get the fast runtime with no post-install patching.
//
// Input is assumed pre-validated: astral/empty edge cases are the caller's responsibility (rejected before
// they reach bablr), which is why we no longer carry the astral/empty-root patches.
export { cstSpans } from "../../bablr-language-ts/lib/spans";
// classifyChange(before, after): "cosmetic" | "semantic" | "unparsable" — a structural (not text) diff verdict, so
// reformatting/comment edits read as cosmetic and meaning changes read as semantic. See ../../bablr-language-ts/lib/cosmetic.
export { classifyChange } from "../../bablr-language-ts/lib/cosmetic";
