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

export function relativeImports(text: string): string[] {
	return [
		...new Set([
			...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gmu)
		].map(([, specifier]) => specifier))
	];
}

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
