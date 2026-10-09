/**
 * One answer for the same question asked at once: calls with the same key, while the first is still waiting, share its
 * promise — so six peer connections opened together raise one capability prompt, not six queued after each other.
 * Once it settles, the next call asks afresh (what an answer means for later calls — "Allow once" for the session,
 * "Allow always" in the policy — is the broker's and the policy's to remember, not this).
 */
export function coalesce<T, R>(keyOf: (request: T) => string, decide: (request: T) => Promise<R>): (request: T) => Promise<R> {
	const waiting = new Map<string, Promise<R>>();

	return (request) => {
		const key = keyOf(request);
		const pending = waiting.get(key);

		if (pending !== undefined) {
			return pending;
		}

		const decision = decide(request).finally(() => { waiting.delete(key); });

		waiting.set(key, decision);

		return decision;
	};
}
