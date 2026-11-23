/**
 * npm's `util` (the package Node's code on npm requires as `util/`: assert, readable-stream) with Node's own `inspect`
 * (node-inspect-extracted, as almostnode's util built-in has it) in place of the package's. Node's assert renders what it
 * compares with Node's inspect, whose output budget stops a rendering that would grow without end (unenv-resolve.ts,
 * BROWSER_INSPECT_BUDGET in a browser); npm's has none, so an assertion between two global objects ran the debug worker
 * out of memory, and its page with it (2026-11-23). Not almostnode's util built-in itself: that takes its deep equality
 * from assert, which takes this.
 */
export * from "util/util.js";
export { inspect } from "node-inspect-extracted";
