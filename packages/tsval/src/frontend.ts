import ts from "typescript";

export { ts };

/**
 * Parse source text into a native TypeScript `SourceFile` (SyntaxKind AST, "Path B").
 *
 * Parse-only: `ts.createSourceFile` gives us `SyntaxKind` nodes with positions but **no types**
 * (type-awareness is a later stage, ASSIGNMENT S6). We keep the raw AST as the unit of execution
 * so source-mapping / stepping stay trivial (ASSIGNMENT §3).
 */
export function parse(code: string, fileName = "tsval.ts"): ts.SourceFile {
	return ts.createSourceFile(
		fileName,
		code,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true, // handlers need node.parent for scope/name resolution
		ts.ScriptKind.TS
	);
}

/**
 * `SyntaxKind` has duplicate numeric values across token ranges, so `ts.SyntaxKind[kind]` returns
 * whichever name was assigned *last* to that number — often the wrong one for tokens. We only use
 * this for human-readable diagnostics; dispatch always compares against `ts.SyntaxKind.X` numerically.
 * (The dup-enum gotcha is DumbLang's `enumerateReverseLookup`; ASSIGNMENT §4.)
 */
const kindNames: Record<number, string> = (() => {
	const out: Record<number, string> = {};

	for (const [name, value] of Object.entries(ts.SyntaxKind)) {
		if (typeof value === "number" && out[value] === undefined) {
			out[value] = name;
		}
	}

	return out;
})();

export function syntaxKindName(kind: number): string {
	return kindNames[kind] ?? `#${kind}`;
}
