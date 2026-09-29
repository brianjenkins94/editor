/**
 * `node:module` for the browser eslint engine (aliased in build.ts) — there is no browser polyfill for it, so without
 * this `createRequire`/`isBuiltin` are undefined and every plugin that touches them fails at load. Semantics are
 * Node's for "nothing is installed", except the few modules the engine can hand out (REGISTRY): `require()` throws a
 * real MODULE_NOT_FOUND otherwise (which optional-dependency code already catches), `require.resolve` hands the id
 * back (plugins only use it to name files), `require.cache` is empty.
 */

import builtinRules from "eslint-registry:builtin-rules";
import * as eslintUtils from "eslint-registry:eslint-utils";

// Modules a runtime `require` can still reach. `typescript` is tsserver's own instance (the engine runs inside the
// tsserver plugin; see ts-external.js), so a dynamic require of it costs nothing and matches what everything else uses.
const REGISTRY = {
	"typescript": () => globalThis.__eslintTs,
	// @stylistic loads its AST helpers this way.
	"@eslint-community/eslint-utils": () => eslintUtils.default ?? eslintUtils,
	// eslint-plugin-unused-imports builds on ESLint's core `no-unused-vars` through `builtinRules`. Only the rule
	// registry: the rest of `use-at-your-own-risk` is ESLint's Node API.
	"eslint/use-at-your-own-risk": () => ({ "builtinRules": builtinRules })
};
export const builtinModules = [
	"assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
	"events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
	"readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"
];

export function isBuiltin(name) {
	const bare = String(name).replace(/^node:/u, "");

	return builtinModules.includes(bare) || builtinModules.includes(bare.split("/")[0]);
}

export function createRequire() {
	function require(id) {
		const provided = Object.prototype.hasOwnProperty.call(REGISTRY, id) ? REGISTRY[id]() : undefined;

		if (provided !== undefined) {
			return provided;
		}

		const error = new Error(`Cannot find module '${id}' (require is unavailable in the browser eslint engine)`);

		error.code = "MODULE_NOT_FOUND";
		throw error;
	}

	require.resolve = (id) => id;
	require.cache = {};

	return require;
}

export default { builtinModules, isBuiltin, createRequire };
