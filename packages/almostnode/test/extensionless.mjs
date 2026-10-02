// A resolve hook for tests: almostnode's sources import each other without extensions (they're bundled, not run as
// is) — resolve such a relative import to its .ts file, or a directory's index.ts, so `node --test` can load them.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
	if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$|\.json$/u.test(specifier) && context.parentURL?.startsWith("file:")) {
		for (const candidate of [specifier + ".ts", specifier + "/index.ts"]) {
			const url = new URL(candidate, context.parentURL);

			if (existsSync(fileURLToPath(url)) && statSync(fileURLToPath(url)).isFile()) {
				return next(url.href, context);
			}
		}
	}

	return next(specifier, context);
}
