/**
 * The editor's BABLR, from the workbench realm: one worker (bablr-worker.ts), asked one call at a time. BABLR is a VM
 * interpreter — about 14ms a line — so it never runs on the UI thread, and nothing is parsed twice: the worker keeps each
 * text's parse by its blob oid in its own IndexedDB cache, and everything it derives — spans, verdicts, edit groups —
 * starts from that.
 *
 * Its callers: the cosmetic classifier (verdicts, edit groups), the runtime evidence (evidence.ts: span ids for a run's
 * statements), and — over the hub, `spans.of` — the pod's `editor.bablr.spans` command, for extensions (the insights
 * extension's evidence marks). One worker for now; if BABLR's cost outgrows it, a pool goes here, behind `request`.
 *
 * ABORT: the worker yields between parse chunks, so a cancelled call's signal reaches it mid-run and it bails
 * cooperatively (the worker stays warm); a still-queued call is dropped unsent. A worker that fails to load, or dies,
 * fails what's in flight and every later call.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/evidence";
import { fs } from "@zenfs/core";

/** One span of a text: its spanAnchors id and offsets (punctuation left out — it's never a handle). */
export interface Span { "id": string; "start": number; "end": number }

export interface Bablr {
	/** Ask the worker for `bablr.<name>` (bablr-worker.ts), after whatever was asked before. No timeout: the first call
	 *  waits out the worker's (large) bundle loading, and a parse takes what it takes; `signal` and a dead worker end it. */
	"request": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T>;
	/** `source`'s spans — from its cached parse — or undefined when BABLR's grammar doesn't take it. */
	"spans": (source: string, signal?: AbortSignal) => Promise<Span[] | undefined>;
	/** The span id standing for each of `ranges` in `source` (bablr-language-ts's pickAnchor), from its cached spans. */
	"anchors": (source: string, ranges: { "start": number; "end": number }[]) => Promise<(string | undefined)[] | undefined>;
	"dispose": () => void;
}

export function startBablr(hub: Hub): Bablr {
	const worker = new Worker(new URL("./lsp/bablr-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	const rpc = createRpcClient(hub);
	const dead = new AbortController();

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		dead.abort(new Error("BABLR worker failed: " + (event.message || "could not load")));
	});

	// One call at a time: BABLR is slow, and the newest request is the one someone is waiting on.
	let tail: Promise<unknown> = Promise.resolve();

	const request = <T>(name: string, args: unknown, signal?: AbortSignal): Promise<T> => {
		const combined = signal === undefined ? dead.signal : AbortSignal.any([signal, dead.signal]);
		// An already-aborted signal skips the call unsent.
		const run = tail.then(() => rpc.request("bablr." + name, args, { "timeoutMs": Infinity, "waitForResponderMs": 30000, "signal": combined }) as Promise<T>);

		tail = run.catch(() => undefined);

		// Reject a queued call as soon as it's aborted, not when its turn comes.
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => { reject(combined.reason); };

			combined.addEventListener("abort", onAbort, { "once": true });
			run.then(resolve, reject).finally(() => { combined.removeEventListener("abort", onAbort); });
		});
	};

	// What earlier builds kept in the workspace — verdicts in `.git/bablr/`, then spans and verdicts in
	// `.silo/local/bablr/` — is all derivable, and the worker's cache has what it came from: it just goes.
	for (const old of ["/workspace/.git/bablr", `/workspace/${LOCAL_DIR}/bablr`]) {
		void fs.promises.rm(old, { "recursive": true, "force": true }).catch(() => undefined);
	}

	const spans = async (source: string, signal?: AbortSignal): Promise<Span[] | undefined> => {
		if (source === "") {
			return undefined; // BABLR has nothing to parse
		}

		return (await request<{ "spans"?: Span[]; "unparsable"?: true }>("spans", { "source": source }, signal)).spans;
	};

	// The pod's `editor.bablr.spans` (for extensions) asks here, so it gets the cache too.
	const offServe = serve(hub, "spans.of", async (args, { signal }) => {
		const source = (args as { "source"?: unknown } | undefined)?.source;

		return typeof source === "string" ? { "spans": await spans(source, signal) } : {};
	});

	return {
		"request": request,
		"spans": spans,
		"anchors": async (source, ranges) => {
			const known = await spans(source);

			if (known === undefined) {
				return undefined;
			}

			const { ids } = await request<{ "ids": (string | null)[] }>("pick", { "spans": known, "ranges": ranges });

			return ids.map((id) => id ?? undefined);
		},
		"dispose": () => {
			offServe();
			unlink();
			worker.terminate();
		}
	};
}
