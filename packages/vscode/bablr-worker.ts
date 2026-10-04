/**
 * The BABLR worker — the editor's BABLR, OFF the main thread (bablr.ts starts it and queues what it's asked): the
 * cosmetic/semantic analysis over the CST-node IDENTITY core, and the span ids the runtime evidence keys on.
 *
 * `deriveIdentityAsync` restates the verdict on top of stable node identity: cosmetic exactly when the trivia-insensitive
 * node atoms are unchanged, otherwise semantic (a deletion counts), or unparsable — and it also yields which nodes
 * changed and the working lines they land on, so the diff pane can focus per node. `editGroups` decomposes an
 * edit-burst chain into node-grouped chunks for the "your edits" timeline.
 *
 * Served over the hub, to bablr.ts: `bablr.verdict` and `bablr.editGroups` (cosmetic-classifier.ts); `bablr.spans`,
 * every span of a source, from its cached parse (below); and `bablr.pick`, the span standing for each of a text's
 * ranges, from its spans (the runtime evidence's span ids for a run's statements); and `bablr.follow`, where a span of
 * one version of a text went in another (a span annotation re-placed from its baseline, SPAN-ANNOTATIONS.md); and for
 * annotations themselves, `bablr.refer` (references to the spans standing for ranges) and `bablr.resolve` (where
 * references' spans are in a text now — silo's resolver, over the text's span shapes).
 * YIELDING + ABORT: the derivation paces the BABLR VM (yields as it parses), so a cancelled call's signal lands
 * mid-parse and the run bails cooperatively, no worker termination. bablr.ts drives one call at a time.
 */
import "./bablr-fast-freeze"; // MUST be first: neutralizes record freezing before the BABLR bundle captures Object.freeze
import { atomsOf, cstSpansAsync, deriveIdentityAsync, editGroups, follow, PARSE_VERSION, pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import { serve } from "@brianjenkins94/hub";
import type { SpanRef, SpanShape } from "@brianjenkins94/util/silo/annotations";
import { OBSERVED, PIPELINE, referTo, resolve } from "@brianjenkins94/util/silo/annotations";

import { createWorkerHub } from "./worker-hub";

const hub = createWorkerHub("bablr");

// ── the parse cache ──
// A text's parse (cstSpans) is the one expensive step every product starts from, and a pure function of the text: kept
// by its git blob oid in this browser's IndexedDB (`bablr`, its own database — not the workspace, whose fixed buffer the
// project shares), under PARSE_VERSION so a change to the grammar or the span walk drops what it makes stale. A silo on
// disk would keep the same thing in `.silo/local/bablr/`. Everything in it can go at any time: past CACHE_BYTES, the
// least recently used go first.

interface CstSpan { "type": string | null; "field": string | null; "start": number; "end": number; "token": boolean; "cover": boolean; "trivia": boolean }
interface Cst { "spans": CstSpan[]; "length": number }
/** A parse as kept: names once each, and five numbers a span (type, field — -1 for none — start, end, flags). */
interface Kept { "names": string[]; "data": Int32Array; "length": number }

const CACHE_BYTES = 200 * 1024 * 1024;
const PRUNE_EVERY = 20;
const TOKEN = 1;
const COVER = 2;
const TRIVIA = 4;

function keep(cst: Cst): Kept {
	const names: string[] = [];
	const index = new Map<string, number>();
	const name = (value: string | null): number => {
		if (value === null) {
			return -1;
		}

		let at = index.get(value);

		if (at === undefined) {
			at = names.push(value) - 1;
			index.set(value, at);
		}

		return at;
	};
	const data = new Int32Array(cst.spans.length * 5);

	cst.spans.forEach((span, at) => {
		data.set([name(span.type), name(span.field), span.start, span.end, (span.token ? TOKEN : 0) | (span.cover ? COVER : 0) | (span.trivia ? TRIVIA : 0)], at * 5);
	});

	return { "names": names, "data": data, "length": cst.length };
}

function unkeep({ names, data, length }: Kept): Cst {
	const spans: CstSpan[] = [];

	for (let at = 0; at < data.length; at += 5) {
		const flags = data[at + 4];

		spans.push({ "type": data[at] === -1 ? null : names[data[at]], "field": data[at + 1] === -1 ? null : names[data[at + 1]], "start": data[at + 2], "end": data[at + 3], "token": (flags & TOKEN) !== 0, "cover": (flags & COVER) !== 0, "trivia": (flags & TRIVIA) !== 0 });
	}

	return { "spans": spans, "length": length };
}

/** A text's git blob oid: what git calls the same content. */
async function blobOid(text: string): Promise<string> {
	const body = new TextEncoder().encode(text);
	const header = new TextEncoder().encode(`blob ${body.length}\0`);
	const bytes = new Uint8Array(header.length + body.length);

	bytes.set(header);
	bytes.set(body, header.length);

	return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const done = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
	request.addEventListener("success", () => { resolve(request.result); });
	request.addEventListener("error", () => { reject(request.error); });
});

