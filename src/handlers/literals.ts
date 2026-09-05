/**
 * Literals and erased wrappers: primitives, identifiers, templates, array and object literals.
 */
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import type { NodeFrame } from "../frame.ts";
import type { VM } from "../vm.ts";
import { createGuestFunction, nameAnonymous, setFunctionName } from "./functions.ts";
import { defineData, toPropertyKey } from "./realm.ts";
import { evaluating, on, passThroughExpr, pushText } from "./registry.ts";

const K = ts.SyntaxKind;

function numericLiteral(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.NumericLiteral;
	vm.frames.pop();
	vm.push(Number(node.text.replace(/_/g, "")));
}

function bigIntLiteral(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.BigIntLiteral;
	vm.frames.pop();
	vm.push(BigInt(node.text.replace(/_/g, "").replace(/n$/, "")));
}



function trueKeyword(vm: VM): void {
	vm.frames.pop();
	vm.push(true);
}

function falseKeyword(vm: VM): void {
	vm.frames.pop();
	vm.push(false);
}

function nullKeyword(vm: VM): void {
	vm.frames.pop();
	vm.push(null);
}

function regularExpressionLiteral(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.RegularExpressionLiteral;
	vm.frames.pop();
	const lastSlash = node.text.lastIndexOf("/");
	vm.push(new vm.realm.RegExp(node.text.slice(1, lastSlash), node.text.slice(lastSlash + 1)));
}

function identifier(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.Identifier;
	vm.frames.pop();
	// Globals are host values; guest bindings pass through the guard unchanged (identity by default).
	vm.push(vm.fromHost(frame.scope.get(node.text)));
}

// `new.target` (undefined in a plain call, the constructor under `new`); `import.meta` is a module
// concept this program-runner doesn't model.
function metaProperty(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.MetaProperty;
	if (node.keywordToken !== K.NewKeyword || node.name.text !== "target") unimplemented(`${ts.SyntaxKind[node.keywordToken]}.${node.name.text}`);
	vm.frames.pop();
	vm.push(frame.scope.getNewTarget());
}







const templateExpression = evaluating<ts.TemplateExpression>(
	(node) => node.templateSpans.map((span) => span.expression),
	(vm, _frame, node, values) => {
		let out = node.head.text;
		for (let i = 0; i < node.templateSpans.length; i++) out += String(values[i]) + node.templateSpans[i].literal.text;
		vm.push(out);
	},
);

const arrayLiteralExpression = evaluating<ts.ArrayLiteralExpression>(
	// Elisions (`[1, , 3]`) are OmittedExpressions: they produce no operand and leave a hole.
	(node) => node.elements.filter((el) => !ts.isOmittedExpression(el)).map((el) => (ts.isSpreadElement(el) ? el.expression : el)),
	(vm, _frame, node, raw) => {
		const out = new vm.realm.Array() as unknown[];
		let cursor = 0;
		let index = 0; // elements are *defined* (CreateDataProperty): an inherited setter on an index never runs
		for (const el of node.elements) {
			if (ts.isOmittedExpression(el)) index++;
			else if (ts.isSpreadElement(el)) for (const v of raw[cursor++] as Iterable<unknown>) defineData(out, index++, v);
			else defineData(out, index++, raw[cursor++]);
		}
		out.length = index;
		vm.push(out);
	},
);

function objectLiteralExpression(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.ObjectLiteralExpression;
	objectLiteral(vm, frame);
}

/** The value-producing nodes of an object literal, in source order: a computed key before its
 *  value. Methods/accessors produce no operand — their functions are created in the build step. */
export function objectLiteralOperands(node: ts.ObjectLiteralExpression): ts.Node[] {
	const out: ts.Node[] = [];
	for (const prop of node.properties) {
		const name = (prop as { name?: ts.PropertyName }).name;
		if (name !== undefined && ts.isComputedPropertyName(name)) out.push(name.expression);
		if (ts.isPropertyAssignment(prop)) out.push(prop.initializer);
		else if (ts.isShorthandPropertyAssignment(prop)) out.push(prop.name);
		else if (ts.isSpreadAssignment(prop)) out.push(prop.expression);
		else if (!ts.isMethodDeclaration(prop) && !ts.isGetAccessorDeclaration(prop) && !ts.isSetAccessorDeclaration(prop)) {
			unimplemented(`${ts.SyntaxKind[(prop as ts.Node).kind]} in ObjectLiteral`);
		}
	}
	return out;
}

