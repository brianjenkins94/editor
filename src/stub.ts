/**
 * silo — response-first authoring (the `stub` disposition). Run guest code WITHOUT making its real calls:
 * give a stand-in RESPONSE per data-source global (a fixture value or a factory), auto-stub named sources
 * with a recursive undefined-safe Proxy, and/or SYNTHESIZE a stand-in shaped like a call's return TYPE.
 * Lets you build "the part after a good response" before wiring the real call or its auth.
 *
 * Built on tsval (the interpreter), dev-linked via a tsconfig `paths` alias to ../tsval like `./canary`; kept
 * out of the CI import sweep until tsval publishes. Type synthesis uses tsval's typed layer's callsite seam
 * (`site.returnType()` — the apparent type at the site, generics resolved) and keys on the specific callee it
 * means to replace (the guard sees EVERY host call, including an incidental `new URL(...)` in an argument list).
 */

import type { TypedHostGuard } from "@brianjenkins94/tsval/typed";
import { interpret, ts } from "@brianjenkins94/tsval";
import { createTypedVM } from "@brianjenkins94/tsval/typed";

/** A recursive, undefined-safe stand-in: every property / call / construct yields another auto-stub, so
 *  `res.a.b[0].c()` never throws while you explore downstream. Carries no real data — a peek shows a stub.
 *  Three keys are NOT stubs, because a stub there breaks the code being explored: `then` (a stub is not a
 *  thenable — `await stub` yields the stub instead of hanging forever), the primitive-coercion protocol
 *  (`\`${stub}\`` and `stub + ""` give "[stub]" instead of throwing) and `toJSON` (`{}`); other symbol keys
 *  are undefined (a stub is not iterable). */
export function autostub(): unknown {
	const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
		"get": (_target, key) => {
			// Not a tsval guest function either: the interpreter brands its own functions with `__tsval` and would
			// otherwise try to run the stub as guest code.
			if (key === "then" || key === "toJSON" || key === "__tsval") {
				return undefined;
			}

			if (key === Symbol.toPrimitive || key === "valueOf" || key === "toString") {
				return () => "[stub]";
			}

			if (typeof key === "symbol") {
				return undefined;
			}

			return autostub();
		},
		"apply": () => autostub(),
		"construct": () => autostub() as object
	};

	// A callable target, so both `res()` and `res.x` (and `new res()`) are trapped.
	return new Proxy(function stub() { /* inert proxy target: all traps route through `handler`, never this body */ }, handler);
}

/** Usable stand-ins for the builtins a synthesized value may contain (a stub in their place would fail on
 *  first use: `date.getTime() + 1` coerces, `map.get` is not a function). */
const BUILTIN_STANDINS: Record<string, () => unknown> = {
	"Date": () => new Date(0),
	"Map": () => new Map(),
	"Set": () => new Set(),
	"WeakMap": () => new WeakMap(),
	"WeakSet": () => new WeakSet(),
	"RegExp": () => /^/u,
	"Error": () => new Error("stub")
};

/** Build a plausible value shaped like `type` (the call's resolved return type). Unknowns fall back to an
 *  `autostub`; recursion is depth- and cycle-guarded so a self-referential type (a linked list) terminates. */
