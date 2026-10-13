/**
 * The node id a probe gives what it sees — a worker by its file, a request by where it goes, an IndexedDB database by
 * its owner — in every realm the probes run in (the service worker and every worker too). Kept apart from the declared
 * model (architecture-model.ts), which only the view and the tests read, so a probe doesn't carry the declarations.
 */

/** Node id owning an IndexedDB database, when it isn't the realm that opens it: the workspace's zen-fs, persisting its
 *  shared buffer (`workspace-fs`) and mounting silo's local/ (`silo-local`). */
export function idbOwner(database: string): string | undefined {
	return database === "workspace-fs" || database === "silo-local" ? "zenfs" : undefined;
}

/** Identity of a worker created in the workbench realm, by file name (see the monaco probes' `identifyWorker`). */
export function identifyWorker(url: string): { "id": string; "label"?: string; "container": string; "owner"?: string } | undefined {
	const file = url.split(/[?#]/u)[0].split("/").pop() ?? "";

	switch (file) {
		case "node-worker.js":
			return { "id": "node", "container": "workers", "owner": "workbench" };
		case "debug-worker.js":
			return { "id": "debug-worker", "container": "podWorkers", "owner": "pod" };
		case "server-host.js":
			return { "id": "worker:server-host", "container": "podWorkers", "owner": "pod" };
		case "bablr-worker.js":
			return { "id": "bablr", "container": "workers", "owner": "workbench" };
		case "provoke-worker.js":
			return { "id": "provoke", "container": "workers", "owner": "node" };
		default:
			return undefined;
	}
}

/**
 * Does a request made here go through the service worker? It takes every request from the pages and workers it
 * controls. A page can ask (`navigator.serviceWorker.controller`); a worker can't (no `navigator.serviceWorker`), and
 * the workers here are controlled (their own imports arrive through it), so a worker counts as going through it. The
 * service worker's own requests go straight out, and so does anything outside a browser (tests).
 */
function viaServiceWorker(): boolean {
	const scope = globalThis as unknown as { "ServiceWorkerGlobalScope"?: new () => unknown; "WorkerGlobalScope"?: unknown; "navigator"?: { "serviceWorker"?: { "controller": unknown } } };

	if (scope.ServiceWorkerGlobalScope !== undefined && globalThis instanceof scope.ServiceWorkerGlobalScope) {
		return false;
	}

	const container = scope.navigator?.serviceWorker;

	return container !== undefined ? container.controller !== null : scope.WorkerGlobalScope !== undefined;
}

/** Node id of an HTTP / WebSocket endpoint. */
export function classifyUrl(url: URL): string {
	// A WebSocket never passes through the service worker.
	if (url.port === "7378" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
		return "debug-mcp";
	}

	if (viaServiceWorker()) {
		return "sw";
	}

	// A route only the service worker answers (a preview's dev-server request).
	if (url.origin === globalThis.location?.origin && url.pathname.includes("/__virtual__/")) {
		return "sw";
	}

	return url.origin === globalThis.location?.origin ? "net:origin" : "net:" + url.host;
}
