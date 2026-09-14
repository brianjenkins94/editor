/**
 * @brianjenkins94/observability — the observability plane: `@brianjenkins94/util/logger` spans/records carried
 * over `@brianjenkins94/hub`.
 *
 * Every context (a page, an iframe, a worker, a service worker, a Node process) logs through a source-scoped
 * `logger({ source })` and opens timed SPANS for its operations. A sink appended to that context's shared `sinks`
 * publishes each structured `LogRecord` onto its hub on `$sys.log.<source>`. Because hubs federate, those records
 * flow up to whatever root hub is present, where a single COLLECTOR leaf renders the merged, span-nested,
 * duration-carrying stream — so the whole tree's activity is watchable from one place, and a context stays
 * debuggable standalone (its own console sink is kept). This is the WireTap / Control-Bus pattern: telemetry
 * rides its own reserved `$sys.>` namespace, separate from application traffic.
 *
 * This is the reusable middle layer between `@brianjenkins94/hub` (transport/routing) and a sink such as
 * `@brianjenkins94/debug-mcp` (a Node collector + MCP): the editor wires these three together, and a game or any
 * other host wires them the same way — no host imports another's internals.
 *
 * `LogRecord` carries `span/spanId/parentSpanId/traceId/depth/durationMs` as W3C-shaped ids, so spans survive the
 * trip intact and stitch across contexts; the collector tags each by `context.source`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger, LogRecord } from "@brianjenkins94/util/logger";
import { portTransport, serve, websocketTransport } from "@brianjenkins94/hub";
import { logger, renderRecord, sinks } from "@brianjenkins94/util/logger";

/** Reserved observability namespace — records are published on `$sys.log.<source>`; app code must not use it.
 *  A separate-process sink (a Node collector) must use this same value; see @brianjenkins94/debug-mcp. */
export const LOG_SUBJECT = "$sys.log";

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
 * channel, distinct from any application data port). Re-links on `controllerchange` (the SW is idle-restarted by
 * the browser), tearing down the stale link first. No-op where service workers are unavailable.
 */
export function linkServiceWorkerHub(rootHub: Hub): void {
	if (navigator.serviceWorker === undefined) {
		return;
	}

	let unlink: (() => void) | undefined;

	const wire = (): void => {
		const { controller } = navigator.serviceWorker;

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
 * Is the debug-mcp link enabled for this page? Always on localhost; on any other origin (e.g. the DEPLOYED Pages
 * site) only when the developer opts in with `?debug` or `localStorage.debug`. So the deployed site can talk to
 * a debug-mcp on YOUR machine when you ask, and a random visitor's tab never probes their localhost or serves tools.
 */
function debugEnabled(): boolean {
	const host = location.hostname;

	if (host === "localhost" || host === "127.0.0.1") {
		return true;
	}

	try {
		if (new URLSearchParams(location.search).has("debug") || localStorage.getItem("debug") !== null) {
			return true;
		}
	} catch { /* no URL/storage access — treat as disabled */ }

	return false;
}

/** JSON-safe a page_eval result: the reply crosses a WebSocket (JSON), so functions/DOM nodes/undefined can't ride
 *  raw. undefined→null, functions→a label, objects→a JSON round-trip (or their String() if that fails). */
function jsonSafe(value: unknown): unknown {
	if (value === undefined) {
		return null;
	}

	if (typeof value === "function") {
		return "ƒ " + ((value as { "name"?: string }).name ?? "");
	}

	if (typeof value === "object" && value !== null) {
		try {
			return JSON.parse(JSON.stringify(value));
		} catch {
			return String(value);
		}
	}

	return value;
}

/**
 * Host live MCP tools IN THIS TAB. When the debug-mcp link is enabled (see `debugEnabled`), register handlers the
 * debug-mcp relay forwards agent tool calls to — so an MCP client (Claude Code) can query the LIVE page, not just
 * the log stream: `page_eval` (evaluate an expression in page scope) and `page_query` (a CSS selector's count +
 * text sample). This is what makes the tab the de-facto MCP server; the relay is a pipe. Dev-only + gated, and
 * `eval` here is reachable only by a relay that passed its own Origin check — but it IS arbitrary in-page eval,
 * so keep it behind the opt-in.
 */
export function servePageTools(hub: Hub): void {
	if (!debugEnabled()) {
		return;
	}

	serve(hub, "page_eval", (args) => {
		const { expression } = args as { "expression": string };
		// eslint-disable-next-line no-eval -- page_eval's whole purpose is to evaluate a caller-supplied expression in the tab; indirect eval runs it in global scope, not this closure.
		const indirectEval = eval;

		return jsonSafe(indirectEval(expression));
	});

	serve(hub, "page_query", (args) => {
		const { selector, limit = 10 } = args as { "selector": string; "limit"?: number };
		const nodes = Array.from(document.querySelectorAll(selector));

		return { "count": nodes.length, "sample": nodes.slice(0, limit).map((node) => (node.textContent ?? "").trim().slice(0, 120)) };
	});
}

/**
 * Dev-only: link the page's rootHub to a running `@brianjenkins94/debug-mcp` over a WebSocket, so the whole tree's
 * `$sys.log.>` stream federates out to the Node collector and becomes queryable over MCP (query_logs /
 * query_spans / get_tree_state / wait_for) — no screenshots. Enabled per `debugEnabled` (localhost, or `?debug`
 * on the deployed site). It makes ONE quiet attempt: if no debug-mcp is running the failed connect is left alone (no
 * retry, no spam); once it HAS connected, a later drop reconnects with a short backoff (the hub's `hello`
 * handshake re-advertises interest on each relink).
 */
export function linkDebugMcp(rootHub: Hub, url = "ws://localhost:7378"): void {
	if (!debugEnabled()) {
		return;
	}

	let everConnected = false;
	let unlink: (() => void) | undefined;

	const connect = (): void => {
		const ws = new WebSocket(url);

		ws.addEventListener("open", () => {
			everConnected = true;
			unlink = rootHub.link(websocketTransport(ws));
		});

		ws.addEventListener("close", () => {
			unlink?.();
			unlink = undefined;

			if (everConnected) {
				setTimeout(connect, 2000); // debug-mcp restarted — rejoin
			}
		});

		// Swallow the connect error so a missing debug-mcp doesn't surface as an unhandled event; `close` follows.
		ws.addEventListener("error", () => { /* handled by close */ });
	};

	connect();
}
