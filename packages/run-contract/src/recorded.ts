/**
 * A value as a recorded call keeps it (RUNNING.md: stepping a recorded handler): the page encodes what a replayable
 * function read and what each of its calls returned (`encode`), JSON-safe, and the replay revives it (`revive`) for tsval
 * to run the function on. Data comes back as data — numbers, strings, arrays, plain objects, a Map, a Set, a Date —
 * bounded in depth and breadth. What can't come back is marked, and revived as what stands in for it: a function as a
 * named stand-in (the replay hands it the result its call had); a DOM node, an event or a class's instance as an object of
 * what could be read of it, its methods stand-ins too.
 */

/** An encoded value: a JSON primitive, an array of encoded values, or a marked object (`$` says what it was). */
export type Encoded = string | number | boolean | null | Encoded[] | { "$": string; [key: string]: unknown };

const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ITEMS = 50;
const MAX_TEXT = 500;

/** A host object (the page's, not the program's own data): a DOM node, an event, the window, the document. */
function isHost(value: object): boolean {
	return (typeof Node !== "undefined" && value instanceof Node) || (typeof Event !== "undefined" && value instanceof Event) || (typeof window !== "undefined" && (value === window || value === globalThis));
}

/** The name a host object goes by (`<button#add>`, `PointerEvent click`). */
function hostName(value: object): string {
	if (typeof Element !== "undefined" && value instanceof Element) {
		return `<${value.tagName.toLowerCase()}${value.id === "" ? "" : "#" + value.id}>`;
	}

	if (typeof Event !== "undefined" && value instanceof Event) {
		return `${value.constructor.name} ${value.type}`;
	}

	return (value as { "constructor"?: { "name"?: string } }).constructor?.name ?? "object";
}

/** Every method name along `value`'s prototypes (not Object's own). */
function methodsOf(value: object): string[] {
	const names = new Set<string>();

	for (let proto = Object.getPrototypeOf(value) as object | null; proto !== null && proto !== Object.prototype && names.size < MAX_KEYS * 4; proto = Object.getPrototypeOf(proto) as object | null) {
		for (const name of Object.getOwnPropertyNames(proto)) {
			const descriptor = Object.getOwnPropertyDescriptor(proto, name);

			if (name !== "constructor" && descriptor !== undefined && typeof descriptor.value === "function") {
				names.add(name);
			}
		}
	}

	return [...names];
}

