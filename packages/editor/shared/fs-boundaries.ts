/**
 * The filesystems' boundaries, counted (packages/editor/ARCHITECTURE.md, *Visibility*): each call that crosses one — VS
 * Code's file service into a provider, a store operation of zen-fs's, the write-back to IndexedDB — by boundary,
 * operation and caller, with how many calls, how long they took, how many distinct paths they named and how many bytes
 * they carried. Hot paths are counted, not spanned (CLAUDE.md, *Spans*): thousands of calls a second each add to a
 * total, and the totals are one gauge on the metrics plane (`fs`: `<boundary>.<op>.<caller>.calls`, `.ms`, `.paths`,
 * `.bytes`), so `metrics_query` says how many calls a load made per path, and whose they were.
 */

/** One boundary, operation and caller's totals. */
interface Tally { "calls": number; "ms": number; "bytes": number; "paths": Set<string> }

/** The distinct paths remembered per tally, at most: past it, `paths` says at least this many. */
const MOST_PATHS = 50_000;

/** The totals, on the realm's global: one for every bundle loaded into it (the workbench's, the bridge's), which the
 *  workbench's gauge reports. */
const tallies = ((globalThis as Record<symbol, unknown>)[Symbol.for("editor.fs-boundaries")] ??= new Map()) as Map<string, Tally>;

function tallyOf(boundary: string, operation: string, caller: string): Tally {
	const key = `${boundary}.${operation}.${caller}`;
	let tally = tallies.get(key);

	if (tally === undefined) {
		tally = { "calls": 0, "ms": 0, "bytes": 0, "paths": new Set() };
		tallies.set(key, tally);
	}

	return tally;
}

/** A call of `operation` at `boundary` by `caller` that took `ms`, of `path` (when it names one), carrying `bytes`. */
export function countCall(boundary: string, operation: string, caller: string, ms: number, path?: string, bytes = 0): void {
	const tally = tallyOf(boundary, operation, caller);

	tally.calls += 1;
	tally.ms += ms;
	tally.bytes += bytes;

	if (path !== undefined && tally.paths.size < MOST_PATHS) {
		tally.paths.add(path);
	}
}

/** `run` timed as a call of `operation` at `boundary` by `caller`, of `path`: to its return, or to its promise settling. */
export function timeCall<T>(boundary: string, operation: string, caller: string, path: string | undefined, run: () => T): T {
	const started = performance.now();
	const done = (): void => {
		countCall(boundary, operation, caller, performance.now() - started, path);
	};

	let result: T;

	try {
		result = run();
	} catch (error) {
		done();

		throw error;
	}

	if (result instanceof Promise) {
		return result.finally(done) as T;
	}

	done();

	return result;
}

/** The totals since this realm started, as the `fs` gauge reads them: four numbers per boundary, operation and caller. */
export function fsGauge(): Record<string, number> {
	const values: Record<string, number> = {};

	for (const [key, tally] of tallies) {
		values[key + ".calls"] = tally.calls;
		values[key + ".ms"] = Math.round(tally.ms);
		values[key + ".paths"] = tally.paths.size;
		values[key + ".bytes"] = tally.bytes;
	}

	return values;
}
