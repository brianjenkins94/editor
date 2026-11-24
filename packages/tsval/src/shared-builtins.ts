/**
 * The built-ins a program shares with its host, held apart (VMOptions.builtins).
 *
 * tsval's values are its host's (globals.ts), so a program's change to a built-in — `Array.prototype[Symbol.iterator]`
 * replaced, `Object.prototype.then` added, as test262's tests do on purpose — is made to the host's own, and the host's
 * code runs on it: a debugger's worker iterating an array calls the program's iterator. Node keeps its own code apart
 * with primordials; here the program's changes are held as its own instead. While its code runs (an outermost step or
 * run, or a host's call into one of its functions) they're in place, as the program made them; when control goes back to
 * the host they're recorded (`layer`: what differs from the built-ins as they were) and the built-ins put back, to be
 * made again when its code next runs. So the host's code between steps runs on its own built-ins, and the program's on
 * the ones it changed.
 *
 * What isn't held: a change that can't be undone — a built-in frozen, made non-extensible, or given a property that
 * can't be reconfigured — stays for everyone (`lasting` names it); the host's code a step itself runs (tsval's own,
 * and a package's) sees the program's changes, as Node's packages do; and a fork shares its machine's.
 *
 * The code here runs with the program's changes in place, so it uses nothing a program could have changed: functions
 * taken before any program ran, called directly, index loops, and descriptors with no prototype.
 */

/* eslint-disable ts/prefer-for-of -- a for…of calls the iterator, which may be the program's here */
import { STANDARD_GLOBAL_NAMES } from "./globals.ts";

const { "defineProperty": define, "deleteProperty": remove, "getOwnPropertyDescriptor": descriptorOf, "getPrototypeOf": prototypeOf, "isExtensible": extensible, ownKeys, "setPrototypeOf": setPrototype } = Reflect;
const { create, hasOwn, "is": same } = Object;
const FIELDS = [
	"value",
	"get",
	"set",
	"writable",
	"enumerable",
	"configurable"
] as const;

type Descriptor = Partial<Record<(typeof FIELDS)[number], unknown>>;

/** A built-in as it was: its prototype, whether it took new properties, and its own properties in order. */
interface Pristine {
	readonly "object": object;
	readonly "name": string;
	readonly "prototype": object | null;
	readonly "extensible": boolean;
	readonly "keys": PropertyKey[];
	readonly "descriptors": Descriptor[];
}

/** One difference the program made: a property (`descriptor`, or `undefined` deleted), or the prototype. */
interface Change {
	readonly "at": number;
	readonly "key": PropertyKey | undefined;
	readonly "descriptor": Descriptor | undefined;
	readonly "prototype"?: object | null;
}

/** `item` added to `list` without reading anything up its prototypes (an index set would look for a setter there). */
function append<T>(list: T[], item: T): void {
	const slot = create(null) as Descriptor;

	slot.value = item;
	slot.writable = true;
	slot.enumerable = true;
	slot.configurable = true;
	define(list, list.length, slot as PropertyDescriptor);
}

/** A descriptor's own fields, on an object with no prototype (so defining from it reads nothing inherited). */
function bare(descriptor: PropertyDescriptor): Descriptor {
	const copy = create(null) as Descriptor;

	for (let index = 0; index < FIELDS.length; index += 1) {
		const field = FIELDS[index];

		if (hasOwn(descriptor, field)) {
			copy[field] = (descriptor as Descriptor)[field];
		}
	}

	return copy;
}

function sameDescriptor(left: Descriptor, right: PropertyDescriptor): boolean {
	for (let index = 0; index < FIELDS.length; index += 1) {
		const field = FIELDS[index];

		if (hasOwn(left, field) !== hasOwn(right, field) || !same(left[field], (right as Descriptor)[field])) {
			return false;
		}
	}

	return true;
}

/** Whether `value` is a container of built-ins: an object, or a constructor (its own `prototype` an object). A method is
 *  a leaf: its own `length` and `name` aren't held. */
function container(value: unknown): value is object {
	if (typeof value === "object") {
		return value !== null;
	}

	if (typeof value !== "function") {
		return false;
	}

	const prototype = descriptorOf(value, "prototype")?.value as unknown;

	return typeof prototype === "object" && prototype !== null;
}

/** The objects the language's built-ins are reached through: each standard global, the objects on them, their
 *  prototypes and up, and the prototypes no global names (an array's iterator's, a generator's, %TypedArray%). */
function reach(global: Record<string, unknown>, names: readonly string[]): { "object": object; "name": string }[] {
	const found: { "object": object; "name": string }[] = [];
	const seen = new WeakSet();
	const visit = (value: unknown, name: string): void => {
		if (!container(value) || seen.has(value)) {
			return;
		}

		seen.add(value);
		found.push({ "object": value, "name": name });

		for (const key of ownKeys(value)) {
			const descriptor = descriptorOf(value, key);

			visit(descriptor?.value, typeof key === "symbol"
				? `${name}[${String(key.description)}]`
				: `${name}.${key}`);
		}

		visit(prototypeOf(value), `${name}.[[Prototype]]`);
	};

	for (const name of names) {
		if (name !== "globalThis" && name in global) {
			visit(global[name], name);
		}
	}

	const hidden: [string, () => unknown][] = [
		[
			"%ArrayIteratorPrototype%",
			() => prototypeOf([][Symbol.iterator]())
		],
		[
			"%MapIteratorPrototype%",
			() => prototypeOf(new Map()[Symbol.iterator]())
		],
		[
			"%SetIteratorPrototype%",
			() => prototypeOf(new Set()[Symbol.iterator]())
		],
		[
			"%StringIteratorPrototype%",
			() => prototypeOf(""[Symbol.iterator]())
		],
		[
			"%RegExpStringIteratorPrototype%",
			() => prototypeOf("".matchAll(/x/gu))
		],
		[
			"%GeneratorFunction%",
			() => prototypeOf(function *() { /* probe */ }).constructor
		],
		[
			"%AsyncGeneratorFunction%",
			() => prototypeOf(async function *() { /* probe */ }).constructor
		],
		[
			"%AsyncFunction%",
			() => prototypeOf(async function() { /* probe */ }).constructor
		],
		[
			"%TypedArray%",
			() => prototypeOf(Int8Array)
		],
		[
			"%AsyncIteratorPrototype%",
			() => prototypeOf(prototypeOf(prototypeOf((async function *() { /* probe */ })())))
		]
	];

	for (const [name, probe] of hidden) {
		visit(probe(), name);
	}

	return found;
}

