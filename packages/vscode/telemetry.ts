/**
 * The observability plane — `util/logger` spans/records carried over `@brianjenkins94/hub`.
 *
 * Every context (top page, workbench pane, extension pod, workers, the service worker) logs through a
 * source-scoped `logger({ source })` and opens timed SPANS for its operations. A sink appended to that
 * context's shared `sinks` publishes each structured `LogRecord` onto its hub on `$sys.log.<source>`. Because
 * hubs federate, those records flow up to whatever root hub is present, where a single COLLECTOR leaf renders
 * the merged, span-nested, duration-carrying stream — so the whole tree's activity is watchable from one place,
 * and a context stays debuggable standalone (its own console sink is kept). This is the WireTap / Control-Bus
 * pattern: telemetry rides its own reserved `$sys.>` namespace, separate from application traffic.
 *
 * `LogRecord` already carries `span/spanId/parentSpanId/traceId/depth/durationMs`, so spans survive the trip
 * intact; the collector tags each by `context.source` (span ids are per-context, so the source tag is what
 * disambiguates them across contexts until we add a context-id prefix for cross-context parent linking).
 */
import type { Hub, WebSocketLike } from "@brianjenkins94/hub";
import { portTransport, websocketTransport } from "@brianjenkins94/hub";
import type { Logger, LogRecord } from "@brianjenkins94/util/logger";
import { logger, renderRecord, sinks } from "@brianjenkins94/util/logger";

/** Reserved observability namespace — records are published on `$sys.log.<source>`; app code must not use it. */
const LOG_SUBJECT = "$sys.log";

/**
 * Source side: return a source-scoped logger (open spans off it — `const span = log.span("cdn")`) whose every
 * record is published onto `hub`. Keeps the context's own console sink, so it's still debuggable standalone.
 */
export function relayLoggerToHub(hub: Hub, source: string): Logger {
	sinks.push((record: LogRecord) => {
		// Telemetry must never break the context it observes.
		try {
			hub.publish(LOG_SUBJECT + "." + source, record);
		} catch { /* no subscriber / clone failure — the local console sink still has it */ }
	});

	return logger({ "source": source });
}

/** Root side: subscribe to every context's records on `$sys.log.>` and hand each to `onRecord`. */
export function installHubCollector(hub: Hub, onRecord: (record: LogRecord) => void): () => void {
	return hub.subscribe(LOG_SUBJECT + ".>", (data) => { onRecord(data as LogRecord); });
}

/** A console renderer for collected records — tagged by source, span-aware (`→ name` / `← name (Xms)`) via
 *  `renderRecord`, routed to the matching console method so levels survive in devtools. */
export function consoleCollector(record: LogRecord): void {
	const tag = typeof record.context?.["source"] === "string" ? record.context["source"] : "?";
	const line = `[${tag}] ${renderRecord(record)}`;
	const attrs = record.attrs !== undefined && Object.keys(record.attrs).length > 0 ? [record.attrs] : [];

	if (record.level === "error" || record.level === "fatal") {
		console.error(line, ...attrs);
	} else if (record.level === "warn") {
		console.warn(line, ...attrs);
	} else {
		console.log(line, ...attrs);
	}
}

/**
 * Link the controlling service worker's hub to `rootHub` over a DEDICATED MessagePort (its own observability
 * channel, distinct from the ServerBridge data port). Re-links on `controllerchange` (the SW is idle-restarted
 * by the browser), tearing down the stale link first. No-op where service workers are unavailable.
 */
export function linkServiceWorkerHub(rootHub: Hub): void {
	if (navigator.serviceWorker === undefined) {
		return;
	}

	let unlink: (() => void) | undefined;

	const wire = (): void => {
		const controller = navigator.serviceWorker.controller;

		if (controller === null) {
			return;
		}

		unlink?.();

		const channel = new MessageChannel();
		controller.postMessage({ "type": "hub", "port": channel.port2 }, [channel.port2]);
		unlink = rootHub.link(portTransport(channel.port1));
	};

	wire();
	navigator.serviceWorker.addEventListener("controllerchange", wire);
}

/**
 * Dev-only: link the page's rootHub to a running `@brianjenkins94/dev-hub` over a WebSocket, so the whole tree's
 * `$sys.log.>` stream federates out to the Node collector and becomes queryable over MCP (query_logs /
 * query_spans / get_tree_state / wait_for) — no screenshots. No-op off localhost. It makes ONE quiet attempt: if
 * no dev-hub is running the failed connect is left alone (no retry, no spam); once it HAS connected, a later drop
 * reconnects with a short backoff (the hub's `hello` handshake re-advertises interest on each relink).
 */
export function linkDevHub(rootHub: Hub, url = "ws://localhost:7378"): void {
	const host = location.hostname;

	if (host !== "localhost" && host !== "127.0.0.1") {
		return;
	}

	let everConnected = false;
	let unlink: (() => void) | undefined;

	const connect = (): void => {
		const ws = new WebSocket(url);

		ws.addEventListener("open", () => {
			everConnected = true;
			unlink = rootHub.link(websocketTransport(ws as unknown as WebSocketLike));
		});

		ws.addEventListener("close", () => {
			unlink?.();
			unlink = undefined;

			if (everConnected) {
				setTimeout(connect, 2000); // dev-hub restarted — rejoin
			}
		});

		// Swallow the connect error so a missing dev-hub doesn't surface as an unhandled event; `close` follows.
		ws.addEventListener("error", () => { /* handled by close */ });
	};

	connect();
}
