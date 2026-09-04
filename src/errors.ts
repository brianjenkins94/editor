/**
 * An interpreter-internal failure (an unimplemented node kind, a broken invariant) — as opposed to a
 * guest runtime error. These are never converted into catchable guest `throw`s; they propagate to the
 * host so gaps and bugs fail loud (ASSIGNMENT working style).
 */
export class TsvalInternalError extends Error {
	override name = "TsvalInternalError";
}

/** Throw an interpreter-internal "not yet implemented" error. */
export function unimplemented(what: string): never {
	throw new TsvalInternalError(`unimplemented: ${what}`);
}
