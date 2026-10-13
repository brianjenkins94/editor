/**
 * Every context's architecture reporter (binding): its hub's topology and traffic, plus — unless the realm is
 * already probed by another context (the pod shares the workbench realm) — its HTTP / WebSocket / IndexedDB traffic,
 * with URLs classified by the declared model. Reports ride `$sys.arch` to the live architecture view.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ArchReporter, NetworkProbeOptions } from "@brianjenkins94/observability";
import { createArchReporter, installNetworkProbes } from "@brianjenkins94/observability";
import { classifyUrl, idbOwner } from "./architecture-model";

/** How the editor's realms probe their network: URLs classified by the declared model (`observe(hub, { network })`). */
export const NETWORK_PROBES: NetworkProbeOptions = { "classifyUrl": classifyUrl, "idbOwner": idbOwner };

/** Just the architecture reporter, for a context that collects logs rather than relaying them (the root, the shell). */
export function reportArchitecture(hub: Hub): ArchReporter {
	const reporter = createArchReporter(hub);

	installNetworkProbes(reporter, NETWORK_PROBES);

	return reporter;
}
