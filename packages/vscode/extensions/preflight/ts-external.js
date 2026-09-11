/**
 * External-`typescript` shim for the PLUGIN engine build (engine.plugin.config.ts aliases `typescript` here).
 *
 * The preflight engine runs inside the tsserver plugin, which already has the full `typescript` loaded — so
 * rather than bundle our own ~7MB copy, the plugin sets `globalThis.__preflightTs = modules.typescript` (see
 * ts-plugin.js) BEFORE importing the engine, and every `import ts from "typescript"` in the analysis chain
 * resolves here to that same instance. In Node (tests) `typescript` isn't aliased and resolves from
 * node_modules — so the one source works in both environments.
 */
export default globalThis.__preflightTs;
