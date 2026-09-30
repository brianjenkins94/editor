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
import type { Hub, LinkPermissions } from "@brianjenkins94/hub";
import type { Logger, LogRecord } from "@brianjenkins94/util/logger";
import { createRpcClient, portTransport, serve, websocketTransport, windowTransport } from "@brianjenkins94/hub";
import { logger, renderRecord, sinks } from "@brianjenkins94/util/logger";

import type { PageTool } from "./page-tools.ts";
import type { TabInfo } from "./tabs.ts";
import { tagBySubject } from "./log-subject.ts";
import { PAGE_TOOLS_CHANGED, servePageToolSet } from "./page-tools.ts";
import { OBSERVABILITY_PROTOCOL, TAB_DISCOVER, TAB_HERE } from "./tabs.ts";

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

/** Where a root sends a linking collector the records it logged before it could receive them (see `logBacklog`) —
 *  one message, an array of LogRecords. Outside `$sys.log.>`, so the root's own collectors never see it. */
export const LOG_BACKLOG = "$sys.backlog.log";

/**
 * Hold a root's records for a collector that isn't linked yet (debug-mcp, before its socket opens and its interest
 * arrives), then send them to it as one backlog (`LOG_BACKLOG`) — so it sees startup too.
 *
 * No record is both sent live and in the backlog: a record published once the collector's interest is known went
 * out live, so the first one to see that interest flushes the backlog instead of joining it (the collector's
 * `$sys.log.>` and `LOG_BACKLOG` interest arrive together, in its hello). Holds at most `max` (the newest).
 */
export function logBacklog(hub: Hub, { max = 1000 } = {}): { "flushWhenReady": (timeoutMs?: number) => Promise<void>; "rearm": () => void; "dispose": () => void } {
	let held: LogRecord[] | undefined = [];

	const flush = (): void => {
		const records = held ?? [];

		held = undefined;

		if (records.length > 0) {
			hub.publish(LOG_BACKLOG, records);
		}
	};
	const unsubscribe = hub.subscribe(LOG_SUBJECT + ".>", (data) => {
		if (held === undefined) {
			return;
		}

		if (hub.interested(LOG_BACKLOG)) {
			flush();

			return;
		}

		held.push(data as LogRecord);

		if (held.length > max) {
			held.shift();
		}
	});

	return {
		/** A collector is linking: send the backlog once it can receive it (or give up after `timeoutMs`). */
		"flushWhenReady": async (timeoutMs = 5000) => {
			if (held !== undefined && await hub.whenInterested(LOG_BACKLOG, timeoutMs)) {
				flush();
			}
		},
		/** The collector went away: hold records again, for the next one. */
		"rearm": () => {
			held ??= [];
		},
		"dispose": unsubscribe
	};
}

/** Root side: subscribe to every context's records on `$sys.log.>` and hand each to `onRecord` — tagged with the source
 *  its subject names (the part link permissions enforce), not whatever source the record claims (tagBySubject). */
export function installHubCollector(hub: Hub, onRecord: (record: LogRecord) => void): () => void {
	return hub.subscribe(LOG_SUBJECT + ".>", (data, envelope) => { onRecord(tagBySubject(data as LogRecord, envelope.subject)); });
}

/**
 * What a link lets an untrusted peer (hub id `peer`) do for observability: publish its own logs (`$sys.log.<peer>`) and
 * architecture reports (`$sys.arch.<peer>`) — or a context's behind it, `<peer>.<suffix>` (its instance page, say) —
 * and hear the viewers' `$sys.arch.sync`. So it can't log or report as anyone else. Merge it into the link's own
 * permissions.
 */
export function observabilityPermissions(peer: string): Required<LinkPermissions> {
	return {
		"publish": [`${LOG_SUBJECT}.${peer}`, `${LOG_SUBJECT}.${peer}.>`, `$sys.arch.${peer}`, `$sys.arch.${peer}.>`],
		"subscribe": ["$sys.arch.sync"]
	};
}

/**
 * Own a worker's errors once. A worker reports its own uncaught errors over its hub (tapConsoleAndErrors), but the
 * browser then re-raises an unhandled one in the page that owns the worker — whose tap would report it again, as the
 * page's. Mark those handled here. A worker that failed to LOAD can't report anything: that arrives as a plain Event,
 * and `onLoadFailure` hears it (log it where the worker would have).
 */
