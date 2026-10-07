/**
 * A program's modules (VMOptions.modules, MODULES.md): its host's loader resolves — a built-in, a package, or one of the
 * program's own files — and loads what isn't the program's natively; the program's files are tsval's to evaluate, each
 * in a module frame of its own on the stack that required or imported it, so stepping goes into them.
 *
 * A file's `require` is its own (it resolves from the file): a call to it is intercepted (calls.ts) — a program file not
 * loaded yet is a module frame pushed, its `module.exports` the call's value when it completes; anything else goes to
 * the host. An ES module's imports of program files are evaluated before its body, depth-first, each once (the link
 * order: statements.ts' program handler); its exports are getters on `module.exports` reading its own bindings (live,
 * as ESM's are), its default export set as it runs.
 */
import type ts from "typescript";
import type { ModuleFrame, NodeFrame } from "./frame.ts";
import type { Machine } from "./vm.ts";
import tsModule from "typescript";
import { bindingNames } from "./handlers/hoist.ts";
import { on, syntheticHandlers } from "./handlers/registry.ts";

const Kind = tsModule.SyntaxKind;

/** A module, as its loader caches it (almostnode's `Module`, Node's shape). */
export interface ModuleRecord { "id": string; "filename": string; "exports": unknown; "loaded": boolean; "children": unknown[]; "paths": string[] }

/** What a specifier resolves to: a built-in (its name), a package's file, or one of the program's own files. */
export interface ResolvedModule { "kind": "builtin" | "package" | "program"; "filename": string }

/** The host's module system, for the program's modules (almostnode's Runtime: resolve, require, register, cached). */
export interface ModuleLoader {
	/** Where `specifier` resolves from the directory `fromDir`, and what it is. Throws when nothing's there. */
	"resolve": (specifier: string, fromDir: string) => ResolvedModule;
	/** A module that isn't the program's, loaded natively, as the program's code asks for it from `fromDir`. */
	"require": (specifier: string, fromDir: string) => unknown;
	/** A program file's source. */
	"source": (filename: string) => string;
	/** The module cached for `filename`, if it's loaded (or being loaded). */
	"cached": (filename: string) => ModuleRecord | undefined;
	/** Put a module tsval is evaluating in the cache — before it runs, so a cycle sees its partial exports. */
	"register": (filename: string, module: ModuleRecord) => void;
	/** Take a module out of the cache: its evaluation threw. */
	"forget"?: (filename: string) => void;
}

/** Each module's require, by the file it resolves from. */
const requires = new WeakMap<object, string>();
/** Each module's scope's module. */
const moduleOfScope = new WeakMap<object, ModuleRecord>();

/** The file a module's `require` resolves from — undefined for any other function. */
export function requireOf(value: unknown): string | undefined {
	return (typeof value === "function" || (typeof value === "object" && value !== null)) ? requires.get(value) : undefined;
}

/** The directory a file is in. */
export function directoryOf(filename: string): string {
	return filename.slice(0, filename.lastIndexOf("/")) || "/";
}

/** `filename`'s `require`: a host function the call handler recognizes (and `invokeHost` serves, called otherwise —
 *  from a package, say); with `resolve`, as Node's has. */
export function makeRequire(loader: ModuleLoader, filename: string): (specifier: string) => unknown {
	function require(specifier: string): unknown {
		return loader.require(String(specifier), directoryOf(filename));
	}

	requires.set(require, filename);
	Object.assign(require, { "resolve": (specifier: string) => loader.resolve(String(specifier), directoryOf(filename)).filename });

	return require;
}

/** The module a scope belongs to (its module scope's, up the chain), if it's in one. */
export function moduleOf(scope: { "parent"?: unknown } | undefined): ModuleRecord | undefined {
	for (let at = scope; at !== undefined && at !== null; at = at.parent as typeof at) {
		const module = moduleOfScope.get(at);

		if (module !== undefined) {
			return module;
		}
	}

	return undefined;
}

/** Mark `scope` as `module`'s. */
export function setModuleOf(scope: object, module: ModuleRecord): void {
	moduleOfScope.set(scope, module);
}

