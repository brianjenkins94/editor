/**
 * The dev-hub's record store — an in-memory, queryable window over the span/log stream the page's hub tree
 * federates out over the WebSocket link. It is deliberately a plain JSON store: records arrive already shaped
 * by @brianjenkins94/util/logger, and everything downstream (the MCP tools, an eventual OTel exporter) reads
 * that shape without the store ever constructing a logger — the "construct downstream from Roarr" line.
 *
 * It answers three questions an agent would otherwise need a screenshot for: what happened (query), what is the
 * tree doing right now (tree state — sources seen, spans still open), and "tell me when X happens" (wait_for,
 * so the agent synchronizes on a real event instead of polling or sleeping).
 */

/** The subset of util/logger's `LogRecord` that rides the hub as JSON. Kept STRUCTURAL (not imported from
 *  @brianjenkins94/util) so the Node collector stays decoupled from the util package version — it stores plain
 *  records and never needs the logger itself. See lib/util/logger.ts for the authoritative shape. */
export interface HubLogRecord {
	"kind": "log" | "span-open" | "span-close";
	"level": "trace" | "debug" | "info" | "warn" | "error" | "fatal";
	"message": string;
	"attrs"?: Record<string, unknown>;
	"context"?: Record<string, unknown>;
	/** Unix ms. On a `span-close` this is the END time; start is `time - durationMs`. */
	"time": number;
	"span"?: string;
	"spanId"?: string;
	"parentSpanId"?: string;
	"traceId"?: string;
	"depth"?: number;
	/** Present only on `span-close`. */
	"durationMs"?: number;
}

/** A stored record — the wire record plus the collector's own receive metadata. */
export interface StoredRecord extends HubLogRecord {
	/** Monotonic receive order (stable tiebreaker; `time` can collide or skew across contexts). */
	"seq": number;
	/** The emitting context, from `context.source` (what `relayLoggerToHub(hub, source)` binds). */
	"source": string;
	/** Unix ms this collector received it. */
	"receivedAt": number;
}

const LEVELS = { "trace": 10, "debug": 20, "info": 30, "warn": 40, "error": 50, "fatal": 60 } as const;

type Level = keyof typeof LEVELS;

/** A reconstructed span (an open matched with its close, or still open). */
export interface SpanRow {
	"source": string;
	"name"?: string;
	"spanId"?: string;
	"parentSpanId"?: string;
	"traceId"?: string;
	"depth"?: number;
	"attrs"?: Record<string, unknown>;
	/** Unix ms the span opened. */
	"startTime": number;
	/** Unix ms the span closed (undefined while open). */
	"endTime"?: number;
	"durationMs"?: number;
	/** True when no `span-close` has been seen for it — it's in progress (e.g. paused at a breakpoint). */
	"open": boolean;
}

export interface QueryLogsInput {
	"source"?: string;
	"minLevel"?: Level;
	"textIncludes"?: string;
	/** Relative window: only records from the last N ms. Ignored when `since` is given. */
	"sinceMs"?: number;
	/** Absolute window (unix ms). */
	"since"?: number;
	"until"?: number;
	/** Restrict to one record kind; default returns point logs AND span boundaries. */
	"kind"?: HubLogRecord["kind"];
	/** Max rows (most recent), default 200. */
	"limit"?: number;
}

export interface QuerySpansInput {
	"source"?: string;
	"name"?: string;
	"minDurationMs"?: number;
	"onlyOpen"?: boolean;
	"sinceMs"?: number;
	"limit"?: number;
}

export interface WaitInput {
	"source"?: string;
	"minLevel"?: Level;
	"textIncludes"?: string;
	"kind"?: HubLogRecord["kind"];
	/** Match a span by name (`record.span`), e.g. wait for a `render` span. */
	"spanName"?: string;
	"timeoutMs"?: number;
}

interface Waiter {
	"input": WaitInput;
	"resolve": (record: StoredRecord | null) => void;
	"timer"?: ReturnType<typeof setTimeout>;
}

/** Compose the per-record source id and span id into one map key (span ids are per-context in the pre-W3C era,
 *  so the source disambiguates them; harmless once ids are globally unique). */
function spanKey(source: string, spanId: string): string {
	return source + "\0" + spanId;
}

export class RecordStore {
	private readonly ring: StoredRecord[] = [];
	private readonly max: number;
	private seq = 0;

	private readonly sources = new Set<string>();
	private readonly lastBySource = new Map<string, StoredRecord>();
	/** Spans opened but not yet closed — key `source\0spanId` → the opening record. */
	private readonly open = new Map<string, StoredRecord>();
	private readonly waiters = new Set<Waiter>();

	public constructor(options: { "max"?: number } = {}) {
		this.max = options.max ?? 10000;
	}

	/** Ingest one federated record. Never throws — a malformed record is dropped, telemetry must not crash. */
	public add(record: HubLogRecord): void {
		if (record === null || typeof record !== "object" || typeof record.message !== "string") {
			return;
		}

		const source = typeof record.context?.["source"] === "string" ? record.context["source"] : "?";
		const stored: StoredRecord = { ...record, "seq": this.seq, "source": source, "receivedAt": Date.now() };

		this.seq += 1;
		this.ring.push(stored);

		if (this.ring.length > this.max) {
			this.ring.shift();
		}

		this.sources.add(source);
		this.lastBySource.set(source, stored);

		if (record.spanId !== undefined) {
			const key = spanKey(source, record.spanId);

			if (record.kind === "span-open") {
				this.open.set(key, stored);
			} else if (record.kind === "span-close") {
				this.open.delete(key);
			}
		}

		this.notify(stored);
	}