/** `value`, encoded (see the header). */
export function encode(value: unknown, depth = 0, seen = new Set<object>()): Encoded {
	if (value === null) {
		return null;
	}

	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
	}

	if (typeof value === "number") {
		return Number.isFinite(value) && !Object.is(value, -0) ? value : { "$": "n", "v": Object.is(value, -0) ? "-0" : String(value) };
	}

	if (value === undefined) {
		return { "$": "u" };
	}

	if (typeof value === "bigint") {
		return { "$": "bi", "v": String(value) };
	}

	if (typeof value === "symbol") {
		return { "$": "sym", "v": value.description ?? "" };
	}

	if (typeof value === "function") {
		return { "$": "f", "name": (value as { "name"?: string }).name ?? "" };
	}

	const object = value as object;

	if (seen.has(object)) {
		return { "$": "cyc" };
	}

	seen.add(object);

	try {
		if (isHost(object)) {
			// What can be read of it, one level: its primitives (a node's id, an event's key, an input's value), and the
			// nodes it points at by name.
			const props: Record<string, Encoded> = {};
			const methods: string[] = [];

			for (const key in object) {
				let member: unknown;

				try {
					member = (object as Record<string, unknown>)[key];
				} catch {
					continue;
				}

				if (typeof member === "function") {
					methods.push(key);
				} else if (Object.keys(props).length < MAX_KEYS * 2 && (member === null || ["string", "number", "boolean"].includes(typeof member))) {
					props[key] = encode(member, depth + 1, seen);
				} else if (Object.keys(props).length < MAX_KEYS * 2 && typeof member === "object" && member !== null && isHost(member) && depth < 1) {
					props[key] = { "$": "h", "name": hostName(member), "p": {}, "m": [] };
				}
			}

			return { "$": "h", "name": hostName(object), "p": props, "m": methods };
		}

		if (depth >= MAX_DEPTH) {
			return { "$": "deep" };
		}

		if (Array.isArray(object)) {
			const items = object.slice(0, MAX_ITEMS).map((item: unknown) => encode(item, depth + 1, seen));

			return object.length > MAX_ITEMS ? [...items, { "$": "more", "n": object.length - MAX_ITEMS }] : items;
		}

		if (object instanceof Date) {
			return { "$": "date", "v": object.getTime() };
		}

		if (object instanceof RegExp) {
			return { "$": "re", "source": object.source, "flags": object.flags };
		}

		if (object instanceof Map) {
			return { "$": "map", "v": [...object].slice(0, MAX_ITEMS).map(([key, item]) => [encode(key, depth + 1, seen), encode(item, depth + 1, seen)]) };
		}

		if (object instanceof Set) {
			return { "$": "set", "v": [...object].slice(0, MAX_ITEMS).map((item) => encode(item, depth + 1, seen)) };
		}

		if (object instanceof Error) {
			return { "$": "err", "name": object.name, "message": object.message };
		}

		if (typeof (object as { "then"?: unknown }).then === "function") {
			return { "$": "pending" };
		}

		const proto = Object.getPrototypeOf(object) as object | null;
		const plain = proto === null || proto === Object.prototype;
		const props: Record<string, Encoded> = {};

		for (const key of Object.keys(object).slice(0, MAX_KEYS)) {
			try {
				props[key] = encode((object as Record<string, unknown>)[key], depth + 1, seen);
			} catch {
				props[key] = { "$": "u" };
			}
		}

		return plain ? { "$": "o", "v": props } : { "$": "o", "v": props, "cls": (object as { "constructor"?: { "name"?: string } }).constructor?.name ?? "", "m": methodsOf(object) };
	} finally {
		seen.delete(object);
	}
}

/** What stands in for a function that couldn't be recorded: called, it gives what `result` says (the replay's
 *  recorded result for the call being made — undefined when there's none). */
export type StandIn = (name: string) => (...args: unknown[]) => unknown;

/** `value`, revived (see the header): functions and methods as `standIn`'s. */
export function revive(value: Encoded, standIn: StandIn): unknown {
	if (value === null || typeof value !== "object") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.filter((item) => !(item !== null && typeof item === "object" && !Array.isArray(item) && item.$ === "more")).map((item) => revive(item, standIn));
	}

	const methods = (object: object, names: unknown): object => {
		for (const name of Array.isArray(names) ? names as string[] : []) {
			if (!(name in object)) {
				Object.defineProperty(object, name, { "value": standIn(name), "writable": true, "configurable": true, "enumerable": false });
			}
		}

		return object;
	};

	switch (value.$) {
		case "u": return undefined;
		case "n": return value.v === "-0" ? -0 : Number(value.v);
		case "bi": return BigInt(value.v as string);
		case "sym": return Symbol(value.v as string);
		case "f": return standIn(String(value.name ?? ""));
		case "date": return new Date(value.v as number);
		case "re": return new RegExp(String(value.source), String(value.flags));
		case "map": return new Map((value.v as [Encoded, Encoded][]).map(([key, item]) => [revive(key, standIn), revive(item, standIn)]));
		case "set": return new Set((value.v as Encoded[]).map((item) => revive(item, standIn)));
		case "err": return Object.assign(new Error(String(value.message)), { "name": String(value.name) });
		case "h": return methods(Object.fromEntries(Object.entries(value.p as Record<string, Encoded>).map(([key, item]) => [key, revive(item, standIn)])), value.m);
		case "o": return methods(Object.fromEntries(Object.entries(value.v as Record<string, Encoded>).map(([key, item]) => [key, revive(item, standIn)])), value.m);
		case "p": return Promise.resolve(revive(value.v as Encoded, standIn));
		case "pr": return Promise.reject(revive(value.v as Encoded, standIn));
		default: return undefined; // cyc, deep, more, pending: not to hand
	}
}