/** The specifiers a file imports or re-exports from (not types), in order. */
export function linkedSpecifiers(source: ts.SourceFile): string[] {
	const specifiers: string[] = [];

	for (const statement of source.statements) {
		if (tsModule.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true && tsModule.isStringLiteral(statement.moduleSpecifier)) {
			specifiers.push(statement.moduleSpecifier.text);
		} else if (tsModule.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier !== undefined && tsModule.isStringLiteral(statement.moduleSpecifier)) {
			specifiers.push(statement.moduleSpecifier.text);
		}
	}

	return specifiers;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => (tsModule.canHaveModifiers(node) ? tsModule.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true : false);

/** An ES module's exports, on `module.exports`: getters reading its own bindings (live), re-exports reading the module
 *  they're from — `get(name)` reads a binding of its scope; `from(specifier)` is a re-exported module's exports. */
export function defineExports(source: ts.SourceFile, module: ModuleRecord, get: (name: string) => unknown, from: (specifier: string) => unknown): void {
	const exports = module.exports as Record<string, unknown>;
	const define = (name: string, read: () => unknown): void => { Object.defineProperty(exports, name, { "get": read, "enumerable": true, "configurable": true }); };
	let esm = false;

	for (const statement of source.statements) {
		const exported = hasModifier(statement, Kind.ExportKeyword) && !hasModifier(statement, Kind.DeclareKeyword);
		const isDefault = hasModifier(statement, Kind.DefaultKeyword);

		if (exported && tsModule.isVariableStatement(statement)) {
			esm = true;

			for (const name of statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name))) {
				define(name, () => get(name));
			}
		} else if (exported && (tsModule.isFunctionDeclaration(statement) || tsModule.isClassDeclaration(statement) || tsModule.isEnumDeclaration(statement)) && statement.name !== undefined) {
			esm = true;

			const { text } = statement.name;

			define(isDefault ? "default" : text, () => get(text));
		} else if (tsModule.isExportDeclaration(statement) && !statement.isTypeOnly) {
			esm = true;

			const specifier = statement.moduleSpecifier !== undefined && tsModule.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
			const clause = statement.exportClause;

			if (clause === undefined && specifier !== undefined) {
				// export * from "…": its names (not its default), read from it when asked
				const source = from(specifier) as Record<string, unknown>;

				for (const name of Object.keys(source ?? {})) {
					if (name !== "default" && !Object.hasOwn(exports, name)) {
						define(name, () => (from(specifier) as Record<string, unknown>)[name]);
					}
				}
			} else if (clause !== undefined && tsModule.isNamespaceExport(clause) && specifier !== undefined) {
				define(clause.name.text, () => from(specifier));
			} else if (clause !== undefined && tsModule.isNamedExports(clause)) {
				for (const element of clause.elements) {
					if (!element.isTypeOnly) {
						const local = (element.propertyName ?? element.name).text;

						define(element.name.text, specifier === undefined ? () => get(local) : () => (from(specifier) as Record<string, unknown>)[local]);
					}
				}
			}
		} else if (tsModule.isExportAssignment(statement)) {
			esm = true;
		}
	}

	if (esm) {
		Object.defineProperty(exports, "__esModule", { "value": true, "configurable": true });
	}
}

/** A module frame: its file's program node pushed in its scope; when that completes, `module.exports` is its value. */
function moduleFrame(vm: Machine, frame: ModuleFrame): void {
	if (frame.phase === 0) {
		vm.pushNode(frame.source, frame.scope);
		frame.phase = 1;

		return;
	}

	vm.frames.pop();
	vm.values.length = frame.valuesBase;
	frame.module.loaded = true;
	vm.push(frame.module.exports);
}

/** `export default <expression>` sets the module's default export as it runs; `export = <expression>` its exports. */
function exportAssignment(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ExportAssignment;

	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;

		return;
	}

	const value = vm.pop();
	const module = moduleOf(frame.scope);

	vm.frames.pop();

	if (module === undefined) {
		return;
	}

	if (node.isExportEquals === true) {
		module.exports = value;
	} else {
		Object.defineProperty(module.exports, "default", { "value": value, "enumerable": true, "configurable": true, "writable": true });
	}
}

/** Registers this module's handlers (called by ./handlers.ts once every module has loaded). */
export function register(): void {
	syntheticHandlers.module = moduleFrame;
	on(Kind.ExportAssignment, exportAssignment);
}