export function ownWorker(worker: Worker, onLoadFailure: () => void = () => undefined): () => void {
	const onError = (event: Event): void => {
		if (typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent) {
			event.preventDefault();
		} else {
			onLoadFailure();
		}
	};

	worker.addEventListener("error", onError);

	return () => { worker.removeEventListener("error", onError); };
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
 * A rejection that only says an operation was called off: VS Code's `CancellationError` (its own global handler
 * ignores these — e.g. a debug session's in-flight requests, cancelled as it stops) or the platform's `AbortError`.
 * Someone chose to stop the work, so it isn't a fault to report.
 */
export function isCancellation(reason: unknown): boolean {
	return reason instanceof Error && ((reason.name === "Canceled" && reason.message === "Canceled") || reason.name === "AbortError");
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

			if (isCancellation(reason)) {
				return;
			}

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
	// A restarted service worker (the browser stops idle ones) is a fresh global with an unlinked hub: it asks.
	navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
		if ((event.data as { "type"?: string } | null)?.type === "sw-needs-hub") {
			wire();
		}
	});
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

/** Answer tab discovery (tabs.ts) on `hub` as tab `tab`. Returns an unsubscribe. */
export function answerTabDiscovery(hub: Hub, tab: string): () => void {
	return hub.subscribe(TAB_DISCOVER, (data) => {
		hub.publish(TAB_HERE, { "query": (data as { "query"?: string } | undefined)?.query, ...describeTab(tab, hub) });
	});
}

function describeTab(tab: string, hub: Hub): TabInfo {
	const info: TabInfo = { "tab": tab, "url": location.href, "title": document.title, "visible": document.visibilityState === "visible", "focused": document.hasFocus(), "protocol": OBSERVABILITY_PROTOCOL };

	// An app in an editor preview is its own page, inside the editor's tab: describe it, not the editor around it —
	// and say which preview window it is (the id the editor's shell assigned its page: Hub.knownAs), the scope the
	// editor files its records under, so a relay can tell its records from the editor's.
	if (previewHost() !== undefined) {
		const scope = hub.knownAs()[0];

		return { ...info, "preview": true, ...scope === undefined ? {} : { "scope": scope } };
	}

	try {
		// A hub in a frame describes the tab it's in: the top window's address, title and focus.
		const top = window.top;

		if (top !== null && top !== window) {
			info.url = top.location.href;
			info.title = top.document.title || info.title;
			info.focused = top.document.hasFocus();
		}
	} catch { /* a cross-origin top — keep this frame's own */ }

	return info;
}

/**
 * The editor window hosting this page, when it's the TOP frame of an editor preview (served under `/__virtual__/`);
 * undefined otherwise — including in a frame the app nests inside its page, which reaches the editor through the
 * app's own hub tree (linking it too would make a cycle).
 */
export function previewHost(): Window | undefined {
	if (typeof window === "undefined" || window.parent === window || !location.pathname.includes("/__virtual__/")) {
		return undefined;
	}

	try {
		return window.parent.location.pathname.includes("/__virtual__/") ? undefined : window.parent;
	} catch {
		return undefined; // a cross-origin parent: not the editor
	}
}

/**
 * Inside an editor preview, link `hub` — the app page's root hub — into the editor's hub tree, through the shell: the
 * app's logs, architecture and page tools then reach the editor's observability plane and its debug-mcp, as part of
 * the editor's tab (the shell confines what crosses). Returns the link, or undefined when this page isn't a preview's
 * top frame (then link debug-mcp directly: `linkPreviewHost(hub) ?? linkDebugMcp(hub)`).
 */
export function linkPreviewHost(hub: Hub): PreviewLink | undefined {
	const host = previewHost();

	if (host === undefined) {
		return undefined;
	}

	// What the app logs while it boots — before this link is up — would never reach the editor: hold it, send it once
	// the collector can hear it (as linkDebugMcp does).
	const backlog = logBacklog(hub);
	const link = hub.link(windowTransport(host, location.origin)) as PreviewLink;

	void backlog.flushWhenReady();
	announceWhenReady(hub, link);

	return link;
}

/** Once `link` is up, tell whoever's across it to (re-)read this page's tools: announcing them when they were first
 *  served happened before this link could carry it (a one-off publish before a link's interest has arrived goes
 *  nowhere), so a relay linking later would otherwise never learn them. */
function announceWhenReady(hub: Hub, link: () => void): void {
	void (link as { "ready"?: Promise<boolean> }).ready?.then((ready) => {
		if (ready) {
			hub.publish(PAGE_TOOLS_CHANGED, {});
		}
	});
}

/** The link `linkPreviewHost` makes (hub's link handle): call it to unlink; `ready` resolves once the editor answered. */
export type PreviewLink = (() => void) & { readonly "ready": Promise<boolean> };

