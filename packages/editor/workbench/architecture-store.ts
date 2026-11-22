import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import { ArchitectureStore, collectArchReports, requestArchSync } from "@brianjenkins94/observability";

let shared: ArchitectureStore | undefined;

export interface ArchitectureHandle {
	"hub": Hub;
	"request": (subject: string, data?: unknown, timeoutMs?: number) => Promise<unknown>;
	"snapshot": () => unknown;
}

export function architectureStore(hub: Hub): ArchitectureStore {
	if (shared === undefined) {
		const store = new ArchitectureStore();

		shared = store;
		collectArchReports(hub, (report) => {
			store.apply(report);
		});
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
