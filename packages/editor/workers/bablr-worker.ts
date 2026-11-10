/**
 * The editor's BABLR, off the main thread (workbench/bablr.ts starts it and asks one thing at a time): whether BABLR's
 * grammar takes a text, and why not when it doesn't, and where its comments are — `bablr.parse` { source } →
 * { parsed, why?, comments?, ms, cached }, `comments` each comment's start and end, in turn. BABLR is
 * a VM interpreter, about 14 ms a line, so a text's answer is kept by its git blob oid in this browser's IndexedDB
 * (`bablr`, its own database, not the workspace's store), under PARSE_VERSION, so a grammar change asks again: a file
 * is parsed once however often it's asked about.
 *
 * And what's placed on code stays on it (RUNTIME-EVIDENCE.md, *Durable annotations on spans*; editor-api's annotations.ts is its
 * contract): `bablr.spans`, a text's spans; `bablr.refer`, a reference to the span standing for each range; `bablr.resolve`,
 * where references' spans are now, by silo's resolver: by id, followed from a text they were made against, or in another file.
 * The last few parses are kept here for these: a text is asked about many times running, and a parse of one being typed
 * isn't worth keeping on disk.
 *
 * What else is built on a parse — verdicts (`full-editor`'s worker) — comes back with the features that need it. A parse
 * yields as it goes, so a cancelled call's signal ends it mid-parse and the worker stays.
 */
import "./bablr-fast-freeze"; // first: neutralizes record freezing before the BABLR bundle captures Object.freeze
// (A comment, so sorting leaves the freeze first.)
import type { SpanRef, SpanShape } from "@brianjenkins94/util/silo/annotations";
import { atomsOf, cstSpansAsync, deriveIdentityAsync, editGroups, follow, PARSE_VERSION, pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { OBSERVED, PIPELINE, referTo, resolve } from "@brianjenkins94/util/silo/annotations";
import { NETWORK_PROBES } from "../shared/architecture";

const hub = createHub({ "id": "bablr" });

hub.link(portTransport(globalThis));

const { log } = observe(hub, { "network": NETWORK_PROBES });

/** A text's answer as kept: whether it parsed, why not, where its comments are (each one's start and end, in turn), and
 *  what the parse took. */
interface Answer { "parsed": boolean; "why"?: string; "comments"?: number[]; "ms": number }

/** A text's git blob oid: what git calls the same content. */
async function blobOid(text: string): Promise<string> {
	const body = new TextEncoder().encode(text);
	const header = new TextEncoder().encode(`blob ${String(body.length)}\0`);
	const bytes = new Uint8Array(header.length + body.length);

	bytes.set(header);
	bytes.set(body, header.length);

	return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => {
			resolve(request.result);
		});
		request.addEventListener("error", () => {
			reject(request.error ?? new Error("IndexedDB failed"));
		});
	});
}

/** The answers, kept: a store of them by PARSE_VERSION and blob oid; another version's go as it opens. */
const database = new Promise<IDBDatabase | undefined>((resolve) => {
	try {
		const open = indexedDB.open("bablr", 3);

		open.addEventListener("upgradeneeded", () => {
			// (a version before's answers, and full-editor's kept spans: they go)
			for (const name of [...open.result.objectStoreNames]) {
				open.result.deleteObjectStore(name);
			}

			open.result.createObjectStore("parses");
		});
		open.addEventListener("success", () => {
			resolve(open.result);
		});
		open.addEventListener("error", () => {
			resolve(undefined);
		});
	} catch {
		resolve(undefined); // no IndexedDB here: parsed every time
	}
}).then(async (db) => {
	if (db !== undefined) {
		const parses = db.transaction("parses", "readwrite").objectStore("parses");

		for (const key of await done(parses.getAllKeys()) as string[]) {
			if (!key.startsWith(PARSE_VERSION + "/")) {
				parses.delete(key);
			}
		}
	}

	return db;
}).catch(() => undefined);

serve(hub, "bablr.parse", async (args, { signal }) => {
	const { source } = (args ?? {}) as { "source"?: unknown };

	if (typeof source !== "string") {
		throw new TypeError("bablr.parse takes { source }");
	}

	const key = PARSE_VERSION + "/" + await blobOid(source);
	const db = await database;
	const kept = db === undefined ? undefined : await done(db.transaction("parses").objectStore("parses").get(key) as IDBRequest<Answer | undefined>).catch(() => undefined);

	if (kept !== undefined) {
		return { ...kept, "cached": true };
	}

	const answer = await log.span("editor.workers.bablr-worker.parse", { "bytes": source.length }, async (span): Promise<Answer> => {
		const started = performance.now();

		let comments: number[];

		try {
			const { spans } = await cstSpansAsync(source, "Program", { "signal": signal }) as { "spans": { "type": string | null; "start": number; "end": number }[] };

			comments = spans.filter((each) => each.type === "Comment").flatMap((each) => [each.start, each.end]);
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			span.end({ "parsed": false });

			return { "parsed": false, "why": error instanceof Error ? error.message : String(error), "ms": Math.round(performance.now() - started) };
		}

		span.end({ "parsed": true, "count": comments.length / 2 });

		return { "parsed": true, "comments": comments, "ms": Math.round(performance.now() - started) };
	});

	if (db !== undefined) {
		await done(db.transaction("parses", "readwrite").objectStore("parses").put(answer, key)).catch(() => undefined);
	}

	return { ...answer, "cached": false };
});

