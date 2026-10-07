/**
 * Stepped async's event loop (VMOptions.eventLoop) — deterministic: the same program, started at the same time with the
 * same seed, runs the same way every time, and so does every fork of it.
 *
 * Between tasks the machine runs what settled first (promise jobs, in the order they settled), then timers —
 * `setTimeout`, `setInterval`, `setImmediate` — in order of their due time on a VIRTUAL clock, ties by when they were
 * set; a timer's callback is a job of its own on the main stack, steppable. The clock moves only when a timer fires
 * (to its due time), so `Date` and `Date.now()` read it, not the host's; `Math.random()` is a seeded generator. What
 * the wait costs is the host's choice (`pace`): `"real"` waits each timer's real delay (a service ticks as it does for
 * real), `"fast"` none (a test's waits are free) — the order is the same either way.
 *
 * The intrinsics are host functions that act on the machine calling them, not on one they close over (`INTRINSICS`,
 * which `invokeHost` checks first): a fork's guest code sets its timers on the fork, reads the fork's clock.
 *
 * What a host call returns as a promise (a fetch, a file read) is EXTERNAL: when it settles isn't the program's to say.
 * Its settlement is an event of its own, delivered between tasks like a timer — and where several could come next (two
 * results in, or a result and the next timer), which does is a CHOICE, made by `choose` (the first by default: results
 * in the order they were asked for, then the timer), recorded, and replayable (`schedule`). So a race between results,
 * or a result and a timeout, is a choice point, and every way it can go is a schedule to run (explore.ts).
 */
import type { GuestFunction } from "./values.ts";
import { isGuestFunction } from "./values.ts";

/** How the event loop starts: its clock (ms since the epoch; the host's now by default), the random generator's seed
 *  (the host's random by default) — a host that wants a run again records both — and what a wait costs. */
export interface EventLoopOptions {
	"now"?: number;
	"seed"?: number;
	"pace"?: "real" | "fast";
	/** At each choice point (more than one event could come next), which: an index into `candidates`. The first, by
	 *  default. `index`: the choice point's number in the run. */
	"choose"?: (candidates: Candidate[], index: number) => number;
	/** The choices to make, by choice point (a run's `choices`, picked) — the first beyond them. */
	"schedule"?: number[];
}

/** An event that could come next: a host call's result (by what was called), or the next timer. */
export interface Candidate { "kind": "result" | "timer"; "label": string }

/** A host call's promised result, outstanding: what was called, and — once it's in — how to deliver it (settle the
 *  promise the program got). */
export interface Result { "id": number; "label": string; "deliver"?: () => void }

/** A choice made: how many events could have come next, and which did. */
export interface Choice { "candidates": Candidate[]; "picked": number }

/** A timer: when it's due on the virtual clock, its place among timers due then, what it calls, its delay, and whether
 *  it repeats (an interval). An unref'd one doesn't keep the program alive. */
export interface Timer { "id": number; "due": number; "seq": number; "fn": unknown; "args": unknown[]; "delay": number; "interval": boolean; "ref": boolean }

/** A machine's event loop: its own (a fork copies it). `checkpoint`: a real turn of the host's event loop has passed
 *  since the machine went idle — the host's microtasks are flushed, so a timer may fire. */
export interface Loop {
	"clock": number;
	"seq": number;
	"ids": number;
	"timers": Map<number, Timer>;
	/** Host calls' results the program is owed, by id (the order they were asked for). */
	"results": Map<number, Result>;
	"rng": number;
	"pace": "real" | "fast";
	"checkpoint": boolean;
	"token": number;
	/** The choices made so far, in order. */
	"choices": Choice[];
	"choose": ((candidates: Candidate[], index: number) => number) | undefined;
	"schedule": number[] | undefined;
}

/** What an intrinsic needs of the machine calling it. */
export interface LoopMachine {
	"loop": Loop | undefined;
	"deferCallback": (fn: GuestFunction) => (...args: unknown[]) => Promise<unknown>;
}

/** An intrinsic's behavior, given the machine calling it: what `invokeHost` runs instead of calling the function. */
export type Intrinsic = (machine: LoopMachine, thisArg: unknown, args: unknown[], isConstruct: boolean) => unknown;

/** The event loop's intrinsics, by the host function standing for each. */
export const INTRINSICS = new WeakMap<object, Intrinsic>();

/** The host's own timer, for the real waits (captured before anything could replace the global). */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const RealDate = Date;
const TIMER_ID = Symbol("tsval.timer");

