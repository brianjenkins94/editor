/**
 * Wait for what a test needs to have happened, not for a fixed time. A loaded CI runner can take longer than any fixed
 * sleep to deliver a message, and a sleep that resolves too early fails a test that would have passed — or, if cleanup
 * came after the assertion, hangs it. So: poll `probe` until it returns something truthy and resolve to that, or fail
 * after `timeoutMs` saying what never happened.
 */
export async function until<T>(what: string, probe: () => T, timeoutMs = 5000): Promise<NonNullable<T>> {
	for (const deadline = Date.now() + timeoutMs; ;) {
		const value = probe();

		if (value) {
			return value;
		}

		if (Date.now() > deadline) {
			throw new Error("timed out waiting for " + what);
		}

		await new Promise((resolve) => { setTimeout(resolve, 5); });
	}
}

/** Let time pass for a scenario's sake — reporters flushing to nobody, a peer still booting. Not for waiting on a delivery:
 *  that's `until`. */
export function elapse(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}
