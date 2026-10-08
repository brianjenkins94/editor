/**
 * Literals and erased wrappers: primitives, identifiers, templates, array and object literals.
 */
import type { NodeFrame } from "../frame.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import { directoryOf } from "../modules.ts";
import { createGuestFunction, nameAnonymous, setFunctionName } from "./functions.ts";
import { cookedTemplateText, defineData, defineFresh, toPropertyKey } from "./realm.ts";
import { evaluating, on, passThroughExpr } from "./registry.ts";

// TypeScript's exports object is in dictionary mode (thousands of members), so each `ts.x` read is a hash lookup: the
// functions used here are read off it once.
const { isBigIntLiteral, isComputedPropertyName, isGetAccessorDeclaration, isIdentifier, isMethodDeclaration, isNumericLiteral, isOmittedExpression, isPrivateIdentifier, isPropertyAssignment, isSetAccessorDeclaration, isShorthandPropertyAssignment, isSpreadAssignment, isSpreadElement, isStringLiteral } = ts;

const Kind = ts.SyntaxKind;

function bigIntLiteral(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.BigIntLiteral;

	vm.frames.pop();
	vm.push(BigInt(node.text.replace(/_/gu, "").replace(/n$/u, "")));
}

function regularExpressionLiteral(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.RegularExpressionLiteral;

	vm.frames.pop();
	const lastSlash = node.text.lastIndexOf("/");

	vm.push(new vm.realm.RegExp(node.text.slice(1, lastSlash), node.text.slice(lastSlash + 1)));
}

/** An identifier, a literal, `true`/`false`/`null` on a frame of its own (a parent evaluates one in its own step when it
 *  can: Machine.pushOperands). */
function leaf(vm: Machine, frame: NodeFrame): void {
	vm.frames.pop();
	vm.push(vm.leafValue(frame.node, frame.scope));
}

// `new.target` (undefined in a plain call, the constructor under `new`), and `import.meta` (its module's: importMeta).
function metaProperty(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.MetaProperty;

	if (node.keywordToken === Kind.ImportKeyword && node.name.text === "meta") {
		vm.frames.pop();
		vm.push(importMeta(vm, node.getSourceFile().fileName));

		return;
	}

	if (node.keywordToken !== Kind.NewKeyword || node.name.text !== "target") {
		unimplemented(`${ts.SyntaxKind[node.keywordToken]}.${node.name.text}`);
	}

	vm.frames.pop();
	vm.push(frame.scope.getNewTarget());
}

/** Each realm's `import.meta` objects, by module file: one per module, the same object every time it's read (a fork's
 *  too — it shares the realm, as it does every host object). */
const importMetas = new WeakMap<object, Map<string, object>>();

/**
 * A module's `import.meta`, as Node makes it: a null-prototype object with the module's `url` (a `file:` URL), its
 * `filename` and `dirname`, and `resolve(specifier)` — where an import of `specifier` from this module would load
 * from, as a URL (`node:fs` for a built-in), through the program's module loader when it has one.
 */
function importMeta(vm: Machine, filename: string): object {
	let metas = importMetas.get(vm.realm);

	if (metas === undefined) {
		metas = new Map();
		importMetas.set(vm.realm, metas);
	}

	let meta = metas.get(filename);

	if (meta === undefined) {
		const url = new URL(filename, "file://").href;
		const dirname = directoryOf(filename);
		const resolve = (specifier: string): string => {
			if (vm.modules === undefined) {
				return new URL(specifier, url).href;
			}

			const resolved = vm.modules.resolve(String(specifier), dirname);

			return resolved.kind === "builtin" ? `node:${resolved.filename.replace(/^node:/u, "")}` : new URL(resolved.filename, "file://").href;
		};

		meta = Object.assign(Object.create(null) as object, { "dirname": dirname, "filename": filename, "resolve": resolve, "url": url });
		metas.set(filename, meta);
	}

	return meta;
}

const templateExpression = evaluating<ts.TemplateExpression>(
	(node) => node.templateSpans.map((span) => span.expression),
	(vm, _frame, node, values) => {
		let out = cookedTemplateText(node.head)!;

		for (let index = 0; index < node.templateSpans.length; index++) {
			out += String(values[index]) + (cookedTemplateText(node.templateSpans[index].literal)!);
		}

		vm.push(out);
	}
);

