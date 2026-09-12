/**
 * Rollup shim - Uses @rollup/browser for browser-compatible Rollup
 *
 * Vite uses Rollup for bundling. The native Rollup package doesn't work
 * in browsers, so we need to use @rollup/browser instead.
 */

import { ROLLUP_BROWSER_CDN, ROLLUP_BROWSER_VERSION } from '../config/cdn';

// Rollup instance loaded from CDN
let rollupInstance: unknown = null;
let loadPromise: Promise<unknown> | null = null;

/**
 * Load Rollup from CDN
 */
async function loadRollup(): Promise<unknown> {
  if (rollupInstance) return rollupInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      // Load @rollup/browser from CDN
      const rollup = await import(
        /* @vite-ignore */
        ROLLUP_BROWSER_CDN
      );
      rollupInstance = rollup;
      console.log('[rollup] Browser version loaded');
      return rollup;
    } catch (error) {
      console.error('[rollup] Failed to load browser version:', error);
      loadPromise = null;
      throw error;
    }
  })();

  return loadPromise;
}

// For synchronous require(), we need a stub that works before async load
// This will be replaced when loadRollup() is called

export const VERSION = ROLLUP_BROWSER_VERSION;

export async function rollup(options: unknown): Promise<unknown> {
  const r = await loadRollup() as { rollup: (options: unknown) => Promise<unknown> };
  return r.rollup(options);
}

export async function watch(options: unknown): Promise<unknown> {
  const r = await loadRollup() as { watch: (options: unknown) => unknown };
  return r.watch(options);
}

// Export a function to pre-load rollup
export { loadRollup };

// Define plugin context types that Vite expects
export interface Plugin {
  name: string;
  [key: string]: unknown;
}

export interface PluginContext {
  meta: { rollupVersion: string };
  parse: (code: string) => unknown;
  [key: string]: unknown;
}

// parseAst/parseAstAsync — Rollup's public parser, which real Vite imports from `rollup` for its ESM
// import-analysis. It must return an ESTree AST, which the TypeScript AST the rest of almostnode now parses
// with is NOT — so this can't be backed by `ts`. Nothing in the editor's runtime reaches it (the preview is a
// hand-rolled `ViteDevServer` using `ts.transpileModule`, not real Vite/Rollup; the almostnode host runs only
// language servers), so rather than bundle acorn solely for a dead path, throw. If real Vite/Rollup-in-browser
// is ever wanted, restore an ESTree parser here (e.g. lazy-load acorn from CDN like loadRollup does).
export function parseAst(_input: string, _options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean }): unknown {
  throw new Error("rollup.parseAst is not supported in this runtime (no ESTree parser bundled); see shims/rollup.ts");
}

export async function parseAstAsync(input: string, options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean; signal?: AbortSignal }): Promise<unknown> {
  return parseAst(input, options);
}

// Stub for native module detection - this prevents the "unsupported platform" error
export function getPackageBase(): string {
  return '';
}

// Export default that matches Rollup's API
export default {
  VERSION,
  rollup,
  watch,
  loadRollup,
  parseAst,
  parseAstAsync,
};
