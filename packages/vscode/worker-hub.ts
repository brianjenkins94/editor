/**
 * The hub an app worker starts with: its own hub, linked UP to whoever spawned it over the worker channel (hub frames
 * are wrapped, so they never collide with other postMessage traffic), reporting its topology and requests on
 * `$sys.arch` for the live architecture view, with raw uncaught errors on the observability plane. The spawner links
 * its end with `hub.link(portTransport(worker))`; the worker then `serve`s its methods, callable by name from anywhere
 * in the tree.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createHub, portTransport } from "@brianjenkins94/hub";

import { reportArchitecture } from "./architecture";
import { tapConsoleAndErrors } from "./telemetry";

export function createWorkerHub(id: string): Hub {
	const hub = createHub({ "id": id });

	hub.link(portTransport(globalThis));
	reportArchitecture(hub);
	tapConsoleAndErrors(hub, id);

	return hub;
}