const arrayLiteralExpression = evaluating<ts.ArrayLiteralExpression>(
	// Elisions (`[1, , 3]`) are OmittedExpressions: they produce no operand and leave a hole.
	(node) => node.elements.filter((el) => !isOmittedExpression(el)).map((el) => (isSpreadElement(el) ? el.expression : el)),
	(vm, _frame, node, raw) => {
		const out = new vm.realm.Array() as unknown[];
		let cursor = 0;
		let index = 0; // elements are *defined* (CreateDataProperty): an inherited setter on an index never runs

		for (const el of node.elements) {
			if (isOmittedExpression(el)) {
				index += 1;
			} else if (isSpreadElement(el)) {
				const iterable = raw[cursor] as Iterable<unknown>;

				cursor += 1;
				for (const value of iterable) {
					defineData(out, index, value);
					index += 1;
				}
			} else {
				defineData(out, index, raw[cursor]);
				index += 1;
				cursor += 1;
			}
		}

		out.length = index;
		vm.push(out);
	}
);

/** Operands evaluate one at a time, in source order, and a computed key is converted (ToPropertyKey)
 *  the moment it finishes — before its value is evaluated (observable through `@@toPrimitive`). */
function objectLiteralExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ObjectLiteralExpression;
	const operands = objectLiteralOperands(node);

	if (frame.phase === 0) {
		frame.values = [];
		frame.index = 0;
		frame.phase = 1;
	} else {
		const index = frame.index!;
		const value = vm.pop();

		(frame.values!).push(operands[index - 1].isKey ? toPropertyKey(value) : value);
	}

	// (each leaf — `{ id: i, total }` — read here and taken as a finished operand is, in this step)
	for (let next = frame.index!; next < operands.length; next++) {
		const operand = operands[next];

		frame.index = next + 1;

		if (!vm.pushOperand(operand.node, frame.scope)) {
			return;
		}

		const value = vm.pop();

		(frame.values!).push(operand.isKey ? toPropertyKey(value) : value);
	}

	vm.frames.pop();
	buildObjectLiteral(vm, frame, node, frame.values!);
}

/** The value-producing nodes of an object literal, in source order: a computed key before its
 *  value. Methods/accessors produce no operand — their functions are created in the build step. */
const literalOperands = new WeakMap<ts.ObjectLiteralExpression, { "node": ts.Node; "isKey": boolean }[]>();

export function objectLiteralOperands(node: ts.ObjectLiteralExpression): { "node": ts.Node; "isKey": boolean }[] {
	// (asked at each of the literal's steps: worked out once)
	let out = literalOperands.get(node);

	if (out === undefined) {
		out = findObjectLiteralOperands(node);
		literalOperands.set(node, out);
	}

	return out;
}

function findObjectLiteralOperands(node: ts.ObjectLiteralExpression): { "node": ts.Node; "isKey": boolean }[] {
	const out: { "node": ts.Node; "isKey": boolean }[] = [];

	for (const prop of node.properties) {
		const { name } = prop as { "name"?: ts.PropertyName };

		if (name !== undefined && isComputedPropertyName(name)) {
			out.push({ "node": name.expression, "isKey": true });
		}

		if (isPropertyAssignment(prop)) {
			out.push({ "node": prop.initializer, "isKey": false });
		} else if (isShorthandPropertyAssignment(prop)) {
			out.push({ "node": prop.name, "isKey": false });
		} else if (isSpreadAssignment(prop)) {
			out.push({ "node": prop.expression, "isKey": false });
		} else if (!isMethodDeclaration(prop) && !isGetAccessorDeclaration(prop) && !isSetAccessorDeclaration(prop)) {
			unimplemented(`${ts.SyntaxKind[(prop as ts.Node).kind]} in ObjectLiteral`);
		}
	}

	return out;
}

