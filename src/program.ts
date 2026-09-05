import ts from "typescript";

/**
 * Type-aware front-end (ASSIGNMENT S6). `ts.createSourceFile` (the `./frontend` default) gives a
 * `SyntaxKind` AST but **no types**; a `TypeChecker` needs a `Program`. This builds one over a single
 * in-memory file, delegating lib.d.ts reads to the host filesystem (in the browser, a virtual FS would
 * supply the libs — the same seam). Heavy and slow via the JS `typescript` package today; the TS 7.1
 * native backend (Go→WASM, microsoft/TypeScript#63703) is the intended future path. The interpreter
 * runs parse-only by default and only pays for this when type-awareness is asked for.
 *
 * The returned `sourceFile` is the Program's own, so node identities line up with `checker` queries.
 */

export interface TypedProgram {
	program: ts.Program;
	checker: ts.TypeChecker;
	sourceFile: ts.SourceFile;
}

const VIRTUAL_DIR = "/tsval";

export function createTypedProgram(code: string, fileName = "entry.ts"): TypedProgram {
	const full = `${VIRTUAL_DIR}/${fileName}`;
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], // DOM too, so web-platform values (fetch, URL, WebSocket) have their types
		types: [],
		skipLibCheck: true,
		noResolve: false,
		allowJs: true,
		noEmit: true,
	};

	const host = ts.createCompilerHost(options, /* setParentNodes */ true);
	const src = ts.createSourceFile(full, code, options.target ?? ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...rest) => (name === full ? src : getSourceFile(name, ...rest));
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (name) => name === full || fileExists(name);
	const readFile = host.readFile.bind(host);
	host.readFile = (name) => (name === full ? code : readFile(name));

	const program = ts.createProgram([full], options, host);
	return { program, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(full)! };
}

/** The static type of a node as a string (e.g. `"string"`, `"URL"`), or undefined without a checker. */
export function typeOfNode(checker: ts.TypeChecker | undefined, node: ts.Node | undefined): string | undefined {
	if (checker === undefined || node === undefined) return undefined;
	try {
		return checker.typeToString(checker.getTypeAtLocation(node));
	} catch {
		return undefined;
	}
}
