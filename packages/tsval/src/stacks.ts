/**
 * A program's own stack, as V8 gives one: an error the program makes (`new Error`, a class extending Error, a host
 * built-in's that it catches, `Error.captureStackTrace`) has a `stack` of the program's frames — not the interpreter's
 * — awaits followed back to their callers as V8 follows them (`at async …`), formatted by `Error.prepareStackTrace`
 * when the program set one, with call sites as V8's (`getTypeName`, `getFunctionName`, `isAsync`, …), else as V8
 * formats them. The machine walks its frames into sites (vm.ts `sitesHere`); this is what a site says, and how a
 * stack is told.
 */
import ts from "typescript";

/** A frame of the program's stack: what was running, and where in it. */
export interface Site {
	/** The node it's at: a call's callee name, a `new`, an `await`. */
	"node": ts.Node | undefined;
	/** The function (undefined: a module's top level). */
	"fn"?: unknown;
	"name": string | undefined;
	"thisArg"?: unknown;
	"isConstructor"?: boolean;
	"isAsync"?: boolean;
	/** A function with no receiver of its own (a module's code, a plain call): V8's top level. */
	"isToplevel": boolean;
}

/** Where V8 says a call is: a method call at its name, a plain call or a `new` at its start; a property read at its
 *  name. */
function positionOf(node: ts.Node): ts.Node {
	const at = ts.isCallExpression(node)
		? node.expression
		: node;

	return ts.isPropertyAccessExpression(at)
		? at.name
		: at;
}

function locationOf(node: ts.Node | undefined): { "file": string; "line": number; "column": number } | undefined {
	if (node === undefined) {
		return undefined;
	}

	const at = positionOf(node);
	const file = at.getSourceFile();
	const { line, character } = file.getLineAndCharacterOfPosition(at.getStart(file));

	return { "file": file.fileName, "line": line + 1, "column": character + 1 };
}

/** A receiver's class, as V8 names it (null for none). */
function typeNameOf(thisArg: unknown): string | null {
	if (thisArg === undefined || thisArg === null) {
		return null;
	}

	if (typeof thisArg !== "object" && typeof thisArg !== "function") {
		return {
			"string": "String",
			"number": "Number",
			"boolean": "Boolean",
			"symbol": "Symbol",
			"bigint": "BigInt"
		}[typeof thisArg] ?? null;
	}

	try {
		const ctor = (thisArg as { "constructor"?: unknown }).constructor;

		return typeof ctor === "function" && ctor.name !== ""
			? ctor.name
			: "Object";
	} catch {
		return "Object";
	}
}

/** One of `Error.prepareStackTrace`'s call sites, as V8's CallSite. */
export class CallSite {
	readonly #site: Site;

	public constructor(site: Site) {
		this.#site = site;
	}

	public getThis(): unknown {
		return undefined; // (as V8's, for strict code: a module's)
	}

	public getTypeName(): string | null {
		return this.#site.isToplevel && this.#site.isConstructor !== true
			? null
			: typeNameOf(this.#site.thisArg);
	}

	public getFunction(): unknown {
		return undefined; // (strict code's, as V8's)
	}

	public getFunctionName(): string | null {
		return this.#site.name === undefined || this.#site.name === ""
			? null
			: this.#site.name;
	}

	public getMethodName(): string | null {
		return this.#site.isToplevel || this.#site.isConstructor === true
			? null
			: this.getFunctionName();
	}

	public getFileName(): string | undefined {
		return locationOf(this.#site.node)?.file;
	}

	public getScriptNameOrSourceURL(): string | undefined {
		return this.getFileName();
	}

	public getLineNumber(): number | null {
		return locationOf(this.#site.node)?.line ?? null;
	}

	public getColumnNumber(): number | null {
		return locationOf(this.#site.node)?.column ?? null;
	}

	public getEvalOrigin(): undefined {
		return undefined;
	}

	public isToplevel(): boolean {
		return this.#site.isToplevel;
	}

	public isEval(): boolean {
		return false;
	}

	public isNative(): boolean {
		return false;
	}

	public isConstructor(): boolean {
		return this.#site.isConstructor === true;
	}

	public isAsync(): boolean {
		return this.#site.isAsync === true;
	}

	public isPromiseAll(): boolean {
		return false;
	}

	public getPromiseIndex(): null {
		return null;
	}

	/** As V8 writes a frame, after its `at `. */
	public toString(): string {
		const where = locationOf(this.#site.node);
		const place = where === undefined
			? "<anonymous>"
			: `${where.file}:${String(where.line)}:${String(where.column)}`;
		const name = this.getFunctionName();
		const type = this.getTypeName();
		let what: string | undefined;

		if (this.isConstructor()) {
			what = `new ${name ?? "<anonymous>"}`;
		} else if (!this.isToplevel() && type !== null) {
			what = `${type}.${name ?? "<anonymous>"}`;
		} else {
			what = name ?? undefined;
		}

		return (this.isAsync()
			? "async "
			: "") + (what === undefined
			? place
			: `${what} (${place})`);
	}
}

/** V8's header for an error's stack: its name and message. */
export function headerOf(error: unknown): string {
	try {
		const { name, message } = error as { "name"?: unknown; "message"?: unknown };
		const named = name === undefined
			? "Error"
			: String(name);
		const said = message === undefined
			? ""
			: String(message);

		if (named === "") {
			return said;
		}

		return said === ""
			? named
			: `${named}: ${said}`;
	} catch {
		return "Error";
	}
}

/** The errors given the program's stack: one given it isn't given another (a rethrow keeps where it was made). */
const given = new WeakSet();

/** Whether `error` has the program's stack already. */
export function hasProgramStack(error: object): boolean {
	return given.has(error);
}

/** While a stack is told: an error made meanwhile (by `prepareStackTrace` itself) is told as V8 does, not through it. */
let telling = false;

/**
 * Give `error` the program's stack, `sites`: told when it's first read — through `errorCtor.prepareStackTrace` if the
 * program set one, then as it is then, as V8 does — and a value the program assigns after that, as an own property.
 */
export function giveStack(error: object, sites: Site[], errorCtor: { "prepareStackTrace"?: unknown }): void {
	given.add(error);

	const settle = (value: unknown): void => {
		Object.defineProperty(error, "stack", {
			"value": value,
			"writable": true,
			"enumerable": false,
			"configurable": true
		});
	};

	try {
		Object.defineProperty(error, "stack", {
			"get": () => {
				const prepare = telling ? undefined : errorCtor.prepareStackTrace;
				const calls = sites.map((site) => new CallSite(site));
				let told: unknown;

				if (typeof prepare === "function") {
					telling = true;

					try {
						told = (prepare as (error: unknown, sites: CallSite[]) => unknown)(error, calls);
					} finally {
						telling = false;
					}
				} else {
					told = [
						headerOf(error),
						...calls.map((call) => `    at ${call.toString()}`)
					].join("\n");
				}

				settle(told);

				return told;
			},
			"set": settle,
			"enumerable": false,
			"configurable": true
		});
	} catch {
		// (a frozen object, or one whose stack can't be redefined: it keeps what it has)
	}
}
