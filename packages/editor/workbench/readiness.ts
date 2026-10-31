/**
 * How far the editor has come up, as stages a part can wait on before it acts — rather than acting as soon as it's
 * registered and waiting out whatever isn't up yet. Each stage is reached once, when it is:
 *
 * - `workspace`: the workspace's store is mounted, and what it kept restored (workspace-fs.ts).
 * - `api`: the bridge has handed core VS Code's API (everything core does in VS Code is done through it).
 * - `debugger`: a debug run can start — tsval is active, and the bridge answers the workspace runtime's link
 *   (`runtime.fs.attach`), which every debugger's worker asks for first. While the page is busy loading, the bridge
 *   (on the page's own thread) can be minutes from that.
 */

export const STAGES = ["workspace", "api", "debugger"] as const;

export type Stage = typeof STAGES[number];

const reached = new Set<Stage>();
const waiters = new Map<Stage, (() => void)[]>();

/** `stage` is reached (again: no change). */
export function markReady(stage: Stage): void {
	if (reached.has(stage)) {
		return;
	}

	reached.add(stage);

	for (const wake of waiters.get(stage) ?? []) {
		wake();
	}

	waiters.delete(stage);
}

/** Settles once `stage` is reached. */
export async function whenReady(stage: Stage): Promise<void> {
	if (reached.has(stage)) {
		return;
	}

	await new Promise<void>((resolve) => {
		waiters.set(stage, [...waiters.get(stage) ?? [], resolve]);
	});
}

/** Wait for `stages` until `timeoutMs`: the ones still missing then (none, when all came). */
export async function waitFor(stages: readonly Stage[], timeoutMs: number, signal?: AbortSignal): Promise<Stage[]> {
	const deadline = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);

		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { "once": true });
	});

	await Promise.race([Promise.all(stages.map(whenReady)), deadline]);

	return stages.filter((stage) => !reached.has(stage));
}
