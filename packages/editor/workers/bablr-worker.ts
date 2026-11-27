import "./bablr-fast-freeze";
// (A comment, so sorting leaves the freeze first.)
import type { SpanRef, SpanShape } from "@brianjenkins94/util/silo/annotations";
import type { Anchor, Kept, Places } from "./bablr-places";
import { atomsOf, cstSpansAsync, deriveIdentityAsync, editGroups, follow, PARSE_VERSION, pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { OBSERVED, PIPELINE, referTo, resolve } from "@brianjenkins94/util/silo/annotations";
import { NETWORK_PROBES } from "../shared/architecture";
import { blobOid, placer, placesOf, shapesOf } from "./bablr-places";

const hub = createHub({ "id": "bablr" });

hub.link(portTransport(globalThis));

const { log } = observe(hub, { "network": NETWORK_PROBES });

interface Answer { "parsed": boolean; "why"?: string; "comments"?: number[]; "ms": number }

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

let released = false;

const MOST_PLACES = 4000;

const database = new Promise<IDBDatabase | undefined>((resolve) => {
	try {
		const open = indexedDB.open("bablr", 4);

		open.addEventListener("upgradeneeded", () => {
			for (const name of [...open.result.objectStoreNames]) {
				open.result.deleteObjectStore(name);
			}

			open.result.createObjectStore("parses");
			open.result.createObjectStore("places").createIndex("at", "at");
		});
		open.addEventListener("success", () => {
			open.result.addEventListener("versionchange", () => {
				released = true;
				open.result.close();
			});
			resolve(open.result);
		});
		open.addEventListener("blocked", () => {
			resolve(undefined);
		});
		open.addEventListener("error", () => {
			resolve(undefined);
		});
	} catch {
		resolve(undefined);
	}
}).then(async (db) => {
	if (db !== undefined) {
		const stores = db.transaction(["parses", "places"], "readwrite");

		for (const name of ["parses", "places"]) {
			const store = stores.objectStore(name);

			for (const key of await done(store.getAllKeys()) as string[]) {
				if (!key.startsWith(PARSE_VERSION + "/")) {
					store.delete(key);
				}
			}
		}

		const places = stores.objectStore("places");
		const over = await done(places.count()) - MOST_PLACES;

		if (over > 0) {
			for (const key of await done(places.index("at").getAllKeys(null, over))) {
				places.delete(key);
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
	const kept = db === undefined || released ? undefined : await done(db.transaction("parses").objectStore("parses").get(key) as IDBRequest<Answer | undefined>).catch(() => undefined);

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

	if (db !== undefined && !released) {
		await done(db.transaction("parses", "readwrite").objectStore("parses").put(answer, key)).catch(() => undefined);
	}

	return { ...answer, "cached": false };
});

interface CstSpan { "type": string | null; "start": number; "end": number; "token": boolean; "trivia": boolean; "text"?: string }
interface Cst { "spans": CstSpan[]; "length": number; "hash": string }
type Parsed = { "cst": Cst } | { "why": string };

const KEPT_PARSES = 16;
const parses = new Map<string, Parsed>();

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

const parseFor = (signal: AbortSignal) => async (source: string): Promise<Cst> => {
	const answer = await parsed(source, signal);

	if ("why" in answer) {
		throw new Error(answer.why);
	}

	return answer.cst;
};

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

			span.end({ "op": "unparsable" });

			return { "verdict": "unparsable", "changedNodeIds": [], "changedLines": [] };
		}
	});
});

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

const kept: Kept = {
	"get": async (key) => {
		const db = await database;

		if (db === undefined || released) {
			return undefined;
		}

		const found = await done(db.transaction("places").objectStore("places").get(key) as IDBRequest<{ "bytes": ArrayBuffer } | undefined>);

		return found?.bytes;
	},
	"put": async (key, bytes) => {
		const db = await database;

		if (db !== undefined && !released) {
			await done(db.transaction("places", "readwrite").objectStore("places").put({ "at": Date.now(), "bytes": bytes }, key));
		}
	}
};

const place = placer({
	"version": PARSE_VERSION,
	"kept": kept,
	"log": log,
	"place": async (source, signal): Promise<{ "places": Places } | { "why": string }> => {
		const answer = await parsed(source, signal);

		return "why" in answer ? answer : { "places": placesOf(anchorsOf(source, answer.cst), answer.cst.spans) };
	}
});

