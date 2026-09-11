import { engineConfig } from "./engine.config";

/**
 * The PLUGIN engine build (extensions/preflight/engine.ts → dist/preflight/engine.plugin.js) — the same engine,
 * but with `typescript` externalized to the ts-external shim so it uses tsserver's already-loaded `ts` instead
 * of bundling its own ~7MB copy (route 3 B). Loaded INSIDE the tsserver plugin, which sets
 * `globalThis.__preflightTs` before importing it. Runs after engine.config.ts (emptyOutDir stays false).
 */
export default engineConfig({ "entryName": "preflight/engine.plugin", "typescriptExternal": true });