export function createLoop(options: EventLoopOptions): Loop {
	return {
		"clock": options.now ?? RealDate.now(),
		"seq": 0,
		"ids": 0,
		"timers": new Map(),
		"results": new Map(),
		"rng": (options.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0,
		"pace": options.pace ?? "real",
		"checkpoint": false,
		"token": 0,
		"choices": [],
		"choose": options.choose,
		"schedule": options.schedule
	};
}

/** Which of `candidates` comes next — the schedule's, else the policy's, else the first — recorded when there was a
 *  choice. */
export function choose(loop: Loop, candidates: Candidate[]): number {
	if (candidates.length < 2) {
		return 0;
	}

	const index = loop.choices.length;
	const wanted = loop.schedule?.[index] ?? loop.choose?.(candidates, index) ?? 0;
	const picked = Number.isInteger(wanted) && wanted >= 0 && wanted < candidates.length ? wanted : 0;

	loop.choices.push({ "candidates": candidates, "picked": picked });

	return picked;
}

/** A copy of `loop` for a fork: its timers' callbacks and arguments cloned as the fork's other values are. */
export function forkLoop(loop: Loop, clone: (value: unknown) => unknown): Loop {
	return { ...loop, "timers": new Map([...loop.timers].map(([id, timer]) => [id, { ...timer, "fn": clone(timer.fn), "args": timer.args.map(clone) }])), "results": new Map(loop.results), "checkpoint": false, "choices": [...loop.choices] };
}

/** The next timer to fire: the earliest due, the first set among those. */
export function nextTimer(loop: Loop): Timer | undefined {
	let next: Timer | undefined;

	for (const timer of loop.timers.values()) {
		if (next === undefined || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq)) {
			next = timer;
		}
	}

	return next;
}

/** The results that are in, waiting to be delivered, in the order they were asked for. */
export function arrived(loop: Loop): Result[] {
	return [...loop.results.values()].filter((result) => result.deliver !== undefined).sort((a, b) => a.id - b.id);
}

/** Whether a timer keeps the program alive. */
export function hasRefTimers(loop: Loop): boolean {
	return [...loop.timers.values()].some((timer) => timer.ref);
}

/** Take the next timer off the loop to fire, the clock moved to its due time (an interval set again from there). */
export function takeTimer(loop: Loop): Timer | undefined {
	const timer = nextTimer(loop);

	if (timer === undefined) {
		return undefined;
	}

	loop.clock = Math.max(loop.clock, timer.due);

	if (timer.interval) {
		loop.seq += 1;
		loop.timers.set(timer.id, { ...timer, "due": loop.clock + timer.delay, "seq": loop.seq });
	} else {
		loop.timers.delete(timer.id);
	}

	return timer;
}

/** What a timer is, as a candidate. */
export function timerLabel(loop: Loop, timer: Timer): string {
	return `${timer.interval ? "setInterval" : timer.delay === 0 ? "setImmediate" : "setTimeout"} ${timer.delay}ms (at +${timer.due - loop.clock}ms)`;
}

/** A wait for the next event: the next real turn when a result is in (`ready`) or `pace` is `"fast"`, else the next
 *  timer's real delay — after which an event may come (`checkpoint`). Undefined with nothing to wait for. A newer wait
 *  makes an older one's moot. */
export function waitForTurn(loop: Loop, ready: boolean): Promise<void> | undefined {
	const timer = nextTimer(loop);

	if (timer === undefined && !ready) {
		return undefined;
	}

	loop.token += 1;

	const { token } = loop;

	return new Promise((resolve) => {
		realSetTimeout(() => {
			if (loop.token === token) {
				loop.checkpoint = true;
			}

			resolve();
		}, ready || loop.pace === "fast" || timer === undefined ? 0 : Math.max(0, timer.due - loop.clock));
	});
}

