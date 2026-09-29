/**
 * Every context's architecture reporter (binding): its hub's topology and traffic, plus — unless the realm is
 * already probed by another context (the pod shares the workbench realm) — its HTTP / WebSocket / IndexedDB traffic,
 * with URLs classified by the declared model. Reports ride `$sys.arch` to the live architecture view.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ArchReporter } from "@brianjenkins94/observability";
import { createArchReporter, installNetworkProbes } from "@brianjenkins94/observability";
import { classifyUrl, idbOwner } from "./architecture-model";

export function reportArchitecture(hub: Hub, options: { "network"?: boolean } = {}): ArchReporter {
	const reporter = createArchReporter(hub);

	if (options.network !== false) {
		installNetworkProbes(reporter, { "classifyUrl": classifyUrl, "idbOwner": idbOwner });
	}

	return reporter;
}
