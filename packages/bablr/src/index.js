// @brianjenkins94/bablr — the bablr parse surface (`cstSpans`), bundled with @bablr/record's validation
// neutralized at build time (see ../build.mjs). Consumers get the fast runtime with no post-install patching.
//
// Input is assumed pre-validated: astral/empty edge cases are the caller's responsibility (rejected before
// they reach bablr), which is why we no longer carry the astral/empty-root patches.
export { cstSpans, cstSpansAsync } from "../../bablr-language-ts/lib/spans";
// What the parse depends on — the grammar, the span walk and BABLR's own packages — hashed when this bundle is built
// (vite.config.ts), so a cache of parses can tell its entries are stale. "dev" when loaded from source.
// eslint-disable-next-line no-undef -- a build-time define
export const PARSE_VERSION = typeof __BABLR_PARSE_VERSION__ === "undefined" ? "dev" : __BABLR_PARSE_VERSION__;
// classifyChange(before, after): "cosmetic" | "semantic" | "unparsable" — a structural (not text) diff verdict, so
// reformatting/comment edits read as cosmetic and meaning changes read as semantic. See ../../bablr-language-ts/lib/cosmetic.
// classifyChangeAsync: same verdict, but PACED (yields the BABLR VM) and cooperatively cancellable via an
// AbortSignal — for callers that classify large files off a hot path and want to bail if the reviewer moves on.
export { classifyChange, classifyChangeAsync } from "../../bablr-language-ts/lib/cosmetic";
// stable CST-node identity (the xit/Pijul model, diff-derived): reidentify carries node ids across edits so data can
// be pinned to a line/node as it moves — the basis for .bablr sidecars. See ../../bablr-language-ts/lib/identity.
// fileDiffIdentity produces the .bablr snapshot for a HEAD→working change (working nodes with anchored ids), the
// changed-node set, and the whole-file verdict (identity-derived) — the cosmetic classifier, restated over identity.
export { nodeAtoms, reidentify, reidentifyFromSource, fileDiffIdentity, fileDiffIdentityAsync } from "../../bablr-language-ts/lib/identity";
// follow: where a node of one version is in another, by that same diff (kept, or replaced by an edit that changed it) —
// how a span whose id changed is found again; atomsOf: the diff's nodes from a parse the caller already has.
export { atomsOf, follow } from "../../bablr-language-ts/lib/identity";
// Content-addressed, move-stable span ids (the durable anchor annotations attach to). See ../../bablr-language-ts/lib/anchors.
export { spanAnchors } from "../../bablr-language-ts/lib/anchors";
// The anchor that best stands for a range another parser found (TypeScript's statements, say), among a file's anchors.
export { pickAnchor } from "../../bablr-language-ts/lib/anchors";
// HEAD→working (or baseline→current) identity over a content chain + the "your edits" node-grouped chunks. No
// commit-chain CDC (removed — see history-identity.ts / [[collab-identity-durability]]).
export { deriveIdentityAsync, editGroups } from "../../bablr-language-ts/lib/history-identity";
