/**
 * The workbench's architecture store: every context's `$sys.arch` reports over the hub tree (observability's
 * ArchitectureStore) — the realms, hubs, workers and channels running, and the traffic between them. The metrics name
 * workers by it (editor-metrics.ts), and scripts driving the editor read it as `globalThis.__architecture`: the
 * architecture harness's boot check and its snapshots.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import { ArchitectureStore, collectArchReports, requestArchSync } from "@brianjenkins94/observability";

let shared: ArchitectureStore | undefined;

export interface ArchitectureHandle {
	"hub": Hub;
	/** An RPC into the hub tree, for a script driving the editor. */
	"request": (subject: string, data?: unknown, timeoutMs?: number) => Promise<unknown>;
	"snapshot": () => unknown;
}

/** The workbench's architecture store — made on first use: it hears every reporter and asks them for a sync. */
export function architectureStore(hub: Hub): ArchitectureStore {
	if (shared === undefined) {
		const store = new ArchitectureStore();

		shared = store;
		collectArchReports(hub, (report) => {
			store.apply(report);
		});
		// The subscription's interest has to reach the other hubs before they're asked to answer.
		setTimeout(() => {
			requestArchSync(hub);
		}, 200);

		const rpc = createRpcClient(hub);

		// eslint-disable-next-line ts/naming-convention -- the global the architecture harness and scripts read
		(globalThis as unknown as { "__architecture": ArchitectureHandle }).__architecture = {
			"hub": hub,
			"request": async (subject, data, timeoutMs) => rpc.request(subject, data, { "timeoutMs": timeoutMs, "waitForResponderMs": 5000 }),
			"snapshot": () => store.snapshot()
		};
	}

	return shared;
}
