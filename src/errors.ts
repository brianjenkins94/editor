/**
 * Marker for errors that must propagate to the host uncaught — never converted into a catchable guest
 * `throw` by the step loop. Used for interpreter-internal failures and for canary aborts (so guest
 * code can't swallow the tripwire with its own try/catch).
 */
export const UNCATCHABLE: unique symbol = Symbol("tsval.uncatchable");

/**
 * An interpreter-internal failure (an unimplemented node kind, a broken invariant) — as opposed to a
 * guest runtime error. These are never converted into catchable guest `throw`s; they propagate to the
 * host so gaps and bugs fail loud (ASSIGNMENT working style).
 */
export class TsvalInternalError extends Error {
	override name = "TsvalInternalError";
	readonly [UNCATCHABLE] = true;
}

/** Throw an interpreter-internal "not yet implemented" error. */
export function unimplemented(what: string): never {
	throw new TsvalInternalError(`unimplemented: ${what}`);
}

/** True for errors the step loop must rethrow to the host rather than turn into a guest `throw`. */
export function isUncatchable(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as Record<PropertyKey, unknown>)[UNCATCHABLE] === true;
}
