import type { Hub } from "@brianjenkins94/hub";
import type { ArchReporter, NetworkProbeOptions } from "@brianjenkins94/observability";
import { createArchReporter, installNetworkProbes } from "@brianjenkins94/observability";
import { NETWORK_PROBES } from "@brianjenkins94/editor-api/probes";

export { NETWORK_PROBES };

export function reportArchitecture(hub: Hub): ArchReporter {
	const reporter = createArchReporter(hub);

	installNetworkProbes(reporter, NETWORK_PROBES);

	return reporter;
}
