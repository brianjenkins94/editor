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
import { createRpcClient, portTransport, serve, websocketTransport } from "@brianjenkins94/hub";
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

// Set true only while the collector (or another observability path) writes to console, so a same-realm console
// tap (tapConsoleAndErrors with captureConsole) never re-captures observability's own console output — the one
// way console capture could loop when the collector and a tap share a realm (the page/root).
let observabilityWriting = false;

/** A console renderer for collected records — tagged by source, span-aware (`→ name` / `← name (Xms)`) via
 *  `renderRecord`, routed to the matching console method so levels survive in devtools. */
export function consoleCollector(record: LogRecord): void {
	const tag = typeof record.context?.["source"] === "string" ? record.context["source"] : "?";
	const line = `[${tag}] ${renderRecord(record)}`;
	const attrs = record.attrs !== undefined && Object.keys(record.attrs).length > 0 ? [record.attrs] : [];

	observabilityWriting = true;

	try {
		if (record.level === "error" || record.level === "fatal") {
			console.error(line, ...attrs);
		} else if (record.level === "warn") {
			console.warn(line, ...attrs);
		} else {
			console.log(line, ...attrs);
		}
	} finally {
		observabilityWriting = false;
	}
}

/** Render one console argument for a captured record: strings as-is, objects as compact JSON (String() fallback). */
function fmtArg(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Publish a raw (non-logger) record straight onto the plane — the taps use this for console/error capture that
 *  didn't originate from a structured logger, so it stays decoupled from `sinks` (no default-console-sink loop). */
function publishRecord(hub: Hub, source: string, level: LogRecord["level"], message: string, attrs: Record<string, unknown> = {}): void {
	try {
		hub.publish(`${LOG_SUBJECT}.${source}`, {
			"kind": "log",
			"level": level,
			"message": message,
			"attrs": attrs,
			"context": { "source": source },
			"time": Date.now(),
			"depth": 0
		} satisfies LogRecord);
	} catch { /* telemetry must never break the observed context */ }
}

/**
 * Capture the RAW failures that `relayLoggerToHub` misses — uncaught `error` + `unhandledrejection` on this
 * context's global — and publish them onto the plane as `$sys.log.<source>` records, so every boundary's crashes
 * (not just its intentional, structured logs) show up in the one collected stream. Loop-free everywhere: an error
 * event is never produced by console, and publishing never touches console.
 *
 * `captureConsole` additionally patches `console.error`/`console.warn` (for contexts WITHOUT a structured logger,
 * e.g. an app iframe — a context WITH `relayLoggerToHub` would double-log, since the logger's own console sink
 * would be re-captured). It's guarded against the collector's own writes via `observabilityWriting`, and calls the
 * ORIGINAL console (captured at patch time) so it never self-loops. Returns a disposer.
 */
export function tapConsoleAndErrors(hub: Hub, source: string, options: { "captureConsole"?: boolean } = {}): () => void {
	const disposers: (() => void)[] = [];
	const target = globalThis as { "addEventListener"?: (type: string, handler: (event: Event) => void) => void; "removeEventListener"?: (type: string, handler: (event: Event) => void) => void };

	if (typeof target.addEventListener === "function") {
		const onError = (event: Event): void => {
			const error = event as ErrorEvent;

			publishRecord(hub, source, "error", error.message || "uncaught error", {
				"src": error.filename,
				"line": error.lineno,
				"col": error.colno,
				"stack": error.error instanceof Error ? error.error.stack : undefined
			});
		};
		const onRejection = (event: Event): void => {
			const reason = (event as PromiseRejectionEvent).reason;

			publishRecord(hub, source, "error", "unhandledrejection: " + (reason instanceof Error ? reason.message : String(reason)), {
				"stack": reason instanceof Error ? reason.stack : undefined
			});
		};

		target.addEventListener("error", onError);
		target.addEventListener("unhandledrejection", onRejection);
		disposers.push(() => {
			target.removeEventListener?.("error", onError);
			target.removeEventListener?.("unhandledrejection", onRejection);
		});
	}

	if (options.captureConsole === true) {
		const bay = console as unknown as Record<string, (...args: unknown[]) => void>;
		// Hoisted out of the level loop so the wrapper closure isn't declared inside a loop (no-loop-func).
		const patch = (method: string, level: LogRecord["level"]): void => {
			const original = typeof bay[method] === "function" ? bay[method].bind(console) : (): void => undefined;

			bay[method] = (...args: unknown[]): void => {
				if (!observabilityWriting) {
					publishRecord(hub, source, level, args.map(fmtArg).join(" "));
				}

				original(...args);
			};
			disposers.push(() => { bay[method] = original; });
		};

		patch("error", "error");
		patch("warn", "warn");
	}

	return () => {
		for (const dispose of disposers) {
			dispose();
		}
	};
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

	// Forward `provoke_transform` down to the preview worker (which hosts `preview.provoke`). page_eval can't reach
	// the worker's dev server, but an rpc request from this page routes to it — so this thin bridge lets an agent
	// loop the cold-start transform race from debug-mcp instead of hand-driving cold boots. See node-worker.ts.
	const rpc = createRpcClient(hub);

	serve(hub, "preview_provoke", (args) => rpc.request("preview.provoke", args ?? {}, { "timeoutMs": 300000 }));
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
