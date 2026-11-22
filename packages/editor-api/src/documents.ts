/**
 * Documents opened, counted by who opened them. Opening a document is never free: whoever listens for documents — a
 * linter, a type checker, a spell checker — starts on it, tab or no tab, so a sweep that opens a workspace's files to
 * read them queues the whole workspace on each (packages/editor's growth warnings did: ESLint's worker past 2 GB, the
 * tab out of memory). Counted, not spanned — a sweep is thousands (CLAUDE.md, *Spans*) — as a gauge on the metrics plane,
 * `documents.<caller>.opened`, `.ms` (to each settling) and `.paths` (distinct), so `metrics_query` names the sweep.
 *
 * The caller is the function that asked, as its stack says (a class's method as `Class/method`): the editor builds with
 * its names kept, minified or not. An extension counts its own by handing `observeExtension` its `vscode`.
 */
import type { Gauge } from "@brianjenkins94/observability";

/** What's counted of an API: its `workspace.openTextDocument`. */
interface Api { "workspace": { "openTextDocument": (...args: never[]) => unknown } }

/** A frame of a stack as V8 hands it to `Error.prepareStackTrace`. */
interface CallSite { "getTypeName": () => string | null; "getFunctionName": () => string | null }

/** Names on a stack that say nothing of who asked: a language's own, or the way through a callback. */
const NOBODY = new Set(["Object", "Array", "Promise", "Map", "Set", "Function", "Generator", "AsyncGenerator", "Window", "global", "DedicatedWorkerGlobalScope", "map", "forEach", "all", "then", "flatMap", "filter", "next", "step", "fulfilled", "rejected", "__awaiter", "eval"]);

/** The distinct paths remembered per caller, at most. */
const MOST_PATHS = 50_000;

/** Its name, so it's past this on a stack. */
const WRAPPER = "openTextDocumentCounted";

/** V8's Error, whose stack can be had as its call sites. */
const V8Error = Error as ErrorConstructor & { "prepareStackTrace"?: (error: Error, frames: CallSite[]) => unknown; "stackTraceLimit": number };

/** The function asking, from the stack as it calls in. */
function callerOf(): string {
	const prepare = V8Error.prepareStackTrace;
	const limit = V8Error.stackTraceLimit;
	let sites: CallSite[] | string | undefined;

	V8Error.prepareStackTrace = (_, frames) => frames;
	V8Error.stackTraceLimit = 20;

	try {
		sites = new Error("caller").stack as unknown as CallSite[] | string | undefined;
	} finally {
		V8Error.prepareStackTrace = prepare;
		V8Error.stackTraceLimit = limit;
	}

	if (!Array.isArray(sites)) {
		return "unknown";
	}

	let past = false;

	for (const site of sites) {
		const name = site.getFunctionName();

		if (name === WRAPPER) {
			past = true;
		} else if (past && name !== null && name !== "" && !NOBODY.has(name)) {
			const type = site.getTypeName();

			return type !== null && !NOBODY.has(type) && type !== name ? `${type}/${name}` : name;
		}
	}

	return "anonymous";
}

/** The path a call names: a Uri's, a file name, or nothing (an untitled document). */
function pathOf(target: unknown): string | undefined {
	if (typeof target === "string") {
		return target;
	}

	return typeof (target as { "path"?: unknown } | undefined)?.path === "string" ? (target as { "path": string }).path : undefined;
}

/**
 * `api`'s documents opened from now on, counted by caller: its `workspace.openTextDocument` replaced by one that counts
 * and calls it. `first` is told on the first one (to start reporting only once there's something to report). The gauge
 * reads the totals so far; undefined when `api`'s workspace can't be added to (a frozen one), or it's counted already.
 */
export function countDocumentOpens(api: Api, first?: () => void): Gauge | undefined {
	const tallies = new Map<string, { "opened": number; "ms": number; "paths": Set<string> }>();
	const open = api.workspace.openTextDocument;

	if ((open as { "counted"?: true }).counted === true) {
		return undefined;
	}

	const counted = {
		[WRAPPER](...args: never[]): unknown {
			const caller = callerOf();
			const started = performance.now();
			let tally = tallies.get(caller);

			if (tally === undefined) {
				tally = { "opened": 0, "ms": 0, "paths": new Set() };
				tallies.set(caller, tally);
			}

			if (tallies.size === 1 && tally.opened === 0) {
				first?.();
			}

			tally.opened += 1;

			const path = pathOf(args[0]);

			if (path !== undefined && tally.paths.size < MOST_PATHS) {
				tally.paths.add(path);
			}

			const kept = tally;
			const done = (): void => { kept.ms += performance.now() - started; };
			const result = open.apply(api.workspace, args);

			Promise.resolve(result).then(done, done);

			return result;
		}
	}[WRAPPER] as typeof open & { "counted"?: true };

	counted.counted = true;

	try {
		api.workspace.openTextDocument = counted;
	} catch {
		return undefined;
	}

	if (api.workspace.openTextDocument !== counted) {
		return undefined;
	}

	return () => {
		const values: Record<string, number> = {};

		for (const [caller, tally] of tallies) {
			values[`${caller}.opened`] = tally.opened;
			values[`${caller}.ms`] = Math.round(tally.ms);
			values[`${caller}.paths`] = tally.paths.size;
		}

		return tallies.size === 0 ? undefined : values;
	};
}
