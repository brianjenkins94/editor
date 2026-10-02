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
 *  throws is left out of that reading: telemetry never breaks the context it observes. An empty reading isn't published. */
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

	// A reading with nothing in it (no gauges, or none with a reading — a span metric with no spans this window) isn't sent.
	const timer = setInterval(() => {
		const reading = sample();

		if (Object.keys(reading.values).length > 0) {
			hub.publish(METRICS_SUBJECT + "." + source, reading);
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
 * cross-origin isolation and resolves only at the next garbage collection — up to ~20 s — so it's refreshed in the
 * background, `everyMs` after each measurement lands, and each read reports the latest. Undefined until the first
 * measurement, or where it isn't supported.
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

/** A series over a window, summarized: `source:gauge`, its latest reading (and how long ago), its range and mean, and —
 *  when asked — the readings themselves, thinned to at most that many (`[msAgo, value]`, oldest first). */
export interface SeriesSummary {
	"series": string;
	"latest": number;
	"agoMs": number;
	"min": number;
	"max": number;
	"mean": number;
	"samples": number;
	"points"?: [number, number][];
}

/** A few minutes of every source's samples, oldest first — what a monitor or an agent reads back. */
export class MetricsHistory {
	readonly #bySource = new Map<string, MetricsSample[]>();
	readonly #keep: number;

	/** `keep`: samples per source (five minutes at one a second). */
	constructor(keep = 300) {
		this.#keep = keep;
	}

	/** File a sample as it arrives off `$sys.metrics.>` (anything that isn't one is ignored). */
	add(data: unknown): void {
		const sample = data as MetricsSample | null;

		if (typeof sample?.source !== "string" || typeof sample.t !== "number" || typeof sample.values !== "object") {
			return;
		}

		const kept = this.#bySource.get(sample.source) ?? [];

		kept.push(sample);

		if (kept.length > this.#keep) {
			kept.shift();
		}

		this.#bySource.set(sample.source, kept);
	}

	/** Every source's samples, only those after `since` when it's given. */
	read(since?: number): Record<string, MetricsSample[]> {
		const out: Record<string, MetricsSample[]> = {};

		for (const [source, kept] of this.#bySource) {
			out[source] = since === undefined ? kept : kept.filter((sample) => sample.t > since);
		}

		return out;
	}

	/** Each series (`source:gauge`) with a reading in the last `sinceMs`, summarized — narrowed to one `source`, and to
	 *  series whose name contains `match` (case-insensitive). Sorted by name. */
	summarize({ source, match, sinceMs = 60000, points = 0, now = Date.now() }: { "source"?: string; "match"?: string; "sinceMs"?: number; "points"?: number; "now"?: number } = {}): SeriesSummary[] {
		const series = new Map<string, [number, number][]>();
		const needle = match?.toLowerCase();

		for (const [from, kept] of this.#bySource) {
			if (source !== undefined && from !== source) {
				continue;
			}

			for (const sample of kept) {
				if (sample.t < now - sinceMs) {
					continue;
				}

				for (const [name, value] of Object.entries(sample.values)) {
					const key = from + ":" + name;

					if (needle === undefined || key.toLowerCase().includes(needle)) {
						const list = series.get(key) ?? [];

						list.push([sample.t, value]);
						series.set(key, list);
					}
				}
			}
		}

		return [...series].sort(([a], [b]) => a.localeCompare(b)).map(([key, readings]) => {
			const values = readings.map(([, value]) => value);
			const [lastT, latest] = readings.at(-1) as [number, number];
			const summary: SeriesSummary = {
				"series": key,
				"latest": round(latest),
				"agoMs": now - lastT,
				"min": round(Math.min(...values)),
				"max": round(Math.max(...values)),
				"mean": round(values.reduce((sum, value) => sum + value, 0) / values.length),
				"samples": readings.length
			};

			if (points > 0) {
				const step = Math.max(1, Math.ceil(readings.length / points));

				summary.points = readings.filter((_, index) => index % step === 0 || index === readings.length - 1).map(([t, value]) => [now - t, round(value)]);
			}

			return summary;
		});
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/** What spanMetrics reads of a record: util/logger's LogRecord, structurally. */
interface SpanRecord { "kind"?: string; "level"?: string; "span"?: string; "spanId"?: string; "durationMs"?: number; "context"?: Record<string, unknown> }

/**
 * Metrics from the timed spans every context already logs (`→ cdn` / `← cdn (12ms)`), with no code in the subsystems
 * that open them. Per `source/name` over the last `windowMs`: `rate` (ended per second), `errors` (ended with an error
 * logged inside them), `p50` and `p95` (ms), and `open` (begun, not yet ended). Hand it every record a collector sees
 * (`record`) and register `gauge`. A name idle for the whole window drops out; `top` keeps the busiest.
 */
export function spanMetrics({ windowMs = 10000, top = 30 }: { "windowMs"?: number; "top"?: number } = {}): { "record": (record: unknown) => void; "gauge": Gauge } {
	/** Begun and not yet ended, by span id: which series, and whether an error was logged inside. Bounded, for spans
	 *  that never end (their context went away). */
	const open = new Map<string, { "key": string; "errored": boolean }>();
	const ended = new Map<string, { "t": number; "ms"?: number; "errored": boolean }[]>();
	const keyOf = (record: SpanRecord): string => String(record.context?.["source"] ?? "?") + "/" + (record.span ?? "?");

	return {
		"record": (data) => {
			const record = data as SpanRecord | null;

			if (record?.spanId === undefined) {
				return;
			}

			if (record.kind === "span-open") {
				open.set(record.spanId, { "key": keyOf(record), "errored": false });

				if (open.size > 2000) {
					open.delete(open.keys().next().value as string);
				}
			} else if (record.kind === "span-close") {
				const begun = open.get(record.spanId);
				const key = begun?.key ?? keyOf(record);
				const list = ended.get(key) ?? [];

				open.delete(record.spanId);
				list.push({ "t": Date.now(), "ms": record.durationMs, "errored": begun?.errored === true || record.level === "error" || record.level === "fatal" });
				ended.set(key, list);
			} else if (record.level === "error" || record.level === "fatal") {
				const begun = open.get(record.spanId);

				if (begun !== undefined) {
					begun.errored = true;
				}
			}
		},
		"gauge": () => {
			const since = Date.now() - windowMs;
			const openCount = new Map<string, number>();

			for (const { key } of open.values()) {
				openCount.set(key, (openCount.get(key) ?? 0) + 1);
			}

			const rows: [string, Record<string, number>, number][] = [];

			for (const key of new Set([...ended.keys(), ...openCount.keys()])) {
				const recent = (ended.get(key) ?? []).filter((entry) => entry.t >= since);

				if (recent.length === 0) {
					ended.delete(key);
				} else {
					ended.set(key, recent);
				}

				const durations = recent.flatMap((entry) => entry.ms === undefined ? [] : [entry.ms]).sort((a, b) => a - b);
				const at = (q: number): number => round(durations[Math.min(durations.length - 1, Math.floor(q * durations.length))]);
				const values: Record<string, number> = {};

				if (recent.length > 0) {
					values["rate"] = round(recent.length / (windowMs / 1000));
					values["errors"] = recent.filter((entry) => entry.errored).length;
				}

				if (durations.length > 0) {
					values["p50"] = at(0.5);
					values["p95"] = at(0.95);
				}

				if ((openCount.get(key) ?? 0) > 0) {
					values["open"] = openCount.get(key) as number;
				}

				if (Object.keys(values).length > 0) {
					rows.push([key, values, recent.length + (openCount.get(key) ?? 0)]);
				}
			}

			if (rows.length === 0) {
				return undefined;
			}

			const out: Record<string, number> = {};

			for (const [key, values] of rows.sort((a, b) => b[2] - a[2]).slice(0, top)) {
				for (const [stat, value] of Object.entries(values)) {
					out[key + "." + stat] = value;
				}
			}

			return out;
		}
	};
}
