/**
 * The editor's BABLR, from the workbench realm: one worker (bablr-worker.ts), asked one call at a time. BABLR is a VM
 * interpreter — about 14ms a line — so it never runs on the UI thread, and nothing is parsed twice: the worker keeps each
 * text's parse by its blob oid in its own IndexedDB cache, and everything it derives — spans, verdicts, edit groups —
 * starts from that.
 *
 * Its callers: the cosmetic classifier (verdicts, edit groups), the runtime evidence (evidence.ts: span ids for a run's
 * statements), and — over the hub, `annotations.refer` and `annotations.resolve` — the pod's `editor.annotations.*`
 * commands, for extensions: everything they attach to code (notes, the insights extension's evidence marks, the event
 * sheet's anchors) refers to its span, and finds it again, the one way SPAN-ANNOTATIONS.md sets out. One worker for now;
 * if BABLR's cost outgrows it, a pool goes here, behind `request`.
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
import { blobText, status } from "./git-engine";

/** One span of a text: its spanAnchors id and offsets (punctuation left out — it's never a handle). */
export interface Span { "id": string; "start": number; "end": number }

/** Where a reference's span is, and the reference as it would be made there now (when found other than by its id). */
export type Resolved = Resolution & { "ref"?: SpanRef };

/** The files BABLR's grammar may take: where a moved span is looked for. */
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
/** At most this many changed files are looked in for a moved span (each is parsed once, then cached). */
const MAX_OTHERS = 50;

export interface Bablr {
	/** Ask the worker for `bablr.<name>` (bablr-worker.ts), after whatever was asked before. No timeout: the first call
	 *  waits out the worker's (large) bundle loading, and a parse takes what it takes; `signal` and a dead worker end it. */
	"request": <T>(name: string, args: unknown, signal?: AbortSignal) => Promise<T>;
	/** `source`'s spans — from its cached parse — or undefined when BABLR's grammar doesn't take it. */
	"spans": (source: string, signal?: AbortSignal) => Promise<Span[] | undefined>;
	/** Where span `span` of `baseline` went in `current`, by the structural diff: the same node (`kept`) or the one that
	 *  replaced it — or undefined, gone. How a span annotation is re-placed from its baseline (SPAN-ANNOTATIONS.md). */
	"follow": (baseline: string, current: string, span: string) => Promise<{ "id": string; "how": "kept" | "replaced" } | undefined>;
	/** A reference to the span standing for each of `ranges` in `source`, the text of `file` — what an annotation keeps;
	 *  undefined for one BABLR can't place, all of them when it can't parse the text. */
	"refer": (source: string, file: string, ranges: { "start": number; "end": number }[]) => Promise<(SpanRef | undefined)[]>;
	/** Where each of `refs`' spans is in `source`, the text their file has now (SPAN-ANNOTATIONS.md) — and the reference
	 *  as it would be made there now, for one found other than by its own id. An authored annotation whose id is gone
	 *  is looked for in the other changed files (moved) and re-identified from its baseline, from git's objects; an
	 *  `observed` one is looked for by its id, in its own file, alone. */
	"resolve": (source: string, file: string, refs: SpanRef[], observed?: boolean) => Promise<Resolved[]>;
	/** The span id standing for each of `ranges` in `source` (bablr-language-ts's pickAnchor), from its cached spans —
	 *  or, `exact`, the span whose range is exactly the range (the node itself, when several are), and none when no
	 *  span is: what an observed site keeps, so unrelated sites never pool into one enclosing span. */
	"anchors": (source: string, ranges: { "start": number; "end": number }[], exact?: boolean) => Promise<(string | undefined)[] | undefined>;
	"dispose": () => void;
}

/** What a lost annotation's span may have moved to: the code files that differ from HEAD on disk, other than `file`,
 *  with their text (by workspace-relative path) — at most MAX_OTHERS of them. None when there's no repo. */
