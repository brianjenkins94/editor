import type { Hub } from "@brianjenkins94/hub";
import type { ArchitectureStore, Gauge, MemoryMeasurement } from "@brianjenkins94/observability";
import { serve } from "@brianjenkins94/hub";
import { longFrameGauge, memoryGauge, reportMetrics, spanMetrics } from "@brianjenkins94/observability";
import { fsGauge } from "./fs-boundaries";

const SUPERBLOCK_MAGIC = 0x62732E7A;

const withoutFragment = (url: string): string => url.split("#")[0];

function workerName(id: string, label: string | undefined): string {
	if (id.startsWith("exthost:LocalWebWorker")) {
		return "extension host";
	}

	return (label ?? id.replace(/^(?:nested:|worker:|ext:[^/]+\/)/u, "")).replace(/\s+#\d+$/u, "").replace(/\.js$/u, "");
}

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
		[/\/lsp\/node-worker\.js$/u, "node"],
		[/\/lsp\/debug-worker\.js$/u, "debug-worker"],
		[/webWorkerExtensionHostIframe/u, "exthost-iframe"]
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

	return scope === "Window" ? "page" : path.split("/").pop() || "unnamed workers";
}

export function workspaceFill(buffer: ArrayBufferLike): Record<string, number> | undefined {
	const view = new DataView(buffer);

	if (buffer.byteLength < 256 || view.getUint32(4, true) !== SUPERBLOCK_MAGIC || view.getUint16(8, true) !== 2) {
		return undefined;
	}

	const total = Number(view.getBigUint64(24, true));
	const state = view.getUint32(48, true);
	let free: number;

	for (;;) {
		const generation = view.getBigUint64(state + 8, true);
		const commit = state + 24 + Number(generation & 1n) * 60;

		free = view.getUint32(commit + 32, true) + view.getUint32(commit + 44, true) * view.getUint32(20, true) + view.getUint32(commit + 56, true);

		if (view.getBigUint64(state + 8, true) === generation) {
			break;
		}
	}

	const used = total - free;

	return { "usedMB": used / 1048576, "totalMB": total / 1048576, "percent": total > 0 ? (used / total) * 100 : 0 };
}

function refreshed(read: () => Promise<number | undefined>, everyMs: number): Gauge {
	let latest: number | undefined;
	const refresh = (): void => {
		read().then((value) => {
			latest = value;
		}, () => undefined).finally(() => {
			setTimeout(refresh, everyMs);
		});
	};

	refresh();

	return () => latest;
}

export function reportWorkbenchMetrics(hub: Hub, workspaceBuffer: SharedArrayBuffer | undefined, store?: ArchitectureStore, documents?: Gauge): () => void {
	const metrics = reportMetrics(hub);
	let handled = 0;
	let since = performance.now();
	const untap = hub.tap((event) => {
		if (event.type === "publish" || (event.type === "receive" && "subject" in event.frame)) {
			handled += 1;
		}
	});

	let realms: { "at": number; "realms": RealmMemory[] } | undefined;

	metrics.gauge("memory", memoryGauge({ "everyMs": 10000, "name": (url, scope) => realmName(url, scope, store === undefined ? undefined : workerNames(store)), "measured": (measurement) => { realms = { "at": Date.now(), "realms": realmsOf(measurement) }; } }));

	const unserve = serve(hub, "devtools.realms", () => realms ?? thisWindow() ?? null);

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

	metrics.gauge("fs", fsGauge);
	if (documents !== undefined) {
		metrics.gauge("documents", documents);
	}

	return () => {
		untap();
		unserve();
		metrics.dispose();
	};
}

export interface RealmMemory { "url": string; "scope": string; "bytes": number }

export function thisWindow(): { "at": number; "realms": RealmMemory[] } | undefined {
	const memory = (performance as Performance & { "memory"?: { "usedJSHeapSize": number } }).memory;

	return memory === undefined ? undefined : { "at": Date.now(), "realms": [{ "url": location.href, "scope": "Window", "bytes": memory.usedJSHeapSize }] };
}

export function realmsOf(measurement: MemoryMeasurement): RealmMemory[] {
	const byRealm = new Map<string, RealmMemory>();

	for (const { bytes, attribution } of measurement.breakdown) {
		const [only] = attribution;

		if (attribution.length !== 1 || only?.url === undefined || only.scope === undefined) {
			continue;
		}

		const key = only.scope + " " + only.url;
		const known = byRealm.get(key) ?? { "url": only.url, "scope": only.scope, "bytes": 0 };

		known.bytes += bytes;
		byRealm.set(key, known);
	}

	return [...byRealm.values()];
}

export function reportSpanMetrics(hub: Hub): { "record": (record: unknown) => void; "dispose": () => void } {
	const metrics = reportMetrics(hub);
	const spans = spanMetrics();

	metrics.gauge("spans", spans.gauge);

	return {
		"record": spans.record,
		"dispose": () => {
			metrics.dispose();
		}
	};
}

export function reportShellMetrics(hub: Hub): () => void {
	const metrics = reportMetrics(hub);

	metrics.gauge("longFrames", longFrameGauge(window));

	return () => {
		metrics.dispose();
	};
}