/** The next random number in [0, 1) of the loop's seeded generator (mulberry32). */
function random(loop: Loop): number {
	loop.rng = (loop.rng + 0x6D2B79F5) >>> 0;

	let t = loop.rng;

	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Register `fn` as an intrinsic acting by `behavior`. */
function intrinsic<F extends object>(fn: F, behavior: Intrinsic): F {
	INTRINSICS.set(fn, behavior);

	return fn;
}

const loopOf = (machine: LoopMachine): Loop => {
	if (machine.loop === undefined) {
		throw new TypeError("tsval: no event loop (VMOptions.eventLoop)");
	}

	return machine.loop;
};

/** A timer's handle, as Node's: `ref`/`unref`/`hasRef`/`refresh`, and its id as a number. */
const handleMethods = {
	"ref": intrinsic(function ref(this: unknown) { return this; }, (machine, handle) => { setRef(machine, handle, true); return handle; }),
	"unref": intrinsic(function unref(this: unknown) { return this; }, (machine, handle) => { setRef(machine, handle, false); return handle; }),
	"hasRef": intrinsic(function hasRef() { return true; }, (machine, handle) => loopOf(machine).timers.get(idOf(handle))?.ref ?? false),
	"refresh": intrinsic(function refresh(this: unknown) { return this; }, (machine, handle) => {
		const loop = loopOf(machine);
		const timer = loop.timers.get(idOf(handle));

		if (timer !== undefined) {
			loop.seq += 1;
			loop.timers.set(timer.id, { ...timer, "due": loop.clock + timer.delay, "seq": loop.seq });
		}

		return handle;
	})
};

function setRef(machine: LoopMachine, handle: unknown, ref: boolean): void {
	const timer = loopOf(machine).timers.get(idOf(handle));

	if (timer !== undefined) {
		timer.ref = ref;
	}
}

function idOf(handle: unknown): number {
	return typeof handle === "object" && handle !== null && TIMER_ID in handle ? (handle as { [TIMER_ID]: number })[TIMER_ID] : Number(handle);
}

function handleFor(id: number): object {
	return { [TIMER_ID]: id, ...handleMethods, [Symbol.toPrimitive]: () => id };
}

/** Set a timer due `delay` from now (Node's: at least 1ms; setImmediate's, now), calling `fn` with `args`. */
function setTimer(machine: LoopMachine, fn: unknown, delay: number, args: unknown[], interval: boolean): object {
	const loop = loopOf(machine);

	if (typeof fn !== "function") {
		throw new TypeError("The \"callback\" argument must be of type function");
	}

	loop.ids += 1;
	loop.seq += 1;
	loop.timers.set(loop.ids, { "id": loop.ids, "due": loop.clock + delay, "seq": loop.seq, "fn": fn, "args": args, "delay": delay, "interval": interval, "ref": true });

	return handleFor(loop.ids);
}

const delayOf = (value: unknown): number => {
	const delay = Number(value);

	return Number.isFinite(delay) && delay >= 1 ? Math.floor(delay) : 1;
};

const clear = intrinsic(function clearTimer() { /* the machine's */ }, (machine, _thisArg, [handle]) => { loopOf(machine).timers.delete(idOf(handle)); });

/** The intrinsic `Date`: `new Date()` and `Date.now()` on the virtual clock; with arguments, and as a value
 *  (`instanceof`, its prototype), the real one. Called directly (a subclass's `super()`), it falls back to the host's
 *  clock — no machine to read. */
const VirtualDate = intrinsic(function Date(this: unknown, ...args: unknown[]) {
	return new.target === undefined ? new RealDate().toString() : Reflect.construct(RealDate, args, new.target);
}, (machine, _thisArg, args, isConstruct) => {
	const date = args.length === 0 ? new RealDate(loopOf(machine).clock) : new RealDate(...args as [number]);

	return isConstruct ? date : date.toString();
}) as unknown as DateConstructor;

Object.defineProperties(VirtualDate, {
	"prototype": { "value": RealDate.prototype },
	"now": { "value": intrinsic(function now() { return RealDate.now(); }, (machine) => loopOf(machine).clock), "writable": true, "configurable": true },
	"parse": { "value": RealDate.parse, "writable": true, "configurable": true },
	"UTC": { "value": RealDate.UTC, "writable": true, "configurable": true }
});

/** The intrinsic `Math`: the host's, with `random` the loop's seeded generator. */
const VirtualMath = Object.defineProperties(Object.create(Object.getPrototypeOf(Math) as object) as Math, {
	...Object.getOwnPropertyDescriptors(Math),
	"random": { "value": intrinsic(function random() { return Math.random(); }, (machine) => random(loopOf(machine))), "writable": true, "configurable": true }
});

/** The globals an event loop gives the guest. */
export function loopGlobals(): Record<string, unknown> {
	return {
		"setTimeout": intrinsic(function setTimeout() { /* the machine's */ }, (machine, _thisArg, [fn, delay, ...args]) => setTimer(machine, fn, delayOf(delay), args, false)),
		"setInterval": intrinsic(function setInterval() { /* the machine's */ }, (machine, _thisArg, [fn, delay, ...args]) => setTimer(machine, fn, delayOf(delay), args, true)),
		"setImmediate": intrinsic(function setImmediate() { /* the machine's */ }, (machine, _thisArg, [fn, ...args]) => setTimer(machine, fn, 0, args, false)),
		"clearTimeout": clear,
		"clearInterval": clear,
		"clearImmediate": clear,
		// A microtask: a job run after the current one, in turn with the promise jobs that settle before it.
		"queueMicrotask": intrinsic(function queueMicrotask() { /* the machine's */ }, (machine, _thisArg, [fn]) => {
			if (typeof fn !== "function") {
				throw new TypeError("The \"callback\" argument must be of type function");
			}

			const run = isGuestFunction(fn) ? machine.deferCallback(fn as GuestFunction) : fn as () => unknown;

			void Promise.resolve().then(() => run());
		}),
		"Date": VirtualDate,
		"Math": VirtualMath
	};
}
