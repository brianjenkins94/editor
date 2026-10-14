/**
 * unenv's Node modules (almostnode's built-ins are built on them: builtins.ts) import each other by Node's names —
 * `node:events`, `node:stream/promises` — which a browser can't resolve, and Node would answer with its own. Here, a
 * built-in imported from inside unenv is unenv's own module. A bundler of almostnode resolves them with this
 * (`unenvResolve`, a Vite/rolldown plugin); almostnode's tests, with their loader (test/extensionless.mjs).
 */
// eslint-disable-next-line ts/no-restricted-imports -- almostnode doesn't depend on util (its fs wrapper); this runs in Node, at build and test time
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

/** Where unenv's Node modules are. */
const UNENV_NODE = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "node_modules", "unenv", "dist", "runtime", "node");

/** The file of unenv's own module for built-in `specifier` imported from `importer` — when the importer is unenv's and
 *  unenv has that module; else undefined (resolved as it would be). */
export function unenvModuleFor(specifier: string, importer: string): string | undefined {
	if (!importer.includes(`${path.sep}node_modules${path.sep}unenv${path.sep}`)) {
		return undefined;
	}

	const name = specifier.startsWith("node:") ? specifier.slice("node:".length) : undefined;
	const file = name === undefined ? undefined : path.join(UNENV_NODE, name + ".mjs");

	return file !== undefined && existsSync(file) ? file : undefined;
}

/** A Vite/rolldown plugin resolving unenv's imports of Node's built-ins to unenv's own modules (unenvModuleFor). */
export function unenvResolve(): { "name": string; "enforce": "pre"; "resolveId": (source: string, importer?: string) => string | undefined } {
	return {
		"name": "almostnode-unenv-resolve",
		"enforce": "pre",
		"resolveId": (source, importer) => (importer === undefined ? undefined : unenvModuleFor(source, importer))
	};
}