export function buildObjectLiteral(vm: Machine, frame: NodeFrame, node: ts.ObjectLiteralExpression, values: unknown[]): void {
	const obj = new vm.realm.Object() as Record<PropertyKey, unknown>;
	let cursor = 0; // advances over the evaluated keys (already property keys) and values, in source order
	const keyOf = (name: ts.PropertyName): PropertyKey => {
		if (isComputedPropertyName(name)) {
			const computed = values[cursor] as PropertyKey;

			cursor += 1;

			return computed;
		}

		return propertyName(name);
	};

	for (const prop of node.properties) {
		if (isPropertyAssignment(prop)) {
			// `__proto__: v` (non-computed) sets the prototype instead of defining a property.
			if (!isComputedPropertyName(prop.name) && propertyName(prop.name) === "__proto__") {
				const value = values[cursor];

				cursor += 1;
				if (value === null || typeof value === "object" || typeof value === "function") {
					Object.setPrototypeOf(obj, value);
				}
			} else {
				const key = keyOf(prop.name);
				const value = values[cursor];

				cursor += 1;
				defineFresh(vm, obj, key, nameAnonymous(value, key, prop.initializer));
			}
		} else if (isShorthandPropertyAssignment(prop)) {
			defineFresh(vm, obj, prop.name.text, values[cursor]);
			cursor += 1;
		} else if (isSpreadAssignment(prop)) {
			spreadInto(vm, obj, values[cursor]); // own enumerable props, each through the guard
			cursor += 1;
		} else if (isMethodDeclaration(prop)) {
			const key = keyOf(prop.name);
			const fn = createGuestFunction(vm, prop, frame.scope, obj);

			setFunctionName(fn, key);
			Object.defineProperty(obj, key, { "value": fn, "writable": true, "enumerable": true, "configurable": true });
		} else if (isGetAccessorDeclaration(prop) || isSetAccessorDeclaration(prop)) {
			const key = keyOf(prop.name);
			const fn = createGuestFunction(vm, prop, frame.scope, obj);

			setFunctionName(fn, key, isGetAccessorDeclaration(prop) ? "get" : "set");
			// An accessor replaces an earlier data property of the same name (and vice versa).
			const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(obj, key) ?? {}), "enumerable": true, "configurable": true };

			delete desc.value;
			delete desc.writable;
			if (isGetAccessorDeclaration(prop)) {
				desc.get = fn as () => unknown;
			} else {
				desc.set = fn as (value: unknown) => void;
			}

			Object.defineProperty(obj, key, desc);
		}
	}

	vm.push(obj);
}

/** `{ ...source }`: copy own enumerable props (string + symbol keys), each value through the guard. */
export function spreadInto(vm: Machine, target: Record<PropertyKey, unknown>, source: unknown): void {
	if (source === null || source === undefined) {
		return;
	}

	const src = new Object(source) as Record<PropertyKey, unknown>;

	for (const key of Reflect.ownKeys(src)) {
		if (Object.getOwnPropertyDescriptor(src, key)?.enumerable) {
			defineFresh(vm, target, key, vm.fromHost(src[key]));
		}
	}
}

export function propertyName(name: ts.PropertyName | ts.Identifier): string {
	if (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) {
		return name.text;
	}

	if (isBigIntLiteral(name)) {
		return String(BigInt(name.text.slice(0, -1))); // `{ 1n: v }` → "1"
	}

	if (isPrivateIdentifier(name)) {
		return name.text;
	}

	unimplemented(`computed/other property name (${ts.SyntaxKind[name.kind]})`);
}

const voidExpression = evaluating<ts.VoidExpression>((node) => [node.expression], (vm) => {
	vm.push(undefined);
});

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	for (const kind of [Kind.Identifier, Kind.NumericLiteral, Kind.StringLiteral, Kind.NoSubstitutionTemplateLiteral, Kind.TrueKeyword, Kind.FalseKeyword, Kind.NullKeyword]) {
		on(kind, leaf);
	}

	on(Kind.BigIntLiteral, bigIntLiteral);
	on(Kind.RegularExpressionLiteral, regularExpressionLiteral);
	on(Kind.MetaProperty, metaProperty);
	on(Kind.ParenthesizedExpression, passThroughExpr);
	on(Kind.ExpressionWithTypeArguments, passThroughExpr); // an instantiation expression `f<T>` is `f`
	on(Kind.AsExpression, passThroughExpr);
	on(Kind.TypeAssertionExpression, passThroughExpr);
	on(Kind.NonNullExpression, passThroughExpr);
	on(Kind.SatisfiesExpression, passThroughExpr);
	on(Kind.TemplateExpression, templateExpression);
	on(Kind.ArrayLiteralExpression, arrayLiteralExpression);
	on(Kind.ObjectLiteralExpression, objectLiteralExpression);
	on(Kind.VoidExpression, voidExpression);
}
