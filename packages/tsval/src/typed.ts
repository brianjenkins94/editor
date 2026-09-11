import type { InterpretOptions, LoadedVM } from "./interpret.ts";
import type { HostCallSite, HostGuard } from "./vm.ts";
import ts from "typescript";
import { VM } from "./vm.ts";

/**
 * The type-aware layer — OPT-IN, layered on top of the interpreter, which knows no TypeChecker.
 *
 * `ts.createSourceFile` (the interpreter's front-end) gives a `SyntaxKind` AST but **no types**; a
 * `TypeChecker` needs a `Program`. `createTypedProgram` builds one over a single in-memory file,
 * delegating lib.d.ts reads to the host filesystem (in the browser, a virtual FS would supply the
 * libs — the same seam). Heavy and slow via the JS `typescript` package today; the TS 7.1 native
 * backend (Go→WASM, microsoft/TypeScript#63703) is the intended future path. Nothing here runs
 * unless this module is imported.
 *
 * `createTypedVM` seats a VM on the Program's own SourceFile (so node identities line up with
 * checker queries) and, if a guard is given, wraps it so its callsite carries the static types.
 */

export interface TypedProgram {
	"program": ts.Program;
	"checker": ts.TypeChecker;
	"sourceFile": ts.SourceFile;
}

const VIRTUAL_DIR = "/tsval";

// Lib .d.ts contents injected by environments without a host filesystem (the browser), keyed by basename
// — `ts.createCompilerHost` reads libs through `ts.sys`, which is undefined there. Empty ⇒ no default lib
// (types degrade to `any`, but the program still builds). See `provideLibFiles`.
let injectedLibFiles: Record<string, string> = {};

/** Supply the TypeScript lib .d.ts files (keyed by basename, e.g. `lib.es2022.d.ts`) for environments with
 *  no host filesystem, so `createTypedProgram` can type-check in the browser. Call once before use. */
export function provideLibFiles(files: Record<string, string>): void {
	injectedLibFiles = files;
}

const basename = (filePath: string): string => filePath.slice(filePath.lastIndexOf("/") + 1);

/** An in-memory `CompilerHost` for environments without `ts.sys` (the browser): it answers lib .d.ts reads
 *  from the injected map by basename, so no real filesystem is touched. The single virtual source file is
 *  layered on top by `createTypedProgram`, exactly as it is over `ts.createCompilerHost`. */