// ── what's placed on code ──

interface CstSpan { "type": string | null; "start": number; "end": number; "token": boolean; "trivia": boolean; "text"?: string }
interface Cst { "spans": CstSpan[]; "length": number; "hash": string }
interface Anchor { "type": string | null; "start": number; "end": number; "id": string }
type Parsed = { "cst": Cst } | { "why": string };

/** How many texts' parses are kept: enough for a file and what it's being compared with. */
const KEPT_PARSES = 16;
const parses = new Map<string, Parsed>();

/** A text's parse, or why BABLR can't: the most recently asked about kept. */
async function parsed(source: string, signal: AbortSignal): Promise<Parsed> {
	const known = parses.get(source);

	if (known !== undefined) {
		parses.delete(source);
		parses.set(source, known);

		return known;
	}

	const answer = await log.span("editor.workers.bablr-worker.spans", { "bytes": source.length }, async (): Promise<Parsed> => {
		try {
			return { "cst": await cstSpansAsync(source, "Program", { "signal": signal }) as Cst };
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			return { "why": error instanceof Error ? error.message : String(error) };
		}
	});

	parses.set(source, answer);

	for (const oldest of [...parses.keys()].slice(0, Math.max(0, parses.size - KEPT_PARSES))) {
		parses.delete(oldest);
	}

	return answer;
}

/** `parsed`'s parse as BABLR's identity core takes one: it throws where the text doesn't parse. */
const parseFor = (signal: AbortSignal) => async (source: string): Promise<Cst> => {
	const answer = await parsed(source, signal);

	if ("why" in answer) {
		throw new Error(answer.why);
	}

	return answer.cst;
};

// Two texts of a file (HEAD's and the working tree's) ⇒ whether the change is cosmetic (formatting or comments only) or
// meaningful, the nodes that changed and their lines: the cosmetic extension's badge (workbench/bablr.ts `classify`).
// From the parses kept above, so each version is parsed once however many it's compared with.
serve(hub, "bablr.verdict", async (args, { signal }) => {
	const { contents } = args as { "contents": string[] };

	return log.span("editor.workers.bablr-worker.verdict", { "count": contents.length, "bytes": contents.reduce((total, text) => total + text.length, 0) }, async (span) => {
		try {
			const result = await deriveIdentityAsync(contents, { "signal": signal, "parse": parseFor(signal) }) as { "verdict": string; "changedNodeIds": string[]; "changedLines"?: number[] };

			span.end({ "op": result.verdict });

			return { "verdict": result.verdict, "changedNodeIds": result.changedNodeIds, "changedLines": result.changedLines ?? [] };
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			// (a text BABLR can't parse: the caller says so rather than guess)
			span.end({ "op": "unparsable" });

			return { "verdict": "unparsable", "changedNodeIds": [], "changedLines": [] };
		}
	});
});

// A file's texts since the last commit, [HEAD, …each burst after it] ⇒ the code each change touched, for "your edits"
// (edit-history.ts): from the parses kept above, so a burst's text is parsed once. Nothing where one doesn't parse.
serve(hub, "bablr.editGroups", async (args, { signal }) => {
	const { chain } = args as { "chain": string[] };

	return log.span("editor.workers.bablr-worker.editGroups", { "count": chain.length }, async (span) => {
		try {
			const grouped = await editGroups(chain, { "signal": signal, "parse": parseFor(signal) }) as { "groups": unknown[]; "bursts": number };

			span.end({ "groups": grouped.groups.length, "bursts": grouped.bursts });

			return grouped;
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			span.end({ "unparsable": true });

			return { "groups": [], "bursts": 0 };
		}
	});
});

const anchorsOf = (source: string, cst: Cst): Anchor[] => spanAnchors(source, "Program", cst) as Anchor[];

/** Each span of a text with its shape: its id, type, offsets and the code's tokens in it. */
function shapesOf(source: string, cst: Cst): SpanShape[] {
	const tokens = cst.spans.filter((span) => span.token && !span.trivia).toSorted((left, right) => left.start - right.start);
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

	return anchorsOf(source, cst).filter((span): span is Anchor & { "type": string } => span.type !== null).map((span) => {
		const atoms: string[] = [];

		for (let at = firstAt(span.start); at < tokens.length && tokens[at].end <= span.end; at += 1) {
			atoms.push(tokens[at].text ?? "");
		}

		return { "id": span.id, "type": span.type, "start": span.start, "end": span.end, "atoms": atoms };
	});
}

