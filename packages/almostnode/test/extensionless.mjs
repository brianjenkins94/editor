// A resolve hook for tests, registered as this is imported (a test imports it before almostnode's sources):
// almostnode's sources import each other without extensions (they're bundled, not run as is) — resolve such a relative
// import to its .ts file, or a directory's index.ts, so `node --test` can load them. And unenv's Node modules, and
// Node's code on npm (readable-stream), import Node's built-ins: those are unenv's own, as almostnode's bundles resolve
// them (unenv-resolve.ts) — not this Node's. In-thread hooks (registerHooks), so a CommonJS package's require() is
// resolved here too, not only an import.
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import * as url from "node:url";
import { unenvModuleFor } from "../unenv-resolve.ts";

export function resolve(specifier, context, next) {
	const unenv = context.parentURL?.startsWith("file:") === true ? unenvModuleFor(specifier, url.fileURLToPath(context.parentURL)) : undefined;

	// (answered, not passed on: a require()'s next resolution takes a path, an import's a URL)
	if (unenv !== undefined) {
		return { "url": url.pathToFileURL(unenv).href, "shortCircuit": true };
	}

	if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$|\.json$/u.test(specifier) && context.parentURL?.startsWith("file:")) {
		for (const candidate of [specifier + ".ts", specifier + "/index.ts"]) {
			const target = new URL(candidate, context.parentURL);

			if (existsSync(url.fileURLToPath(target)) && statSync(url.fileURLToPath(target)).isFile()) {
				return next(target.href, context);
			}
		}
	}

	return next(specifier, context);
}

registerHooks({ "resolve": resolve });