export const objectLiteral = evaluating<ts.ObjectLiteralExpression>(objectLiteralOperands, (vm, frame, node, values) => {
	{
		const obj = new vm.realm.Object() as Record<PropertyKey, unknown>;
		let cursor = 0; // advances over the evaluated keys and values, in source order
		const keyOf = (name: ts.PropertyName): PropertyKey => (ts.isComputedPropertyName(name) ? toPropertyKey(values[cursor++]) : propertyName(name));
		for (const prop of node.properties) {
			if (ts.isPropertyAssignment(prop)) {
				// `__proto__: v` (non-computed) sets the prototype instead of defining a property.
				if (!ts.isComputedPropertyName(prop.name) && propertyName(prop.name) === "__proto__") {
					const value = values[cursor++];
					if (value === null || typeof value === "object" || typeof value === "function") Object.setPrototypeOf(obj, value);
					continue;
				}
				const key = keyOf(prop.name);
				const value = values[cursor++];
				defineData(obj, key, nameAnonymous(value, key, prop.initializer));
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				defineData(obj, prop.name.text, values[cursor++]);
			} else if (ts.isSpreadAssignment(prop)) {
				spreadInto(vm, obj, values[cursor++]); // own enumerable props, each through the guard
			} else if (ts.isMethodDeclaration(prop)) {
				const key = keyOf(prop.name);
				const fn = createGuestFunction(vm, prop, frame.scope, obj);
				setFunctionName(fn, key);
				Object.defineProperty(obj, key, { value: fn, writable: true, enumerable: true, configurable: true });
			} else if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
				const key = keyOf(prop.name);
				const fn = createGuestFunction(vm, prop, frame.scope, obj);
				setFunctionName(fn, key, ts.isGetAccessorDeclaration(prop) ? "get" : "set");
				// An accessor replaces an earlier data property of the same name (and vice versa).
				const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(obj, key) ?? {}), enumerable: true, configurable: true };
				delete desc.value;
				delete desc.writable;
				if (ts.isGetAccessorDeclaration(prop)) desc.get = fn as () => unknown;
				else desc.set = fn as (v: unknown) => void;
				Object.defineProperty(obj, key, desc);
			}
		}
		vm.push(obj);
	}
});

/** `{ ...source }`: copy own enumerable props (string + symbol keys), each value through the guard. */
export function spreadInto(vm: VM, target: Record<PropertyKey, unknown>, source: unknown): void {
	if (source == null) return;
	const src = Object(source) as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(src)) {
		if (Object.getOwnPropertyDescriptor(src, key)?.enumerable) defineData(target, key, vm.fromHost(src[key]));
	}
}

export function propertyName(name: ts.PropertyName | ts.Identifier): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	if (ts.isBigIntLiteral(name)) return String(BigInt(name.text.slice(0, -1))); // `{ 1n: v }` → "1"
	if (ts.isPrivateIdentifier(name)) return name.text;
	unimplemented(`computed/other property name (${ts.SyntaxKind[name.kind]})`);
}

const voidExpression = evaluating<ts.VoidExpression>((node) => [node.expression], (vm) => vm.push(undefined));


/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(K.NumericLiteral, numericLiteral);
	on(K.BigIntLiteral, bigIntLiteral);
	on(K.StringLiteral, pushText);
	on(K.NoSubstitutionTemplateLiteral, pushText);
	on(K.TrueKeyword, trueKeyword);
	on(K.FalseKeyword, falseKeyword);
	on(K.NullKeyword, nullKeyword);
	on(K.RegularExpressionLiteral, regularExpressionLiteral);
	on(K.Identifier, identifier);
	on(K.MetaProperty, metaProperty);
	on(K.ParenthesizedExpression, passThroughExpr);
	on(K.ExpressionWithTypeArguments, passThroughExpr); // an instantiation expression `f<T>` is `f`
	on(K.AsExpression, passThroughExpr);
	on(K.TypeAssertionExpression, passThroughExpr);
	on(K.NonNullExpression, passThroughExpr);
	on(K.SatisfiesExpression, passThroughExpr);
	on(K.TemplateExpression, templateExpression);
	on(K.ArrayLiteralExpression, arrayLiteralExpression);
	on(K.ObjectLiteralExpression, objectLiteralExpression);
	on(K.VoidExpression, voidExpression);
}
