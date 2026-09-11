/**
 * Preflight engine — the ESM/wasm analysis kernel, built typescript-EXTERNAL (engine.plugin.config.ts) and
 * loaded INSIDE the tsserver plugin (ts-plugin.js), which supplies tsserver's own `ts` via the ts-external
 * shim. Running in tsserver means `ts.sys` is available, so tsval's typed program reads the REAL lib .d.ts
 * from tsserver's filesystem — no bundled lib copy, and DOM/ES globals match the user's actual project.
 *
 * oxc's browser binding initialises its wasm via a module-level top-level await, so by the time this module
 * has finished evaluating (which `await import()` waits for) `parseSync` — hence detect/reach — is ready, and
 * `runPreflight` can stay synchronous.
 */
import { type DocRow, preflightDocument } from "../../../../src/preflight";

export interface PreflightResult {
	"rows": DocRow[];
	"floating": DocRow[];
}

/** Run the full static+dynamic preflight over a document and return its anchored + floating rows. */
export function runPreflight(src: string, fileName: string): PreflightResult {
	return preflightDocument(src, fileName);
}