// Two stores: the parses, and what each weighs and when it was last used (pruning reads only the second).
const database = new Promise<IDBDatabase | undefined>((resolve) => {
	try {
		const open = indexedDB.open("bablr", 1);

		open.addEventListener("upgradeneeded", () => {
			open.result.createObjectStore("cst");
			open.result.createObjectStore("meta").createIndex("used", "used");
		});
		open.addEventListener("success", () => { resolve(open.result); });
		open.addEventListener("error", () => { resolve(undefined); });
	} catch {
		resolve(undefined); // no IndexedDB here: parse every time
	}
}).then(async (db) => {
	// Another version's parses are stale: let them go.
	if (db !== undefined) {
		const stores = db.transaction(["cst", "meta"], "readwrite");

		for (const key of await done(stores.objectStore("meta").getAllKeys()) as string[]) {
			if (!key.startsWith(PARSE_VERSION + "/")) {
				stores.objectStore("meta").delete(key);
				stores.objectStore("cst").delete(key);
			}
		}
	}

	return db;
});

let writes = 0;

/** Past CACHE_BYTES, let the least recently used go, down to three quarters of it. */
async function prune(db: IDBDatabase): Promise<void> {
	const meta = db.transaction("meta").objectStore("meta");
	const entries = await done(meta.getAll()) as { "key": string; "size": number; "used": number }[];
	let total = entries.reduce((sum, entry) => sum + entry.size, 0);

	if (total <= CACHE_BYTES) {
		return;
	}

	const stores = db.transaction(["cst", "meta"], "readwrite");

	for (const entry of entries.sort((a, b) => a.used - b.used)) {
		if (total <= CACHE_BYTES * 0.75) {
			break;
		}

		stores.objectStore("cst").delete(entry.key);
		stores.objectStore("meta").delete(entry.key);
		total -= entry.size;
	}
}

/** `source`'s parse, from the cache when it's there — or undefined when BABLR's grammar doesn't take it. */
async function parse(source: string, signal?: AbortSignal): Promise<Cst | undefined> {
	const db = await database;
	const key = PARSE_VERSION + "/" + await blobOid(source);

	if (db !== undefined) {
		try {
			const kept = await done(db.transaction("cst").objectStore("cst").get(key)) as Kept | { "unparsable": true } | undefined;

			if (kept !== undefined) {
				db.transaction("meta", "readwrite").objectStore("meta").put({ "key": key, "size": "data" in kept ? kept.data.byteLength : 64, "used": Date.now() }, key);

				return "data" in kept ? unkeep(kept) : undefined;
			}
		} catch { /* unreadable: parse it */ }
	}

	let cst: Cst | undefined;

	try {
		cst = await cstSpansAsync(source, "Program", { "signal": signal }) as Cst;
	} catch (error) {
		if (signal?.aborted === true) {
			throw error;
		}
	}

	if (db !== undefined) {
		try {
			const kept = cst === undefined ? { "unparsable": true as const } : keep(cst);
			const stores = db.transaction(["cst", "meta"], "readwrite");

			stores.objectStore("cst").put(kept, key);
			stores.objectStore("meta").put({ "key": key, "size": "data" in kept ? kept.data.byteLength : 64, "used": Date.now() }, key);
			writes += 1;

			if (writes % PRUNE_EVERY === 0) {
				void prune(db).catch(() => undefined);
			}
		} catch { /* nowhere to keep it: parsed again next time */ }
	}

	return cst;
}

