/**
 * External-`typescript` shim for the history engine build (build.ts aliases `typescript` here): the engine runs inside
 * the TypeScript server, whose plugin (ts-plugin.js) sets `globalThis.__historyTs = modules.typescript` before importing
 * it — so nothing bundles a copy. CommonJS on purpose, as capabilities' is: a default import gets `module.exports`.
 */
module.exports = globalThis.__historyTs;
