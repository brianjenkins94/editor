// @brianjenkins94/bablr — the bablr parse surface (`cstSpans`), bundled with @bablr/record's validation
// neutralized at build time (see ../build.mjs). Consumers get the fast runtime with no post-install patching.
//
// Input is assumed pre-validated: astral/empty edge cases are the caller's responsibility (rejected before
// they reach bablr), which is why we no longer carry the astral/empty-root patches.
export { cstSpans } from "../../bablr-language-ts/lib/spans";
// classifyChange(before, after): "cosmetic" | "semantic" | "unparsable" — a structural (not text) diff verdict, so
// reformatting/comment edits read as cosmetic and meaning changes read as semantic. See ../../bablr-language-ts/lib/cosmetic.
// classifyChangeAsync: same verdict, but PACED (yields the BABLR VM) and cooperatively cancellable via an
// AbortSignal — for callers that classify large files off a hot path and want to bail if the reviewer moves on.
export { classifyChange, classifyChangeAsync } from "../../bablr-language-ts/lib/cosmetic";
// stable CST-node identity (the xit/Pijul model, diff-derived): reidentify carries node ids across edits so data can
// be pinned to a line/node as it moves — the basis for .bablr sidecars. See ../../bablr-language-ts/lib/identity.
export { nodeAtoms, reidentify, reidentifyFromSource } from "../../bablr-language-ts/lib/identity";