export interface PageToolsOptions {
	/** This tab's id (default: minted here). Every tool is served as `<name>.<tab>`, so a relay linked to several tabs
	 *  at once addresses one (see tabs.ts for how it learns the ids). */
	"tab"?: string;
	/** Host calls to expose the same way, each forwarded into THIS tab's own tree: `{ "preview_provoke": "preview.provoke" }`
	 *  serves `preview_provoke.<tab>` by requesting `preview.provoke` here. The caller owns the timeout (and cancels). */
	"forward"?: Record<string, string>;
	/** Tools this page defines (see page-tools.ts): debug-mcp registers each as a real MCP tool while this tab is
	 *  connected, and forwards calls here. */
	"tools"?: PageTool[];
}

/**
 * Host live MCP tools IN THIS TAB. When the debug-mcp link is enabled (see `debugEnabled`), register handlers the
 * debug-mcp relay forwards agent tool calls to — so an MCP client (Claude Code) can query the LIVE page, not just
 * the log stream: `page_eval` (evaluate an expression in page scope), `page_query` (a CSS selector's count + text
 * sample), and the host's `forward`ed calls — all under this tab's id, and it answers the relay's tab discovery. This
 * is what makes the tab the de-facto MCP server; the relay is a pipe. Dev-only + gated, and `eval` here is reachable
 * only by a relay that passed its own Origin check — but it IS arbitrary in-page eval, so keep it behind the opt-in.
 * Returns the tab id, or undefined when disabled.
 */
export function servePageTools(hub: Hub, options: PageToolsOptions = {}): string | undefined {
	if (!debugEnabled()) {
		return undefined;
	}

	const tab = options.tab ?? crypto.randomUUID().slice(0, 8);

	serve(hub, "page_eval." + tab, async (args) => {
		const { expression } = args as { "expression": string };
		// page_eval's whole purpose is to evaluate a caller-supplied expression in the tab: indirect eval runs it in global
		// scope, not this closure. Through `globalThis` — an `eval` alias gets inlined back into a direct eval by the
		// consumer's bundler (Rolldown's [EVAL] warning, in every app that bundles this).
		// eslint-disable-next-line no-eval -- see above
		const indirectEval = globalThis.eval;

		// Await a thenable result: a Promise JSON-serializes to `{}`, which would hide every async answer.
		return jsonSafe(await indirectEval(expression));
	});

	serve(hub, "page_query." + tab, (args) => {
		const { selector, limit = 10 } = args as { "selector": string; "limit"?: number };
		const nodes = Array.from(document.querySelectorAll(selector));

		return { "count": nodes.length, "sample": nodes.slice(0, limit).map((node) => (node.textContent ?? "").trim().slice(0, 120)) };
	});

	// A request from this hub reaches only this tab's tree (the relay links each tab as its own), so a forward is how a
	// relay reaches a service deep in ONE tab — a worker's dev server, the debugger — that page_eval can't.
	const rpc = createRpcClient(hub);

	for (const [name, target] of Object.entries(options.forward ?? {})) {
		serve(hub, name + "." + tab, (args, { signal }) => rpc.request(target, args ?? {}, { "timeoutMs": Infinity, "waitForResponderMs": 10000, "signal": signal }));
	}

	servePageToolSet(hub, tab, options.tools ?? []);
	answerTabDiscovery(hub, tab);

	return tab;
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
	// What's logged before the socket is up (and its interest has arrived) — startup, mostly — would never reach it.
	const backlog = logBacklog(rootHub);

	const connect = (): void => {
		const ws = new WebSocket(url);

		ws.addEventListener("open", () => {
			everConnected = true;
			const link = rootHub.link(websocketTransport(ws));

			unlink = link;
			void backlog.flushWhenReady();
			announceWhenReady(rootHub, link);
		});

		ws.addEventListener("close", () => {
			unlink?.();
			unlink = undefined;
			backlog.rearm();

			if (everConnected) {
				setTimeout(connect, 2000); // debug-mcp restarted — rejoin
			}
		});

		// Swallow the connect error so a missing debug-mcp doesn't surface as an unhandled event; `close` follows.
		ws.addEventListener("error", () => { /* handled by close */ });
	};

	connect();
}

export * from "./log-subject.ts";
export * from "./arch.ts";
export * from "./arch-probes.ts";
export * from "./arch-store.ts";
export * from "./page-tools.ts";
export * from "./tabs.ts";
export * from "./scope.ts";
