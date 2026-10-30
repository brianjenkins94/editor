/**
 * The history plugin's engine (history-engine.js, beside the plugin in the extension's folder): util/silo's reading over TypeScript's tree — a file's ways in and
 * its part of the declaration graph — for the plugin to run with the TypeScript server's own `ts` (classicHost). Built
 * with `typescript` external (ts-external.js), and without oxc: ts-analysis loads only silo's pure model and graph. And
 * patterns.ts's structural search, over the same trees.
 */
export { analyzeFile, classicHost, stale } from "@brianjenkins94/util/silo/ts-analysis";
// (structural search and rewrite on TypeScript's tree: agents' code_query / code_rewrite, `_history.query`)
export { matchPattern, patternNode, rewrites } from "./patterns";
