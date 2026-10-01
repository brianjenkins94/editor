/**
 * The editor's gauges on the metrics plane (observability's metrics.ts): what a monitor shows about the editor itself.
 *
 *  - `memory` (MB): the whole tab, by realm (measureUserAgentSpecificMemory: a reading about every 30 s — the measurement
 *    itself waits for a garbage collection, ~20 s). A realm is named from its URL:
 *    the editor's own by path, and the `blob:` workers — the web worker extension host, TypeScript's servers, the
 *    language servers, monaco's workers — by the architecture probes, which put each worker's URL on its node. Any
 *    that's still unknown counts toward `unnamed workers`.
 *  - `workspace` (MB, %): how full the shared workspace (zen-fs, one fixed-size SharedArrayBuffer) is — read from its
 *    superblock, the numbers zen-fs's own usage() reports.
 *  - `longFrames` (%): the share of the time the workbench spent in long animation frames.
 *  - `hub` (messages/s): the messages the workbench hub handles — the tree's middle, so most traffic passes it — counted
 *    by its tap as they happen (the architecture store's rates aren't usable here: a reporter's first report brings its
 *    traffic since it started as one delta, which reads as a burst).
 *  - `storage` (MB): what the origin keeps (IndexedDB, the service worker's caches), every 15 s.
 *
 * The shell reports its own `longFrames` (it hosts the preview windows): `reportShellMetrics`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ArchitectureStore, Gauge } from "@brianjenkins94/observability";
import { longFrameGauge, memoryGauge, reportMetrics } from "@brianjenkins94/observability";

/** zen-fs SingleBuffer's superblock: magic (u32 at 4), used_bytes and total_bytes (u64 at 16 and 24), little-endian. */
const SUPERBLOCK_MAGIC = 0x62732e7a;

/** A URL without its fragment: a worker loaded through the probe bootstrap carries its target there, and a memory
 *  attribution may not. */
const withoutFragment = (url: string): string => url.split("#")[0];

/** A worker's short, reload-stable name from its architecture node: `nested:TS semantic server #1` → `TS semantic
 *  server`, `worker:TextMateWorker` → its label, the web worker extension host → `extension host`. */
function workerName(id: string, label: string | undefined): string {
	if (id.startsWith("exthost:LocalWebWorker")) {
		return "extension host";
	}

	return (label ?? id.replace(/^(?:nested|worker):/u, "")).replace(/\s+#\d+$/u, "").replace(/\.js$/u, "");
}

/** Each worker's URL → its name, from the architecture store (the probes put a worker's URL on its node). */
export function workerNames(store: ArchitectureStore): Map<string, string> {
	const names = new Map<string, string>();

	for (const [id, node] of store.nodes) {
		const url = node.spec.meta?.["url"];

		if (typeof url === "string") {
			names.set(withoutFragment(url), workerName(id, node.spec.label));
		}
	}

	return names;
}

/** A realm's name for the memory breakdown, from its URL (as measureUserAgentSpecificMemory attributes it) — a worker the
 *  probes named first (`workers`: URL → name). */
export function realmName(url: string, scope: string, workers = new Map<string, string>()): string {
	const known = workers.get(withoutFragment(url));
	let path: string;

	if (known !== undefined) {
		return known;
	}

	try {
		path = new URL(url).pathname;
	} catch {
		return scope === "" ? "shared" : "unnamed workers";
	}

	if (url.startsWith("blob:")) {
		return "unnamed workers";
	}

	const named: [RegExp, string][] = [
		[/\/__vscode__\/host\.html$/u, "workbench"],
		[/\/lsp\/server-host\.js$/u, "server-host"],
		[/\/lsp\/node-worker\.js$/u, "node"],
		[/\/lsp\/classify-worker\.js$/u, "classify"],
		[/\/lsp\/debug-worker\.js$/u, "debug-worker"],
		[/webWorkerExtensionHostIframe/u, "exthost-iframe"],
		[/\/debug-preview\.html$/u, "tsval-preview"]
	];

	for (const [pattern, name] of named) {
		if (pattern.test(path)) {
			return name;
		}
	}

	const preview = /\/__virtual__\/(?:[^/]+\/)?(\d+)\//u.exec(path);

	if (preview !== null) {
		return "preview:" + preview[1];
	}

	// The shell and the app frame both load the page itself; they share its name.
	return scope === "Window" ? "page" : path.split("/").pop() || "unnamed workers";
}

/** How full the shared workspace is, from its superblock; undefined if the buffer isn't zen-fs's. */
export function workspaceFill(buffer: ArrayBufferLike): Record<string, number> | undefined {
	const view = new DataView(buffer);

	if (buffer.byteLength < 32 || view.getUint32(4, true) !== SUPERBLOCK_MAGIC) {
		return undefined;
	}

	const used = Number(view.getBigUint64(16, true));
	const total = Number(view.getBigUint64(24, true));

	return { "usedMB": used / 1048576, "totalMB": total / 1048576, "percent": total > 0 ? (used / total) * 100 : 0 };
}

/** A reading refreshed in the background every `everyMs` (for the slow ones). */
function refreshed(read: () => Promise<number | undefined>, everyMs: number): Gauge {
	let latest: number | undefined;
	const refresh = (): void => {
		read().then((value) => { latest = value; }, () => undefined).finally(() => { setTimeout(refresh, everyMs); });
	};

	refresh();

	return () => latest;
}

/** The workbench's gauges, published on `$sys.metrics.workbench`; `store` (its architecture store) names the workers.
 *  Returns their removal. (The store is handed in so this module stays free of the workbench's: the shell imports it.) */
export function reportWorkbenchMetrics(hub: Hub, workspaceBuffer: SharedArrayBuffer | undefined, store?: ArchitectureStore): () => void {
	const metrics = reportMetrics(hub);
	// Messages this hub handles: those it originates and those that arrive on its links (not the links' control frames).
	let handled = 0;
	let since = performance.now();
	const untap = hub.tap((event) => {
		if (event.type === "publish" || (event.type === "receive" && "subject" in event.frame)) {
			handled += 1;
		}
	});

	metrics.gauge("memory", memoryGauge({ "everyMs": 10000, "name": (url, scope) => realmName(url, scope, store === undefined ? undefined : workerNames(store)) }));
	metrics.gauge("longFrames", longFrameGauge(window));
	metrics.gauge("hub", () => {
		const now = performance.now();
		const perSecond = now > since ? (handled * 1000) / (now - since) : 0;

		handled = 0;
		since = now;

		return perSecond;
	});
	metrics.gauge("storage", refreshed(async () => ((await navigator.storage.estimate()).usage ?? 0) / 1048576, 15000));

	if (workspaceBuffer !== undefined) {
		metrics.gauge("workspace", () => workspaceFill(workspaceBuffer));
	}

	return () => {
		untap();
		metrics.dispose();
	};
}

/** The shell's own gauge: the share of time it spent in long animation frames (it hosts the preview windows). */
export function reportShellMetrics(hub: Hub): () => void {
	const metrics = reportMetrics(hub);

	metrics.gauge("longFrames", longFrameGauge(window));

	return () => { metrics.dispose(); };
}
