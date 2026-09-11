/**
 * Centralized, span-aware logging across the editor's windows.
 *
 * The workbench runs in its own iframe/window (see vscode.tsx), and the preview pane will too. Each is a
 * separate JS realm with its own console — so a bug in the popped-out editor lands in a console nobody is
 * watching. This module funnels every pane's structured log records back to ONE aggregator on the host
 * page, so the host console is the single place to read what every pane did, in order.
 *
 * Built on `@brianjenkins94/util/logger`: each pane logs through a `logger({ source })`, opening timed
 * SPANS for its lifecycles (boot, save) so caus­ality and duration survive the trip. A relay sink appended
 * to the pane's `sinks` forwards every `LogRecord` (a plain, structured-clone-friendly object — including
 * `span-open`/`span-close`) to the host over postMessage; the pane keeps its own console sink too, so a
 * popped-out tab is still debuggable standalone. The host renders relayed records with `renderRecord`
 * (which bakes in depth-based indentation), tagged by their originating pane — flat rather than replayed
 * through `console.group`, because records from different windows interleave and grouped nesting can't be
 * reconstructed reliably across realms.
 *
 * Adapted from games' worker/client console relay (games/war2/src/worker/ipc.ts `client-console` /
 * `worker-console`) and harness client.tsx's `logger({ source: "almostnode" })` + window error capture.
 */
import type { Logger, LogRecord } from "@brianjenkins94/util/logger";
import { logger, renderRecord, sinks } from "@brianjenkins94/util/logger";

/** Message discriminator for a relayed log record (host ⇄ pane postMessage). */
const RELAY_SOURCE = "pane-log";

interface RelayMessage {
	"source": typeof RELAY_SOURCE;
	"record": LogRecord;
}

/** The host page's own logger — its records print through the default console sink locally (they don't
 *  travel), so host and pane logs share one console and one format. */
export const hostLog: Logger = logger({ "source": "host" });

/**
 * Install the host-side aggregator: render every relayed pane record into the host console, tagged by the
 * pane it came from. `renderRecord` already indents by `record.depth` (`→ name` / `← name (Xms)` for
 * spans, depth-indented point logs), so nested pane spans stay legible even interleaved with other panes'.
 * Routed to the matching console method so warnings/errors keep their level in devtools.
 */
export function installLogAggregator(): void {
	window.addEventListener("message", (event) => {
		const data = event.data as Partial<RelayMessage> | null;

		if (data?.source !== RELAY_SOURCE || data.record === undefined) {
			return;
		}

		const { record } = data;
		const tag = typeof record.context?.["source"] === "string" ? record.context["source"] : "pane";
		const line = `[${tag}] ${renderRecord(record)}`;
		const attrs = record.attrs !== undefined && Object.keys(record.attrs).length > 0 ? [record.attrs] : [];

		if (record.level === "error" || record.level === "fatal") {
			console.error(line, ...attrs);
		} else if (record.level === "warn") {
			console.warn(line, ...attrs);
		} else {
			console.log(line, ...attrs);
		}
	});
}

/** postMessage a record to the host, sanitising to a structured-clone-safe form only if the rich object
 *  can't be cloned (an Error/function/DOM node slipped into attrs). Records are low-frequency lifecycle
 *  events, so the round-trip cost when it's needed is negligible. */
function relayTo(host: Window, record: LogRecord): void {
	const message: RelayMessage = { "source": RELAY_SOURCE, "record": record };

	try {
		host.postMessage(message, "*");
	} catch {
		try {
			host.postMessage({ "source": RELAY_SOURCE, "record": JSON.parse(JSON.stringify(record)) as LogRecord }, "*");
		} catch {
			/* host gone or truly un-cloneable — the pane's own console sink still has it. */
		}
	}
}

/**
 * Install the pane-side relay and return this pane's source-scoped logger (open spans off it:
 * `const boot = paneLog.span("workbench-boot")`). Appends a sink that forwards every record to `host`,
 * keeps the pane's existing console sink, and pipes uncaught errors/rejections through the same logger so
 * they reach the host too.
 */
export function installLogRelay(host: Window, source: string): Logger {
	const paneLog = logger({ "source": source });

	sinks.push((record) => {
		relayTo(host, record);
	});

	window.addEventListener("error", (event) => {
		// A benign, self-correcting browser notice monaco's layout triggers constantly — not a real fault,
		// so don't relay it as an error (it would drown the aggregated log). See w3c/csswg-drafts#5023.
		if (event.message.includes("ResizeObserver loop")) {
			return;
		}

		paneLog.error("uncaught error", { "message": event.message, "file": event.filename, "line": event.lineno });
	});
	window.addEventListener("unhandledrejection", (event) => {
		paneLog.error("unhandled rejection", { "reason": String(event.reason) });
	});

	return paneLog;
}