/** How a derivation gets a text's parse: from the cache — and, for a text BABLR can't parse, the failure a parse is. */
const cachedParse = (signal: AbortSignal) => async (source: string): Promise<Cst> => {
	const cst = await parse(source, signal);

	if (cst === undefined) {
		throw new Error("BABLR can't parse this text");
	}

	return cst;
};

// A content chain (in practice [HEAD, working]) ⇒ verdict + changed nodes + their working lines. From cached parses:
// each version of a file is parsed once, however many working versions it's compared against.
serve(hub, "bablr.verdict", async (args, { signal }) => {
	try {
		const result = await deriveIdentityAsync((args as { "contents": string[] }).contents, { "signal": signal, "parse": cachedParse(signal) });

		return { "verdict": result.verdict, "changedNodeIds": result.changedNodeIds, "changedLines": "changedLines" in result ? result.changedLines : [] };
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}

		// never let a parse blow up the worker — the caller falls back to a plain diff
		return { "verdict": "unparsable", "changedNodeIds": [], "changedLines": [] };
	}
});

// A burst chain [HEAD, …afters] ⇒ node-grouped chunks for the "your edits" timeline. From cached parses too: each burst's
// text is parsed once, ever.
serve(hub, "bablr.editGroups", async (args, { signal }) => {
	try {
		const { groups, bursts } = await editGroups((args as { "chain": string[] }).chain, { "signal": signal, "parse": cachedParse(signal) });

		return { "groups": groups, "bursts": bursts };
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}

		return { "groups": [], "bursts": 0 };
	}
});

// A source ⇒ every span of it that can be a handle (punctuation never is: pickAnchor skips it) — its id and offsets — or
// `unparsable` when BABLR's grammar doesn't take it (it covers the subset tsval runs, and grows). From the cached parse.
serve(hub, "bablr.spans", async (args, { signal }) => {
	const { source } = args as { "source": string };
	const cst = source === "" ? undefined : await parse(source, signal);

	if (cst === undefined) {
		return { "unparsable": true };
	}

	return { "spans": (spanAnchors(source, "Program", cst) as { "type": string | null; "start": number; "end": number; "id": string }[]).filter((span) => span.type !== null).map(({ id, start, end }) => ({ "id": id, "start": start, "end": end })) };
});

// A text's spans (bablr.spans, cached) and ranges in it — TypeScript's statements, as a run's coverage gives them ⇒ the
// span standing for each range (pickAnchor). No parse: the spans are given.
serve(hub, "bablr.pick", (args) => {
	const { spans, ranges } = args as { "spans": { "id": string; "start": number; "end": number }[]; "ranges": { "start": number; "end": number }[] };
	const handles = spans.map((span) => ({ ...span, "type": "" }));

	return { "ids": ranges.map((range) => pickAnchor(handles, range.start, range.end) ?? null) };
});

// A span of a baseline text ⇒ where it went in the current one, by the structural diff (follow): the same node — a
// container survives edits inside it — or the one an edit replaced it with; nothing when it went. From cached parses.
serve(hub, "bablr.follow", async (args, { signal }) => {
	const { baseline, current, span } = args as { "baseline": string; "current": string; "span": string };
	const [was, now] = [await parse(baseline, signal), await parse(current, signal)];

	if (was === undefined || now === undefined) {
		return {};
	}

	const index = spanAnchors(baseline, "Program", was).findIndex((anchor) => anchor.id === span);
	const found = index === -1 ? undefined : follow(atomsOf(baseline, was), atomsOf(current, now), index);

	return found === undefined ? {} : { "id": spanAnchors(current, "Program", now)[found.to].id, "how": found.how };
});