function createBrowserCompilerHost(options: ts.CompilerOptions): ts.CompilerHost {
	const cache = new Map<string, ts.SourceFile>();

	return {
		"getSourceFile": (name, languageVersionOrOptions) => {
			const key = basename(name);
			const cached = cache.get(key);

			if (cached !== undefined) {
				return cached;
			}

			const content = injectedLibFiles[key];

			if (content === undefined) {
				return undefined;
			}

			const target = typeof languageVersionOrOptions === "object" ? languageVersionOrOptions.languageVersion : languageVersionOrOptions;
			const sourceFile = ts.createSourceFile(name, content, target ?? options.target ?? ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

			cache.set(key, sourceFile);

			return sourceFile;
		},
		"getDefaultLibFileName": () => "lib.es2022.d.ts",
		"getDefaultLibLocation": () => VIRTUAL_DIR,
		"writeFile": () => { /* no emit */ },
		"getCurrentDirectory": () => VIRTUAL_DIR,
		"getCanonicalFileName": (name) => name,
		"useCaseSensitiveFileNames": () => true,
		"getNewLine": () => "\n",
		"fileExists": (name) => injectedLibFiles[basename(name)] !== undefined,
		"readFile": (name) => injectedLibFiles[basename(name)]
	};
}

export function createTypedProgram(code: string, fileName = "entry.ts"): TypedProgram {
	const full = `${VIRTUAL_DIR}/${fileName}`;
	const options: ts.CompilerOptions = {
		"target": ts.ScriptTarget.ES2022,
		"lib": ["lib.es2022.d.ts", "lib.dom.d.ts"], // DOM too, so web-platform values (fetch, URL, WebSocket) have their types
		"types": [],
		// Types are read for what they say (synthesis from a return type, TypeBox schemas), so keep `null` and
		// `undefined` in them (without this `T | null` and `x?: T` erase to `T`) and type `f.call(…)` /
		// `f.apply(…)` by `f`'s signature rather than as `any`.
		"strictNullChecks": true,
		"strictBindCallApply": true,
		"skipLibCheck": true,
		"noResolve": false,
		"allowJs": true,
		"noEmit": true
	};

	// `ts.createCompilerHost` reads lib.d.ts through `ts.sys`; in the browser that's undefined, so fall back
	// to an in-memory host fed by `provideLibFiles`. Node keeps the real filesystem host unchanged.
	const host = ts.sys === undefined ? createBrowserCompilerHost(options) : ts.createCompilerHost(options, /* setParentNodes */ true);
	const src = ts.createSourceFile(full, code, options.target ?? ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

	const getSourceFile = host.getSourceFile.bind(host);

	host.getSourceFile = (name, ...rest) => (name === full ? src : getSourceFile(name, ...rest));
	const fileExists = host.fileExists.bind(host);

	host.fileExists = (name) => name === full || fileExists(name);
	const readFile = host.readFile.bind(host);

	host.readFile = (name) => (name === full ? code : readFile(name));

	const program = ts.createProgram([full], options, host);

	return { "program": program, "checker": program.getTypeChecker(), "sourceFile": program.getSourceFile(full)! };
}

/** The static type at a node, structured (a `ts.Type` to walk: properties, unions, call signatures).
 *  For a call or `new` expression this is the call's result type. */
export function typeAtNode(checker: ts.TypeChecker, node: ts.Node | undefined): ts.Type | undefined {
	if (node === undefined) {
		return undefined;
	}

	try {
		return checker.getTypeAtLocation(node);
	} catch {
		return undefined;
	}
}

/** The static type of a node as a string (e.g. `"string"`, `"URL"`). */
export function typeOfNode(checker: ts.TypeChecker, node: ts.Node | undefined): string | undefined {
	const type = typeAtNode(checker, node);

	return type === undefined ? undefined : checker.typeToString(type);
}

/** The signature a call/new expression resolved to (parameter and return types as declared), or undefined. */
export function signatureAt(checker: ts.TypeChecker, node: ts.CallLikeExpression | undefined): ts.Signature | undefined {
	if (node === undefined) {
		return undefined;
	}

	try {
		return checker.getResolvedSignature(node);
	} catch {
		return undefined;
	}
}

// --- the VM composition ----------------------------------------------------------------------------

/** A host callsite with the program's static types alongside the interpreter's syntax and values. */
export interface TypedHostCallSite extends HostCallSite {
	"checker": ts.TypeChecker;
	/** the static type of the call's result (a `ts.Type`). */
	"returnType": () => ts.Type | undefined;
	/** the signature the call resolved to (declared parameter/return types). */
	"signature": () => ts.Signature | undefined;
	/** the static type of the i-th argument expression. */
	"argumentType": (index: number) => ts.Type | undefined;
}

/** The interpreter's callsite, enriched with the checker's view of it. */
export function typedCallSite(checker: ts.TypeChecker, site: HostCallSite): TypedHostCallSite {
	const { node } = site;

	return {
		...site,
		"checker": checker,
		"returnType": () => typeAtNode(checker, node),
		"signature": () => signatureAt(checker, node),
		"argumentType": (index) => (ts.isTaggedTemplateExpression(node) ? undefined : typeAtNode(checker, node.arguments?.[index]))
	};
}

/** A `HostGuard` whose `beforeCall` sees a `TypedHostCallSite`. (A plain `HostGuard` is one too.) */
export interface TypedHostGuard {
	"sanitize"?: (value: unknown) => unknown;
	"beforeCall"?: (callee: (...args: unknown[]) => unknown, thisArg: unknown, isConstruct: boolean, site: TypedHostCallSite) => (...args: unknown[]) => unknown;
}

/** Adapt a typed guard to the interpreter's guard: the site the interpreter passes is enriched on the way through. */
export function typedGuard(checker: ts.TypeChecker, guard: TypedHostGuard): HostGuard {
	const { beforeCall } = guard;

	return {
		"sanitize": guard.sanitize?.bind(guard),
		"beforeCall": beforeCall === undefined ? undefined : (callee, thisArg, isConstruct, site) => beforeCall.call(guard, callee, thisArg, isConstruct, typedCallSite(checker, site))
	};
}

export interface TypedVMOptions extends Omit<InterpretOptions, "hostGuard"> {
	"hostGuard"?: TypedHostGuard;
}

/** A VM seated on a typed program, with the program's checker beside it (the VM itself holds no checker). */
export interface TypedVM extends LoadedVM, TypedProgram {}

/**
 * Like `createVM`, but over a `Program` + `TypeChecker`: the VM runs the Program's own SourceFile, and
 * the guard's callsites carry the static types (`site.returnType()`, `site.signature()`,
 * `site.argumentType(i)`). Heavier — only for runs that need types.
 */
export function createTypedVM(code: string, options: TypedVMOptions = {}): TypedVM {
	const typed = createTypedProgram(code, options.fileName);
	const { hostGuard, ...rest } = options;
	const vm = new VM({ ...rest, "hostGuard": hostGuard === undefined ? undefined : typedGuard(typed.checker, hostGuard) });

	vm.load(typed.sourceFile);

	return { ...typed, "vm": vm };
}
