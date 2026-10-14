// A resolve hook for tests: almostnode's sources import each other without extensions (they're bundled, not run as
// is) — resolve such a relative import to its .ts file, or a directory's index.ts, so `node --test` can load them.
// And unenv's Node modules import each other by Node's names (`node:events`): those are unenv's own, as almostnode's
// bundles resolve them (unenv-resolve.ts) — not this Node's.
import { existsSync, statSync } from "node:fs";
import * as url from "node:url";
import { unenvModuleFor } from "../unenv-resolve.ts";

export async function resolve(specifier, context, next) {
	const unenv = context.parentURL?.startsWith("file:") === true ? unenvModuleFor(specifier, url.fileURLToPath(context.parentURL)) : undefined;

	if (unenv !== undefined) {
		return next(url.pathToFileURL(unenv).href, context);
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