async function changedFiles(file: string): Promise<Record<string, string>> {
	const changes = await status().catch(() => undefined);
	const paths = [...new Set([...changes?.staged ?? [], ...changes?.unstaged ?? []].filter((change) => change.status !== "D" && change.path !== file && CODE_FILE.test(change.path)).map((change) => change.path))].slice(0, MAX_OTHERS);
	const others: Record<string, string> = {};

	for (const path of paths) {
		const text = await fs.promises.readFile(`/workspace/${path}`, "utf8").catch(() => undefined);

		if (text !== undefined && text !== "") {
			others[path] = text;
		}
	}

	return others;
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

	// The last text's spans, so asking twice in a row (a run's statements, then its sites) asks the worker once.
	let last: { "source": string; "spans": Promise<Span[] | undefined> } | undefined;

	const spans = async (source: string, signal?: AbortSignal): Promise<Span[] | undefined> => {
		if (source === "") {
			return undefined; // BABLR has nothing to parse
		}

		if (last?.source !== source) {
			const asked = request<{ "spans"?: Span[]; "unparsable"?: true }>("spans", { "source": source }, signal).then((answer) => answer.spans);

			last = { "source": source, "spans": asked };
			asked.catch(() => { if (last?.spans === asked) { last = undefined; } });
		}

		return last.spans;
	};

	const anchors = async (source: string, ranges: { "start": number; "end": number }[], exact = false): Promise<(string | undefined)[] | undefined> => {
		const known = await spans(source);

		if (known === undefined) {
			return undefined;
		}

		if (exact) {
			// Several spans can have one range (a BinaryExpression in a LogicExpression in an Expression); they come
			// innermost first. The innermost without an ordinal is the node itself, and its id doesn't shift when the
			// same code turns up earlier in the file. A statement's range from TypeScript takes its `;`; BABLR's doesn't.
			const byRange = new Map<string, Span[]>();

			for (const span of known) {
				byRange.set(`${span.start}:${span.end}`, [...byRange.get(`${span.start}:${span.end}`) ?? [], span]);
			}

			return ranges.map(({ start, end }) => {
				const found = byRange.get(`${start}:${end}`) ?? (source[end - 1] === ";" ? byRange.get(`${start}:${end - 1}`) : undefined);

				return (found?.find((span) => !span.id.includes("#")) ?? found?.[0])?.id;
			});
		}

		const { ids } = await request<{ "ids": (string | null)[] }>("pick", { "spans": known, "ranges": ranges });

		return ids.map((id) => id ?? undefined);
	};

	const refer = async (source: string, file: string, ranges: { "start": number; "end": number }[]): Promise<(SpanRef | undefined)[]> => {
		const { refs } = await request<{ "refs"?: (SpanRef | null)[] }>("refer", { "source": source, "file": file, "ranges": ranges });

		return ranges.map((_, index) => refs?.[index] ?? undefined);
	};
	const resolveRefs = async (source: string, file: string, refs: SpanRef[], observed = false): Promise<Resolved[]> => {
		const first = (await request<{ "resolutions": Resolved[] }>("resolve", { "source": source, "file": file, "refs": refs, "observed": observed })).resolutions;
		// An authored one its own id didn't find is looked for further: in the other files that differ from HEAD (code
		// moved to another file changed that file), and followed from its baseline — when git has it (code that was
		// committed). An observed one fades instead.
		const lost = observed ? [] : refs.map((ref, index) => ({ "ref": ref, "index": index })).filter(({ index }) => first[index].status !== "attached");

		if (lost.length === 0) {
			return first;
		}

		const baselines: Record<string, string> = {};

		for (const blob of new Set(lost.flatMap(({ ref }) => ref.baseline === undefined ? [] : [ref.baseline.blob]))) {
			const text = await blobText(blob);

			if (text !== undefined) {
				baselines[blob] = text;
			}
		}

		const others = await changedFiles(file);

		if (Object.keys(baselines).length === 0 && Object.keys(others).length === 0) {
			return first;
		}

		const again = (await request<{ "resolutions": Resolved[] }>("resolve", { "source": source, "file": file, "refs": lost.map(({ ref }) => ref), "baselines": baselines, "others": others })).resolutions;

		lost.forEach(({ index }, at) => { first[index] = again[at]; });

		return first;
	};
	// The pod's `editor.annotations.refer` and `editor.annotations.resolve` (for extensions) ask here, so they share the
	// worker and its cache.
	const offServe = [
		serve(hub, "annotations.refer", async (args) => {
			const { source, file, ranges } = (args ?? {}) as { "source"?: unknown; "file"?: unknown; "ranges"?: unknown };

			return typeof source === "string" && typeof file === "string" && Array.isArray(ranges) ? { "refs": (await refer(source, file, ranges as { "start": number; "end": number }[])).map((ref) => ref ?? null) } : {};
		}),
		serve(hub, "annotations.resolve", async (args) => {
			const { source, file, refs, observed } = (args ?? {}) as { "source"?: unknown; "file"?: unknown; "refs"?: unknown; "observed"?: unknown };

			return typeof source === "string" && typeof file === "string" && Array.isArray(refs) ? { "resolutions": await resolveRefs(source, file, refs as SpanRef[], observed === true) } : {};
		})
	];

	return {
		"request": request,
		"spans": spans,
		"anchors": anchors,
		"refer": refer,
		"resolve": resolveRefs,
		"follow": async (baseline, current, span) => {
			const found = await request<{ "id"?: string; "how"?: "kept" | "replaced" }>("follow", { "baseline": baseline, "current": current, "span": span });

			return found.id === undefined || found.how === undefined ? undefined : { "id": found.id, "how": found.how };
		},
		"dispose": () => {
			for (const off of offServe) {
				off();
			}

			unlink();
			worker.terminate();
		}
	};
}
