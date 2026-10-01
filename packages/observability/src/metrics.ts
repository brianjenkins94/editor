/**
 * The metrics plane: numbers sampled on an interval, beside the logs (`$sys.log`) and the architecture (`$sys.arch`).
 *
 * A context registers named gauges — a function read at each sample — and its reporter publishes what they read on
 * `$sys.metrics.<source>` (`reportMetrics`). Anything on the tree subscribes: a monitor, debug-mcp, a debug adapter's
 * `getPerformance`. A gauge reads one number, or a group (`{ total, workbench, … }`, published as `name.key`), or
 * nothing this time (undefined: not measured yet, or not measurable here).
 *
 * Two gauges any browser realm can use come with it: `longFrameGauge` (the share of each interval a window spent in long
 * animation frames) and `memoryGauge` (memory by realm, from the slow `measureUserAgentSpecificMemory`, refreshed in the
 * background).
 */
import type { Hub } from "@brianjenkins94/hub";

export const METRICS_SUBJECT = "$sys.metrics";

/** One context's reading: each gauge's value at `t` (a group gauge's values as `name.key`). */
export interface MetricsSample { "source": string; "t": number; "values": Record<string, number> }

/** Read at each sample: a number, a group of them, or undefined for no reading this time. */
export type Gauge = () => number | Record<string, number> | undefined;

export interface MetricsReporter {
	/** Add a gauge; returns its removal. */
	"gauge": (name: string, read: Gauge) => () => void;
	/** Read every gauge now (what the next publish would carry). */
	"sample": () => MetricsSample;
	"dispose": () => void;
}

/** Sample this context's gauges every `intervalMs` and publish each reading on `$sys.metrics.<source>`. A gauge that
 *  throws is left out of that reading: telemetry never breaks the context it observes. */
export function reportMetrics(hub: Hub, { source = hub.id, intervalMs = 1000 }: { "source"?: string; "intervalMs"?: number } = {}): MetricsReporter {
	const gauges = new Map<string, Gauge>();

	const sample = (): MetricsSample => {
		const values: Record<string, number> = {};

		for (const [name, read] of gauges) {
			try {
				const value = read();

				if (typeof value === "number") {
					values[name] = value;
				} else if (value !== undefined) {
					for (const [key, inner] of Object.entries(value)) {
						values[name + "." + key] = inner;
					}
				}
			} catch { /* left out of this reading */ }
		}

		return { "source": source, "t": Date.now(), "values": values };
	};

	const timer = setInterval(() => {
		if (gauges.size > 0) {
			hub.publish(METRICS_SUBJECT + "." + source, sample());
		}
	}, intervalMs);

	return {
		"gauge": (name, read) => {
			gauges.set(name, read);

			return () => { gauges.delete(name); };
		},
		"sample": sample,
		"dispose": () => { clearInterval(timer); }
	};
}

/**
 * The share (%) of the time since the last read that this window spent in long animation frames — frames over 50 ms,
 * the ones a user feels. Chromium only (undefined elsewhere). It's a floor, not the whole main-thread load: shorter
 * frames aren't reported to anyone.
 */
export function longFrameGauge(win: { "PerformanceObserver"?: typeof PerformanceObserver; "performance": Performance } = globalThis as never): Gauge {
	const Observer = win.PerformanceObserver;

	if (Observer?.supportedEntryTypes.includes("long-animation-frame") !== true) {
		return () => undefined;
	}

	let busy = 0;
	let since = win.performance.now();

	new Observer((list) => {
		for (const entry of list.getEntries()) {
			busy += entry.duration;
		}
	}).observe({ "type": "long-animation-frame" });

	return () => {
		const now = win.performance.now();
		const share = now > since ? Math.min(100, (busy / (now - since)) * 100) : 0;

		busy = 0;
		since = now;

		return share;
	};
}

interface MemoryMeasurement { "bytes": number; "breakdown": { "bytes": number; "attribution": { "url"?: string; "scope"?: string }[] }[] }

/**
 * Memory (MB) for this page's whole agent — every frame and worker it runs — as `total` plus one entry per realm, named by
 * `name(url, scope)` (realms that share a name add up). It's `performance.measureUserAgentSpecificMemory`, which needs
 * cross-origin isolation and takes seconds, so it's refreshed every `everyMs` in the background and each read reports the
 * latest. Undefined until the first measurement, or where it isn't supported.
 */
export function memoryGauge({ everyMs = 20000, name = (url: string) => url }: { "everyMs"?: number; "name"?: (url: string, scope: string) => string } = {}): Gauge {
	const measure = (performance as Performance & { "measureUserAgentSpecificMemory"?: () => Promise<MemoryMeasurement> }).measureUserAgentSpecificMemory?.bind(performance);
	let latest: Record<string, number> | undefined;

	if (measure === undefined || (globalThis as { "crossOriginIsolated"?: boolean }).crossOriginIsolated !== true) {
		return () => undefined;
	}

	const refresh = (): void => {
		measure().then((result) => {
			const byName: Record<string, number> = { "total": result.bytes / 1048576 };

			for (const entry of result.breakdown) {
				const where = entry.attribution[0];
				const key = where === undefined ? "unattributed" : name(where.url ?? "", where.scope ?? "");

				byName[key] = (byName[key] ?? 0) + entry.bytes / 1048576;
			}

			latest = byName;
		}, () => { /* a measurement can be refused (a frame navigating): keep the last */ }).finally(() => { setTimeout(refresh, everyMs); });
	};

	refresh();

	return () => latest;
}