/** Every span of a parsed text as silo's annotation strategies see it: id, node type, offsets, tokens. */
function shapesOf(source: string, cst: Cst): SpanShape[] {
	const tokens = cst.spans.filter((span) => span.token && !span.trivia).sort((a, b) => a.start - b.start);
	const firstAt = (offset: number): number => {
		let low = 0;
		let high = tokens.length;

		while (low < high) {
			const middle = (low + high) >> 1;

			if (tokens[middle].start < offset) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		return low;
	};

	return (spanAnchors(source, "Program", cst) as { "type": string | null; "start": number; "end": number; "id": string }[]).filter((span) => span.type !== null).map((span) => {
		const atoms: string[] = [];

		for (let at = firstAt(span.start); at < tokens.length && tokens[at].end <= span.end; at += 1) {
			atoms.push(source.slice(tokens[at].start, tokens[at].end));
		}

		return { "id": span.id, "type": span.type!, "start": span.start, "end": span.end, "atoms": atoms };
	});
}

// A text, ranges in it, and the file's name ⇒ a reference to the span standing for each range (its id, shape and
// neighbours, and the text's blob oid as its baseline) — what an annotation keeps. Nothing when BABLR can't parse it.
serve(hub, "bablr.refer", async (args, { signal }) => {
	const { source, ranges, file } = args as { "source": string; "ranges": { "start": number; "end": number }[]; "file": string };
	const cst = source === "" ? undefined : await parse(source, signal);

	if (cst === undefined) {
		return {};
	}

	const shapes = shapesOf(source, cst);
	const blob = await blobOid(source);

	return { "refs": ranges.map((range) => {
		const id = pickAnchor(shapes, range.start, range.end);

		return (id === undefined ? undefined : referTo(shapes, id, file, blob)) ?? null;
	}) };
});

// References, the text their file has now (and their baselines' texts, by blob oid, when the caller could get them) ⇒
// where each one's span is: silo's resolver — the authored pipeline, with the structural diff from a baseline as its
// re-identified strategy, or the observed one (the id alone) — and, for one found anywhere but by its own id, the
// reference as it would be made here now (for an annotation to be rewritten with).
serve(hub, "bablr.resolve", async (args, { signal }) => {
	const { source, file, refs, baselines = {}, observed = false } = args as { "source": string; "file": string; "refs": SpanRef[]; "baselines"?: Record<string, string>; "observed"?: boolean };
	const cst = source === "" ? undefined : await parse(source, signal);

	if (cst === undefined) {
		return { "resolutions": refs.map(() => ({ "status": "orphaned", "alternatives": [] })) };
	}

	const shapes = shapesOf(source, cst);
	const ids = new Set(shapes.map((shape) => shape.id));
	const anchors = spanAnchors(source, "Program", cst);
	const blob = await blobOid(source);
	const resolutions = [];

	for (const ref of refs) {
		let reidentified: { "id": string; "how": "kept" | "replaced" } | undefined;
		const baseline = ref.baseline === undefined ? undefined : baselines[ref.baseline.blob];

		if (!observed && baseline !== undefined && !ids.has(ref.span)) {
			const was = await parse(baseline, signal);
			const index = was === undefined ? -1 : spanAnchors(baseline, "Program", was).findIndex((anchor) => anchor.id === ref.span);
			const found = was === undefined || index === -1 ? undefined : follow(atomsOf(baseline, was), atomsOf(source, cst), index);

			reidentified = found === undefined ? undefined : { "id": anchors[found.to].id, "how": found.how };
		}

		const resolution = resolve(ref, { "file": file, "shapes": shapes, ...reidentified === undefined ? {} : { "reidentified": reidentified } }, observed ? OBSERVED : PIPELINE);
		const moved = resolution.candidate !== undefined && resolution.status !== "attached";

		resolutions.push({ ...resolution, ...moved ? { "ref": referTo(shapes, resolution.candidate!.span, file, blob) } : {} });
	}

	return { "resolutions": resolutions };
});
