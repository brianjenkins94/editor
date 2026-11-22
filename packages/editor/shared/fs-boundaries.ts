export interface Call { "boundary": string; "operation": string; "caller": string; "ms": number; "path"?: string; "bytes": number }

const traces = ((globalThis as Record<symbol, unknown>)[Symbol.for("editor.fs-traces")] ??= new Set()) as Set<(call: Call) => void>;

interface Tally { "calls": number; "ms": number; "bytes": number; "paths": Set<string> }

const MOST_PATHS = 50_000;

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

export function countCall(boundary: string, operation: string, caller: string, ms: number, path?: string, bytes = 0): void {
	const tally = tallyOf(boundary, operation, caller);

	tally.calls += 1;
	tally.ms += ms;
	tally.bytes += bytes;

	if (path !== undefined && tally.paths.size < MOST_PATHS) {
		tally.paths.add(path);
	}

	if (traces.size > 0) {
		const call: Call = { "boundary": boundary, "operation": operation, "caller": caller, "ms": ms, "path": path, "bytes": bytes };

		for (const see of traces) {
			see(call);
		}
	}
}

export function traceCalls(see: (call: Call) => void): () => void {
	traces.add(see);

	return () => {
		traces.delete(see);
	};
}

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
