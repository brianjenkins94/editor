export function coalesce<T, R>(keyOf: (request: T) => string, decide: (request: T) => Promise<R>): (request: T) => Promise<R> {
	const waiting = new Map<string, Promise<R>>();

	return (request) => {
		const key = keyOf(request);
		const pending = waiting.get(key);

		if (pending !== undefined) {
			return pending;
		}

		const decision = decide(request).finally(() => {
			waiting.delete(key);
		});

		waiting.set(key, decision);

		return decision;
	};
}
