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
		/\.[jt]sx$/u.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
}

/** A file that can't run: what the parser said, and where, so a debugger can mark it. A SyntaxError, as Node's is, and
 *  thrown where Node would throw one: loading the file, before any of it runs. Its message names the place, which a
 *  program's own `catch` has no other way to see. */
export class ProgramSyntaxError extends SyntaxError {
	/** The file, its 0-based line, and the error's start and end offsets in the file. */
	public readonly "file": string;
	public readonly "line": number;
	public readonly "at": [number, number];

	public constructor(file: string, line: number, column: number, at: [number, number], what: string) {
		super(`${file}:${line + 1}:${column + 1}: ${what}`);
		this.file = file;
		this.line = line;
		this.at = at;
	}
}

/** The first error the parser met in `source`, if any. (Only the parser's: what V8 calls early errors that TypeScript
 *  leaves to its binder and checker, a redeclared `let` or a stray `break`, aren't among them.) */
export function syntaxErrorIn(source: ts.SourceFile): ProgramSyntaxError | undefined {
	const [first] = (source as unknown as { "parseDiagnostics": readonly ts.DiagnosticWithLocation[] }).parseDiagnostics;

	if (first === undefined) {
		return undefined;
	}

	const { line, character } = source.getLineAndCharacterOfPosition(first.start);

	return new ProgramSyntaxError(source.fileName, line, character, [first.start, first.start + first.length], ts.flattenDiagnosticMessageText(first.messageText, " "));
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