	public queryLogs(input: QueryLogsInput = {}): StoredRecord[] {
		const limit = input.limit ?? 200;
		const min = input.minLevel === undefined ? 0 : LEVELS[input.minLevel];
		const since = input.since ?? (input.sinceMs === undefined ? undefined : Date.now() - input.sinceMs);

		const matched = this.ring.filter((record) => {
			if (input.source !== undefined && record.source !== input.source) { return false; }
			if (input.kind !== undefined && record.kind !== input.kind) { return false; }
			if (LEVELS[record.level] < min) { return false; }
			if (since !== undefined && record.time < since) { return false; }
			if (input.until !== undefined && record.time > input.until) { return false; }
			if (input.textIncludes !== undefined && !record.message.includes(input.textIncludes)) { return false; }

			return true;
		});

		return matched.slice(-limit);
	}

	public querySpans(input: QuerySpansInput = {}): SpanRow[] {
		const limit = input.limit ?? 200;
		const since = input.sinceMs === undefined ? undefined : Date.now() - input.sinceMs;
		// Pair opens with closes by key, scanning the retained window. A close carries the duration + end time.
		const byKey = new Map<string, SpanRow>();

		for (const record of this.ring) {
			if (record.spanId === undefined || (record.kind !== "span-open" && record.kind !== "span-close")) {
				continue;
			}

			const key = spanKey(record.source, record.spanId);
			const row = byKey.get(key) ?? { "source": record.source, "spanId": record.spanId, "startTime": record.time, "open": true };

			if (record.kind === "span-open") {
				row.name = record.span;
				row.parentSpanId = record.parentSpanId;
				row.traceId = record.traceId;
				row.depth = record.depth;
				row.attrs = record.attrs;
				row.startTime = record.time;
			} else {
				row.name = row.name ?? record.span;
				row.endTime = record.time;
				row.durationMs = record.durationMs;
				row.open = false;

				if (record.durationMs !== undefined) {
					row.startTime = record.time - record.durationMs;
				}
			}

			byKey.set(key, row);
		}

		const rows = [...byKey.values()].filter((row) => {
			if (input.source !== undefined && row.source !== input.source) { return false; }
			if (input.name !== undefined && row.name !== input.name) { return false; }
			if (input.onlyOpen === true && !row.open) { return false; }
			if (input.minDurationMs !== undefined && (row.durationMs ?? 0) < input.minDurationMs) { return false; }
			if (since !== undefined && row.startTime < since) { return false; }

			return true;
		});

		rows.sort((a, b) => a.startTime - b.startTime);

		return rows.slice(-limit);
	}

	/** A health snapshot of the whole tree: which contexts are alive, and what's still running. */
	public treeState(links = 0): {
		"links": number;
		"totalRecords": number;
		"sources": { "source": string; "records": number; "lastMessage": string; "lastLevel": Level; "lastAgoMs": number }[];
		"openSpans": { "source": string; "name"?: string; "spanId"?: string; "ageMs": number; "attrs"?: Record<string, unknown> }[];
	} {
		const now = Date.now();
		const counts = new Map<string, number>();

		for (const record of this.ring) {
			counts.set(record.source, (counts.get(record.source) ?? 0) + 1);
		}

		const sources = [...this.sources].map((source) => {
			const last = this.lastBySource.get(source);

			return {
				"source": source,
				"records": counts.get(source) ?? 0,
				"lastMessage": last?.message ?? "",
				"lastLevel": last?.level ?? "trace",
				"lastAgoMs": last === undefined ? -1 : now - last.receivedAt
			};
		});

		const openSpans = [...this.open.values()].map((record) => ({
			"source": record.source,
			"name": record.span,
			"spanId": record.spanId,
			"ageMs": now - record.time,
			"attrs": record.attrs
		}));

		return { "links": links, "totalRecords": this.ring.length, "sources": sources, "openSpans": openSpans };
	}

	/** Resolve with the FIRST record received AFTER this call that matches, or null on timeout. */
	public waitFor(input: WaitInput = {}): Promise<StoredRecord | null> {
		return new Promise((resolve) => {
			const waiter: Waiter = { "input": input, "resolve": resolve };

			if (input.timeoutMs !== undefined) {
				waiter.timer = setTimeout(() => {
					this.waiters.delete(waiter);
					resolve(null);
				}, input.timeoutMs);
			}

			this.waiters.add(waiter);
		});
	}

	private notify(record: StoredRecord): void {
		if (this.waiters.size === 0) {
			return;
		}

		for (const waiter of [...this.waiters]) {
			if (this.waiterMatches(waiter.input, record)) {
				this.waiters.delete(waiter);

				if (waiter.timer !== undefined) {
					clearTimeout(waiter.timer);
				}

				waiter.resolve(record);
			}
		}
	}

	private waiterMatches(input: WaitInput, record: StoredRecord): boolean {
		if (input.source !== undefined && record.source !== input.source) { return false; }
		if (input.kind !== undefined && record.kind !== input.kind) { return false; }
		if (input.spanName !== undefined && record.span !== input.spanName) { return false; }
		if (input.minLevel !== undefined && LEVELS[record.level] < LEVELS[input.minLevel]) { return false; }
		if (input.textIncludes !== undefined && !record.message.includes(input.textIncludes)) { return false; }

		return true;
	}
}
