/**
 * What a file names of node_modules, read from its text: the packages it reaches (an import, a `require`, a path resolved in
 * one), and the files of its own it imports by a relative path. What the CDN's node_modules reads ahead, whole, for what
 * reads packages as Node reads a disk (node-modules-provider.ts's prefetchFor: ESLint's worker, before its configs load).
 */

/** Split a node_modules-relative path into package + subpath, honouring scopes (@scope/name). */
export function splitPackage(rel: string): { "pkg": string; "sub": string } {
	const parts = rel.split("/");
	const count = parts[0]?.startsWith("@")
		? 2
		: 1;

	return {
		"pkg": parts.slice(0, count).join("/"),
		"sub": parts.slice(count).join("/")
	};
}

/** The packages a file's text names, of those in `pinned`: a string that's a package's name, or a path in it (an import,
 *  a `require`, a `require.resolve` of a file in it — whatever code reaches it by). */
export function packagesNamedBy(text: string, pinned: Record<string, string>): string[] {
	const named = new Set<string>();

	for (const [, specifier] of text.matchAll(/["'`](@?[\w.-][^"'`\s]*)["'`]/gu)) {
		const { pkg } = splitPackage(specifier);

		if (pinned[pkg] !== undefined) {
			named.add(pkg);
		}
	}

	return [...named];
}

/** The files a file's text imports by a relative path (`./`, `../`), as written. */
export function relativeImports(text: string): string[] {
	return [
		...new Set([
			...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gmu)
		].map(([, specifier]) => specifier))
	];
}

/** `path` normalized: its `.` and `..` resolved. */
export function normalized(path: string): string {
	const parts: string[] = [];

	for (const part of path.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	return "/" + parts.join("/");
}
