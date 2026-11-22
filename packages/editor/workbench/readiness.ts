import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { rpcCallSubject } from "@brianjenkins94/hub";

export const STAGES = ["workspace", "api", "debugger", "versions"] as const;

export type Stage = typeof STAGES[number];

const reached = new Set<Stage>();
const waiters = new Map<Stage, (() => void)[]>();

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

export async function whenReady(stage: Stage): Promise<void> {
	if (reached.has(stage)) {
		return;
	}

	await new Promise<void>((resolve) => {
		waiters.set(stage, [...waiters.get(stage) ?? [], resolve]);
	});
}

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

export async function whenDebuggerUp(vscode: typeof vscodeApi, hub: Hub): Promise<void> {
	await vscode.extensions.getExtension("brianjenkins94.tsval")?.activate();

	while (!await hub.whenInterested(rpcCallSubject("runtime.fs.attach"), 60_000)) { /* still coming up */ }

	markReady("debugger");
}
