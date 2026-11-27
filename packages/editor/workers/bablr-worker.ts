import "./bablr-fast-freeze";
// (A comment, so sorting leaves the freeze first.)
import type { SpanRef, SpanShape } from "@brianjenkins94/util/silo/annotations";
import type { Kept, Parse, ParsedNode } from "./bablr-parses";
import { atomsOf, cstSpansAsync, deriveIdentityAsync, editGroups, follow, PARSE_VERSION, pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { OBSERVED, PIPELINE, referTo, resolve } from "@brianjenkins94/util/silo/annotations";
import { NETWORK_PROBES } from "../shared/architecture";
import { blobOid, parseOf, parser, shapesOf, spansOf } from "./bablr-parses";

const hub = createHub({ "id": "bablr" });

hub.link(portTransport(globalThis));

const { log } = observe(hub, { "network": NETWORK_PROBES });

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

const MOST_PARSES = 4000;

const database = new Promise<IDBDatabase | undefined>((resolve) => {
	try {
		const open = indexedDB.open("bablr", 5);

		open.addEventListener("upgradeneeded", () => {
			for (const name of [...open.result.objectStoreNames]) {
				open.result.deleteObjectStore(name);
			}

			open.result.createObjectStore("parses").createIndex("at", "at");
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
		const parses = db.transaction("parses", "readwrite").objectStore("parses");

		for (const key of await done(parses.getAllKeys()) as string[]) {
			if (!key.startsWith(PARSE_VERSION + "/")) {
				parses.delete(key);
			}
		}

		const over = await done(parses.count()) - MOST_PARSES;

		if (over > 0) {
			for (const key of await done(parses.index("at").getAllKeys(null, over))) {
				parses.delete(key);
			}
		}
	}

	return db;
}).catch(() => undefined);

const kept: Kept = {
	"get": async (key) => {
		const db = await database;

		if (db === undefined || released) {
			return undefined;
		}

		const found = await done(db.transaction("parses").objectStore("parses").get(key) as IDBRequest<{ "bytes": ArrayBuffer } | undefined>);

		return found?.bytes;
	},
	"put": async (key, bytes) => {
		const db = await database;

		if (db !== undefined && !released) {
			await done(db.transaction("parses", "readwrite").objectStore("parses").put({ "at": Date.now(), "bytes": bytes }, key));
		}
	}
};

const parse = parser({
	"version": PARSE_VERSION,
	"kept": kept,
	"log": log,
	"parse": async (source, signal) => {
		try {
			const cst = await cstSpansAsync(source, "Program", { "signal": signal }) as { "spans": { "type": string | null; "start": number; "end": number; "token": boolean; "trivia": boolean; "text": string | null }[] };

			return parseOf(spanAnchors(source, "Program", cst) as ParsedNode[], cst.spans);
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}

			return { "why": error instanceof Error ? error.message : String(error) };
		}
	}
});

const spansFor = (signal: AbortSignal) => async (source: string): Promise<{ "spans": unknown[] }> => {
	const parsed = await parse(source, signal);

	if ("why" in parsed) {
		throw new Error(parsed.why);
	}

	return spansOf(parsed);
};

serve(hub, "bablr.parse", async (args, { signal }) => {
	const { source } = (args ?? {}) as { "source"?: unknown };

	if (typeof source !== "string") {
		throw new TypeError("bablr.parse takes { source }");
	}

	return parse(source, signal);
});

serve(hub, "bablr.verdict", async (args, { signal }) => {
	const { contents } = args as { "contents": string[] };

	return log.span("editor.workers.bablr-worker.verdict", { "count": contents.length, "bytes": contents.reduce((total, text) => total + text.length, 0) }, async (span) => {
		try {
			const result = await deriveIdentityAsync(contents, { "signal": signal, "parse": spansFor(signal) }) as { "verdict": string; "changedNodeIds": string[]; "changedLines"?: number[] };

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
			const grouped = await editGroups(chain, { "signal": signal, "parse": spansFor(signal) }) as { "groups": unknown[]; "bursts": number };

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

serve(hub, "bablr.spans", async (args, { signal }) => {
	const { source } = args as { "source": string };

	if (source === "") {
		return { "spans": [] };
	}

	const parsed = await parse(source, signal);

	return "why" in parsed ? { "unparsable": parsed.why } : { "spans": parsed.nodes.filter((node) => node.type !== null).map(({ id, type, start, end }) => ({ "id": id, "type": type, "start": start, "end": end })) };
});

serve(hub, "bablr.refer", async (args, { signal }) => {
	const { source, ranges, file } = args as { "source": string; "ranges": { "start": number; "end": number }[]; "file": string };

	if (source === "") {
		return { "refs": ranges.map(() => null) };
	}

	const parsed = await parse(source, signal);

	if ("why" in parsed) {
		return { "unparsable": parsed.why };
	}

	const shapes = shapesOf(parsed);

	return { "refs": ranges.map((range) => {
		const id = pickAnchor(shapes, range.start, range.end) as string | undefined;

		return (id === undefined ? undefined : referTo(shapes, id, file, parsed.blob)) ?? null;
	}) };
});

async function reidentify(baseline: string, now: Parse & { "nodes": ParsedNode[] }, span: string, signal: AbortSignal): Promise<{ "id": string; "how": "kept" | "replaced" } | undefined> {
	const was = await parse(baseline, signal);
	const index = "nodes" in was ? was.nodes.findIndex((node) => node.id === span) : -1;
	const found = "nodes" in was && index !== -1 ? follow(atomsOf(spansOf(was)), atomsOf(spansOf(now)), index) as { "to": number; "how": "kept" | "replaced" } | undefined : undefined;

	return found === undefined ? undefined : { "id": now.nodes[found.to].id, "how": found.how };
}

serve(hub, "bablr.resolve", async (args, { signal }) => {
	const { source, file, refs, "baselines": fromGit = {}, texts = [], others = {}, observed = false, types = {} } = args as { "source": string; "file": string; "refs": SpanRef[]; "baselines"?: Record<string, string>; "texts"?: string[]; "others"?: Record<string, string>; "observed"?: boolean; "types"?: Record<string, { "inferred"?: string; "observed"?: string[] }> };

	if (source === "") {
		return { "resolutions": refs.map(() => ({ "status": "orphaned", "alternatives": [] })) };
	}

	const parsed = await parse(source, signal);

	if ("why" in parsed) {
		return { "unparsable": parsed.why };
	}

	const baselines: Record<string, string> = { ...fromGit };

	for (const text of texts) {
		baselines[await blobOid(text)] = text;
	}

	const shapes = shapesOf(parsed);
	const ids = new Set(shapes.map((shape) => shape.id));
	const elsewhere = new Map<string, { "file": string; "shape": SpanShape; "shapes": SpanShape[]; "blob": string }>();

	if (!observed && refs.some((ref) => !ids.has(ref.span))) {
		for (const [path, text] of Object.entries(others)) {
			const theirs = await parse(text, signal);

			if ("nodes" in theirs) {
				const theirShapes = shapesOf(theirs);

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
		const reidentified = !observed && baseline !== undefined && !ids.has(ref.span) ? await reidentify(baseline, parsed, ref.span, signal) : undefined;
		const resolution = resolve(ref, {
			"file": file,
			"shapes": shapes,
			"types": (id: string) => types[id],
			...elsewhere.size === 0 ? {} : { "elsewhere": (id: string) => elsewhere.get(id) },
			...reidentified === undefined ? {} : { "reidentified": () => reidentified }
		}, observed ? OBSERVED : PIPELINE);
		const at = resolution.status === "attached" ? undefined : resolution.candidate;
		const there = at === undefined || at.file === file ? { "shapes": shapes, "blob": parsed.blob } : elsewhere.get(at.span);

		resolutions.push({ ...resolution, ...at === undefined || there === undefined ? {} : { "ref": referTo(there.shapes, at.span, at.file, there.blob) } });
	}

	return { "resolutions": resolutions };
});
