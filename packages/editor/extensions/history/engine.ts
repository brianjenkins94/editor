/**
 * The history plugin's engine (lsp/history-engine.js): util/silo's reading over TypeScript's tree — a file's ways in and
 * its part of the declaration graph — for the plugin to run with the TypeScript server's own `ts` (classicHost). Built
 * with `typescript` external (ts-external.js), and without oxc: ts-analysis loads only silo's pure model and graph.
 */
export { analyzeFile, classicHost, stale } from "@brianjenkins94/util/silo/ts-analysis";