function synthesizeFromType(type: ts.Type | undefined, checker: ts.TypeChecker | undefined, node: ts.Node, depth = 0, seen = new Set<ts.Type>()): unknown {
	if (type === undefined || checker === undefined || depth > 6 || seen.has(type)) {
		return autostub();
	}

	const typeFlags = ts.TypeFlags;

	if (type.isStringLiteral()) {
		return type.value;
	}

	if (type.isNumberLiteral()) {
		return type.value;
	}

	if (type.flags & typeFlags.BooleanLiteral) {
		return checker.typeToString(type) === "true";
	}

	if (type.flags & typeFlags.String) {
		return "string";
	}

	if (type.flags & typeFlags.Number) {
		return 0;
	}

	if (type.flags & typeFlags.Boolean) {
		return false;
	}

	if (type.flags & typeFlags.BigInt) {
		return 0n;
	}

	if (type.flags & (typeFlags.Void | typeFlags.Undefined)) {
		return undefined;
	}

	if (type.flags & typeFlags.Null) {
		return null;
	}

	if (type.flags & (typeFlags.Any | typeFlags.Unknown)) {
		return autostub();
	}

	if (type.isUnion()) {
		const nullish = type.types.find((member) => member.flags & (typeFlags.Null | typeFlags.Undefined | typeFlags.Void));
		const pick = type.types.find((member) => !(member.flags & (typeFlags.Null | typeFlags.Undefined | typeFlags.Void))) ?? type.types[0];

		// A self-reference that the type lets be nullish ends there (a one-element linked list) — real data,
		// rather than a stub where the cycle is cut.
		return synthesizeFromType(seen.has(pick) && nullish !== undefined ? nullish : pick, checker, node, depth, seen);
	}

	const name = (type.aliasSymbol ?? type.getSymbol())?.getName();

	// A promised result stays a promise: the code after it says `.then(…)` as often as `await`.
	if (name === "Promise") {
		return Promise.resolve(synthesizeFromType(checker.getTypeArguments(type as ts.TypeReference)[0], checker, node, depth, seen));
	}

	if (name === "Array" || name === "ReadonlyArray") {
		return [synthesizeFromType(checker.getTypeArguments(type as ts.TypeReference)[0], checker, node, depth + 1, seen)];
	}

	if (checker.isTupleType(type)) {
		return checker.getTypeArguments(type as ts.TypeReference).map((element) => synthesizeFromType(element, checker, node, depth + 1, seen));
	}

	if (name !== undefined && name in BUILTIN_STANDINS) {
		return BUILTIN_STANDINS[name]();
	}

	if (type.getCallSignatures().length > 0) {
		return () => undefined;
	}

	if (type.flags & typeFlags.Object) {
		seen.add(type);
		const result: Record<string, unknown> = {};

		// Program-declared members only: a member declared solely by the default lib (`push`, `map`, … of an
		// array-like or class-typed result) is a builtin's, not the program's shape.
		for (const property of type.getProperties()) {
			const declarations = property.getDeclarations() ?? [];
			const libOnly = declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib);

			if (!libOnly) {
				result[property.getName()] = synthesizeFromType(checker.getTypeOfSymbolAtLocation(property, node), checker, node, depth + 1, seen);
			}
		}

		seen.delete(type);

		return result;
	}

	return autostub();
}

export interface RespondFirstOptions {
	/** Per data-source global: a fixture value (returned as-is on each call) or a factory (called per call). */
	"responses"?: Record<string, unknown>;
	/** Source globals to auto-stub with a recursive Proxy when not already given a `responses` fixture. */
	"autostubs"?: string[];
	/** Source globals whose result is SYNTHESIZED from the callsite's return type (needs the typed VM, and the
	 *  program must DECLARE the source — `declare function load(): T` — or the type is `any` and the result an
	 *  auto-stub). */
	"synthesize"?: string[];
	/** Extra globals passed through untouched. */
	"globals"?: Record<string, unknown>;
}

/** Run `code` with its data sources stubbed; returns the program's completion value and which sources stood in. */
export function respondFirst(code: string, options: RespondFirstOptions = {}): { "completion": unknown; "stubbed": string[] } {
	const { responses = {}, autostubs = [], synthesize = [], globals = {} } = options;
	const injected: Record<string, unknown> = { ...globals };
	const stubbed: string[] = [];

	for (const [name, value] of Object.entries(responses)) {
		injected[name] = typeof value === "function" ? value : () => value;
		stubbed.push(name);
	}

	for (const name of autostubs) {
		if (!(name in injected)) {
			injected[name] = () => autostub();
			stubbed.push(name);
		}
	}

	// Placeholders for the type-synthesized sources: the name must resolve for the call to happen, and the
	// guard replaces the call's result with a stand-in shaped like its return type. Match by callee identity.
	const synthTargets = new Set<unknown>();

	for (const name of synthesize) {
		if (!(name in injected)) {
			const placeholder = (): undefined => undefined;

			injected[name] = placeholder;
			synthTargets.add(placeholder);
			stubbed.push(name);
		}
	}

	if (synthTargets.size === 0) {
		return { "completion": interpret(code, { "globals": injected }), "stubbed": stubbed };
	}

	const hostGuard: TypedHostGuard = {
		// Matched by identity — as the callee, or as the receiver of `load.call(…)` / `load.apply(…)`.
		"beforeCall": (callee, thisArg, _isConstruct, site) => (synthTargets.has(callee) || synthTargets.has(thisArg)
			? () => synthesizeFromType(site.returnType(), site.checker, site.node)
			: callee)
	};

	const { vm } = createTypedVM(code, { "globals": injected, "hostGuard": hostGuard });

	return { "completion": vm.run(), "stubbed": stubbed };
}
