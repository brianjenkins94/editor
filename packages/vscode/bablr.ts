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
import type { Resolution, SpanRef } from "@brianjenkins94/util/silo/annotations";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/evidence";
import { fs } from "@zenfs/core";
import { blobText } from "./git-engine";

/** One span of a text: its spanAnchors id and offsets (punctuation left out — it's never a handle). */
export interface Span { "id": string; "start": number; "end": number }

export interface Bablr {
	/** Ask the worker for `bablr.<name>` (bablr-worker.ts), after whatever was asked before. No timeout: the first call
	 *  waits out the worker's (large) bundle loading, and a parse takes what it takes; `signal` and a dead worker end it. */
	"request": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T>;
	/** `source`'s spans — from its cached parse — or undefined when BABLR's grammar doesn't take it. */
	"spans": (source: string, signal?: AbortSignal) => Promise<Span[] | undefined>;
	/** Where span `span` of `baseline` went in `current`, by the structural diff: the same node (`kept`) or the one that
	 *  replaced it — or undefined, gone. How a span annotation is re-placed from its baseline (SPAN-ANNOTATIONS.md). */
	"follow": (baseline: string, current: string, span: string) => Promise<{ "id": string; "how": "kept" | "replaced" } | undefined>;
	/** A reference to the span standing for `range` in `source`, the text of `file` — what an annotation keeps. */
	"refer": (source: string, file: string, range: { "start": number; "end": number }) => Promise<SpanRef | undefined>;
	/** Where `ref`'s span is in `source`, the text its file has now (SPAN-ANNOTATIONS.md) — and the reference as it would
	 *  be made there now, when it's found. Its baseline, from git's objects, re-identifies it when its id is gone. */
	"resolve": (source: string, file: string, ref: SpanRef) => Promise<Resolution & { "ref"?: SpanRef }>;
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

	const anchors = async (source: string, ranges: { "start": number; "end": number }[]): Promise<(string | undefined)[] | undefined> => {
		const known = await spans(source);

		if (known === undefined) {
			return undefined;
		}

		const { ids } = await request<{ "ids": (string | null)[] }>("pick", { "spans": known, "ranges": ranges });

		return ids.map((id) => id ?? undefined);
	};

	const refer = async (source: string, file: string, range: { "start": number; "end": number }): Promise<SpanRef | undefined> => (await request<{ "ref"?: SpanRef }>("refer", { "source": source, "file": file, "start": range.start, "end": range.end })).ref;
	const resolveRef = async (source: string, file: string, ref: SpanRef): Promise<Resolution & { "ref"?: SpanRef }> => {
		const first = await request<Resolution & { "ref"?: SpanRef }>("resolve", { "source": source, "file": file, "ref": ref });

		// Its own id found it, or there's no baseline to follow it from: that's the answer. Otherwise follow it from the
		// baseline — when git has it (code that was committed).
		if (first.status === "attached" || ref.baseline === undefined) {
			return first;
		}

		const baseline = await blobText(ref.baseline.blob);

		return baseline === undefined ? first : request("resolve", { "source": source, "file": file, "ref": ref, "baseline": baseline });
	};
	// The pod's `editor.annotations.refer` and `editor.annotations.resolve` (for extensions: the notes) ask here.
	const offAnnotations = [
		serve(hub, "annotations.refer", async (args) => {
			const { source, file, start, end } = (args ?? {}) as { "source"?: unknown; "file"?: unknown; "start"?: unknown; "end"?: unknown };

			return typeof source === "string" && typeof file === "string" && typeof start === "number" && typeof end === "number" ? { "ref": await refer(source, file, { "start": start, "end": end }) } : {};
		}),
		serve(hub, "annotations.resolve", async (args) => {
			const { source, file, ref } = (args ?? {}) as { "source"?: unknown; "file"?: unknown; "ref"?: SpanRef };

			return typeof source === "string" && typeof file === "string" && ref !== undefined ? resolveRef(source, file, ref) : { "status": "orphaned", "alternatives": [] };
		})
	];

	// The pod's `editor.bablr.spans` and `editor.bablr.anchors` (for extensions) ask here, so they share the worker and
	// its cache: a text's spans, or — given ranges — the span standing for each.
	const offServe = serve(hub, "spans.of", async (args, { signal }) => {
		const { source, ranges } = (args ?? {}) as { "source"?: unknown; "ranges"?: unknown };

		if (typeof source !== "string") {
			return {};
		}

		if (Array.isArray(ranges)) {
			return { "ids": (await anchors(source, ranges as { "start": number; "end": number }[]))?.map((id) => id ?? null) };
		}

		return { "spans": await spans(source, signal) };
	});

	return {
		"request": request,
		"spans": spans,
		"anchors": anchors,
		"refer": refer,
		"resolve": resolveRef,
		"follow": async (baseline, current, span) => {
			const found = await request<{ "id"?: string; "how"?: "kept" | "replaced" }>("follow", { "baseline": baseline, "current": current, "span": span });

			return found.id === undefined || found.how === undefined ? undefined : { "id": found.id, "how": found.how };
		},
		"dispose": () => {
			offServe();

			for (const off of offAnnotations) {
				off();
			}

			unlink();
			worker.terminate();
		}
	};
}