serve(hub, "bablr.spans", async (args, { signal }) => {
	const { source } = args as { "source": string };

	if (source === "") {
		return { "spans": [] };
	}

	const answer = await parsed(source, signal);

	return "why" in answer ? { "unparsable": answer.why } : { "spans": anchorsOf(source, answer.cst).filter((span) => span.type !== null).map(({ id, type, start, end }) => ({ "id": id, "type": type, "start": start, "end": end })) };
});

serve(hub, "bablr.refer", async (args, { signal }) => {
	const { source, ranges, file } = args as { "source": string; "ranges": { "start": number; "end": number }[]; "file": string };

	if (source === "") {
		return { "refs": ranges.map(() => null) };
	}

	const answer = await parsed(source, signal);

	if ("why" in answer) {
		return { "unparsable": answer.why };
	}

	const shapes = shapesOf(source, answer.cst);
	const blob = await blobOid(source);

	return { "refs": ranges.map((range) => {
		const id = pickAnchor(shapes, range.start, range.end) as string | undefined;

		return (id === undefined ? undefined : referTo(shapes, id, file, blob)) ?? null;
	}) };
});

serve(hub, "bablr.resolve", async (args, { signal }) => {
	const { source, file, refs, "baselines": fromGit = {}, texts = [], others = {}, observed = false, types = {} } = args as { "source": string; "file": string; "refs": SpanRef[]; "baselines"?: Record<string, string>; "texts"?: string[]; "others"?: Record<string, string>; "observed"?: boolean; "types"?: Record<string, { "inferred"?: string; "observed"?: string[] }> };

	if (source === "") {
		return { "resolutions": refs.map(() => ({ "status": "orphaned", "alternatives": [] })) };
	}

	const answer = await parsed(source, signal);

	if ("why" in answer) {
		return { "unparsable": answer.why };
	}

	const { cst } = answer;
	const baselines: Record<string, string> = { ...fromGit };

	for (const text of texts) {
		baselines[await blobOid(text)] = text;
	}

	const shapes = shapesOf(source, cst);
	const ids = new Set(shapes.map((shape) => shape.id));
	const anchors = anchorsOf(source, cst);
	const blob = await blobOid(source);
	const elsewhere = new Map<string, { "file": string; "shape": SpanShape; "shapes": SpanShape[]; "blob": string }>();

	// (the other files' spans only when a reference isn't here)
	if (!observed && refs.some((ref) => !ids.has(ref.span))) {
		for (const [path, text] of Object.entries(others)) {
			const theirs = await parsed(text, signal);

			if ("cst" in theirs) {
				const theirShapes = shapesOf(text, theirs.cst);
				const theirBlob = await blobOid(text);

				for (const shape of theirShapes) {
					if (!elsewhere.has(shape.id)) {
						elsewhere.set(shape.id, { "file": path, "shape": shape, "shapes": theirShapes, "blob": theirBlob });
					}
				}
			}
		}
	}

	const resolutions = [];

	for (const ref of refs) {
		let reidentified: { "id": string; "how": "kept" | "replaced" } | undefined;
		const baseline = ref.baseline === undefined ? undefined : baselines[ref.baseline.blob];

		if (!observed && baseline !== undefined && !ids.has(ref.span)) {
			const was = await parsed(baseline, signal);
			const index = "cst" in was ? anchorsOf(baseline, was.cst).findIndex((anchor) => anchor.id === ref.span) : -1;
			const found = "cst" in was && index !== -1 ? follow(atomsOf(was.cst), atomsOf(cst), index) as { "to": number; "how": "kept" | "replaced" } | undefined : undefined;

			reidentified = found === undefined ? undefined : { "id": anchors[found.to].id, "how": found.how };
		}

		const resolution = resolve(ref, {
			"file": file,
			"shapes": shapes,
			"types": (id: string) => types[id],
			...elsewhere.size === 0 ? {} : { "elsewhere": (id: string) => elsewhere.get(id) },
			...reidentified === undefined ? {} : { "reidentified": () => reidentified }
		}, observed ? OBSERVED : PIPELINE);
		const at = resolution.status === "attached" ? undefined : resolution.candidate;
		const there = at === undefined || at.file === file ? { "shapes": shapes, "blob": blob } : elsewhere.get(at.span);

		resolutions.push({ ...resolution, ...at === undefined || there === undefined ? {} : { "ref": referTo(there.shapes, at.span, at.file, there.blob) } });
	}

	return { "resolutions": resolutions };
});