let PRISTINE: Pristine[] | undefined;

/** The built-ins as they are now, before any program: taken once, the first time a host holds them. */
function pristine(global: Record<string, unknown>, names: readonly string[]): Pristine[] {
	PRISTINE ??= reach(global, names).map(({ object, name }) => {
		const keys = ownKeys(object);

		return {
			"object": object,
			"name": name,
			"prototype": prototypeOf(object),
			"extensible": extensible(object),
			"keys": keys,
			"descriptors": keys.map((key) => bare(descriptorOf(object, key) as PropertyDescriptor))
		};
	});

	return PRISTINE;
}

/** Where `key` is in `keys`, or -1. */
function indexOf(keys: readonly PropertyKey[], key: PropertyKey, from: number): number {
	if (from < keys.length && keys[from] === key) {
		return from;
	}

	for (let index = 0; index < keys.length; index += 1) {
		if (keys[index] === key) {
			return index;
		}
	}

	return -1;
}

export class SharedBuiltins {
	/** What the program changed, as of the last time its code was left. */
	private layer: Change[] = [];
	private depth = 0;
	private readonly pristine: Pristine[];
	/** What the program changed that couldn't be undone: in place for everyone since. */
	public readonly lasting: string[] = [];

	/** `global`: where the standard built-ins are found (the host's global by default), `names` which. */
	public constructor(global: Record<string, unknown> = globalThis, names: readonly string[] = STANDARD_GLOBAL_NAMES) {
		this.pristine = pristine(global, names);
	}

	/** The program's code is entered: its changes made, if this is the outermost entry. */
	public enter(): void {
		this.depth += 1;

		if (this.depth !== 1) {
			return;
		}

		const { layer, "pristine": all } = this;

		for (let index = 0; index < layer.length; index += 1) {
			const change = layer[index];
			const { object } = all[change.at];

			if (change.key === undefined) {
				setPrototype(object, change.prototype ?? null);
			} else if (change.descriptor === undefined) {
				remove(object, change.key);
			} else {
				define(object, change.key, change.descriptor as PropertyDescriptor);
			}
		}
	}

	/** The program's code is left: if this is the outermost, what it changed recorded and the built-ins put back. */
	public leave(): void {
		this.depth -= 1;

		if (this.depth !== 0) {
			return;
		}

		const changes: Change[] = [];
		const lasting: string[] = [];
		const stuck: Change[] = [];
		const all = this.pristine;

		for (let at = 0; at < all.length; at += 1) {
			const was = all[at];
			const { object } = was;
			const keys = ownKeys(object);
			let added = false;

			for (let index = 0; index < keys.length; index += 1) {
				const key = keys[index];
				const now = descriptorOf(object, key) as PropertyDescriptor;
				const before = indexOf(was.keys, key, index);

				added ||= before === -1;

				if (before === -1 || !sameDescriptor(was.descriptors[before], now)) {
					append(changes, {
						"at": at,
						"key": key,
						"descriptor": bare(now)
					});
				}
			}

			// (every key there now was there before, and as many: none gone)
			if (added || keys.length !== was.keys.length) {
				for (let index = 0; index < was.keys.length; index += 1) {
					if (descriptorOf(object, was.keys[index]) === undefined) {
						append(changes, { "at": at, "key": was.keys[index], "descriptor": undefined });
					}
				}
			}

			const prototype = prototypeOf(object);

			if (prototype !== was.prototype) {
				append(changes, {
					"at": at,
					"key": undefined,
					"descriptor": undefined,
					"prototype": prototype
				});
			}

			if (was.extensible && !extensible(object)) {
				append(lasting, `${was.name} made non-extensible`);
			}
		}

		for (let index = changes.length - 1; index >= 0; index -= 1) {
			const change = changes[index];
			const was = all[change.at];
			let undone: boolean;

			if (change.key === undefined) {
				undone = setPrototype(was.object, was.prototype);
			} else {
				const before = indexOf(was.keys, change.key, 0);

				undone = before === -1
					? remove(was.object, change.key)
					: define(was.object, change.key, was.descriptors[before] as PropertyDescriptor);
			}

			if (!undone) {
				append(stuck, change);
			}
		}

		this.layer = changes;

		for (const each of [
			...lasting,
			...stuck.map((change) => this.named(change))
		]) {
			if (!this.lasting.includes(each)) {
				this.lasting.push(each);
			}
		}
	}

	/** What the program has changed of the built-ins it shares, by name (as of the last time its code was left). */
	public changed(): string[] {
		return this.layer.map((change) => this.named(change));
	}

	private named({ at, key }: Change): string {
		const { name } = this.pristine[at];

		if (key === undefined) {
			return `${name}'s prototype`;
		}

		return typeof key === "symbol"
			? `${name}[${String(key.description)}]`
			: `${name}.${key}`;
	}
}
