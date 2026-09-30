/**
 * The debug-mcp's record store — an in-memory, queryable window over the span/log stream the page's hub tree
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
	/** The collector's link it arrived on — one per connected tab, which tells two tabs' same-named contexts apart
	 *  (every editor tab has a `root`). Undefined for a record published on the collector's own hub. */
	"link"?: string;
}

const LEVELS = { "trace": 10, "debug": 20, "info": 30, "warn": 40, "error": 50, "fatal": 60 } as const;

type Level = keyof typeof LEVELS;

/** A reconstructed span (an open matched with its close, or still open). */
export interface SpanRow {
	"source": string;
	/** The link (tab) its records arrived on. */
	"link"?: string;
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

/** Is `source` the scope itself or a context under it (`<scope>/…`)? */
function inScope(source: string, scope: string): boolean {
	return source === scope || source.startsWith(scope + "/");
}

export interface QueryLogsInput {
	"source"?: string;
	/** Only records from this scope: the source itself, or `<scope>/…` (a preview window's app — TabInfo.scope). */
	"scope"?: string;
	/** Only records that arrived on this link (one tab's). */
	"link"?: string;
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
	/** As QueryLogsInput's. */
	"scope"?: string;
	/** Only spans from this link (one tab's). */
	"link"?: string;
	"name"?: string;
	"minDurationMs"?: number;
	"onlyOpen"?: boolean;
	"sinceMs"?: number;
	"limit"?: number;
}

export interface WaitInput {
	"source"?: string;
	/** Only records arriving on this link (one tab's). */
	"link"?: string;
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

/** Compose the link, the per-record source id and the span id into one map key (span ids are per-context in the
 *  pre-W3C era, so the source disambiguates them — and two tabs have same-named sources, so the link does too). */
function spanKey(link: string | undefined, source: string, spanId: string): string {
	return (link ?? "") + "\0" + source + "\0" + spanId;
}

/** One context in one tab: tabs' contexts can share a name (every editor tab has a `root`). */
function sourceKey(link: string | undefined, source: string): string {
	return (link ?? "") + "\0" + source;
}

export class RecordStore {
	private readonly ring: StoredRecord[] = [];
	private readonly max: number;
	private seq = 0;

	/** Each context's latest record, per tab (sourceKey). */
	private readonly lastBySource = new Map<string, StoredRecord>();
	/** Spans opened but not yet closed — spanKey → the opening record. */
	private readonly open = new Map<string, StoredRecord>();
	private readonly waiters = new Set<Waiter>();

	public constructor(options: { "max"?: number } = {}) {
		this.max = options.max ?? 10000;
	}

	/** Ingest one federated record. Never throws — a malformed record is dropped, telemetry must not crash. */
	public add(record: HubLogRecord, link?: string): void {
		if (record === null || typeof record !== "object" || typeof record.message !== "string") {
			return;
		}

		const source = typeof record.context?.["source"] === "string" ? record.context["source"] : "?";
		const stored: StoredRecord = { ...record, "seq": this.seq, "source": source, "receivedAt": Date.now(), ...link === undefined ? {} : { "link": link } };

		this.seq += 1;
		this.ring.push(stored);

		if (this.ring.length > this.max) {
			this.ring.shift();
		}

		this.lastBySource.set(sourceKey(link, source), stored);

		if (record.spanId !== undefined) {
			const key = spanKey(link, source, record.spanId);

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
			if (input.scope !== undefined && !inScope(record.source, input.scope)) { return false; }
			if (input.link !== undefined && record.link !== input.link) { return false; }
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

			if (input.link !== undefined && record.link !== input.link) {
				continue;
			}

			const key = spanKey(record.link, record.source, record.spanId);
			const row = byKey.get(key) ?? { "source": record.source, "spanId": record.spanId, "startTime": record.time, "open": true, ...record.link === undefined ? {} : { "link": record.link } };

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
			if (input.scope !== undefined && !inScope(row.source, input.scope)) { return false; }
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
	/** The tree's health: every context seen (per tab) with its last message, and the spans still open. `link` narrows
	 *  it to one tab's; `links` is how many are connected. */
	public treeState(links = 0, link?: string): {
		"links": number;
		"totalRecords": number;
		"sources": { "source": string; "link"?: string; "records": number; "lastMessage": string; "lastLevel": Level; "lastAgoMs": number }[];
		"openSpans": { "source": string; "link"?: string; "name"?: string; "spanId"?: string; "ageMs": number; "attrs"?: Record<string, unknown> }[];
	} {
		const now = Date.now();
		const counts = new Map<string, number>();
		const mine = (record: StoredRecord): boolean => link === undefined || record.link === link;
		let total = 0;

		for (const record of this.ring) {
			if (mine(record)) {
				const key = sourceKey(record.link, record.source);

				counts.set(key, (counts.get(key) ?? 0) + 1);
				total += 1;
			}
		}

		const sources = [...this.lastBySource].filter(([, last]) => mine(last)).map(([key, last]) => ({
			"source": last.source,
			...last.link === undefined ? {} : { "link": last.link },
			"records": counts.get(key) ?? 0,
			"lastMessage": last.message,
			"lastLevel": last.level,
			"lastAgoMs": now - last.receivedAt
		}));

		const openSpans = [...this.open.values()].filter(mine).map((record) => ({
			"source": record.source,
			...record.link === undefined ? {} : { "link": record.link },
			"name": record.span,
			"spanId": record.spanId,
			"ageMs": now - record.time,
			"attrs": record.attrs
		}));

		return { "links": links, "totalRecords": total, "sources": sources, "openSpans": openSpans };
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
		if (input.link !== undefined && record.link !== input.link) { return false; }
		if (input.kind !== undefined && record.kind !== input.kind) { return false; }
		if (input.spanName !== undefined && record.span !== input.spanName) { return false; }
		if (input.minLevel !== undefined && LEVELS[record.level] < LEVELS[input.minLevel]) { return false; }
		if (input.textIncludes !== undefined && !record.message.includes(input.textIncludes)) { return false; }

		return true;
	}
}