serve(hub, "bablr.spans", async (args, { signal }) => {
	const { source } = args as { "source": string };

	if (source === "") {
		return { "spans": [] };
	}

	const placing = await place(source, signal);

	return "why" in placing ? { "unparsable": placing.why } : { "spans": placing.places.anchors.filter((span) => span.type !== null) };
});

serve(hub, "bablr.refer", async (args, { signal }) => {
	const { source, ranges, file } = args as { "source": string; "ranges": { "start": number; "end": number }[]; "file": string };

	if (source === "") {
		return { "refs": ranges.map(() => null) };
	}

	const placing = await place(source, signal);

	if ("why" in placing) {
		return { "unparsable": placing.why };
	}

	const shapes = shapesOf(placing.places);

	return { "refs": ranges.map((range) => {
		const id = pickAnchor(shapes, range.start, range.end) as string | undefined;

		return (id === undefined ? undefined : referTo(shapes, id, file, placing.blob)) ?? null;
	}) };
});

async function reidentify(baseline: string, source: string, span: string, anchors: readonly Anchor[], signal: AbortSignal): Promise<{ "id": string; "how": "kept" | "replaced" } | undefined> {
	const placed = await place(baseline, signal);
	const index = "places" in placed ? placed.places.anchors.findIndex((anchor) => anchor.id === span) : -1;

	if (index === -1) {
		return undefined;
	}

	const was = await parsed(baseline, signal);
	const now = await parsed(source, signal);
	const found = "cst" in was && "cst" in now ? follow(atomsOf(was.cst), atomsOf(now.cst), index) as { "to": number; "how": "kept" | "replaced" } | undefined : undefined;

	return found === undefined ? undefined : { "id": anchors[found.to].id, "how": found.how };
}

serve(hub, "bablr.resolve", async (args, { signal }) => {
	const { source, file, refs, "baselines": fromGit = {}, texts = [], others = {}, observed = false, types = {} } = args as { "source": string; "file": string; "refs": SpanRef[]; "baselines"?: Record<string, string>; "texts"?: string[]; "others"?: Record<string, string>; "observed"?: boolean; "types"?: Record<string, { "inferred"?: string; "observed"?: string[] }> };

	if (source === "") {
		return { "resolutions": refs.map(() => ({ "status": "orphaned", "alternatives": [] })) };
	}

	const placing = await place(source, signal);

	if ("why" in placing) {
		return { "unparsable": placing.why };
	}

	const baselines: Record<string, string> = { ...fromGit };

	for (const text of texts) {
		baselines[await blobOid(text)] = text;
	}

	const { anchors } = placing.places;
	const shapes = shapesOf(placing.places);
	const ids = new Set(shapes.map((shape) => shape.id));
	const elsewhere = new Map<string, { "file": string; "shape": SpanShape; "shapes": SpanShape[]; "blob": string }>();

	if (!observed && refs.some((ref) => !ids.has(ref.span))) {
		for (const [path, text] of Object.entries(others)) {
			const theirs = await place(text, signal);

			if ("places" in theirs) {
				const theirShapes = shapesOf(theirs.places);

				for (const shape of theirShapes) {
					if (!elsewhere.has(shape.id)) {
						elsewhere.set(shape.id, { "file": path, "shape": shape, "shapes": theirShapes, "blob": theirs.blob });
					}
				}
			}
		}
	}

	const resolutions = [];

	for (const ref of refs) {
		const baseline = ref.baseline === undefined ? undefined : baselines[ref.baseline.blob];
		const reidentified = !observed && baseline !== undefined && !ids.has(ref.span) ? await reidentify(baseline, source, ref.span, anchors, signal) : undefined;
		const resolution = resolve(ref, {
			"file": file,
			"shapes": shapes,
			"types": (id: string) => types[id],
			...elsewhere.size === 0 ? {} : { "elsewhere": (id: string) => elsewhere.get(id) },
			...reidentified === undefined ? {} : { "reidentified": () => reidentified }
		}, observed ? OBSERVED : PIPELINE);
		const at = resolution.status === "attached" ? undefined : resolution.candidate;
		const there = at === undefined || at.file === file ? { "shapes": shapes, "blob": placing.blob } : elsewhere.get(at.span);

		resolutions.push({ ...resolution, ...at === undefined || there === undefined ? {} : { "ref": referTo(there.shapes, at.span, at.file, there.blob) } });
	}

	return { "resolutions": resolutions };
});
