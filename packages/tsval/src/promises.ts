/**
 * Stepped async's promise jobs, the machine's own (README.md, *The event loop*): a promise the program makes is a host
 * Promise — a package's promises and the program's pass the same `instanceof`, and native code awaiting one works —
 * but its state is kept here too, and what reacts to it (`then`, `await`, a thenable it adopts, `queueMicrotask`) is a
 * job in the machine's queue, in the order ECMAScript gives them (PerformPromiseThen, NewPromiseReactionJob,
 * NewPromiseResolveThenableJob). So the order is tsval's, the same on any host: V8's queue, or another tsval's.
 *
 * A promise this doesn't know (a package's, made natively) is the boundary: what reacts to it goes through the host's
 * own `then`, and comes back as a job when the host calls it — as before.
 */

/** A promise's capability: it, and the functions that settle it. */
export interface Capability { "promise": Promise<unknown>; "resolve": (value: unknown) => void; "reject": (reason: unknown) => void }

/** What a reaction's job settles with what its handler returns: the promise `then` made's settling functions. */
export type Settlers = Pick<Capability, "resolve" | "reject">;

/** How a pending job is given its turn (vm.ts `Settlement`, these kinds): `then`'s handlers with what the promise
 *  settled as (and the promise `then` returned, to settle with what the handler returns), or host work. */
export type JobInput =
	| { "kind": "fulfilled" | "rejected"; "value": unknown; "derived"?: Settlers }
	| { "kind": "next" | "throw"; "value": unknown }
	| { "kind": "run"; "run": () => void };

/** The machine a job is made on: its realm, and its queue's pending jobs (made now, so a fork that copies them runs its
 *  own) — `then`'s handlers, an `await`'s fiber (its id), or host work. */
export interface JobHost {
	readonly "realm": { readonly "Promise": PromiseConstructor; readonly "Array": ArrayConstructor };
	reactionJob: (onFulfilled: unknown, onRejected: unknown, onFinally?: unknown, species?: unknown) => number;
	hostJob: () => number;
	settleJob: (id: number, input: JobInput) => void;
}

/** What reacts to a promise: a pending job, given its turn when the promise settles; an `await`'s is its fiber. */
interface Reaction { "id": number; "fiber": boolean; "derived"?: Capability }

interface PromiseRecord {
	"state": "pending" | "fulfilled" | "rejected";
	"value": unknown;
	"reactions": Reaction[];
	/** its host settling functions: the host promise settles with it, for native code that awaits it */
	"native": { "resolve": (value: unknown) => void; "reject": (reason: unknown) => void };
	/** a host handler is on it: a rejection something here handles isn't the host's unhandled one */
	"handled": boolean;
	/** the machine it was made on: a thenable it adopts is a job there */
	"machine": JobHost;
}

const noop = (): void => { /* a rejection something here handles */ };

const isObject = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

/** The settling functions this made — a callback's, or an async function's, settles by them. */
const own = new WeakSet<(value: unknown) => void>();

export function isOwnResolve(resolve: unknown): boolean {
	return typeof resolve === "function" && own.has(resolve as (value: unknown) => void);
}

/** The promises a machine and its forks made, by their host promise. */
export class OwnPromises {
	private readonly records = new WeakMap<object, PromiseRecord>();

	public knows(promise: unknown): promise is Promise<unknown> {
		return isObject(promise) && this.records.has(promise);
	}

