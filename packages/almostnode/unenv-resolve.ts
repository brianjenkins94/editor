/**
 * unenv's Node modules (almostnode's built-ins are built on them: builtins.ts) import each other by Node's names —
 * `node:events`, `node:stream/promises` — which a browser can't resolve, and Node would answer with its own. Here, a
 * built-in imported from inside unenv is unenv's own module. Node's own code on npm — streams (readable-stream),
 * string_decoder — imports `buffer`, `process/` and `events` by name too, which Node would answer with its own and a
 * bundle with npm's copies (a second Buffer, a second EventEmitter): those are almostnode's — unenv's buffer and process,
 * and the one events almostnode's built-in is (npm's events: unenv's EventEmitter is a class, which readable-stream's
 * streams can't `EventEmitter.call(this)`). A bundler of almostnode resolves them with this
 * (`unenvResolve`, a Vite/rolldown plugin); almostnode's tests, with their loader (test/extensionless.mjs).
 */
// eslint-disable-next-line ts/no-restricted-imports -- almostnode doesn't depend on util (its fs wrapper); this runs in Node, at build and test time
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";

const require = createRequire(import.meta.url);

/** Where unenv's Node modules are: unenv resolved as Node resolves it, through a pnpm link to its real folder — where
 *  its own dependency (pathe) is found beside it. */
const UNENV_NODE = path.join(path.dirname(require.resolve("unenv/package.json")), "dist", "runtime", "node");

/** The packages of Node's own code almostnode's built-ins are (builtins.ts), and the files of the built-ins they import
 *  by bare name (`process/`: the package, not the built-in) as almostnode's are. */
const NODE_CODE = ["readable-stream", "string_decoder", "safe-buffer", "events", "assert"];
const NODE_CODE_IMPORTS: Record<string, string> = {
	// (npm's util with Node's inspect, which has an output budget: npm-util.ts)
	"util/": path.join(path.dirname(url.fileURLToPath(import.meta.url)), "npm-util.ts"),
	"buffer": path.join(UNENV_NODE, "buffer.mjs"),
	"process": path.join(UNENV_NODE, "process.mjs"),
	"process/": path.join(UNENV_NODE, "process.mjs"),
	"events": require.resolve("events/events.js")
};

/** The file of almostnode's module for built-in `specifier` imported from `importer` — unenv's own, when the importer
 *  is unenv's (a `node:` import) and unenv has it; almostnode's, when the importer is Node's code on npm (NODE_CODE);
 *  else undefined (resolved as it would be). */
export function unenvModuleFor(specifier: string, importer: string): string | undefined {
	const within = (name: string): boolean => importer.includes(`${path.sep}node_modules${path.sep}${name}${path.sep}`);

	if (within("unenv")) {
		const file = specifier.startsWith("node:") ? path.join(UNENV_NODE, specifier.slice("node:".length) + ".mjs") : undefined;

		return file !== undefined && existsSync(file) ? file : undefined;
	}

	return NODE_CODE.some(within) ? NODE_CODE_IMPORTS[specifier] : undefined;
}

/** Node's code on npm that reads Node's `global` as it loads, where a browser's realm has only `globalThis`: util's
 *  parseArgs (@pkgjs/parseargs), whose primordials copy the built-ins off it. */
const READS_GLOBAL = /[\\/]node_modules[\\/]@pkgjs[\\/]parseargs[\\/]internal[\\/]primordials\.js$/u;

/** `code` of module `id`, reading `globalThis` where it read Node's `global` (READS_GLOBAL) — else undefined (as it is). */
export function globalThisFor(code: string, id: string): string | undefined {
	return READS_GLOBAL.test(id) ? code.replace(/\bglobal\[/gu, "globalThis[") : undefined;
}

/** Node's util.inspect, as almostnode's util has it (node-inspect-extracted). */
const INSPECT = /[\\/]node_modules[\\/]node-inspect-extracted[\\/]dist[\\/]inspect\.js$/u;

/** How much of a rendering one level may take before inspect stops going deeper, in a browser: Node's own budget
 *  (2 ** 27 characters a level) is sized for Node's heap, and a worker's is smaller — an assertion rendering two global
 *  objects to depth 1000 (Node's assert does) ran the debug worker out of memory before reaching it, and a dedicated
 *  worker shares its page's renderer, so the editor went with it (2026-11-23). */
export const BROWSER_INSPECT_BUDGET = 2 ** 22;

/** `code` of module `id` with inspect's output budget the browser's (BROWSER_INSPECT_BUDGET) — else undefined. */
export function inspectBudgetFor(code: string, id: string): string | undefined {
	return INSPECT.test(id) && code.includes(">2**27&&") ? code.replace(">2**27&&", `>${String(BROWSER_INSPECT_BUDGET)}&&`) : undefined;
}

/** A Vite/rolldown plugin resolving unenv's, and Node's code's, imports of Node's built-ins to almostnode's modules
 *  (unenvModuleFor), giving Node's code `globalThis` where it reads `global` (globalThisFor), and inspect a budget a
 *  browser's heap can hold (inspectBudgetFor). */
export function unenvResolve(): { "name": string; "enforce": "pre"; "resolveId": (source: string, importer?: string) => string | undefined; "transform": (code: string, id: string) => string | undefined } {
	return {
		"name": "almostnode-unenv-resolve",
		"enforce": "pre",
		"resolveId": (source, importer) => (importer === undefined ? undefined : unenvModuleFor(source, importer)),
		"transform": (code, id) => globalThisFor(code, id) ?? inspectBudgetFor(code, id)
	};
}