	/** NewPromiseCapability(%Promise%): a promise, pending, and its settling functions. */
	public capability(machine: JobHost, newTarget: unknown = machine.realm.Promise): Capability {
		let resolveNative!: (value: unknown) => void;
		let rejectNative!: (reason: unknown) => void;
		const executor = (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => { resolveNative = resolve; rejectNative = reject; };
		const promise = (newTarget === machine.realm.Promise ? new machine.realm.Promise<unknown>(executor) : Reflect.construct(machine.realm.Promise, [executor], newTarget as new () => unknown)) as Promise<unknown>;
		const record: PromiseRecord = { "state": "pending", "value": undefined, "reactions": [], "native": { "resolve": resolveNative, "reject": rejectNative }, "handled": false, "machine": machine };

		this.records.set(promise, record);

		return { "promise": promise, ...this.resolving(promise, record) };
	}

	/** NewPromiseCapability(C): %Promise%'s, or a subclass's, made by constructing it (its `super()` is this one's). */
	public capabilityOf(machine: JobHost, constructor: unknown): Capability {
		if (constructor === machine.realm.Promise) {
			return this.capability(machine);
		}

		let resolve: unknown;
		let reject: unknown;
		const promise = Reflect.construct(constructor as new (executor: unknown) => unknown, [(settleWith: unknown, failWith: unknown) => {
			if (resolve !== undefined || reject !== undefined) {
				throw new TypeError("Promise executor has already been invoked with non-undefined arguments");
			}

			resolve = settleWith;
			reject = failWith;
		}]) as Promise<unknown>;

		if (typeof resolve !== "function" || typeof reject !== "function") {
			throw new TypeError("Promise resolve or reject function is not callable");
		}

		return { "promise": promise, "resolve": resolve as (value: unknown) => void, "reject": reject as (reason: unknown) => void };
	}

	/** `new Promise(executor)` (`newTarget` a subclass, for its `super()`): the executor given its settling functions;
	 *  what it throws rejects. */
	public construct(machine: JobHost, executor: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => unknown, isUncatchable: (error: unknown) => boolean, newTarget?: unknown): Promise<unknown> {
		const capability = this.capability(machine, newTarget);

		try {
			Reflect.apply(executor, undefined, [capability.resolve, capability.reject]);
		} catch (error) {
			if (isUncatchable(error)) {
				throw error;
			}

			capability.reject(error);
		}

		return capability.promise;
	}

	/** PromiseResolve(%Promise%, value): a promise as it is (this one's or a host's), else one resolved with `value`. */
	public resolved(machine: JobHost, value: unknown, constructor: unknown = machine.realm.Promise): Promise<unknown> {
		if (value instanceof machine.realm.Promise && (value as { "constructor"?: unknown }).constructor === constructor) {
			return value;
		}

		const capability = this.capabilityOf(machine, constructor);

		capability.resolve(value);

		return capability.promise;
	}

	public rejected(machine: JobHost, reason: unknown, constructor: unknown = machine.realm.Promise): Promise<unknown> {
		const capability = this.capabilityOf(machine, constructor);

		capability.reject(reason);

		return capability.promise;
	}

	/** Await(value) for fiber `id`: what it awaits reacts with the fiber — false where it's a host's promise this doesn't
	 *  know (the boundary: the host's `then`, as before). */
	public await(machine: JobHost, value: unknown, id: number): boolean {
		const promise = this.resolved(machine, value);
		const record = this.records.get(promise);

		if (record === undefined) {
			return false;
		}

		this.react(record, promise, { "id": id, "fiber": true });

		return true;
	}

	/** Await(value) for host work — `onFulfilled` or `onRejected` a job of `machine`'s when it settles (PerformPromiseThen,
	 *  nothing returned); a host's promise this doesn't know through its own `then` (the boundary). */
	public awaitWith(machine: JobHost, value: unknown, onFulfilled: (value: unknown) => void, onRejected: (reason: unknown) => void): void {
		const promise = this.resolved(machine, value);
		const record = this.records.get(promise);

		if (record === undefined) {
			Reflect.apply(machine.realm.Promise.prototype.then, promise, [onFulfilled, onRejected]);

			return;
		}

		this.react(record, promise, { "id": machine.reactionJob(onFulfilled, onRejected), "fiber": false });
	}

	/** `promise.then(onFulfilled, onRejected)`, a promise this made: the promise it returns its species' (a subclass's,
	 *  made by constructing it). */
	public then(machine: JobHost, promise: Promise<unknown>, onFulfilled: unknown, onRejected: unknown): Promise<unknown> {
		const derived = this.capabilityOf(machine, this.speciesOf(machine, promise));

		this.react(this.records.get(promise)!, promise, { "id": machine.reactionJob(onFulfilled, onRejected), "fiber": false, "derived": derived });

		return derived.promise;
	}

	/** `promise.finally(onFinally)`, a promise this made: `onFinally` is the job's, called with nothing; then the promise
	 *  settles as this one did, once what it returned has (vm.ts resumes it). */
	public finally(machine: JobHost, promise: Promise<unknown>, onFinally: unknown): Promise<unknown> {
		if (typeof onFinally !== "function") {
			return this.invokeThen(machine, promise, onFinally, onFinally) as Promise<unknown>;
		}

		const species = this.speciesOf(machine, promise);
		const derived = this.capabilityOf(machine, species);

		this.react(this.records.get(promise)!, promise, { "id": machine.reactionJob(undefined, undefined, onFinally, species), "fiber": false, "derived": derived });

		return derived.promise;
	}

	/** What a `finally` callback returned, `result`: a promise that settles as `settled` did, once `result` has. */
	public afterFinally(machine: JobHost, result: unknown, settled: { "kind": "fulfilled" | "rejected"; "value": unknown }, constructor: unknown = machine.realm.Promise): Promise<unknown> {
		const awaited = this.resolved(machine, result, constructor);
		const thunk = settled.kind === "fulfilled" ? (): unknown => settled.value : (): never => { throw settled.value; };

		return this.invokeThen(machine, awaited, thunk, undefined) as Promise<unknown>;
	}

	/** Invoke(promise, "then", …): this one's `then` where it's %Promise.prototype.then% on a promise this made, else
	 *  whatever `then` it has. */
	public invokeThen(machine: JobHost, promise: unknown, onFulfilled: unknown, onRejected: unknown): unknown {
		const then = (promise as { "then"?: unknown }).then;

		if (then === machine.realm.Promise.prototype.then && this.knows(promise)) {
			return this.then(machine, promise, onFulfilled, onRejected);
		}

		return Reflect.apply(then as (...args: unknown[]) => unknown, promise, [onFulfilled, onRejected]);
	}

	/** Promise.all, allSettled, race and any, of %Promise%: each value resolved, its `then` invoked, as the spec's are. */
	public combine(machine: JobHost, kind: "all" | "allSettled" | "race" | "any", iterable: unknown, constructor: unknown = machine.realm.Promise): Promise<unknown> {
		const capability = this.capabilityOf(machine, constructor);
		const values: unknown[] = [];
		let remaining = 1;
		const done = (): void => {
			remaining -= 1;

			if (remaining > 0) {
				return;
			}

			if (kind === "any") {
				capability.reject(new AggregateError(machine.realm.Array.from(values), "All promises were rejected"));
			} else {
				capability.resolve(machine.realm.Array.from(values));
			}
		};

		try {
			let index = 0;

			for (const value of iterable as Iterable<unknown>) {
				const at = index;
				let called = false;
				const once = (settle: (result: unknown) => void) => (result: unknown): void => {
					if (called) {
						return;
					}

					called = true;
					settle(result);
				};

				index += 1;
				values.push(undefined);
				remaining += 1;

				const promise = this.resolved(machine, value, constructor);

				if (kind === "race") {
					this.invokeThen(machine, promise, capability.resolve, capability.reject);
				} else if (kind === "all") {
					this.invokeThen(machine, promise, once((result) => { values[at] = result; done(); }), capability.reject);
				} else if (kind === "allSettled") {
					this.invokeThen(machine, promise, once((result) => { values[at] = { "status": "fulfilled", "value": result }; done(); }), once((reason) => { values[at] = { "status": "rejected", "reason": reason }; done(); }));
				} else {
					this.invokeThen(machine, promise, capability.resolve, once((reason) => { values[at] = reason; done(); }));
				}
			}

			if (kind !== "race") {
				done();
			}
		} catch (error) {
			capability.reject(error);
		}

		return capability.promise;
	}

	/** SpeciesConstructor(promise, %Promise%). */
	private speciesOf(machine: JobHost, promise: Promise<unknown>): unknown {
		const constructor = (promise as { "constructor"?: unknown }).constructor;

		if (constructor === undefined) {
			return machine.realm.Promise;
		}

		if (!isObject(constructor)) {
			throw new TypeError("The .constructor property is not an object");
		}

		const species = (constructor as { [Symbol.species]?: unknown })[Symbol.species];

		return species === undefined || species === null ? machine.realm.Promise : species;
	}

	/** PerformPromiseThen: a reaction kept until the promise settles, or its job made now if it has. */
	private react(record: PromiseRecord, promise: Promise<unknown>, reaction: Reaction): void {
		if (record.state === "pending") {
			record.reactions.push(reaction);
		} else {
			this.trigger(record, reaction);
		}

		if (!record.handled && record.state !== "fulfilled") {
			record.handled = true;
			Reflect.apply(record.machine.realm.Promise.prototype.then, promise, [undefined, noop]);
		}
	}

	/** NewPromiseReactionJob: the reaction's job given its turn, with what the promise settled as. */
	private trigger(record: PromiseRecord, reaction: Reaction): void {
		const rejected = record.state === "rejected";

		record.machine.settleJob(reaction.id, reaction.fiber
			? { "kind": rejected ? "throw" : "next", "value": record.value }
			: { "kind": rejected ? "rejected" : "fulfilled", "value": record.value, ...reaction.derived === undefined ? {} : { "derived": reaction.derived } });
	}

	private settle(record: PromiseRecord, state: "fulfilled" | "rejected", value: unknown): void {
		const { reactions } = record;

		record.state = state;
		record.value = value;
		record.reactions = [];

		if (state === "fulfilled") {
			record.native.resolve(value);
		} else {
			record.native.reject(value);
		}

		for (const reaction of reactions) {
			this.trigger(record, reaction);
		}
	}

	/** CreateResolvingFunctions: a promise's resolve and reject, once between them; resolving with a thenable adopts it —
	 *  its `then` called in a job of its own (NewPromiseResolveThenableJob), in the async context it was resolved in. */
	private resolving(promise: Promise<unknown>, record: PromiseRecord): { "resolve": (value: unknown) => void; "reject": (reason: unknown) => void } {
		let already = false;
		const reject = (reason: unknown): void => {
			if (already) {
				return;
			}

			already = true;
			this.settle(record, "rejected", reason);
		};
		const resolve = (resolution: unknown): void => {
			if (already) {
				return;
			}

			already = true;

			if (resolution === promise) {
				this.settle(record, "rejected", new TypeError("Chaining cycle detected for promise #<Promise>"));

				return;
			}

			if (!isObject(resolution)) {
				this.settle(record, "fulfilled", resolution);

				return;
			}

			let then: unknown;

			try {
				then = (resolution as { "then"?: unknown }).then;
			} catch (error) {
				this.settle(record, "rejected", error);

				return;
			}

			if (typeof then !== "function") {
				this.settle(record, "fulfilled", resolution);

				return;
			}

			const { machine } = record;

			machine.settleJob(machine.hostJob(), { "kind": "run", "run": () => {
				const adopted = this.resolving(promise, record);

				try {
					if (then === machine.realm.Promise.prototype.then && this.knows(resolution)) {
						this.invokeThen(machine, resolution, adopted.resolve, adopted.reject);
					} else {
						Reflect.apply(then, resolution, [adopted.resolve, adopted.reject]);
					}
				} catch (error) {
					adopted.reject(error);
				}
			} });
		};

		own.add(resolve);
		own.add(reject);

		return { "resolve": resolve, "reject": reject };
	}
}
